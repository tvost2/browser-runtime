// bcpp/world.hpp — WASM-first scene core. Data-oriented ECS: every component is
// a contiguous array indexed by a dense entity slot. No per-entity objects, no
// virtual dispatch, no per-frame allocation (buffers are sized once and reused).
//
// The whole per-frame CPU pipeline is one function, `evaluate()`:
//   hierarchy traversal → transform propagation → world matrices →
//   bounds refit → frustum culling → visible set → batched render list.
//
// JS fills the staging arrays (bulk), calls evaluate() once, reads back a
// structured render list as views over WASM memory. One boundary crossing.

#pragma once
#include "math.hpp"
#include "bvh.hpp"
#include <vector>
#include <cstdint>
#include <algorithm>
#include <chrono>

namespace bcpp {

inline double _now_us() {
    using clk = std::chrono::steady_clock;
    return std::chrono::duration<double, std::micro>(clk::now().time_since_epoch()).count();
}

enum class CullStrategy : uint32_t {
    Standard = 0,           // incremental linear cull (re-test only movers when the camera is still)
    BoundingSphereOnly = 1, // sphere-only, no 8-corner box test
    None = 2,               // everything visible
    Bvh = 3,                // spatial-index traversal (best for a moving camera over a large scene)
    Auto = 4,               // per frame: Bvh while the camera moves over a big scene, else Standard
    Gpu = 5,                // transform on CPU (incremental), cull + compaction + draw-args on the GPU
                            // via a compute shader — CPU builds no render list, uploads only the
                            // frustum + moved matrices per frame
};

// flag bits (mirror web/shared/flags.ts)
enum EntityFlags : uint32_t {
    F_ENABLED      = 1u << 0,
    F_VISIBLE      = 1u << 1,
    F_ALWAYS_ACTIVE= 1u << 2,  // skip frustum test
    F_CAST_SHADOW  = 1u << 3,
};

struct EvalStats {
    uint32_t entities = 0;
    uint32_t traversed = 0;
    uint32_t culledDisabled = 0;
    uint32_t culledFrustum = 0;
    uint32_t visible = 0;
    uint32_t batches = 0;
    uint32_t hierarchyRebuilds = 0;
    uint32_t transformsRecomputed = 0;  // entities whose world matrix was (re)computed this frame
    uint32_t frameChanged = 1;          // 0 = nothing moved AND camera unchanged → render list reused
    uint32_t bvhBuilds = 0;             // 1 if the spatial index was rebuilt this frame (0 = refit or reused)
    uint32_t bvhNodes = 0;
    // stage timings (microseconds) — steady_clock, cheap enough to always collect
    float transformUs = 0, cullUs = 0, listUs = 0;
    // incremental render list
    uint32_t listRebuilt = 1;           // 1 = pass 2 ran full; 0 = matrices patched in place
    uint32_t dirtySlots = 0;            // instance-buffer rows whose matrix changed (when listRebuilt == 0)
};

struct Batch { uint32_t meshId; uint32_t firstInstance; uint32_t instanceCount; };

class World {
public:
    // ---- component storage (SoA), slot in [0, count) ----
    uint32_t count = 0;

    std::vector<Vec3>     localPos;
    std::vector<Quat>     localRot;
    std::vector<Vec3>     localScale;
    std::vector<int32_t>  parent;      // -1 = root
    std::vector<Vec3>     localMin;    // local-space AABB
    std::vector<Vec3>     localMax;
    std::vector<uint32_t> meshId;
    std::vector<uint32_t> materialId;
    std::vector<uint32_t> flags;
    std::vector<uint8_t>  dirty;        // 1 = local transform changed since last evaluate() (JS writes this)

    // ---- derived, persistent; recomputed only for dirty subtrees ----
    std::vector<Mat4>     world;
    std::vector<Vec4>     worldSphere;  // xyz center + w radius
    std::vector<Vec3>     worldMin;     // world-space AABB (persistent — used by the spatial index)
    std::vector<Vec3>     worldMax;

    // ---- render list output ----
    std::vector<uint32_t> visibleId;      // entity slots, render order
    std::vector<Mat4>     instanceWorld;  // parallel world matrices, GPU-ready
    std::vector<uint32_t> instanceMeshId; // parallel mesh ids
    std::vector<Batch>    batches;        // contiguous runs of one meshId

