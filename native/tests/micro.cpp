// micro.cpp — per-stage micro-timing of the math kernel. Kept for reference:
// this is the harness that caught F-003 (a non-inlined std::fmin cost 3× the
// whole kernel). Not wired into any npm script — build manually:
//   g++ -std=c++20 -O3 -march=native -static -Iinclude tests/micro.cpp -o micro && ./micro
#include "bcpp/math.hpp"
#include <cstdio>
#include <chrono>
#include <vector>
#include <random>
using namespace bcpp;
using clk = std::chrono::high_resolution_clock;
template <class F> double timeit(int iters, F&& f) {
    for (int i = 0; i < iters / 10; i++) f();
    auto a = clk::now();
    for (int i = 0; i < iters; i++) f();
    return std::chrono::duration<double, std::milli>(clk::now() - a).count() / iters;
}
int main() {
    const int N = 7000;
    std::mt19937 rng(1);
    std::uniform_real_distribution<float> U(-1, 1);
    std::vector<Vec3> pos(N), scl(N);
    std::vector<Quat> rot(N);
    std::vector<Mat4> world(N);
    for (int i = 0; i < N; i++) {
        pos[i] = {U(rng)*100, U(rng)*100, U(rng)*100};
        rot[i] = Quat::fromEulerYXZ(U(rng), U(rng), U(rng)).normalized();
        scl[i] = {1,1,1};
    }
    volatile float sink = 0;
    Mat4 vp; vp.m = {1.3f,0,0,0, 0,2.4f,0,0, 0,0,1.001f,1, 0,0,-0.5f,0};

    printf("compose         : %.5f ms / %d nodes\n", timeit(2000, [&]{
        for (int i=0;i<N;i++){ Mat4 m = Mat4::compose(scl[i], rot[i], pos[i]); sink += m.m[12]; }
    }), N);
    printf("compose+multiply: %.5f ms\n", timeit(2000, [&]{
        for (int i=0;i<N;i++){ Mat4 m = Mat4::compose(scl[i], rot[i], pos[i]); world[i]=Mat4::multiply(m, vp); sink += world[i].m[0]; }
    }));
    printf("+8x transformCoord: %.5f ms\n", timeit(2000, [&]{
        for (int i=0;i<N;i++){ Mat4 m = Mat4::compose(scl[i], rot[i], pos[i]); world[i]=Mat4::multiply(m, vp);
            Vec3 mn{1e30f,1e30f,1e30f}, mx{-1e30f,-1e30f,-1e30f};
            for (int c=0;c<8;c++){ Vec3 corner{(c&1)?.5f:-.5f,(c&2)?.5f:-.5f,(c&4)?.5f:-.5f}; Vec3 w=world[i].transformCoord(corner); mn=Vec3::min(mn,w); mx=Vec3::max(mx,w);}
            sink += mn.x + mx.y;
        }
    }));
    printf("Frustum::fromViewProj: %.6f ms (once)\n", timeit(200000, [&]{ Frustum f=Frustum::fromViewProj(vp); sink+=f.planes[0].d; }));
    (void)sink;
    return 0;
}
