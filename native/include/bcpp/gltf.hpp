// bcpp/gltf.hpp — batch processing of glTF binary geometry.
//
// Works on ONE contiguous BIN blob + an array of per-primitive descriptors.
// One call decodes every primitive of an asset into tight, GPU-ready,
// concatenated SoA arrays. No per-vertex object, no per-element boundary call.
//
// JS side (web/asset/wasm.ts): parse the glTF JSON, build the PrimDesc array
// from accessors/bufferViews, upload BIN, call process(), read the outputs as
// typed-array views. Metadata + orchestration stay in TypeScript.
//
// Decode semantics match web/asset/gltf.ts exactly (the reference), so the
// equivalence tests can compare numerically.

#pragma once
#include <cstdint>
#include <cstring>
#include <cmath>
#include <vector>

namespace bcpp::gltf {

// component types (glTF)
enum : int32_t { CT_I8 = 5120, CT_U8 = 5121, CT_I16 = 5122, CT_U16 = 5123, CT_U32 = 5125, CT_F32 = 5126 };

// process() flags
enum : uint32_t {
    F_GEN_NORMALS  = 1u << 0,  // generate normals when a primitive has none
    F_GEN_TANGENTS = 1u << 1,  // generate tangents (needs UV + normals)
};

// per-primitive input descriptor — a flat 24×i32/f32 record (see web/asset/wasm.ts)
struct PrimDesc {
    int32_t posOffset, posStride, posCompType; uint32_t posCount;
    int32_t nrmOffset, nrmStride, nrmCompType, nrmNormalized;
    int32_t uvOffset, uvStride, uvCompType, uvNormalized;
    int32_t idxOffset, idxCompType; uint32_t idxCount;
    int32_t hasAABB;
    float   aabbMin[3], aabbMax[3];
    int32_t posNormalized, _reserved;
};
static_assert(sizeof(PrimDesc) == 96, "PrimDesc must be 96 bytes");

// per-primitive output record — flat 16×i32/f32 (see web/asset/wasm.ts)
struct PrimOut {
    uint32_t vertexBase, vertexCount, indexBase, indexCount;
    float    aabbMin[3], aabbMax[3];
    uint32_t flags;              // bit0 genNormals, bit1 genTangents, bit2 nonIndexed
    uint32_t _r[5];
};
static_assert(sizeof(PrimOut) == 64, "PrimOut must be 64 bytes");
enum : uint32_t { PO_GEN_NORMALS = 1u << 0, PO_GEN_TANGENTS = 1u << 1, PO_NON_INDEXED = 1u << 2 };

// ---- component readers — bit-identical to web/asset/gltf.ts normalize() ----
inline float readComp(const uint8_t* p, int32_t ct, bool normalized) {
    switch (ct) {
        case CT_F32: { float v; std::memcpy(&v, p, 4); return v; }
        case CT_U8:  { uint8_t v = *p;                  return normalized ? v / 255.0f : (float)v; }
        case CT_U16: { uint16_t v; std::memcpy(&v, p, 2); return normalized ? v / 65535.0f : (float)v; }
        case CT_I8:  { int8_t v = *(const int8_t*)p;    return normalized ? std::fmax(v / 127.0f, -1.0f) : (float)v; }
        case CT_I16: { int16_t v; std::memcpy(&v, p, 2); return normalized ? std::fmax(v / 32767.0f, -1.0f) : (float)v; }
        case CT_U32: { uint32_t v; std::memcpy(&v, p, 4); return (float)v; }
    }
    return 0.0f;
}
inline uint32_t readIndex(const uint8_t* p, int32_t ct) {
    switch (ct) {
        case CT_U8:  return *p;
        case CT_U16: { uint16_t v; std::memcpy(&v, p, 2); return v; }
        case CT_U32: { uint32_t v; std::memcpy(&v, p, 4); return v; }
    }
    return 0;
}
inline int compSize(int32_t ct) {
    switch (ct) { case CT_I8: case CT_U8: return 1; case CT_I16: case CT_U16: return 2; default: return 4; }
}

// Decode `count` vec`comps` elements from `src` (byte stride `stride`) into the
// tight float array `dst`. Fast path: tightly-packed non-normalized F32 → memcpy.
inline void decodeVec(float* dst, const uint8_t* src, uint32_t count, int comps,
                      int32_t stride, int32_t compType, bool normalized) {
    const int cs = compSize(compType);
    if (compType == CT_F32 && !normalized && stride == comps * 4) {
        std::memcpy(dst, src, (size_t)count * comps * 4);
        return;
    }
    for (uint32_t v = 0; v < count; ++v) {
        const uint8_t* r = src + (size_t)v * stride;
        for (int k = 0; k < comps; ++k) dst[(size_t)v * comps + k] = readComp(r + k * cs, compType, normalized);
    }
}

// ---- output buffers (grown, reused across process() calls) ----
struct Batch {
    std::vector<uint8_t>  bin;      // JS writes the GLB BIN chunk here
    std::vector<PrimDesc> desc;     // JS writes per-primitive descriptors here