    EvalStats stats{};

    // Grow the SoA storage to capacity `n`, PRESERVING existing entity data and
    // default-initialising only the new [old, n) slots. (Called by JS when the
    // live count outgrows capacity; scenes are built incrementally.)
    void resize(uint32_t n) {
        const uint32_t old = static_cast<uint32_t>(localPos.size());
        if (n <= old) { count = n; _hierarchyDirty = true; return; }
        count = n;
        localPos.resize(n);
        localRot.resize(n, {0, 0, 0, 1});
        localScale.resize(n, {1, 1, 1});
        parent.resize(n, -1);
        localMin.resize(n, {-0.5f, -0.5f, -0.5f});
        localMax.resize(n, {0.5f, 0.5f, 0.5f});
        meshId.resize(n, 0);
        materialId.resize(n, 0);
        flags.resize(n, F_ENABLED | F_VISIBLE);
        dirty.resize(n, 1);
        world.resize(n, Mat4::identity());
        worldSphere.resize(n, {});
        worldMin.resize(n, {-0.5f, -0.5f, -0.5f});
        worldMax.resize(n, {0.5f, 0.5f, 0.5f});
        _order.resize(n);
        _depth.resize(n, 0);
        _recomputed.resize(n, 0);
        for (uint32_t i = old; i < n; ++i) _order[i] = i;
        _hierarchyDirty = true;
        visibleId.reserve(n);
        instanceWorld.reserve(n);
        instanceMeshId.reserve(n);
        batches.reserve(64);
        _sortKeys.reserve(n);
    }

    void setCount(uint32_t n) {
        // entities that just came into existence need a first world-matrix compute
        if (n > count) for (uint32_t i = count; i < n && i < dirty.size(); ++i) dirty[i] = 1;
        count = n;
        _hierarchyDirty = true;
    }
    void markHierarchyDirty() { _hierarchyDirty = true; _bvhDirty = true; }
    void markDirty(uint32_t i) { if (i < dirty.size()) dirty[i] = 1; }
    void markAllDirty() { std::fill(dirty.begin(), dirty.begin() + std::min<size_t>(count, dirty.size()), 1); }
    void markSpatialDirty() { _bvhDirty = true; }   // force a BVH rebuild (e.g. flags changed)

