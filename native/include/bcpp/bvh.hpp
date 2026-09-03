// bcpp/bvh.hpp — a flat, refittable bounding-volume hierarchy over the world-
// space AABBs the World already computes. Sub-linear frustum culling + ray and
// box queries, built and traversed entirely in C++.
//
// Layout (Bikker-style): one contiguous node array. A node is internal when
// `count == 0` (children at `leftFirst`, `leftFirst + 1`, always > this index)
// or a leaf when `count > 0` (`prim[leftFirst .. leftFirst+count)`). `prim` is a
// permutation of entity slots produced by build().
//
// build(): binned SAH, iterative (explicit stack — WASM has a small C stack).
// refit(): bottom-up AABB update, O(nodes), no repartition — call it when
//          entities moved but the topology is unchanged.

#pragma once
#include "math.hpp"
#include <vector>
#include <cstdint>
#include <cmath>
#include <algorithm>
#include <functional>

namespace bcpp {

struct BvhNode {
    float min[3];
    float max[3];
    uint32_t leftFirst;   // internal: left child index; leaf: first prim index
    uint32_t count;       // 0 = internal, >0 = leaf prim count
};
static_assert(sizeof(BvhNode) == 32, "BvhNode must be 32 bytes");

class Bvh {
public:
    std::vector<BvhNode> nodes;
    std::vector<uint32_t> prim;         // entity slots, reordered
    std::vector<uint32_t> entityLeaf;   // entity slot -> index of the leaf node holding it
    std::vector<uint32_t> nodeParent;   // node -> parent node (root -> itself)
    uint32_t nodeCount = 0;
    uint32_t leafSize = 8;

    bool empty() const { return nodeCount == 0; }

    // Build over entity slots [0, n). `wmin`/`wmax` are per-entity world AABBs.
    void build(const Vec3* wmin, const Vec3* wmax, uint32_t n) {
        prim.resize(n);
        for (uint32_t i = 0; i < n; ++i) prim[i] = i;
        nodes.assign(n > 0 ? (2 * n) : 1, BvhNode{});
        nodeCount = 0;
        if (n == 0) { nodeCount = 1; nodes[0] = {{0,0,0},{0,0,0},0,0}; return; }

        // precompute centroids
        _cx.resize(n); _cy.resize(n); _cz.resize(n);
        for (uint32_t i = 0; i < n; ++i) {
            _cx[i] = 0.5f * (wmin[i].x + wmax[i].x);
            _cy[i] = 0.5f * (wmin[i].y + wmax[i].y);
            _cz[i] = 0.5f * (wmin[i].z + wmax[i].z);
        }

        nodeParent.assign(nodes.size(), 0);
        entityLeaf.assign(n, 0);

        const uint32_t root = nodeCount++;
        nodes[root].leftFirst = 0;
        nodes[root].count = n;
        nodeParent[root] = root;
        computeBounds(root, wmin, wmax);

        // explicit work stack of node indices to try to split
        _stack.clear();
        _stack.push_back(root);
        while (!_stack.empty()) {
            const uint32_t ni = _stack.back(); _stack.pop_back();
            BvhNode& node = nodes[ni];
            if (node.count <= leafSize) continue;

            int axis; float split; float cost;
            if (!bestSplit(node, wmin, wmax, axis, split, cost)) continue;
            // don't split if SAH says a leaf is cheaper
            const float leafCost = surfaceArea(node) * node.count;
            if (cost >= leafCost) continue;

            // partition prim[first .. first+count) by centroid on `axis`
            const uint32_t first = node.leftFirst, cnt = node.count;
            uint32_t i = first, j = first + cnt;
            const std::vector<float>& C = (axis == 0) ? _cx : (axis == 1) ? _cy : _cz;
            while (i < j) {
                if (C[prim[i]] < split) ++i;
                else { --j; uint32_t t = prim[i]; prim[i] = prim[j]; prim[j] = t; }
            }
            uint32_t leftCount = i - first;
            if (leftCount == 0 || leftCount == cnt) { leftCount = cnt / 2; } // degenerate → median count

            const uint32_t li = nodeCount++, ri = nodeCount++;
            nodes[li].leftFirst = first;             nodes[li].count = leftCount;
            nodes[ri].leftFirst = first + leftCount; nodes[ri].count = cnt - leftCount;
            nodeParent[li] = ni; nodeParent[ri] = ni;
            node.leftFirst = li;
            node.count = 0;
            computeBounds(li, wmin, wmax);
            computeBounds(ri, wmin, wmax);
            _stack.push_back(li);
            _stack.push_back(ri);
        }
        // entity -> leaf map (every remaining leaf)
        for (uint32_t ni = 0; ni < nodeCount; ++ni)
            if (nodes[ni].count > 0)
                for (uint32_t k = 0; k < nodes[ni].count; ++k) entityLeaf[prim[nodes[ni].leftFirst + k]] = ni;
    }

