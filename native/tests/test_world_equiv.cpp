// Equivalence: bcpp::World (the WASM-first core) vs the Babylon-authored kernel
// fixture. Same visible set required. Also checks the batch list is a valid
// partition of the visible set.
//   ./test_world_equiv <fixtures_dir>

#include "bcpp/world.hpp"
#include <cstdio>
#include <fstream>
#include <vector>
#include <string>
#include <set>

using namespace bcpp;

static std::vector<char> rd(const std::string& p) {
    std::ifstream f(p, std::ios::binary | std::ios::ate);
    if (!f) { std::fprintf(stderr, "open %s\n", p.c_str()); std::exit(2); }
    auto n = f.tellg(); std::vector<char> b(n); f.seekg(0); f.read(b.data(), n); return b;
}
static const float* F(const std::vector<char>& b) { return (const float*)b.data(); }
static const int32_t* I(const std::vector<char>& b) { return (const int32_t*)b.data(); }

int main(int argc, char** argv) {
    std::string dir = argc > 1 ? argv[1] : "fixtures";
    auto P = [&](const char* n) { return dir + "/" + n; };

    auto parent = rd(P("kernel_parent.bin"));
    auto trs = rd(P("kernel_trs.bin"));
    auto ext = rd(P("kernel_ext.bin"));
    auto flags = rd(P("kernel_flags.bin"));
    auto vpb = rd(P("kernel_vp.bin"));
    auto vis = rd(P("kernel_visible.bin"));
    uint32_t n = (uint32_t)(parent.size() / 4);

    World w;
    w.resize(n);
    const int32_t* PA = I(parent); const float* T = F(trs); const float* X = F(ext); const int32_t* FL = I(flags);
    for (uint32_t i = 0; i < n; i++) {
        w.parent[i] = PA[i];
        w.localPos[i] = {T[i*10+0], T[i*10+1], T[i*10+2]};
        w.localRot[i] = {T[i*10+3], T[i*10+4], T[i*10+5], T[i*10+6]};
        w.localScale[i] = {T[i*10+7], T[i*10+8], T[i*10+9]};
        w.localMin[i] = {X[i*6+0], X[i*6+1], X[i*6+2]};
        w.localMax[i] = {X[i*6+3], X[i*6+4], X[i*6+5]};
        w.flags[i] = (uint32_t)FL[i];       // fixture: bit0 enabled, bit1 visible
        w.meshId[i] = i % 4;                 // 4 pretend meshes → exercise batching
    }
    w.markHierarchyDirty();
    Mat4 vp; for (int j = 0; j < 16; j++) vp.m[j] = F(vpb)[j];

    w.evaluate(vp, CullStrategy::Standard, /*sortByMesh=*/true);

    uint32_t expN = (uint32_t)(vis.size() / 4);
    const int32_t* EV = I(vis);
    std::set<int32_t> expSet(EV, EV + expN), gotSet(w.visibleId.begin(), w.visibleId.end());

    int fails = 0;
    if (w.stats.visible != expN) { std::printf("visible count: got %u exp %u\n", w.stats.visible, expN); fails++; }
    if (gotSet != expSet) { std::printf("visible SET differs (got %zu, exp %zu)\n", gotSet.size(), expSet.size()); fails++; }

    // batch list must be a partition of [0, visible)
    uint32_t sum = 0; std::set<uint32_t> seenMesh;
    for (auto& b : w.batches) {
        sum += b.instanceCount;
        for (uint32_t k = b.firstInstance; k < b.firstInstance + b.instanceCount; k++)
            if (w.instanceMeshId[k] != b.meshId) { std::printf("batch meshId mismatch at %u\n", k); fails++; break; }
        if (!seenMesh.insert(b.meshId).second) { std::printf("meshId %u appears in >1 batch (bad sort)\n", b.meshId); fails++; }
    }
    if (sum != w.stats.visible) { std::printf("batch instance sum %u != visible %u\n", sum, w.stats.visible); fails++; }

    std::printf("World: %u entities, %u visible (exp %u), %zu batches. %s\n",
                n, w.stats.visible, expN, w.batches.size(), fails ? "FAIL" : "OK");
    return fails ? 1 : 0;
}