    // One per-frame call. Transforms are recomputed only for entities whose local
    // transform changed (JS sets dirty[i]) or whose ancestor moved — the topo
    // order lets a single forward pass propagate that. Culling still visits every
    // entity (the camera usually moves) but that test is cheap; the O(n)
    // transform+refit cost is now paid only for what actually moved.
    void evaluate(const Mat4& viewProj, CullStrategy strat, bool sortByMesh) {
        const uint32_t prevVisible = stats.visible;
        stats = EvalStats{};
        stats.entities = count;
        if (_hierarchyDirty) { rebuildOrder(); stats.hierarchyRebuilds = 1; }

        const bool camMoved = _cameraChanged(viewProj);
        const bool structChanged = _hierarchyDirty || count != _prevCount;

        // --- transform pass: only dirty subtrees ---
        const double t0 = _now_us();
        _recomputed.assign(count, 0);
        uint32_t recomputed = 0;
        for (uint32_t k = 0; k < count; ++k) {
            const uint32_t i = _order[k];
            const int32_t p = parent[i];
            const bool needs = structChanged || dirty[i] || (p >= 0 && p < (int32_t)count && _recomputed[p]);
            if (!needs) continue;

            const Mat4 local = Mat4::compose(localScale[i], localRot[i].normalized(), localPos[i]);
            world[i] = (p < 0) ? local : Mat4::multiply(local, world[p]);

            const Vec3 lo = localMin[i], hi = localMax[i];
            Vec3 wmin{1e30f, 1e30f, 1e30f}, wmax{-1e30f, -1e30f, -1e30f};
            for (int c = 0; c < 8; ++c) {
                const Vec3 corner{(c & 1) ? hi.x : lo.x, (c & 2) ? hi.y : lo.y, (c & 4) ? hi.z : lo.z};
                const Vec3 w = world[i].transformCoord(corner);
                wmin = Vec3::min(wmin, w);
                wmax = Vec3::max(wmax, w);
            }
            worldMin[i] = wmin; worldMax[i] = wmax;
            const Vec3 center = (wmin + wmax) * 0.5f;
            const f32 radius = ((wmax - wmin) * 0.5f).length();
            worldSphere[i] = {center.x, center.y, center.z, radius};

            _recomputed[i] = 1;
            recomputed++;
        }
        stats.transformsRecomputed = recomputed;
        std::fill(dirty.begin(), dirty.begin() + std::min<size_t>(count, dirty.size()), 0);
        _hierarchyDirty = false;
        _prevCount = count;
        const double t1 = _now_us();
        stats.transformUs = (float)(t1 - t0);

        // --- GPU-driven path: CPU is done after the transform pass. The compute
        //     shader reads worldSphere[] + entityBucket[] and does frustum cull,
        //     per-mesh atomic compaction and indirect-draw-args generation. We
        //     only keep the bucket layout current (recomputed when meshId /
        //     visibility flags change, not per frame). ---
        if (strat == CullStrategy::Gpu) {
            _gpuLayoutRebuilt = (structChanged || _meshLayoutDirty || _gpuBuckets.empty()) ? 1u : 0u;
            if (_gpuLayoutRebuilt) buildGpuBuckets();
            _meshLayoutDirty = false;
            _lastStrat = strat;
            stats.visible = 0;               // the GPU knows; CPU does not
            stats.batches = (uint32_t)_gpuBucketMesh.size();
            stats.frameChanged = (recomputed || camMoved || structChanged) ? 1u : 0u;
            stats.cullUs = 0; stats.listUs = 0;
            return;
        }

        // Auto → concrete strategy for the rest of this frame: a BVH traversal
        // beats the O(n) linear re-test while the camera moves over a large
        // scene; the incremental linear cull is cheaper when the camera is still.
        if (strat == CullStrategy::Auto)
            strat = (camMoved && count > 20000 && recomputed * 8 <= count) ? CullStrategy::Bvh : CullStrategy::Standard;

        // --- fast path: nothing moved and the camera is unchanged → reuse last
        //     frame's render list verbatim (renderer can skip the GPU re-upload) ---
        if (recomputed == 0 && !camMoved && !structChanged && !_meshLayoutDirty) {
            stats.frameChanged = 0;
            stats.visible = prevVisible;
            stats.batches = static_cast<uint32_t>(batches.size());
            stats.traversed = 0;
            stats.listRebuilt = 0;
            _dirtySlots.clear();
            _lastStrat = strat;
            return;
        }

        // --- cull pass ---
        const Frustum fr = Frustum::fromViewProj(viewProj);
        visibleId.clear();

        // A spatial index only pays off when little moves per frame. Build it on
        // setup (first use / structural change), refit only the moved leaves on
        // a light-motion frame, and fall back to the linear scan when a large
        // fraction moved (the refit would cost more than the scan) — rebuilding
        // once things settle.
        bool useBvh = (strat == CullStrategy::Bvh);
        if (useBvh) {
            const bool needBuild = _bvhDirty || structChanged || _bvh.empty();
            const bool heavyChurn = !needBuild && recomputed * 8 > count;
            if (needBuild) {
                _bvh.build(worldMin.data(), worldMax.data(), count);
                _bvhDirty = false; stats.bvhBuilds = 1;
            } else if (heavyChurn) {
                // too much moved for an incremental refit to be worth it — keep
                // the tree valid with a cheap full-AABB refit (no repartition)
                // and cull linearly this frame.
                if (recomputed > 0) _bvh.refit(worldMin.data(), worldMax.data());
                useBvh = false;
            } else if (recomputed > 0) {
                _bvh.refitDirty(_recomputed.data(), count, worldMin.data(), worldMax.data());
            }
            stats.bvhNodes = _bvh.nodeCount;
        }

        if (useBvh) {
            _visibleBitValid = false;   // the BVH path doesn't maintain _visibleBit
            _bvh.frustumCull(fr, [&](uint32_t i, bool fullyInside) {
                stats.traversed++;
                const uint32_t fl = flags[i];
                if (!(fl & F_ENABLED) || !(fl & F_VISIBLE)) { stats.culledDisabled++; return; }
                if (!fullyInside && !(fl & F_ALWAYS_ACTIVE)) {
                    const Vec4 s = worldSphere[i];
                    bool inside = true;
                    for (int pl = 0; pl < 6; ++pl)
                        if (fr.planes[pl].dotCoordinate({s.x, s.y, s.z}) <= -s.w) { inside = false; break; }
                    if (inside) inside = boxInFrustum(fr, worldMin[i], worldMax[i]);
                    if (!inside) { stats.culledFrustum++; return; }
                }
                visibleId.push_back(i);
            });
        } else {
            // Linear cull. The frustum math (6 plane dots + 8-corner box) is the
            // expensive part. Two paths:
            //  · full — camera moved / structural change / strategy switch / the
            //    persistent bit is stale: test every entity, refresh _visibleBit.
            //  · incremental — camera unchanged: only an entity that moved this
            //    frame can have crossed a frustum plane, so re-test just the
            //    `_recomputed` ones and reuse _visibleBit for the rest.
            // The O(n) scan that rebuilds `visibleId` in topo order stays either
            // way (~7 ns/entity).
            if (_visibleBit.size() < count) _visibleBit.assign(count, 0);
            const bool sphereOnly = (strat == CullStrategy::BoundingSphereOnly);
            const bool fullCull = camMoved || structChanged || (strat != _lastStrat) || !_visibleBitValid;

            if (fullCull) {
                for (uint32_t k = 0; k < count; ++k) {
                    const uint32_t i = _order[k];
                    const uint32_t fl = flags[i];
                    if (!(fl & F_ENABLED) || !(fl & F_VISIBLE)) { _visibleBit[i] = 0; stats.culledDisabled++; continue; }
                    uint8_t bit = 1;
                    if (!(fl & F_ALWAYS_ACTIVE) && strat != CullStrategy::None) {
                        const Vec4 s = worldSphere[i];
                        bool inside = true;
                        for (int pl = 0; pl < 6; ++pl)
                            if (fr.planes[pl].dotCoordinate({s.x, s.y, s.z}) <= -s.w) { inside = false; break; }
                        if (inside && !sphereOnly) inside = boxInFrustum(fr, worldMin[i], worldMax[i]);
                        bit = inside ? 1 : 0;
                    }
                    _visibleBit[i] = bit;
                    if (bit) visibleId.push_back(i);
                }
                _visibleBitValid = true;
            } else {
                for (uint32_t k = 0; k < count; ++k) {
                    const uint32_t i = _order[k];
                    const uint32_t fl = flags[i];
                    if (!(fl & F_ENABLED) || !(fl & F_VISIBLE)) { _visibleBit[i] = 0; stats.culledDisabled++; continue; }
                    if (_recomputed[i]) {
                        uint8_t bit = 1;
                        if (!(fl & F_ALWAYS_ACTIVE) && strat != CullStrategy::None) {
                            const Vec4 s = worldSphere[i];
                            bool inside = true;
                            for (int pl = 0; pl < 6; ++pl)
                                if (fr.planes[pl].dotCoordinate({s.x, s.y, s.z}) <= -s.w) { inside = false; break; }
                            if (inside && !sphereOnly) inside = boxInFrustum(fr, worldMin[i], worldMax[i]);
                            bit = inside ? 1 : 0;
                        }
                        _visibleBit[i] = bit;
                    }
                    if (_visibleBit[i]) visibleId.push_back(i);
                }
            }
            stats.traversed = count;
            stats.culledFrustum = stats.entities - stats.culledDisabled - (uint32_t)visibleId.size();
        }
        _lastStrat = strat;
        stats.visible = static_cast<uint32_t>(visibleId.size());
        const double t2 = _now_us();
        stats.cullUs = (float)(t2 - t1);

        // --- pass 2: render list ---
        // If the visible SET and batch layout are unchanged from last frame
        // (same entities in the same cull order, same sort mode, no meshId
        // edits), the slot assignment is identical — just overwrite the matrix
        // rows of entities that actually moved and hand the renderer a dirty
        // slot list for a partial GPU upload. Otherwise rebuild from scratch.
        const bool sameLayout = !structChanged && !_meshLayoutDirty
            && sortByMesh == _lastSortByMesh
            && visibleId.size() == _visiblePrev.size()
            && std::equal(visibleId.begin(), visibleId.end(), _visiblePrev.begin());

        if (sameLayout) {
            _dirtySlots.clear();
            for (uint32_t k = 0; k < visibleId.size(); ++k) {
                const uint32_t e = visibleId[k];
                if (!_recomputed[e]) continue;
                const int32_t s = _entitySlot[e];
                if (s < 0) continue;
                instanceWorld[s] = world[e];
                _dirtySlots.push_back((uint32_t)s);
            }
            stats.listRebuilt = 0;
            stats.dirtySlots = (uint32_t)_dirtySlots.size();
            stats.batches = (uint32_t)batches.size();
        } else {
            instanceWorld.clear();
            instanceMeshId.clear();
            batches.clear();
            if (sortByMesh) buildSortedBatches();
            else            buildRunBatches();
            _visiblePrev.assign(visibleId.begin(), visibleId.end());
            _lastSortByMesh = sortByMesh;
            _meshLayoutDirty = false;
            stats.listRebuilt = 1;
            stats.batches = (uint32_t)batches.size();
        }
        stats.listUs = (float)(_now_us() - t2);
    }

