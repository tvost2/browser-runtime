// Native ceiling for the WASM-first core: bcpp::World.evaluate() with no JS/WASM
// boundary, native SIMD, no GC. The bar the WASM build chases.
//   ./bench_world [nodes] [frames] [--json]

#include "bcpp/world.hpp"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <chrono>
#include <random>
#include <algorithm>
#include <string>

using namespace bcpp;
using clk = std::chrono::high_resolution_clock;

int main(int argc, char** argv) {
    uint32_t n = argc > 1 ? std::atoi(argv[1]) : 20000;
    int frames = argc > 2 ? std::atoi(argv[2]) : 2000;
    bool json = argc > 3 && std::string(argv[3]) == "--json";

    std::mt19937 rng(12345);
    std::uniform_real_distribution<float> U(-1, 1);

    World w;
    w.resize(n);
    for (uint32_t i = 0; i < n; i++) {
        if (i > 0 && U(rng) > 0.0f) w.parent[i] = (int32_t)(rng() % i);
        w.localPos[i] = {U(rng) * 300, U(rng) * 300, U(rng) * 300 + 100};
        w.localRot[i] = Quat::fromEulerYXZ(U(rng) * 3, U(rng) * 3, U(rng) * 3).normalized();
        float s = 0.5f + std::fabs(U(rng));
        w.localScale[i] = {s, s, s};
        w.meshId[i] = rng() % 8;
        w.flags[i] = F_ENABLED | F_VISIBLE;
    }
    w.markHierarchyDirty();

    Mat4 vp;
    vp.m = {1.3f, 0, 0, 0, 0, 2.4f, 0, 0, 0, 0, 1.001f, 1, 0, 0, -0.5f, 0};

    std::vector<double> samp;
    samp.reserve(frames);
    for (int f = 0; f < frames + 200; f++) {
        for (uint32_t i = 0; i < n; i += 7) w.localPos[i].x += 0.001f;
        auto a = clk::now();
        w.evaluate(vp, CullStrategy::Standard, true);
        auto b = clk::now();
        if (f >= 200) samp.push_back(std::chrono::duration<double, std::milli>(b - a).count());
    }
    std::sort(samp.begin(), samp.end());
    double med = samp[samp.size() / 2], p95 = samp[(size_t)(samp.size() * 0.95)];

    if (json)
        std::printf("{\"nodes\":%u,\"visible\":%u,\"batches\":%u,\"medianMs\":%.5f,\"p95Ms\":%.5f}\n",
                    n, w.stats.visible, (uint32_t)w.batches.size(), med, p95);
    else
        std::printf("nodes=%u visible=%u batches=%zu  evaluate(): median=%.4f ms  p95=%.4f ms  (%.0f nodes/ms)\n",
                    n, w.stats.visible, w.batches.size(), med, p95, n / med);
    return 0;
}
