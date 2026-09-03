// Equivalence: incremental transform evaluation vs full recompute.
//
// The whole point of dirty tracking is that World::evaluate() must produce the
// EXACT same world matrices / visible set as a from-scratch recompute — it just
// skips the work for subtrees that didn't move. This test drives a deterministic
// hierarchy through random edits and asserts:
//   * only the moved subtree is recomputed (transformsRecomputed is exact)
//   * every world matrix is bit-identical to a full markAllDirty() recompute
//   * the visible set matches
//   * frameChanged is 0 iff nothing moved and the camera is unchanged
//   * resize() preserves existing entity data across a capacity growth
//
//   ./test_incremental

#include "bcpp/world.hpp"
#include <cstdio>
#include <cstring>
#include <vector>
#include <set>

using namespace bcpp;

static int fails = 0;
static void check(bool ok, const char* msg) {
    if (!ok) { std::printf("  FAIL %s\n", msg); fails++; }
}

// a viewProj that keeps ~half the scene visible (matches run-scale.mjs)
static Mat4 makeVP() {
    Mat4 vp;
    float m[16] = {1.2f,0,0,0, 0,2.1f,0,0, 0,0,1.001f,1, 0,0,-0.5f,0};
    std::memcpy(vp.m.data(), m, sizeof m);
    return vp;
}

static uint32_t rngState = 0x2545F491;
static float frand() { rngState = rngState * 1664525u + 1013904223u; return (rngState >> 8) / 16777216.0f; }

struct Snapshot { std::vector<Mat4> world; std::vector<uint32_t> visible; };
static Snapshot snap(World& w) {
    Snapshot s;
    s.world.assign(w.world.begin(), w.world.begin() + w.count);
    s.visible = w.visibleId;
    return s;
}
static bool mat_eq(const Mat4& a, const Mat4& b) {
    for (int i = 0; i < 16; ++i) if (a.m[i] != b.m[i]) return false;
    return true;
}
static bool worlds_eq(const std::vector<Mat4>& a, const std::vector<Mat4>& b) {
    if (a.size() != b.size()) return false;
    for (size_t i = 0; i < a.size(); ++i) if (!mat_eq(a[i], b[i])) return false;
    return true;
}