    void markMeshLayoutDirty() { _meshLayoutDirty = true; }   // meshId or visibility flag of some entity changed

    // topological order: parents strictly before children (forest / DAG)
    void rebuildOrder() {
        _order.resize(count);
        _depth.assign(count, -1);
        for (uint32_t i = 0; i < count; ++i) _order[i] = i;
        for (uint32_t i = 0; i < count; ++i) computeDepth(i);
        std::stable_sort(_order.begin(), _order.begin() + count,
            [this](uint32_t a, uint32_t b) { return _depth[a] < _depth[b]; });
        _hierarchyDirty = false;
    }

private:
    std::vector<uint32_t> _order;
    std::vector<int32_t>  _depth;
    std::vector<uint64_t> _sortKeys;
    std::vector<uint8_t>  _recomputed;
    std::vector<uint8_t>  _visibleBit;    // persistent frustum-visibility bit per entity (Standard cull)
    std::vector<uint32_t> _visiblePrev;   // last frame's visibleId (same cull order) for the sameLayout check
    std::vector<int32_t>  _entitySlot;    // entity -> its row in instanceWorld (-1 = not visible)
    std::vector<uint32_t> _dirtySlots;    // rows patched this frame (when listRebuilt == 0)
    Bvh _bvh;
    bool _hierarchyDirty = true;
    bool _bvhDirty = true;
    bool _meshLayoutDirty = false;
    bool _lastSortByMesh = true;
    bool _visibleBitValid = false;   // _visibleBit reflects the current frustum (Standard path only)
    CullStrategy _lastStrat = CullStrategy::Standard;
    uint32_t _prevCount = 0;
    Mat4 _lastViewProj{};
    bool _hasLastViewProj = false;

public:
    int32_t dirtySlotsPtr() { return (int32_t)(intptr_t)_dirtySlots.data(); }
    uint32_t dirtySlotCount() { return (uint32_t)_dirtySlots.size(); }
private:

public:
    // ---- spatial queries (BVH-accelerated; build/refit happens in evaluate()
    //      when CullStrategy::Bvh is used, or call ensureSpatialIndex()) ----
    void ensureSpatialIndex() {
        if (_bvhDirty || _bvh.empty()) { _bvh.build(worldMin.data(), worldMax.data(), count); _bvhDirty = false; }
    }
    const Bvh& bvh() const { return _bvh; }