    // Incremental refit: update only the leaves that contain a moved entity
    // (recomputed[e] != 0) and their ancestors. O(moved * treeDepth).
    void refitDirty(const uint8_t* recomputed, uint32_t n, const Vec3* wmin, const Vec3* wmax) {
        if (nodeCount == 0) return;
        if (_stamp.size() < nodeCount) _stamp.assign(nodeCount, 0);
        ++_gen;
        _touched.clear();
        for (uint32_t e = 0; e < n && e < entityLeaf.size(); ++e) {
            if (!recomputed[e]) continue;
            uint32_t ni = entityLeaf[e];
            while (true) {
                if (_stamp[ni] == _gen) break;
                _stamp[ni] = _gen;
                _touched.push_back(ni);
                if (ni == nodeParent[ni]) break;   // root
                ni = nodeParent[ni];
            }
        }
        // deepest first → children updated before parents
        std::sort(_touched.begin(), _touched.end(), std::greater<uint32_t>());
        for (uint32_t ni : _touched) {
            BvhNode& node = nodes[ni];
            if (node.count > 0) computeBounds(ni, wmin, wmax);
            else {
                const BvhNode& L = nodes[node.leftFirst];
                const BvhNode& R = nodes[node.leftFirst + 1];
                for (int k = 0; k < 3; ++k) {
                    node.min[k] = L.min[k] < R.min[k] ? L.min[k] : R.min[k];
                    node.max[k] = L.max[k] > R.max[k] ? L.max[k] : R.max[k];
                }
            }
        }
    }

    // Update every node's AABB from current entity positions without repartition.
    void refit(const Vec3* wmin, const Vec3* wmax) {
        if (nodeCount == 0) return;
        for (int32_t i = (int32_t)nodeCount - 1; i >= 0; --i) {
            BvhNode& node = nodes[i];
            if (node.count > 0) { computeBounds((uint32_t)i, wmin, wmax); }
            else {
                const BvhNode& L = nodes[node.leftFirst];
                const BvhNode& R = nodes[node.leftFirst + 1];
                for (int k = 0; k < 3; ++k) {
                    node.min[k] = L.min[k] < R.min[k] ? L.min[k] : R.min[k];
                    node.max[k] = L.max[k] > R.max[k] ? L.max[k] : R.max[k];
                }
            }
        }
    }

    // Frustum cull: calls visit(entitySlot, fullyInside) for every prim in a
    // node that isn't fully outside. `fullyInside` lets the caller skip the
    // precise per-entity test. Prunes whole subtrees.
    template <class Visit>
    void frustumCull(const Frustum& fr, Visit&& visit) const {
        if (nodeCount == 0) return;
        _tstack.clear();
        _tstack.push_back(0);
        while (!_tstack.empty()) {
            const uint32_t ni = _tstack.back(); _tstack.pop_back();
            const BvhNode& node = nodes[ni];
            const int cls = classifyBox(fr, node.min, node.max);
            if (cls < 0) continue;                       // fully outside → prune
            const bool fullyInside = (cls > 0);
            if (node.count > 0) {
                for (uint32_t k = 0; k < node.count; ++k) visit(prim[node.leftFirst + k], fullyInside);
            } else {
                _tstack.push_back(node.leftFirst);
                _tstack.push_back(node.leftFirst + 1);
            }
        }
    }

    // Visit every entity slot whose leaf node the ray could hit (node-AABB slab
    // test prunes subtrees). The caller does the precise per-entity AABB/geometry
    // test — it owns those arrays. `d` need not be normalised.
    template <class Visit>
    void raycastLeaves(Vec3 o, Vec3 d, float maxT, Visit&& visit) const {
        if (nodeCount == 0) return;
        const Vec3 inv{ 1.0f / d.x, 1.0f / d.y, 1.0f / d.z };
        _tstack.clear();
        _tstack.push_back(0);
        while (!_tstack.empty()) {
            const uint32_t ni = _tstack.back(); _tstack.pop_back();
            const BvhNode& node = nodes[ni];
            if (!slab(o, inv, node.min, node.max, maxT)) continue;
            if (node.count > 0) { for (uint32_t k = 0; k < node.count; ++k) visit(prim[node.leftFirst + k]); }
            else { _tstack.push_back(node.leftFirst); _tstack.push_back(node.leftFirst + 1); }
        }
    }

