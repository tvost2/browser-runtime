// bcpp/gltf_pipeline.hpp — PIPELINE B end to end, in C++.
//
//   GLB bytes (copied once into WASM) -> container split -> JSON parse ->
//   glTF metadata (Document) -> PrimDesc build -> bcpp::gltf::Batch (geometry)
//   -> flat outputs + a single TOC that JS reads in one crossing.
//
// Reuses bcpp::gltf::Batch (the geometry core) unchanged — no parallel system.
// Every stage is timed separately so the benchmark can attribute cost.

#pragma once
#include <chrono>
#include <cstdint>
#include <cstring>
#include <vector>
#include "bcpp/gltf.hpp"
#include "bcpp/gltf_doc.hpp"

namespace bcpp::gltf {

inline double now_ms() {
    using clk = std::chrono::steady_clock;
    return std::chrono::duration<double, std::milli>(clk::now().time_since_epoch()).count();
}

// TOC slots — one flat int32 array JS reads once. Pointers are byte addresses in
// WASM memory; *_N are element counts. See web/asset/native.ts for the mirror.
enum : int32_t {
    TOC_VERSION, TOC_OK, TOC_ZEROCOPY_BIN,
    TOC_BUFVIEWS_PTR, TOC_BUFVIEWS_N,
    TOC_ACCESSORS_PTR, TOC_ACCESSORS_N,
    TOC_PRIMS_PTR, TOC_PRIMS_N,
    TOC_MESHES_PTR, TOC_MESHES_N,
    TOC_NODES_PTR, TOC_NODES_N,
    TOC_ROOTS_PTR, TOC_ROOTS_N,
    TOC_MATS_PTR, TOC_MATS_N,
    TOC_TEX_PTR, TOC_TEX_N,
    TOC_SAMP_PTR, TOC_SAMP_N,
    TOC_IMG_PTR, TOC_IMG_N,
    TOC_STRINGS_PTR, TOC_STRINGS_N,
    TOC_IGNORED_PTR, TOC_IGNORED_N,
    TOC_BIN_PTR, TOC_BIN_N,
    TOC_AUXBIN_PTR, TOC_AUXBIN_N,
    TOC_POS_PTR, TOC_NRM_PTR, TOC_UV_PTR, TOC_TAN_PTR, TOC_IDX_PTR,
    TOC_OUTMETA_PTR, TOC_TOTAL_VERTS, TOC_TOTAL_IDX,
    TOC_SLOTMAP_PTR, TOC_SLOTMAP_N,      // slotmap[i] = primitive index in doc.primitives for geometry slot i
    TOC_TIMINGS_PTR, TOC_TIMINGS_N,      // double[]
    TOC_COUNTERS_PTR, TOC_COUNTERS_N,    // double[]
    TOC_BIN_BLOB_OFFSET,                 // byte offset of the BIN chunk data within the original blob
    TOC__COUNT
};

// timings[] indices
enum : int32_t {
    T_LOAD_TOTAL, T_CONTAINER, T_JSON_PARSE, T_METADATA,
    T_PRIMDESC, T_GEOMETRY, T_PROCESS_TOTAL, T__COUNT
};
// counters[] indices (doubles so JS reads one array)
enum : int32_t {
    C_BLOB_BYTES, C_BIN_COPY_BYTES, C_AUXBIN_BYTES, C_GEOM_OUT_BYTES,
    C_STRINGS_BYTES, C_META_BYTES, C_PRIM_COUNT, C_SLOT_COUNT,
    C_BIN_ZEROCOPY, C_JSON_BYTES, C__COUNT
};

struct Pipeline {
    const uint8_t* blob = nullptr;      // GLB bytes (owned by the binding's inbuf — one copy JS->WASM, no second)
    uint32_t       blobLen = 0;
    Container container;
    Document  doc;
    Batch     batch;                    // reused geometry core

    std::vector<uint8_t> combinedBin;   // built only when a geom buffer isn't the BIN
    std::vector<int32_t> slotmap;
    int32_t  toc[TOC__COUNT] = {};
    double   timings[T__COUNT] = {};
    double   counters[C__COUNT] = {};
    bool     loaded = false;

    int32_t binZeroCopy = 0;