    // Closest entity whose world AABB the ray hits. Returns UINT32_MAX if none.
    // `d` need not be normalised; `outT` is the hit distance along `d`.
    uint32_t raycast(Vec3 o, Vec3 d, float maxT, float& outT) {
        ensureSpatialIndex();
        outT = maxT;
        uint32_t hit = UINT32_MAX;
        const Vec3 inv{1.0f / d.x, 1.0f / d.y, 1.0f / d.z};
        _bvh.raycastLeaves(o, d, maxT, [&](uint32_t e) {
            if (!(flags[e] & F_ENABLED)) return;
            float t;
            if (raySlab(o, inv, worldMin[e], worldMax[e], outT, t) && t < outT) { outT = t; hit = e; }
        });
        return hit;
    }

    // Entity slots whose world AABB overlaps the query box. Appends to `out`.
    void queryBox(Vec3 qmin, Vec3 qmax, std::vector<uint32_t>& out) {
        ensureSpatialIndex();
        _bvh.queryBox(qmin, qmax, [&](uint32_t e) {
            if (!(flags[e] & F_ENABLED)) return;
            const Vec3 a = worldMin[e], b = worldMax[e];
            if (a.x <= qmax.x && b.x >= qmin.x && a.y <= qmax.y && b.y >= qmin.y && a.z <= qmax.z && b.z >= qmin.z)
                out.push_back(e);
        });
    }

private:
    static bool raySlab(Vec3 o, Vec3 inv, Vec3 mn, Vec3 mx, float maxT, float& tHit) {
        float t0 = (mn.x - o.x) * inv.x, t1 = (mx.x - o.x) * inv.x;
        float tmin = t0 < t1 ? t0 : t1, tmax = t0 > t1 ? t0 : t1;
        t0 = (mn.y - o.y) * inv.y; t1 = (mx.y - o.y) * inv.y;
        tmin = std::max(tmin, t0 < t1 ? t0 : t1); tmax = std::min(tmax, t0 > t1 ? t0 : t1);
        t0 = (mn.z - o.z) * inv.z; t1 = (mx.z - o.z) * inv.z;
        tmin = std::max(tmin, t0 < t1 ? t0 : t1); tmax = std::min(tmax, t0 > t1 ? t0 : t1);
        if (tmax < tmin || tmax < 0 || tmin > maxT) return false;
        tHit = tmin >= 0 ? tmin : 0;
        return true;
    }

