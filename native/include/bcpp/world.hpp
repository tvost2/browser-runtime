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
#include <vector>
#include <cstdint>
#include <algorithm>

namespace bcpp {

enum class CullStrategy : uint32_t { Standard = 0, BoundingSphereOnly = 1, None = 2 };

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
    void markHierarchyDirty() { _hierarchyDirty = true; }
    void markDirty(uint32_t i) { if (i < dirty.size()) dirty[i] = 1; }
    void markAllDirty() { std::fill(dirty.begin(), dirty.begin() + std::min<size_t>(count, dirty.size()), 1); }

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

        // --- fast path: nothing moved and the camera is unchanged → reuse last
        //     frame's render list verbatim (renderer can skip the GPU re-upload) ---
        if (recomputed == 0 && !camMoved && !structChanged) {
            stats.frameChanged = 0;
            stats.visible = prevVisible;
            stats.batches = static_cast<uint32_t>(batches.size());
            stats.traversed = 0;
            return;
        }

        // --- cull pass: visits every entity, cheap per-entity ---
        const Frustum fr = Frustum::fromViewProj(viewProj);
        visibleId.clear();
        for (uint32_t k = 0; k < count; ++k) {
            const uint32_t i = _order[k];
            stats.traversed++;
            const uint32_t fl = flags[i];
            if (!(fl & F_ENABLED) || !(fl & F_VISIBLE)) { stats.culledDisabled++; continue; }
            if (strat != CullStrategy::None && !(fl & F_ALWAYS_ACTIVE)) {
                const Vec4 s = worldSphere[i];
                const Vec3 center{s.x, s.y, s.z};
                bool inside = true;
                for (int pl = 0; pl < 6; ++pl)
                    if (fr.planes[pl].dotCoordinate(center) <= -s.w) { inside = false; break; }
                if (inside && strat == CullStrategy::Standard)
                    inside = boxInFrustum(fr, worldMin[i], worldMax[i]);
                if (!inside) { stats.culledFrustum++; continue; }
            }
            visibleId.push_back(i);
        }
        stats.visible = static_cast<uint32_t>(visibleId.size());

        // pass 2: build the batched render list
        instanceWorld.clear();
        instanceMeshId.clear();
        batches.clear();
        if (sortByMesh) buildSortedBatches();
        else            buildRunBatches();
        stats.batches = static_cast<uint32_t>(batches.size());
    }

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
    bool _hierarchyDirty = true;
    uint32_t _prevCount = 0;
    Mat4 _lastViewProj{};
    bool _hasLastViewProj = false;

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
        for (size_t k = 0; k < n; ++k) {
            const uint32_t e = visibleId[k];
            instanceWorld[k] = world[e];
            instanceMeshId[k] = meshId[e];
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
};

} // namespace bcpp