    // --- stage 1: copy blob in, split container, parse JSON + metadata ---
    uint32_t loadGLB(const uint8_t* p, uint32_t len) {
        double t0 = now_ms();
        blob = p; blobLen = len;           // no copy — the bytes already live in WASM memory
        counters[C_BLOB_BYTES] = (double)len;

        double tc = now_ms();
        container = parseContainer(blob, blobLen);
        timings[T_CONTAINER] = now_ms() - tc;
        if (!container.ok) { doc.error = container.error; loaded = false; timings[T_LOAD_TOTAL] = now_ms() - t0; return 0; }
        counters[C_JSON_BYTES] = (double)container.jsonLen;

        double tj = now_ms();
        yyjson_doc* jd_ = yyjson_read((const char*)container.json, container.jsonLen, 0);
        timings[T_JSON_PARSE] = now_ms() - tj;
        if (!jd_) { doc.error = "JSON parse failed"; loaded = false; timings[T_LOAD_TOTAL] = now_ms() - t0; return 0; }

        double tm = now_ms();
        doc = Document{};
        parseMetadata(jd_, container, doc);
        timings[T_METADATA] = now_ms() - tm;
        yyjson_doc_free(jd_);

        counters[C_STRINGS_BYTES] = (double)doc.strings.size();
        counters[C_AUXBIN_BYTES]  = (double)doc.auxbin.size();
        counters[C_META_BYTES] = (double)(
            doc.bufferViews.size()*sizeof(DBufferView) + doc.accessors.size()*sizeof(DAccessor) +
            doc.primitives.size()*sizeof(DPrimitive) + doc.meshes.size()*sizeof(DMesh) +
            doc.nodes.size()*sizeof(DNode) + doc.materials.size()*sizeof(DMaterial) +
            doc.textures.size()*sizeof(DTexture) + doc.images.size()*sizeof(DImage));
        loaded = doc.ok;
        timings[T_LOAD_TOTAL] = now_ms() - t0;
        return loaded ? 1 : 0;
    }