    std::vector<float>    pos;      // [totalVerts*3]  tight, per-primitive contiguous
    std::vector<float>    nrm;      // [totalVerts*3]  always present (generated if missing)
    std::vector<float>    uv;       // [totalVerts*2]  zero-filled if missing
    std::vector<float>    tan;      // [totalVerts*4]  only if F_GEN_TANGENTS
    std::vector<uint32_t> idx;      // [totalIdx]      always u32
    std::vector<PrimOut>  out;      // [primCount]

    uint32_t totalVerts = 0, totalIndices = 0;
    uint32_t crossReads = 0;       // debug: bytes the loader would otherwise touch element-wise

    // When set, process() reads geometry from this external blob (already in
    // WASM memory — e.g. the GLB the native pipeline holds) instead of the `bin`
    // vector. PrimDesc offsets are then absolute into `binExt`. Zero extra copy.
    const uint8_t* binExt = nullptr;
    size_t binExtLen = 0;

    void reserveBin(uint32_t n) { bin.resize(n); }
    void setPrimCount(uint32_t n) { desc.resize(n); }

    uint32_t process(uint32_t flags) {
        const uint32_t np = (uint32_t)desc.size();
        // pass 1: total sizes
        totalVerts = 0; totalIndices = 0;
        for (uint32_t i = 0; i < np; ++i) {
            totalVerts += desc[i].posCount;
            totalIndices += (desc[i].idxOffset < 0) ? desc[i].posCount : desc[i].idxCount;
        }
        // pos/nrm/idx are fully overwritten below → resize (no re-zero, no
        // realloc once the reused batch is warm). uv/tan must be zero where a
        // primitive lacks the attribute, so clear those.
        pos.resize((size_t)totalVerts * 3);
        nrm.resize((size_t)totalVerts * 3);
        idx.resize((size_t)totalIndices);
        uv.assign((size_t)totalVerts * 2, 0.0f);
        tan.assign((flags & F_GEN_TANGENTS) ? (size_t)totalVerts * 4 : 0, 0.0f);
        out.assign(np, PrimOut{});

        const uint8_t* B = binExt ? binExt : bin.data();
        uint32_t vBase = 0, iBase = 0;
        for (uint32_t pi = 0; pi < np; ++pi) {
            const PrimDesc& d = desc[pi];
            const uint32_t vc = d.posCount;
            float* op = pos.data() + (size_t)vBase * 3;
            float* on = nrm.data() + (size_t)vBase * 3;
            float* ou = uv.data()  + (size_t)vBase * 2;

            // positions — fast path: tightly-packed F32 is a straight memcpy
            decodeVec(op, B + d.posOffset, vc, 3, d.posStride, d.posCompType, d.posNormalized != 0);
            // uvs
            if (d.uvOffset >= 0)
                decodeVec(ou, B + d.uvOffset, vc, 2, d.uvStride, d.uvCompType, d.uvNormalized != 0);
            // indices
            uint32_t* oi = idx.data() + iBase;
            uint32_t ic;
            bool nonIndexed = d.idxOffset < 0;
            if (nonIndexed) { ic = vc; for (uint32_t k = 0; k < ic; ++k) oi[k] = k; }
            else {
                ic = d.idxCount;
                if (d.idxCompType == CT_U32) {
                    std::memcpy(oi, B + d.idxOffset, (size_t)ic * 4);
                } else if (d.idxCompType == CT_U16) {
                    const uint8_t* s = B + d.idxOffset;
                    for (uint32_t k = 0; k < ic; ++k) { uint16_t v; std::memcpy(&v, s + (size_t)k*2, 2); oi[k] = v; }
                } else {
                    const uint8_t* s = B + d.idxOffset;
                    for (uint32_t k = 0; k < ic; ++k) oi[k] = s[k];
                }
            }

            // normals
            uint32_t poFlags = 0;
            if (d.nrmOffset >= 0) {
                decodeVec(on, B + d.nrmOffset, vc, 3, d.nrmStride, d.nrmCompType, d.nrmNormalized != 0);
            } else if (flags & F_GEN_NORMALS) {
                genNormals(op, on, oi, vc, ic);
                poFlags |= PO_GEN_NORMALS;
            }

            // tangents
            if (flags & F_GEN_TANGENTS) {
                float* ot = tan.data() + (size_t)vBase * 4;
                if (d.uvOffset >= 0 && (d.nrmOffset >= 0 || (poFlags & PO_GEN_NORMALS))) {
                    genTangents(op, on, ou, ot, oi, vc, ic);
                    poFlags |= PO_GEN_TANGENTS;
                } else {
                    for (uint32_t v = 0; v < vc; ++v) { ot[v*4+0]=1; ot[v*4+1]=0; ot[v*4+2]=0; ot[v*4+3]=1; }
                }
            }

            // AABB
            float mn[3], mx[3];
            if (d.hasAABB) { for (int k = 0; k < 3; ++k) { mn[k] = d.aabbMin[k]; mx[k] = d.aabbMax[k]; } }
            else {
                mn[0]=mn[1]=mn[2]=1e30f; mx[0]=mx[1]=mx[2]=-1e30f;
                for (uint32_t v = 0; v < vc; ++v) for (int k = 0; k < 3; ++k) {
                    float c = op[v*3+k]; if (c < mn[k]) mn[k] = c; if (c > mx[k]) mx[k] = c;
                }
            }

            PrimOut& o = out[pi];
            o.vertexBase = vBase; o.vertexCount = vc;
            o.indexBase = iBase; o.indexCount = ic;
            for (int k = 0; k < 3; ++k) { o.aabbMin[k] = mn[k]; o.aabbMax[k] = mx[k]; }
            o.flags = poFlags | (nonIndexed ? PO_NON_INDEXED : 0);

            vBase += vc; iBase += ic;
        }
        return totalVerts;
    }

private:
    // area-weighted per-vertex normals (matches the usual glTF/engine convention)
    static void genNormals(const float* p, float* n, const uint32_t* ix, uint32_t vc, uint32_t ic) {
        for (uint32_t v = 0; v < vc * 3; ++v) n[v] = 0.0f;
        for (uint32_t t = 0; t + 2 < ic; t += 3) {
            const uint32_t a = ix[t], b = ix[t+1], c = ix[t+2];
            const float e1x = p[b*3]-p[a*3], e1y = p[b*3+1]-p[a*3+1], e1z = p[b*3+2]-p[a*3+2];
            const float e2x = p[c*3]-p[a*3], e2y = p[c*3+1]-p[a*3+1], e2z = p[c*3+2]-p[a*3+2];
            const float fx = e1y*e2z - e1z*e2y, fy = e1z*e2x - e1x*e2z, fz = e1x*e2y - e1y*e2x;
            n[a*3]+=fx; n[a*3+1]+=fy; n[a*3+2]+=fz;
            n[b*3]+=fx; n[b*3+1]+=fy; n[b*3+2]+=fz;
            n[c*3]+=fx; n[c*3+1]+=fy; n[c*3+2]+=fz;
        }
        for (uint32_t v = 0; v < vc; ++v) {
            float x = n[v*3], y = n[v*3+1], z = n[v*3+2];
            float l = std::sqrt(x*x + y*y + z*z);
            if (l > 1e-12f) { n[v*3]=x/l; n[v*3+1]=y/l; n[v*3+2]=z/l; }
            else { n[v*3]=0; n[v*3+1]=1; n[v*3+2]=0; }
        }
    }