int main() {
    const uint32_t N = 5000;
    World w;
    w.resize(N);

    // deterministic forest: ~60% of nodes have a parent with a lower index
    std::vector<uint32_t> childCount(N, 0);
    for (uint32_t i = 0; i < N; ++i) {
        w.parent[i] = (i > 0 && frand() < 0.6f) ? (int32_t)(frand() * i) : -1;
        if (w.parent[i] >= 0) childCount[w.parent[i]]++;
        w.localPos[i] = {(frand() - 0.5f) * 400, (frand() - 0.5f) * 400, frand() * 600 + 40};
        w.localRot[i] = Quat::fromEulerYXZ(frand() * 3.0f, frand() * 6.28f, frand());
        float sc = 0.4f + frand() * 1.2f;
        w.localScale[i] = {sc, sc, sc};
        w.localMin[i] = {-0.5f, -0.5f, -0.5f};
        w.localMax[i] = {0.5f, 0.5f, 0.5f};
        w.meshId[i] = i % 5;
    }
    w.markHierarchyDirty();
    const Mat4 vp = makeVP();

    // ---- 1. first eval recomputes everything ----
    w.evaluate(vp, CullStrategy::Standard, true);
    check(w.stats.transformsRecomputed == N, "first eval recomputes all N");
    check(w.stats.frameChanged == 1, "first eval frameChanged=1");
    Snapshot full0 = snap(w);
    const uint32_t vis0 = w.stats.visible;
    std::printf("  scene: %u entities, %u visible\n", N, vis0);

    // ---- 2. determinism: markAllDirty + eval → identical ----
    w.markAllDirty();
    w.evaluate(vp, CullStrategy::Standard, false);
    check(w.stats.transformsRecomputed == N, "markAllDirty recomputes all N");
    check(worlds_eq(snap(w).world, full0.world), "recompute is deterministic (matrices identical)");

    // ---- 3. nothing moved, camera unchanged → frameChanged=0, 0 recomputed ----
    w.evaluate(vp, CullStrategy::Standard, false);
    check(w.stats.transformsRecomputed == 0, "static frame recomputes nothing");
    check(w.stats.frameChanged == 0, "static frame + same camera → frameChanged=0");

    // ---- 4. camera moves, nothing else → 0 recomputed, visible set still right ----
    Mat4 vp2 = vp; vp2.m[12] += 5.0f;
    w.evaluate(vp2, CullStrategy::Standard, false);
    check(w.stats.transformsRecomputed == 0, "camera-only frame recomputes no transforms");
    check(w.stats.frameChanged == 1, "camera-only frame → frameChanged=1");
    // back to original camera for the rest
    w.evaluate(vp, CullStrategy::Standard, false);

    // ---- 5. move one leaf → exactly 1 recompute ----
    uint32_t leaf = N - 1;
    while (childCount[leaf] != 0 && leaf > 0) leaf--;
    w.localPos[leaf].x += 10.0f;
    w.markDirty(leaf);
    w.evaluate(vp, CullStrategy::Standard, false);
    check(w.stats.transformsRecomputed == 1, "moving a leaf recomputes exactly 1");

    // ---- 6. move a root with descendants → whole subtree recomputes, and the
    //        result equals a full from-scratch recompute ----
    uint32_t root = 0;
    for (uint32_t i = 0; i < N; ++i) if (w.parent[i] == -1 && childCount[i] >= 3) { root = i; break; }
    w.localPos[root].y += 25.0f;
    w.localScale[root] = {1.3f, 1.3f, 1.3f};
    w.markDirty(root);
    w.evaluate(vp, CullStrategy::Standard, false);
    const uint32_t incRecomp = w.stats.transformsRecomputed;
    Snapshot inc = snap(w);

    // count the true subtree size of `root`
    std::vector<uint8_t> inSub(N, 0); inSub[root] = 1;
    uint32_t subSize = 1;
    for (uint32_t i = 0; i < N; ++i) { int32_t p = w.parent[i]; if (p >= 0 && inSub[p] && !inSub[i]) { inSub[i] = 1; subSize++; } }
    check(incRecomp == subSize, "moving a root recomputes exactly its subtree");

    w.markAllDirty();
    w.evaluate(vp, CullStrategy::Standard, false);
    check(worlds_eq(inc.world, snap(w).world), "incremental subtree move == full recompute");
    check(inc.visible == w.visibleId, "incremental visible set == full recompute");

    // ---- 7. 200 random edits, incremental must always match full recompute ----
    World ref;   // shadow world that always does a full recompute
    ref.resize(N);
    ref.parent = w.parent; ref.localMin = w.localMin; ref.localMax = w.localMax; ref.meshId = w.meshId;
    ref.localPos = w.localPos; ref.localRot = w.localRot; ref.localScale = w.localScale;
    ref.markHierarchyDirty();
    ref.evaluate(vp, CullStrategy::Standard, true);

    int mismatch = 0, listMismatch = 0, patched = 0;
    auto instEq = [](World& a, World& b) {
        if (a.instanceWorld.size() != b.instanceWorld.size()) return false;
        for (size_t i = 0; i < a.instanceWorld.size(); ++i) if (!mat_eq(a.instanceWorld[i], b.instanceWorld[i])) return false;
        if (a.instanceMeshId != b.instanceMeshId) return false;
        if (a.batches.size() != b.batches.size()) return false;
        for (size_t i = 0; i < a.batches.size(); ++i)
            if (a.batches[i].meshId != b.batches[i].meshId || a.batches[i].firstInstance != b.batches[i].firstInstance
                || a.batches[i].instanceCount != b.batches[i].instanceCount) return false;
        return true;
    };
    for (int iter = 0; iter < 200; ++iter) {
        uint32_t k = (uint32_t)(frand() * N);
        w.localPos[k].z += (frand() - 0.5f) * 4.0f;
        w.markDirty(k);
        ref.localPos[k].z = w.localPos[k].z;
        ref.markAllDirty();

        w.evaluate(vp, CullStrategy::Standard, true);   // sortByMesh — exercise the counting-sort slot map
        ref.evaluate(vp, CullStrategy::Standard, true);
        if (!worlds_eq(snap(w).world, snap(ref).world)) mismatch++;
        if (w.visibleId != ref.visibleId) mismatch++;
        // the render list (matrices + batches) MUST match a full rebuild whether
        // it was patched in place or rebuilt
        if (!instEq(w, ref)) listMismatch++;
        if (w.stats.listRebuilt == 0) {
            patched++;
            // patch path: dirtySlots must be exactly the visible+recomputed rows
            if (w.stats.dirtySlots > w.stats.transformsRecomputed) listMismatch++;
        }
    }
    check(mismatch == 0, "200 random edits: incremental == full every frame");
    check(listMismatch == 0, "200 random edits: render list (matrices+batches) == full rebuild");
    check(patched > 100, "most frames patched the list in place (not rebuilt)");
    std::printf("  (%d/200 frames patched the render list in place)\n", patched);

    // ---- 7b. incremental cull: camera static, one entity moves out of frustum ----
    // pick a currently-visible entity, shove it far behind the camera, verify it
    // leaves the visible set and the list rebuilds
    {
        uint32_t vis = w.visibleId.empty() ? 0 : w.visibleId[w.visibleId.size() / 2];
        w.localPos[vis] = {0, 0, -9999};   // behind near plane
        w.markDirty(vis);
        w.evaluate(vp, CullStrategy::Standard, true);
        bool gone = std::find(w.visibleId.begin(), w.visibleId.end(), vis) == w.visibleId.end();
        check(gone, "entity moved behind camera leaves the visible set (incremental cull)");
        // and a full re-cull agrees
        ref.localPos[vis] = w.localPos[vis]; ref.markAllDirty();
        ref.evaluate(vp, CullStrategy::Standard, true);
        check(w.visibleId == ref.visibleId, "incremental cull set == full re-cull after the move");
    }

    // ---- 7c. camera pan after incremental frames == from-scratch ----
    {
        Mat4 vpc = vp; vpc.m[12] += 30; vpc.m[13] -= 12;
        w.evaluate(vpc, CullStrategy::Standard, true);
        check(w.stats.listRebuilt == 1, "camera move forces a list rebuild");
        World fresh; fresh.resize(N);
        fresh.parent = w.parent; fresh.localPos = w.localPos; fresh.localRot = w.localRot; fresh.localScale = w.localScale;
        fresh.localMin = w.localMin; fresh.localMax = w.localMax; fresh.flags = w.flags; fresh.meshId = w.meshId;
        fresh.markHierarchyDirty();
        fresh.evaluate(vpc, CullStrategy::Standard, true);
        check(w.visibleId == fresh.visibleId, "camera-pan visible set == from-scratch");
        check(instEq(w, fresh), "camera-pan render list == from-scratch");
    }

    // ---- 7d. visibility toggle invalidates the list ----
    {
        uint32_t e = w.visibleId.empty() ? 0 : w.visibleId[0];
        w.flags[e] &= ~F_VISIBLE;
        w.markDirty(e); w.markMeshLayoutDirty();
        w.evaluate(vp, CullStrategy::Standard, true);
        bool hidden = std::find(w.visibleId.begin(), w.visibleId.end(), e) == w.visibleId.end();
        check(hidden, "clearing F_VISIBLE removes the entity next frame");
        w.flags[e] |= F_VISIBLE;
        w.markDirty(e); w.markMeshLayoutDirty();
        w.evaluate(vp, CullStrategy::Standard, true);
        bool back = std::find(w.visibleId.begin(), w.visibleId.end(), e) != w.visibleId.end();
        check(back, "restoring F_VISIBLE brings it back");
    }

    // ---- 8. resize() preserves data across a capacity growth ----
    World g;
    g.resize(300);
    for (uint32_t i = 0; i < 300; ++i) g.localPos[i] = {(float)i, (float)i * 2, (float)i * 3};
    g.resize(900);            // grow
    bool preserved = true;
    for (uint32_t i = 0; i < 300; ++i)
        if (g.localPos[i].x != (float)i || g.localPos[i].y != (float)i * 2 || g.localPos[i].z != (float)i * 3) { preserved = false; break; }
    check(preserved, "resize() preserves existing entity data on growth");

    std::printf("test_incremental: %s\n", fails ? "FAIL" : "OK");
    return fails ? 1 : 0;
}