    // --- stage 2: build PrimDesc for every processable primitive, run Batch ---
    uint32_t process(uint32_t flags) {
        if (!loaded) return 0;
        double t0 = now_ms();

        // which primitives can the batch core handle? (not sparse, no COLOR_0)
        slotmap.clear();
        for (uint32_t pi = 0; pi < doc.primitives.size(); ++pi) {
            const DPrimitive& p = doc.primitives[pi];
            if (p.position < 0) continue;
            bool sparse = doc.accessors[p.position].sparse
                || (p.normal    >= 0 && doc.accessors[p.normal].sparse)
                || (p.texcoord0 >= 0 && doc.accessors[p.texcoord0].sparse)
                || (p.indices   >= 0 && doc.accessors[p.indices].sparse);
            if (sparse || p.color0 >= 0) continue;   // JS reference path handles these
            slotmap.push_back((int32_t)pi);
        }
        counters[C_PRIM_COUNT] = (double)doc.primitives.size();
        counters[C_SLOT_COUNT] = (double)slotmap.size();

        // geometry base: BIN if every referenced bufferView lives in buffer 0
        // (== BIN); otherwise assemble a combined blob of the referenced ranges.
        std::vector<int64_t> bufBase(64, 0);
        bool allBin = container.bin != nullptr;
        for (int32_t pi : slotmap) {
            const DPrimitive& p = doc.primitives[pi];
            for (int32_t ai : { p.position, p.normal, p.texcoord0, p.indices }) {
                if (ai < 0) continue;
                int32_t bvi = doc.accessors[ai].bufferView >= 0 ? doc.accessors[ai].bufferView : 0;
                if (doc.bufferViews[bvi].buffer != 0) allBin = false;
            }
        }

        double tp = now_ms();
        if (allBin) {
            batch.binExt = container.bin;
            batch.binExtLen = container.binLen;
            binZeroCopy = 1;
            counters[C_BIN_COPY_BYTES] = 0;
        } else {
            // combined bin: union of referenced ranges per buffer (BIN + auxbin)
            binZeroCopy = 0;
            combinedBin.clear();
            std::vector<int64_t> lo(64, -1), hi(64, -1);
            auto touch = [&](int32_t ai) {
                if (ai < 0) return;
                const DAccessor& a = doc.accessors[ai];
                int32_t bvi = a.bufferView >= 0 ? a.bufferView : 0;
                const DBufferView& bv = doc.bufferViews[bvi];
                int32_t b = bv.buffer < 0 ? 0 : bv.buffer;
                int32_t cs = compSize(a.componentType);
                int32_t stride = bv.byteStride >= 0 ? bv.byteStride : (int32_t)a.comps * cs;
                int64_t s = (int64_t)bv.byteOffset + a.byteOffset;
                int64_t e = s + (int64_t)(a.count ? a.count - 1 : 0) * stride + (int64_t)a.comps * cs;
                if (lo[b] < 0 || s < lo[b]) lo[b] = s;
                if (hi[b] < 0 || e > hi[b]) hi[b] = e;
            };
            for (int32_t pi : slotmap) { const DPrimitive& p = doc.primitives[pi]; touch(p.position); touch(p.normal); touch(p.texcoord0); touch(p.indices); }
            int64_t total = 0;
            for (int b = 0; b < 64; ++b) { if (lo[b] < 0) { bufBase[b] = 0; continue; } bufBase[b] = total - lo[b]; total += ((hi[b] - lo[b]) + 3) & ~3; }
            combinedBin.assign((size_t)total, 0);
            for (int b = 0; b < 64; ++b) {
                if (lo[b] < 0) continue;
                const uint8_t* src = nullptr; size_t srcLen = 0;
                // buffer 0 with a BIN chunk -> BIN; else -> auxbin (data-URI buffers land there in order)
                if (b == 0 && container.bin) { src = container.bin; srcLen = container.binLen; }
                else { src = doc.auxbin.data(); srcLen = doc.auxbin.size(); }
                int64_t take = hi[b] - lo[b];
                if (lo[b] + take > (int64_t)srcLen) take = (int64_t)srcLen - lo[b];
                if (take > 0) std::memcpy(combinedBin.data() + (bufBase[b] + lo[b]), src + lo[b], (size_t)take);
            }
            batch.binExt = combinedBin.data();
            batch.binExtLen = combinedBin.size();
            counters[C_BIN_COPY_BYTES] = (double)combinedBin.size();
        }
        counters[C_BIN_ZEROCOPY] = binZeroCopy;

        // PrimDesc table
        batch.setPrimCount((uint32_t)slotmap.size());
        for (uint32_t i = 0; i < slotmap.size(); ++i) {
            const DPrimitive& p = doc.primitives[slotmap[i]];
            PrimDesc& d = batch.desc[i];
            std::memset(&d, 0, sizeof(PrimDesc));
            d.nrmOffset = -1; d.uvOffset = -1; d.idxOffset = -1;

            const DAccessor& pa = doc.accessors[p.position];
            { int32_t bvi = pa.bufferView >= 0 ? pa.bufferView : 0; const DBufferView& bv = doc.bufferViews[bvi];
              int32_t cs = compSize(pa.componentType);
              d.posOffset = (int32_t)(bufBase[bv.buffer < 0 ? 0 : bv.buffer] + bv.byteOffset + pa.byteOffset);
              d.posStride = bv.byteStride >= 0 ? bv.byteStride : (int32_t)pa.comps * cs;
              d.posCompType = pa.componentType; d.posCount = pa.count; d.posNormalized = (int32_t)pa.normalized; }

            if (p.normal >= 0) { const DAccessor& a = doc.accessors[p.normal]; int32_t bvi = a.bufferView >= 0 ? a.bufferView : 0; const DBufferView& bv = doc.bufferViews[bvi];
              int32_t cs = compSize(a.componentType);
              d.nrmOffset = (int32_t)(bufBase[bv.buffer < 0 ? 0 : bv.buffer] + bv.byteOffset + a.byteOffset);
              d.nrmStride = bv.byteStride >= 0 ? bv.byteStride : (int32_t)a.comps * cs;
              d.nrmCompType = a.componentType; d.nrmNormalized = (int32_t)a.normalized; }

            if (p.texcoord0 >= 0) { const DAccessor& a = doc.accessors[p.texcoord0]; int32_t bvi = a.bufferView >= 0 ? a.bufferView : 0; const DBufferView& bv = doc.bufferViews[bvi];
              int32_t cs = compSize(a.componentType);
              d.uvOffset = (int32_t)(bufBase[bv.buffer < 0 ? 0 : bv.buffer] + bv.byteOffset + a.byteOffset);
              d.uvStride = bv.byteStride >= 0 ? bv.byteStride : (int32_t)a.comps * cs;
              d.uvCompType = a.componentType; d.uvNormalized = (int32_t)a.normalized; }

            if (p.indices >= 0) { const DAccessor& a = doc.accessors[p.indices]; int32_t bvi = a.bufferView >= 0 ? a.bufferView : 0; const DBufferView& bv = doc.bufferViews[bvi];
              d.idxOffset = (int32_t)(bufBase[bv.buffer < 0 ? 0 : bv.buffer] + bv.byteOffset + a.byteOffset);
              d.idxCompType = a.componentType; d.idxCount = a.count; }

            if (pa.hasMinMax) { d.hasAABB = 1; for (int k = 0; k < 3; ++k) { d.aabbMin[k] = pa.mn[k]; d.aabbMax[k] = pa.mx[k]; } }

            // note generated normals to match the JS `ignored` text
            if (p.normal < 0 && (flags & F_GEN_NORMALS)) {
                uint32_t mi = 0, base = 0;
                for (; mi < doc.meshes.size(); ++mi) { if (slotmap[i] < (int32_t)(doc.meshes[mi].primFirst + doc.meshes[mi].primCount)) break; }
                base = doc.meshes[mi].primFirst;
                doc.note("mesh " + std::to_string(mi) + " primitive " + std::to_string(slotmap[i] - base) + ": normals generated (source had none)");
            }
        }
        timings[T_PRIMDESC] = now_ms() - tp;

        double tg = now_ms();
        batch.process(flags);
        timings[T_GEOMETRY] = now_ms() - tg;

        counters[C_GEOM_OUT_BYTES] = (double)(
            batch.pos.size()*4 + batch.nrm.size()*4 + batch.uv.size()*4 + batch.tan.size()*4 + batch.idx.size()*4);

        timings[T_PROCESS_TOTAL] = now_ms() - t0;
        fillToc();
        return 1;
    }

