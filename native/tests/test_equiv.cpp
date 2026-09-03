// Numeric equivalence: bcpp math/kernel vs fixtures emitted by real Babylon.js.
//   ./test_equiv <fixtures_dir>
// Exit 0 = all within tolerance.

#include "bcpp/scene.hpp"
#include <cstdio>
#include <cstdint>
#include <cmath>
#include <vector>
#include <string>
#include <fstream>

using namespace bcpp;

static std::vector<char> readFile(const std::string& path) {
    std::ifstream f(path, std::ios::binary | std::ios::ate);
    if (!f) { std::fprintf(stderr, "cannot open %s\n", path.c_str()); std::exit(2); }
    auto n = f.tellg();
    std::vector<char> buf(static_cast<size_t>(n));
    f.seekg(0);
    f.read(buf.data(), n);
    return buf;
}
static const float* asF32(const std::vector<char>& b) { return reinterpret_cast<const float*>(b.data()); }
static const int32_t* asI32(const std::vector<char>& b) { return reinterpret_cast<const int32_t*>(b.data()); }

struct Report { int checks = 0; int fails = 0; double maxAbs = 0; double maxRel = 0; };

static void cmp(Report& R, float got, float exp, double atol, double rtol, const char* what, int idx) {
    R.checks++;
    double a = std::fabs((double)got - (double)exp);
    double rel = a / (std::fabs((double)exp) + 1e-12);
    R.maxAbs = std::max(R.maxAbs, a);
    R.maxRel = std::max(R.maxRel, rel);
    if (a > atol && rel > rtol) {
        if (R.fails < 12)
            std::printf("  MISMATCH %s[%d]: got %.9g  exp %.9g  (abs %.3g rel %.3g)\n", what, idx, got, exp, a, rel);
        R.fails++;
    }
}

int main(int argc, char** argv) {
    std::string dir = argc > 1 ? argv[1] : "fixtures";
    auto P = [&](const char* n) { return dir + "/" + n; };
    Report R;

    // ---- compose ----
    {
        auto in = readFile(P("compose_in.bin"));
        auto out = readFile(P("compose_out.bin"));
        const float* I = asF32(in); const float* O = asF32(out);
        int K = (int)(in.size() / sizeof(float) / 10);
        for (int i = 0; i < K; i++) {
            const float* r = I + i * 10;
            Mat4 m = Mat4::compose({r[0], r[1], r[2]}, Quat{r[3], r[4], r[5], r[6]}, {r[7], r[8], r[9]});
            for (int j = 0; j < 16; j++) cmp(R, m.m[j], O[i * 16 + j], 1e-4, 1e-4, "compose", i * 16 + j);
        }
        std::printf("compose: %d matrices\n", K);
    }

    // ---- multiply ----
    {
        auto in = readFile(P("multiply_in.bin"));
        auto out = readFile(P("multiply_out.bin"));
        const float* I = asF32(in); const float* O = asF32(out);
        int K = (int)(in.size() / sizeof(float) / 32);
        for (int i = 0; i < K; i++) {
            Mat4 a, b;
            for (int j = 0; j < 16; j++) a.m[j] = I[i * 32 + j];
            for (int j = 0; j < 16; j++) b.m[j] = I[i * 32 + 16 + j];
            Mat4 c = Mat4::multiply(a, b);
            for (int j = 0; j < 16; j++) cmp(R, c.m[j], O[i * 16 + j], 1e-3, 1e-4, "multiply", i * 16 + j);
        }
        std::printf("multiply: %d matrices\n", K);
    }

    // ---- frustum ----
    {
        auto in = readFile(P("frustum_in.bin"));
        auto out = readFile(P("frustum_out.bin"));
        const float* I = asF32(in); const float* O = asF32(out);
        int K = (int)(in.size() / sizeof(float) / 16);
        for (int i = 0; i < K; i++) {
            Mat4 vp; for (int j = 0; j < 16; j++) vp.m[j] = I[i * 16 + j];
            Frustum f = Frustum::fromViewProj(vp);
            for (int p = 0; p < 6; p++) {
                cmp(R, f.planes[p].normal.x, O[i * 24 + p * 4 + 0], 1e-5, 1e-4, "frustum.nx", i);
                cmp(R, f.planes[p].normal.y, O[i * 24 + p * 4 + 1], 1e-5, 1e-4, "frustum.ny", i);
                cmp(R, f.planes[p].normal.z, O[i * 24 + p * 4 + 2], 1e-5, 1e-4, "frustum.nz", i);
                cmp(R, f.planes[p].d,        O[i * 24 + p * 4 + 3], 1e-4, 1e-4, "frustum.d",  i);
            }
        }
        std::printf("frustum: %d viewProj\n", K);
    }

    // ---- full kernel: visible-set equality ----
    {
        auto parent = readFile(P("kernel_parent.bin"));
        auto trs = readFile(P("kernel_trs.bin"));
        auto ext = readFile(P("kernel_ext.bin"));
        auto flags = readFile(P("kernel_flags.bin"));
        auto vpb = readFile(P("kernel_vp.bin"));
        auto vis = readFile(P("kernel_visible.bin"));
        uint32_t n = (uint32_t)(parent.size() / sizeof(int32_t));

        Engine e;
        e.scene.resize(n);
        const int32_t* P_ = asI32(parent);
        const float* T = asF32(trs);
        const float* X = asF32(ext);
        const int32_t* F = asI32(flags);
        for (uint32_t i = 0; i < n; i++) {
            e.scene.parent[i] = P_[i];
            e.scene.localPos[i] = {T[i*10+0], T[i*10+1], T[i*10+2]};
            e.scene.localRot[i] = {T[i*10+3], T[i*10+4], T[i*10+5], T[i*10+6]};
            e.scene.localScale[i] = {T[i*10+7], T[i*10+8], T[i*10+9]};
            e.scene.localMin[i] = {X[i*6+0], X[i*6+1], X[i*6+2]};
            e.scene.localMax[i] = {X[i*6+3], X[i*6+4], X[i*6+5]};
            e.scene.flags[i] = (uint32_t)F[i];
        }
        Mat4 vp; for (int j = 0; j < 16; j++) vp.m[j] = asF32(vpb)[j];
        e.evaluate(vp, CullStrategy::Standard);

        uint32_t expN = (uint32_t)(vis.size() / sizeof(int32_t));
        const int32_t* EV = asI32(vis);
        R.checks++;
        if (e.result.visibleCount != expN) {
            std::printf("  KERNEL visible count: got %u exp %u\n", e.result.visibleCount, expN);
            R.fails++;
        } else {
            int mism = 0;
            for (uint32_t i = 0; i < expN; i++) if ((int32_t)e.result.visibleIds[i] != EV[i]) mism++;
            if (mism) { std::printf("  KERNEL visible ids differ in %d slots\n", mism); R.fails++; }
        }
        std::printf("kernel: %u nodes, got %u visible (exp %u)\n", n, e.result.visibleCount, expN);
    }

    std::printf("\n%d checks, %d failures. maxAbs=%.3g maxRel=%.3g\n", R.checks, R.fails, R.maxAbs, R.maxRel);
    return R.fails ? 1 : 0;
}