    bool _cameraChanged(const Mat4& vp) {
        bool same = _hasLastViewProj;
        for (int i = 0; i < 16 && same; ++i) same = (_lastViewProj.m[i] == vp.m[i]);
        _lastViewProj = vp;
        _hasLastViewProj = true;
        return !same;
    }

    int32_t computeDepth(uint32_t i) {
        if (_depth[i] >= 0) return _depth[i];
        const int32_t p = parent[i];
        if (p < 0 || p >= static_cast<int32_t>(count)) return _depth[i] = 0;
        // guard against cycles: temporarily mark
        _depth[i] = 0;
        const int32_t d = computeDepth(static_cast<uint32_t>(p)) + 1;
        return _depth[i] = d;
    }

    static bool boxInFrustum(const Frustum& fr, Vec3 mn, Vec3 mx) {
        const Vec3 v[8] = {
            {mn.x, mn.y, mn.z}, {mx.x, mn.y, mn.z}, {mx.x, mx.y, mn.z}, {mn.x, mx.y, mn.z},
            {mn.x, mn.y, mx.z}, {mx.x, mn.y, mx.z}, {mx.x, mx.y, mx.z}, {mn.x, mx.y, mx.z},
        };
        for (int p = 0; p < 6; ++p) {
            bool canReturnFalse = true;
            for (int i = 0; i < 8; ++i)
                if (fr.planes[p].dotCoordinate(v[i]) >= 0) { canReturnFalse = false; break; }
            if (canReturnFalse) return false;
        }
        return true;
    }

    // visible order preserved; one batch per contiguous run of equal meshId
    void buildRunBatches() {
        const size_t n = visibleId.size();
        instanceWorld.resize(n);
        instanceMeshId.resize(n);
        _entitySlot.assign(count, -1);
        for (size_t k = 0; k < n; ++k) {
            const uint32_t e = visibleId[k];
            instanceWorld[k] = world[e];
            instanceMeshId[k] = meshId[e];
            _entitySlot[e] = (int32_t)k;
        }
        for (size_t k = 0; k < n; ) {
            const uint32_t m = instanceMeshId[k];
            size_t j = k;
            while (j < n && instanceMeshId[j] == m) ++j;
            batches.push_back({m, static_cast<uint32_t>(k), static_cast<uint32_t>(j - k)});
            k = j;
        }
    }

