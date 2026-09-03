// Equivalence + correctness: the BVH cull path and spatial queries.
//
//   * CullStrategy::Bvh must produce the SAME visible set as Standard (the BVH
//     only prunes — it must never drop a visible entity or add a culled one)
//   * this holds after build, after refit (entities moved), and across the
//     transform-dirty fast paths
//   * raycast() returns the nearest entity whose world AABB the ray actually hits
//   * queryBox() returns exactly the entities whose world AABB overlaps the box
//     (checked against a brute-force scan)
//
//   ./test_bvh

#include "bcpp/world.hpp"
#include <cstdio>
#include <cstring>
#include <vector>
#include <set>
#include <cmath>

using namespace bcpp;

static int fails = 0;
static void check(bool ok, const char* msg) { if (!ok) { std::printf("  FAIL %s\n", msg); fails++; } }

static uint32_t rs = 0x13572468;
static float fr() { rs = rs * 1664525u + 1013904223u; return (rs >> 8) / 16777216.0f; }

static Mat4 makeVP() {
    Mat4 vp; float m[16] = {1.2f,0,0,0, 0,2.1f,0,0, 0,0,1.001f,1, 0,0,-0.5f,0};
    std::memcpy(vp.m.data(), m, sizeof m); return vp;
}
static std::set<uint32_t> visSet(World& w) { return {w.visibleId.begin(), w.visibleId.end()}; }