    // Collect entity slots whose leaf node overlaps [qmin, qmax].
    template <class Emit>
    void queryBox(Vec3 qmin, Vec3 qmax, Emit&& emit) const {
        if (nodeCount == 0) return;
        _tstack.clear();
        _tstack.push_back(0);
        while (!_tstack.empty()) {
            const uint32_t ni = _tstack.back(); _tstack.pop_back();
            const BvhNode& node = nodes[ni];
            if (node.max[0] < qmin.x || node.min[0] > qmax.x ||
                node.max[1] < qmin.y || node.min[1] > qmax.y ||
                node.max[2] < qmin.z || node.min[2] > qmax.z) continue;
            if (node.count > 0) for (uint32_t k = 0; k < node.count; ++k) emit(prim[node.leftFirst + k]);
            else { _tstack.push_back(node.leftFirst); _tstack.push_back(node.leftFirst + 1); }
        }
    }

private:
    std::vector<float> _cx, _cy, _cz;
    std::vector<uint32_t> _stack;
    std::vector<uint32_t> _touched;
    std::vector<uint32_t> _stamp;
    uint32_t _gen = 0;
    mutable std::vector<uint32_t> _tstack;

    void computeBounds(uint32_t ni, const Vec3* wmin, const Vec3* wmax) {
        BvhNode& node = nodes[ni];
        float mn[3] = {1e30f, 1e30f, 1e30f}, mx[3] = {-1e30f, -1e30f, -1e30f};
        for (uint32_t k = 0; k < node.count; ++k) {
            const uint32_t e = prim[node.leftFirst + k];
            const Vec3 a = wmin[e], b = wmax[e];
            mn[0] = mn[0] < a.x ? mn[0] : a.x; mn[1] = mn[1] < a.y ? mn[1] : a.y; mn[2] = mn[2] < a.z ? mn[2] : a.z;
            mx[0] = mx[0] > b.x ? mx[0] : b.x; mx[1] = mx[1] > b.y ? mx[1] : b.y; mx[2] = mx[2] > b.z ? mx[2] : b.z;
        }
        for (int k = 0; k < 3; ++k) { node.min[k] = mn[k]; node.max[k] = mx[k]; }
    }

    static float surfaceArea(const BvhNode& n) {
        const float ex = n.max[0] - n.min[0], ey = n.max[1] - n.min[1], ez = n.max[2] - n.min[2];
        return (ex < 0 ? 0 : ex * ey + ey * ez + ez * ex);
    }