    // counting-sort visible entities by meshId → minimal draw calls
    void buildSortedBatches() {
        const size_t n = visibleId.size();
        instanceWorld.resize(n);
        instanceMeshId.resize(n);
        _entitySlot.assign(count, -1);
        if (n == 0) return;

        uint32_t maxMesh = 0;
        for (size_t k = 0; k < n; ++k) maxMesh = std::max(maxMesh, meshId[visibleId[k]]);
        _hist.assign(maxMesh + 2, 0);
        for (size_t k = 0; k < n; ++k) _hist[meshId[visibleId[k]] + 1]++;
        for (uint32_t m = 0; m <= maxMesh; ++m) _hist[m + 1] += _hist[m];
        // _hist[m] = start offset for meshId m
        for (size_t k = 0; k < n; ++k) {
            const uint32_t e = visibleId[k];
            const uint32_t slot = _hist[meshId[e]]++;
            instanceWorld[slot] = world[e];
            instanceMeshId[slot] = meshId[e];
            _entitySlot[e] = (int32_t)slot;
        }
        // rebuild batches from the (now sorted) instanceMeshId
        for (size_t k = 0; k < n; ) {
            const uint32_t m = instanceMeshId[k];
            size_t j = k;
            while (j < n && instanceMeshId[j] == m) ++j;
            batches.push_back({m, static_cast<uint32_t>(k), static_cast<uint32_t>(j - k)});
            k = j;
        }
    }
    std::vector<uint32_t> _hist;

    // ---- GPU-driven path: durable bucket layout (rebuilt only on meshId edits) ----
    // Every entity gets a slot; bucket b covers entities [_gpuBucketOffset[b],
    // _gpuBucketOffset[b+1]) and holds meshId _gpuBucketMesh[b]. The compute
    // shader compacts visible entity ids into the front of each bucket.
    std::vector<uint32_t> _gpuBucketMesh;    // distinct meshIds, ascending  (= draw order)
    std::vector<uint32_t> _gpuBucketOffset;  // size numBuckets+1, cumulative
    std::vector<uint32_t> _gpuEntityBucket;  // per entity → bucket index
    std::vector<uint32_t> _gpuBuckets;       // scratch histogram, also the "built" flag
    uint32_t _gpuLayoutRebuilt = 0;          // 1 = buildGpuBuckets() ran this frame → renderer re-uploads per-entity buffers

    void buildGpuBuckets() {
        _gpuBucketMesh.clear();
        _gpuBucketOffset.clear();
        _gpuEntityBucket.assign(count, 0);
        if (count == 0) { _gpuBuckets.assign(1, 0); return; }

        uint32_t maxMesh = 0;
        for (uint32_t i = 0; i < count; ++i) maxMesh = std::max(maxMesh, meshId[i]);
        _gpuBuckets.assign(maxMesh + 2, 0);
        for (uint32_t i = 0; i < count; ++i) _gpuBuckets[meshId[i] + 1]++;

        // meshId → bucket index, and cumulative offsets
        std::vector<int32_t> meshToBucket(maxMesh + 1, -1);
        uint32_t off = 0;
        _gpuBucketOffset.push_back(0);
        for (uint32_t m = 0; m <= maxMesh; ++m) {
            const uint32_t n = _gpuBuckets[m + 1];
            if (n == 0) continue;
            meshToBucket[m] = (int32_t)_gpuBucketMesh.size();
            _gpuBucketMesh.push_back(m);
            off += n;
            _gpuBucketOffset.push_back(off);
        }
        for (uint32_t i = 0; i < count; ++i)
            _gpuEntityBucket[i] = (uint32_t)meshToBucket[meshId[i]];
    }

public:
    uint32_t gpuBucketCount() const { return (uint32_t)_gpuBucketMesh.size(); }
    const uint32_t* gpuBucketMeshData() const { return _gpuBucketMesh.data(); }
    const uint32_t* gpuBucketOffsetData() const { return _gpuBucketOffset.data(); }
    const uint32_t* gpuEntityBucketData() const { return _gpuEntityBucket.data(); }
    const uint8_t*  recomputedData() const { return _recomputed.data(); }
    uint32_t gpuLayoutRebuilt() const { return _gpuLayoutRebuilt; }
};

} // namespace bcpp