int main() {
    const uint32_t N = 8000;
    World w;
    w.resize(N);
    for (uint32_t i = 0; i < N; ++i) {
        w.parent[i] = (i > 0 && fr() < 0.4f) ? (int32_t)(fr() * i) : -1;
        w.localPos[i] = {(fr() - 0.5f) * 600, (fr() - 0.5f) * 600, fr() * 800 + 30};
        w.localRot[i] = Quat::fromEulerYXZ(fr(), fr() * 6.28f, fr());
        float s = 0.5f + fr() * 2.0f;
        w.localScale[i] = {s, s, s};
        w.localMin[i] = {-0.5f, -0.5f, -0.5f};
        w.localMax[i] = {0.5f, 0.5f, 0.5f};
        w.flags[i] = (fr() < 0.03f) ? F_ENABLED : (F_ENABLED | F_VISIBLE); // ~3% hidden
        w.meshId[i] = i % 6;
    }
    w.markHierarchyDirty();
    const Mat4 vp = makeVP();

    // ---- 1. BVH visible set == Standard visible set (fresh build) ----
    w.markAllDirty();
    w.evaluate(vp, CullStrategy::Standard, true);
    auto stdSet = visSet(w);
    const uint32_t vis = w.stats.visible;
    w.markAllDirty();
    w.evaluate(vp, CullStrategy::Bvh, true);
    check(w.stats.bvhBuilds == 1, "first Bvh eval builds the tree");
    check(visSet(w) == stdSet, "Bvh visible set == Standard (fresh build)");
    std::printf("  %u entities, %u visible, %u bvh nodes\n", N, vis, w.stats.bvhNodes);

    // ---- 2. after a refit (some entities moved) ----
    for (uint32_t k = 0; k < 400; ++k) { uint32_t e = (uint32_t)(fr() * N); w.localPos[e].x += (fr() - 0.5f) * 50; w.markDirty(e); }
    w.evaluate(vp, CullStrategy::Bvh, true);
    check(w.stats.bvhBuilds == 0, "moving entities → refit, not rebuild");
    World ref; ref.resize(N);
    ref.parent = w.parent; ref.localPos = w.localPos; ref.localRot = w.localRot; ref.localScale = w.localScale;
    ref.localMin = w.localMin; ref.localMax = w.localMax; ref.flags = w.flags; ref.meshId = w.meshId;
    ref.markHierarchyDirty();
    ref.evaluate(vp, CullStrategy::Standard, true);
    check(visSet(w) == visSet(ref), "Bvh visible set == Standard (after refit)");

    // ---- 3. camera moves, geometry static → still matches ----
    Mat4 vp2 = vp; vp2.m[12] += 8; vp2.m[13] -= 3;
    w.evaluate(vp2, CullStrategy::Bvh, true);
    ref.markAllDirty();
    ref.evaluate(vp2, CullStrategy::Standard, true);
    check(visSet(w) == visSet(ref), "Bvh visible set == Standard (camera moved)");

    // ---- 4. 100 frames of random motion, sets must always agree ----
    int mismatch = 0;
    for (int iter = 0; iter < 100; ++iter) {
        for (int k = 0; k < 20; ++k) { uint32_t e = (uint32_t)(fr() * N); w.localPos[e].z += (fr() - 0.5f) * 8; w.markDirty(e); ref.localPos[e].z = w.localPos[e].z; }
        ref.markAllDirty();
        w.evaluate(vp, CullStrategy::Bvh, true);
        ref.evaluate(vp, CullStrategy::Standard, true);
        if (visSet(w) != visSet(ref)) mismatch++;
    }
    check(mismatch == 0, "100 frames random motion: Bvh set == Standard set");

    // ---- 5. queryBox vs brute force ----
    w.evaluate(vp, CullStrategy::Bvh, true);
    int qFail = 0;
    for (int q = 0; q < 40; ++q) {
        Vec3 c{(fr() - 0.5f) * 500, (fr() - 0.5f) * 500, fr() * 700};
        float h = 20 + fr() * 120;
        Vec3 qmn{c.x - h, c.y - h, c.z - h}, qmx{c.x + h, c.y + h, c.z + h};
        std::vector<uint32_t> got;
        w.queryBox(qmn, qmx, got);
        std::set<uint32_t> gotSet(got.begin(), got.end()), expSet;
        for (uint32_t e = 0; e < N; ++e) {
            if (!(w.flags[e] & F_ENABLED)) continue;
            Vec3 a = w.worldMin[e], b = w.worldMax[e];
            if (a.x <= qmx.x && b.x >= qmn.x && a.y <= qmx.y && b.y >= qmn.y && a.z <= qmx.z && b.z >= qmn.z) expSet.insert(e);
        }
        if (gotSet != expSet) qFail++;
    }
    check(qFail == 0, "queryBox matches brute-force scan (40 boxes)");

    // ---- 6. raycast: nearest AABB hit ----
    int rFail = 0;
    for (int r = 0; r < 40; ++r) {
        Vec3 o{(fr() - 0.5f) * 400, (fr() - 0.5f) * 400, -50};
        Vec3 d{(fr() - 0.5f) * 0.4f, (fr() - 0.5f) * 0.4f, 1.0f};
        float t; uint32_t hit = w.raycast(o, d, 5000.0f, t);
        // brute force nearest
        Vec3 inv{1.0f / d.x, 1.0f / d.y, 1.0f / d.z};
        float bestT = 5000; uint32_t best = UINT32_MAX;
        for (uint32_t e = 0; e < N; ++e) {
            if (!(w.flags[e] & F_ENABLED)) continue;
            Vec3 a = w.worldMin[e], b = w.worldMax[e];
            float t0 = (a.x-o.x)*inv.x, t1 = (b.x-o.x)*inv.x; float tmin = std::fmin(t0,t1), tmax = std::fmax(t0,t1);
            t0 = (a.y-o.y)*inv.y; t1 = (b.y-o.y)*inv.y; tmin = std::fmax(tmin, std::fmin(t0,t1)); tmax = std::fmin(tmax, std::fmax(t0,t1));
            t0 = (a.z-o.z)*inv.z; t1 = (b.z-o.z)*inv.z; tmin = std::fmax(tmin, std::fmin(t0,t1)); tmax = std::fmin(tmax, std::fmax(t0,t1));
            if (tmax >= tmin && tmax >= 0) { float tt = tmin >= 0 ? tmin : 0; if (tt < bestT) { bestT = tt; best = e; } }
        }
        if (hit != best) rFail++;
        else if (best != UINT32_MAX && std::fabs(t - bestT) > 1e-3f * (1 + bestT)) rFail++;
    }
    check(rFail == 0, "raycast returns the nearest AABB hit (40 rays)");

    std::printf("test_bvh: %s\n", fails ? "FAIL" : "OK");
    return fails ? 1 : 0;
}