    // 12-bin SAH on the widest axis; returns split plane + cost estimate.
    bool bestSplit(const BvhNode& node, const Vec3* wmin, const Vec3* wmax,
                   int& outAxis, float& outSplit, float& outCost) {
        const uint32_t first = node.leftFirst, cnt = node.count;
        outCost = 1e30f;
        outAxis = 0;
        bool found = false;
        for (int axis = 0; axis < 3; ++axis) {
            const std::vector<float>& C = (axis == 0) ? _cx : (axis == 1) ? _cy : _cz;
            float cmn = 1e30f, cmx = -1e30f;
            for (uint32_t k = 0; k < cnt; ++k) { float c = C[prim[first + k]]; cmn = c < cmn ? c : cmn; cmx = c > cmx ? c : cmx; }
            if (cmx - cmn < 1e-6f) continue;

            constexpr int BINS = 12;
            float bMin[BINS][3], bMax[BINS][3]; uint32_t bCnt[BINS] = {};
            for (int b = 0; b < BINS; ++b) { for (int k = 0; k < 3; ++k) { bMin[b][k] = 1e30f; bMax[b][k] = -1e30f; } }
            const float scale = BINS / (cmx - cmn);
            for (uint32_t k = 0; k < cnt; ++k) {
                const uint32_t e = prim[first + k];
                int b = (int)((C[e] - cmn) * scale); if (b < 0) b = 0; if (b >= BINS) b = BINS - 1;
                bCnt[b]++;
                const Vec3 lo = wmin[e], hi = wmax[e];
                bMin[b][0] = bMin[b][0] < lo.x ? bMin[b][0] : lo.x; bMin[b][1] = bMin[b][1] < lo.y ? bMin[b][1] : lo.y; bMin[b][2] = bMin[b][2] < lo.z ? bMin[b][2] : lo.z;
                bMax[b][0] = bMax[b][0] > hi.x ? bMax[b][0] : hi.x; bMax[b][1] = bMax[b][1] > hi.y ? bMax[b][1] : hi.y; bMax[b][2] = bMax[b][2] > hi.z ? bMax[b][2] : hi.z;
            }
            // sweep
            float leftArea[BINS - 1], rightArea[BINS - 1];
            uint32_t leftCnt[BINS - 1], rightCnt[BINS - 1];
            float lMn[3] = {1e30f,1e30f,1e30f}, lMx[3] = {-1e30f,-1e30f,-1e30f}; uint32_t lc = 0;
            for (int b = 0; b < BINS - 1; ++b) {
                lc += bCnt[b];
                for (int k = 0; k < 3; ++k) { lMn[k] = lMn[k] < bMin[b][k] ? lMn[k] : bMin[b][k]; lMx[k] = lMx[k] > bMax[b][k] ? lMx[k] : bMax[b][k]; }
                leftCnt[b] = lc;
                const float ex = lMx[0]-lMn[0], ey = lMx[1]-lMn[1], ez = lMx[2]-lMn[2];
                leftArea[b] = (lc == 0) ? 0 : (ex*ey + ey*ez + ez*ex);
            }
            float rMn[3] = {1e30f,1e30f,1e30f}, rMx[3] = {-1e30f,-1e30f,-1e30f}; uint32_t rc = 0;
            for (int b = BINS - 1; b >= 1; --b) {
                rc += bCnt[b];
                for (int k = 0; k < 3; ++k) { rMn[k] = rMn[k] < bMin[b][k] ? rMn[k] : bMin[b][k]; rMx[k] = rMx[k] > bMax[b][k] ? rMx[k] : bMax[b][k]; }
                rightCnt[b - 1] = rc;
                const float ex = rMx[0]-rMn[0], ey = rMx[1]-rMn[1], ez = rMx[2]-rMn[2];
                rightArea[b - 1] = (rc == 0) ? 0 : (ex*ey + ey*ez + ez*ex);
            }
            const float binW = (cmx - cmn) / BINS;
            for (int b = 0; b < BINS - 1; ++b) {
                const float c = leftArea[b] * leftCnt[b] + rightArea[b] * rightCnt[b];
                if (c < outCost) { outCost = c; outAxis = axis; outSplit = cmn + binW * (b + 1); found = true; }
            }
        }
        return found;
    }

    // -1 outside, 0 straddling, +1 fully inside
    static int classifyBox(const Frustum& fr, const float mn[3], const float mx[3]) {
        bool fully = true;
        for (int p = 0; p < 6; ++p) {
            const Plane& pl = fr.planes[p];
            // p-vertex (farthest along +normal) and n-vertex
            const Vec3 pv{ pl.normal.x >= 0 ? mx[0] : mn[0], pl.normal.y >= 0 ? mx[1] : mn[1], pl.normal.z >= 0 ? mx[2] : mn[2] };
            if (pl.dotCoordinate(pv) < 0) return -1;            // both vertices outside → box outside
            const Vec3 nv{ pl.normal.x >= 0 ? mn[0] : mx[0], pl.normal.y >= 0 ? mn[1] : mx[1], pl.normal.z >= 0 ? mn[2] : mx[2] };
            if (pl.dotCoordinate(nv) < 0) fully = false;
        }
        return fully ? 1 : 0;
    }

    static bool slab(Vec3 o, Vec3 inv, const float mn[3], const float mx[3], float maxT) {
        float t0 = (mn[0] - o.x) * inv.x, t1 = (mx[0] - o.x) * inv.x;
        float tmin = t0 < t1 ? t0 : t1, tmax = t0 > t1 ? t0 : t1;
        t0 = (mn[1] - o.y) * inv.y; t1 = (mx[1] - o.y) * inv.y;
        tmin = (t0 < t1 ? t0 : t1) > tmin ? (t0 < t1 ? t0 : t1) : tmin;
        tmax = (t0 > t1 ? t0 : t1) < tmax ? (t0 > t1 ? t0 : t1) : tmax;
        t0 = (mn[2] - o.z) * inv.z; t1 = (mx[2] - o.z) * inv.z;
        tmin = (t0 < t1 ? t0 : t1) > tmin ? (t0 < t1 ? t0 : t1) : tmin;
        tmax = (t0 > t1 ? t0 : t1) < tmax ? (t0 > t1 ? t0 : t1) : tmax;
        return tmax >= tmin && tmax >= 0 && tmin <= maxT;
    }
};

} // namespace bcpp