    void fillToc() {
        auto P = [](const void* p) { return (int32_t)(intptr_t)p; };
        toc[TOC_VERSION] = (int32_t)container.version;
        toc[TOC_OK] = loaded ? 1 : 0;
        toc[TOC_ZEROCOPY_BIN] = binZeroCopy;
        toc[TOC_BUFVIEWS_PTR] = P(doc.bufferViews.data());  toc[TOC_BUFVIEWS_N] = (int32_t)doc.bufferViews.size();
        toc[TOC_ACCESSORS_PTR] = P(doc.accessors.data());   toc[TOC_ACCESSORS_N] = (int32_t)doc.accessors.size();
        toc[TOC_PRIMS_PTR] = P(doc.primitives.data());      toc[TOC_PRIMS_N] = (int32_t)doc.primitives.size();
        toc[TOC_MESHES_PTR] = P(doc.meshes.data());         toc[TOC_MESHES_N] = (int32_t)doc.meshes.size();
        toc[TOC_NODES_PTR] = P(doc.nodes.data());           toc[TOC_NODES_N] = (int32_t)doc.nodes.size();
        toc[TOC_ROOTS_PTR] = P(doc.roots.data());           toc[TOC_ROOTS_N] = (int32_t)doc.roots.size();
        toc[TOC_MATS_PTR] = P(doc.materials.data());        toc[TOC_MATS_N] = (int32_t)doc.materials.size();
        toc[TOC_TEX_PTR] = P(doc.textures.data());          toc[TOC_TEX_N] = (int32_t)doc.textures.size();
        toc[TOC_SAMP_PTR] = P(doc.samplers.data());         toc[TOC_SAMP_N] = (int32_t)doc.samplers.size();
        toc[TOC_IMG_PTR] = P(doc.images.data());            toc[TOC_IMG_N] = (int32_t)doc.images.size();
        toc[TOC_STRINGS_PTR] = P(doc.strings.data());       toc[TOC_STRINGS_N] = (int32_t)doc.strings.size();
        toc[TOC_IGNORED_PTR] = P(doc.ignored.data());       toc[TOC_IGNORED_N] = (int32_t)doc.ignored.size();
        toc[TOC_BIN_PTR] = P(container.bin);                toc[TOC_BIN_N] = (int32_t)container.binLen;
        toc[TOC_AUXBIN_PTR] = P(doc.auxbin.data());         toc[TOC_AUXBIN_N] = (int32_t)doc.auxbin.size();
        toc[TOC_POS_PTR] = P(batch.pos.data());
        toc[TOC_NRM_PTR] = P(batch.nrm.data());
        toc[TOC_UV_PTR]  = P(batch.uv.data());
        toc[TOC_TAN_PTR] = P(batch.tan.data());
        toc[TOC_IDX_PTR] = P(batch.idx.data());
        toc[TOC_OUTMETA_PTR] = P(batch.out.data());
        toc[TOC_TOTAL_VERTS] = (int32_t)batch.totalVerts;
        toc[TOC_TOTAL_IDX]   = (int32_t)batch.totalIndices;
        toc[TOC_SLOTMAP_PTR] = P(slotmap.data());           toc[TOC_SLOTMAP_N] = (int32_t)slotmap.size();
        toc[TOC_TIMINGS_PTR] = P(timings);                  toc[TOC_TIMINGS_N] = T__COUNT;
        toc[TOC_COUNTERS_PTR] = P(counters);                toc[TOC_COUNTERS_N] = C__COUNT;
        toc[TOC_BIN_BLOB_OFFSET] = container.bin ? (int32_t)(container.bin - blob) : 0;
    }

    int32_t tocPtr() { return (int32_t)(intptr_t)toc; }
};

} // namespace bcpp::gltf
