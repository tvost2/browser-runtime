// Correctness: bcpp::mergeMeshes concatenates meshes + bakes their world
// transform, and the merged geometry is identical (per triangle) to drawing
// each source mesh separately.
//
//   * vertex / index counts are the sums
//   * indices are rebased by the running vertex offset (still in range)
//   * baked positions == host-side transformCoord of the source vertex
//   * baked normals are unit length and point the same way a per-mesh normal
//     transform would (inverse-transpose, checked against a known scale)
//   * every output vertex carries its source item's id
//
//   ./test_merge

#include "bcpp/merge.hpp"
#include <cstdio>
#include <cstring>
#include <vector>
#include <cmath>

using namespace bcpp;

static int fails = 0;
static void check(bool ok, const char* msg) { if (!ok) { std::printf("  FAIL %s\n", msg); fails++; } }

static uint32_t rs = 0x9e3779b9u;
static float fr() { rs = rs * 1664525u + 1013904223u; return (rs >> 8) / 16777216.0f; }

// unit cube: 24 verts (per-face), 36 indices
static void cube(std::vector<float>& pos, std::vector<float>& nrm, std::vector<uint32_t>& idx) {
    const float p[8][3] = {
        {-1,-1,-1},{1,-1,-1},{1,1,-1},{-1,1,-1},
        {-1,-1, 1},{1,-1, 1},{1,1, 1},{-1,1, 1},
    };
    const int faces[6][4] = {
        {0,1,2,3},{5,4,7,6},{4,0,3,7},{1,5,6,2},{3,2,6,7},{4,5,1,0},
    };
    const float fn[6][3] = {
        {0,0,-1},{0,0,1},{-1,0,0},{1,0,0},{0,1,0},{0,-1,0},
    };
    for (int f = 0; f < 6; ++f) {
        uint32_t base = (uint32_t)(pos.size() / 3);
        for (int k = 0; k < 4; ++k) {
            pos.push_back(p[faces[f][k]][0]); pos.push_back(p[faces[f][k]][1]); pos.push_back(p[faces[f][k]][2]);
            nrm.push_back(fn[f][0]); nrm.push_back(fn[f][1]); nrm.push_back(fn[f][2]);
        }
        idx.push_back(base); idx.push_back(base + 1); idx.push_back(base + 2);
        idx.push_back(base); idx.push_back(base + 2); idx.push_back(base + 3);
    }
}

int main() {
    std::vector<float> cpos, cnrm;
    std::vector<uint32_t> cidx;
    cube(cpos, cnrm, cidx);
    const uint32_t VC = (uint32_t)(cpos.size() / 3), IC = (uint32_t)cidx.size();

    const uint32_t N = 40;
    std::vector<Mat4> world(N);
    std::vector<MergeItem> items(N);
    for (uint32_t k = 0; k < N; ++k) {
        const Vec3 scale{0.5f + fr() * 3.0f, 0.5f + fr() * 3.0f, 0.5f + fr() * 5.0f}; // non-uniform
        const Quat q = Quat::fromEulerYXZ(0.0f, fr() * 6.283f, 0.0f);
        const Vec3 t{(fr() - 0.5f) * 200.0f, fr() * 40.0f, (fr() - 0.5f) * 200.0f};
        world[k] = Mat4::compose(scale, q, t);
        items[k] = MergeItem{ cpos.data(), cnrm.data(), nullptr, cidx.data(), VC, IC, world[k].m.data(), 1000u + k };
    }

    MergedGeometry out;
    mergeMeshes(items.data(), N, out);

    check(out.vertexCount == N * VC, "vertex count == sum");
    check(out.indexCount == N * IC, "index count == sum");
    check(out.pos.size() == N * VC * 3, "pos array sized");
    check(out.nrm.size() == N * VC * 3, "nrm array sized (all inputs had normals)");
    check(out.uv.empty(), "uv array empty (no input had uv)");
    check(out.id.size() == N * VC, "id array sized");

    bool idxInRange = true, idxRebased = true, posOk = true, nrmUnit = true, nrmDir = true, idOk = true;
    for (uint32_t k = 0; k < N; ++k) {
        const uint32_t vB = k * VC, iB = k * IC;
        float NM[9]; _inverse3(world[k], NM);
        for (uint32_t j = 0; j < IC; ++j) {
            const uint32_t got = out.idx[iB + j];
            if (got != cidx[j] + vB) idxRebased = false;
            if (got >= out.vertexCount) idxInRange = false;
        }
        for (uint32_t v = 0; v < VC; ++v) {
            const Vec3 src{cpos[v * 3], cpos[v * 3 + 1], cpos[v * 3 + 2]};
            const Vec3 want = world[k].transformCoord(src);
            const uint32_t o = (vB + v) * 3;
            if (std::fabs(out.pos[o] - want.x) > 1e-3f ||
                std::fabs(out.pos[o + 1] - want.y) > 1e-3f ||
                std::fabs(out.pos[o + 2] - want.z) > 1e-3f) posOk = false;

            const float nx = out.nrm[o], ny = out.nrm[o + 1], nz = out.nrm[o + 2];
            const float len = std::sqrt(nx * nx + ny * ny + nz * nz);
            if (std::fabs(len - 1.0f) > 1e-3f) nrmUnit = false;

            // reference normal: inverse-transpose (C·n) then normalise
            const Vec3 sn{cnrm[v * 3], cnrm[v * 3 + 1], cnrm[v * 3 + 2]};
            float rx = NM[0] * sn.x + NM[1] * sn.y + NM[2] * sn.z;
            float ry = NM[3] * sn.x + NM[4] * sn.y + NM[5] * sn.z;
            float rz = NM[6] * sn.x + NM[7] * sn.y + NM[8] * sn.z;
            const float rl = std::sqrt(rx * rx + ry * ry + rz * rz);
            rx /= rl; ry /= rl; rz /= rl;
            if (nx * rx + ny * ry + nz * rz < 0.999f) nrmDir = false;

            if (out.id[vB + v] != 1000u + k) idOk = false;
        }
    }
    check(idxInRange, "rebased indices stay in range");
    check(idxRebased, "indices rebased by running vertex offset");
    check(posOk, "baked positions == transformCoord(src)");
    check(nrmUnit, "baked normals are unit length");
    check(nrmDir, "baked normals match the inverse-transpose reference");
    check(idOk, "every vertex carries its source item id");

    // singular transform → identity fallback, no NaNs
    {
        Mat4 zero; std::memset(zero.m.data(), 0, sizeof(float) * 16); zero.m[15] = 1.0f;
        MergeItem si{ cpos.data(), cnrm.data(), nullptr, cidx.data(), VC, IC, zero.m.data(), 7u };
        MergedGeometry so;
        mergeMeshes(&si, 1, so);
        bool finite = true;
        for (float f : so.nrm) if (!std::isfinite(f)) finite = false;
        check(finite, "singular transform → finite normals (identity fallback)");
    }

    std::printf(fails ? "test_merge: %d FAILs\n" : "test_merge: OK\n", fails);
    return fails ? 1 : 0;
}