    // Lengyel tangent generation, orthonormalised, with handedness in .w
    static void genTangents(const float* p, const float* n, const float* uv, float* tOut,
                            const uint32_t* ix, uint32_t vc, uint32_t ic) {
        std::vector<float> tan(vc * 3, 0.0f), bit(vc * 3, 0.0f);
        for (uint32_t t = 0; t + 2 < ic; t += 3) {
            const uint32_t a = ix[t], b = ix[t+1], c = ix[t+2];
            const float x1 = p[b*3]-p[a*3], x2 = p[c*3]-p[a*3];
            const float y1 = p[b*3+1]-p[a*3+1], y2 = p[c*3+1]-p[a*3+1];
            const float z1 = p[b*3+2]-p[a*3+2], z2 = p[c*3+2]-p[a*3+2];
            const float s1 = uv[b*2]-uv[a*2], s2 = uv[c*2]-uv[a*2];
            const float w1 = uv[b*2+1]-uv[a*2+1], w2 = uv[c*2+1]-uv[a*2+1];
            const float d = s1*w2 - s2*w1;
            const float r = (std::fabs(d) < 1e-12f) ? 0.0f : 1.0f / d;
            const float sx = (w2*x1 - w1*x2)*r, sy = (w2*y1 - w1*y2)*r, sz = (w2*z1 - w1*z2)*r;
            const float tx = (s1*x2 - s2*x1)*r, ty = (s1*y2 - s2*y1)*r, tz = (s1*z2 - s2*z1)*r;
            for (uint32_t j : {a, b, c}) {
                tan[j*3]+=sx; tan[j*3+1]+=sy; tan[j*3+2]+=sz;
                bit[j*3]+=tx; bit[j*3+1]+=ty; bit[j*3+2]+=tz;
            }
        }
        for (uint32_t v = 0; v < vc; ++v) {
            const float nx = n[v*3], ny = n[v*3+1], nz = n[v*3+2];
            float tx = tan[v*3], ty = tan[v*3+1], tz = tan[v*3+2];
            const float dot = nx*tx + ny*ty + nz*tz;
            tx -= nx*dot; ty -= ny*dot; tz -= nz*dot;
            float l = std::sqrt(tx*tx + ty*ty + tz*tz);
            if (l > 1e-12f) { tx/=l; ty/=l; tz/=l; } else { tx = 1; ty = 0; tz = 0; }
            // handedness: sign of dot(cross(n,t), bitangent)
            const float cx = ny*tz - nz*ty, cy = nz*tx - nx*tz, cz = nx*ty - ny*tx;
            const float h = cx*bit[v*3] + cy*bit[v*3+1] + cz*bit[v*3+2];
            tOut[v*4]=tx; tOut[v*4+1]=ty; tOut[v*4+2]=tz; tOut[v*4+3] = (h < 0.0f) ? -1.0f : 1.0f;
        }
    }
};

} // namespace bcpp::gltf
