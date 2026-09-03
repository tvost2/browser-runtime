// bcpp/merge.hpp — static geometry merge. Concatenate many small meshes (each
// with its own world transform) into one big mesh so the renderer issues ONE
// draw where it used to issue thousands.
//
// Used for scenes like the Uberlândia digital twin: ~3.7k unique building
// footprints → group by spatial cell → merge each cell → ~50 draw buckets.
//
// Per-vertex identity is preserved: every output vertex carries the source
// item's `id` (e.g. a building id) so a pick pass can still resolve the
// individual object under the cursor. Positions are baked to world space;
// normals by the inverse-transpose of the upper 3×3 (correct under non-uniform
// scale, which building footprints routinely have).
//
// Pure data-in / data-out, no allocation in the hot loop beyond the output
// vectors sized once up front. Same contract as the rest of bcpp.

#pragma once
#include "math.hpp"
#include <vector>
#include <cstdint>
#include <cstring>
#include <cmath>

namespace bcpp {

struct MergeItem {
    const float*    pos;          // vertexCount * 3   (required)
    const float*    nrm;          // vertexCount * 3   (nullptr = none)
    const float*    uv;           // vertexCount * 2   (nullptr = none)
    const uint32_t* idx;          // indexCount        (required)
    uint32_t        vertexCount;
    uint32_t        indexCount;
    const float*    world;        // 16, row-major Babylon layout (nullptr = identity)
    uint32_t        id;           // per-vertex tag in the output (building id, …)
};

struct MergedGeometry {
    std::vector<float>    pos;         // vertexCount * 3
    std::vector<float>    nrm;         // vertexCount * 3  (empty if no input had normals)
    std::vector<float>    uv;          // vertexCount * 2  (empty if no input had uv)
    std::vector<uint32_t> idx;         // indexCount
    std::vector<uint32_t> id;          // vertexCount — source item id per vertex
    uint32_t vertexCount = 0;
    uint32_t indexCount  = 0;
};

// Inverse of the upper-left 3×3 of a row-major Mat4, written row-major into `out`.
// Returns false (and leaves `out` = identity) if the block is singular.
inline bool _inverse3(const Mat4& M, float out[9]) {
    const auto& m = M.m;
    const float a = m[0], b = m[1], c = m[2];
    const float d = m[4], e = m[5], f = m[6];
    const float g = m[8], h = m[9], i = m[10];
    const float A =  (e * i - f * h);
    const float B = -(d * i - f * g);
    const float C =  (d * h - e * g);
    const float det = a * A + b * B + c * C;
    if (std::fabs(det) < 1e-20f) {
        out[0] = 1; out[1] = 0; out[2] = 0;
        out[3] = 0; out[4] = 1; out[5] = 0;
        out[6] = 0; out[7] = 0; out[8] = 1;
        return false;
    }
    const float invDet = 1.0f / det;
    out[0] = A * invDet;
    out[1] = (c * h - b * i) * invDet;
    out[2] = (b * f - c * e) * invDet;
    out[3] = B * invDet;
    out[4] = (a * i - c * g) * invDet;
    out[5] = (c * d - a * f) * invDet;
    out[6] = C * invDet;
    out[7] = (b * g - a * h) * invDet;
    out[8] = (a * e - b * d) * invDet;
    return true;
}

// Merge `n` items into `out`. `out` is sized once; the loop only writes.
inline void mergeMeshes(const MergeItem* items, uint32_t n, MergedGeometry& out) {
    uint32_t totV = 0, totI = 0;
    bool anyN = false, anyU = false;
    for (uint32_t k = 0; k < n; ++k) {
        totV += items[k].vertexCount;
        totI += items[k].indexCount;
        anyN = anyN || items[k].nrm != nullptr;
        anyU = anyU || items[k].uv  != nullptr;
    }

    out.pos.assign(totV * 3, 0.0f);
    out.nrm.assign(anyN ? totV * 3 : 0, 0.0f);
    out.uv.assign(anyU ? totV * 2 : 0, 0.0f);
    out.idx.assign(totI, 0u);
    out.id.assign(totV, 0u);
    out.vertexCount = totV;
    out.indexCount  = totI;

    uint32_t vBase = 0, iBase = 0;
    for (uint32_t k = 0; k < n; ++k) {
        const MergeItem& it = items[k];

        Mat4 M = Mat4::identity();
        if (it.world) std::memcpy(M.m.data(), it.world, 16 * sizeof(float));
        float NM[9];
        _inverse3(M, NM);   // used as C·n (C = B^{-1}) → inverse-transpose applied to the normal

        for (uint32_t v = 0; v < it.vertexCount; ++v) {
            const Vec3 p{it.pos[v * 3], it.pos[v * 3 + 1], it.pos[v * 3 + 2]};
            const Vec3 wp = M.transformCoord(p);
            const uint32_t o = (vBase + v) * 3;
            out.pos[o]     = wp.x;
            out.pos[o + 1] = wp.y;
            out.pos[o + 2] = wp.z;

            if (anyN) {
                Vec3 nn{0.0f, 1.0f, 0.0f};
                if (it.nrm) nn = {it.nrm[v * 3], it.nrm[v * 3 + 1], it.nrm[v * 3 + 2]};
                float nx = NM[0] * nn.x + NM[1] * nn.y + NM[2] * nn.z;
                float ny = NM[3] * nn.x + NM[4] * nn.y + NM[5] * nn.z;
                float nz = NM[6] * nn.x + NM[7] * nn.y + NM[8] * nn.z;
                const float len = std::sqrt(nx * nx + ny * ny + nz * nz);
                const float inv = len > 1e-12f ? 1.0f / len : 0.0f;
                out.nrm[o]     = nx * inv;
                out.nrm[o + 1] = ny * inv;
                out.nrm[o + 2] = nz * inv;
            }

            if (anyU) {
                const uint32_t uo = (vBase + v) * 2;
                if (it.uv) { out.uv[uo] = it.uv[v * 2]; out.uv[uo + 1] = it.uv[v * 2 + 1]; }
            }

            out.id[vBase + v] = it.id;
        }

        for (uint32_t j = 0; j < it.indexCount; ++j)
            out.idx[iBase + j] = it.idx[j] + vBase;

        vBase += it.vertexCount;
        iBase += it.indexCount;
    }
}

} // namespace bcpp
