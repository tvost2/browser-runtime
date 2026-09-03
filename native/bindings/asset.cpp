// embind surface for batch glTF geometry processing (bcpp::gltf::Batch).
// Same contract as the World bindings: JS writes into WASM-owned buffers,
// calls process() once, reads outputs as typed-array views. No per-element
// calls.

#ifdef __EMSCRIPTEN__
#include <emscripten/bind.h>
#include "bcpp/gltf.hpp"
#include "bcpp/gltf_pipeline.hpp"
#include "bcpp/merge.hpp"

using namespace bcpp::gltf;

namespace {
static int P(const void* p) { return (int)(intptr_t)p; }

struct GltfBatch {
    Batch b;

    void reserveBin(uint32_t n) { b.reserveBin(n); }
    void setPrimCount(uint32_t n) { b.setPrimCount(n); }
    int binPtr()  { return P(b.bin.data()); }
    int descPtr() { return P(b.desc.data()); }   // PrimDesc[primCount], 96 B each

    uint32_t process(uint32_t flags) { return b.process(flags); }

    uint32_t totalVertices() { return b.totalVerts; }
    uint32_t totalIndices()  { return b.totalIndices; }
    int outMetaPtr()  { return P(b.out.data()); } // PrimOut[primCount], 64 B each
    int posPtr()      { return P(b.pos.data()); } // f32[totalVerts*3]
    int nrmPtr()      { return P(b.nrm.data()); } // f32[totalVerts*3]
    int uvPtr()       { return P(b.uv.data()); }  // f32[totalVerts*2]
    int tanPtr()      { return P(b.tan.data()); } // f32[totalVerts*4] (0 if no tangents)
    int idxPtr()      { return P(b.idx.data()); } // u32[totalIndices]
};

// PIPELINE B — full C++ GLB/glTF decode. JS hands over the blob, calls process()
// once, then reads ONE toc int32 array that carries every pointer + count +
// timing. See web/asset/native.ts.
struct GltfPipeline {
    Pipeline pl;

    // JS writes the GLB bytes into WASM memory at inPtr()[0..cap); loadGLB copies
    // them into the pipeline's own blob and parses container + JSON + metadata.
    std::vector<uint8_t> inbuf;
    void reserveInput(uint32_t n) { inbuf.resize(n); }
    int  inputPtr() { return P(inbuf.data()); }
    uint32_t loadGLB(uint32_t len) { return pl.loadGLB(inbuf.data(), len); }

    uint32_t process(uint32_t flags) { return pl.process(flags); }
    int  tocPtr() { return pl.tocPtr(); }               // int32[TOC__COUNT]
    int  tocCount() { return (int)TOC__COUNT; }
    int  errorPtr() { return P(pl.doc.error.data()); }
    int  errorLen() { return (int)pl.doc.error.size(); }
};
// MeshMerger — bake N transformed source meshes into one. JS packs every
// source mesh's geometry contiguously into the input buffers and writes one
// descriptor row per item; C++ concatenates + world-bakes in a single call and
// hands back views over the merged geometry (+ a per-vertex source id).
//
// desc row (7 × int32):  vBase, vCount, iBase, iCount, flags(bit0 nrm|bit1 uv), id, _pad
// world:                 16 × float32 per item (row-major, Babylon), identity if all-zero
struct MeshMerger {
    static constexpr uint32_t DESC_I32 = 7;

    std::vector<float>    inPos, inNrm, inUv;
    std::vector<uint32_t> inIdx;
    std::vector<int32_t>  desc;
    std::vector<float>    world;
    bcpp::MergedGeometry  out;

    void reserveInput(uint32_t totalVerts, uint32_t totalIndices, uint32_t itemCount) {
        inPos.assign((size_t)totalVerts * 3, 0.0f);
        inNrm.assign((size_t)totalVerts * 3, 0.0f);
        inUv.assign((size_t)totalVerts * 2, 0.0f);
        inIdx.assign(totalIndices, 0u);
        desc.assign((size_t)itemCount * DESC_I32, 0);
        world.assign((size_t)itemCount * 16, 0.0f);
    }
    int inPosPtr() { return P(inPos.data()); }
    int inNrmPtr() { return P(inNrm.data()); }
    int inUvPtr()  { return P(inUv.data()); }
    int inIdxPtr() { return P(inIdx.data()); }
    int descPtr()  { return P(desc.data()); }
    int worldPtr() { return P(world.data()); }

    uint32_t merge(uint32_t itemCount) {
        std::vector<bcpp::MergeItem> items(itemCount);
        for (uint32_t k = 0; k < itemCount; ++k) {
            const int32_t* d = &desc[(size_t)k * DESC_I32];
            const uint32_t vBase = (uint32_t)d[0], vCount = (uint32_t)d[1];
            const uint32_t iBase = (uint32_t)d[2], iCount = (uint32_t)d[3];
            const int32_t  fl    = d[4];
            const uint32_t id    = (uint32_t)d[5];
            const float* w = &world[(size_t)k * 16];
            bool wIdentity = true;
            for (int j = 0; j < 16 && wIdentity; ++j) wIdentity = (w[j] == 0.0f);
            items[k] = bcpp::MergeItem{
                &inPos[(size_t)vBase * 3],
                (fl & 1) ? &inNrm[(size_t)vBase * 3] : nullptr,
                (fl & 2) ? &inUv[(size_t)vBase * 2]  : nullptr,
                &inIdx[iBase],
                vCount, iCount,
                wIdentity ? nullptr : w,
                id,
            };
        }
        bcpp::mergeMeshes(items.data(), itemCount, out);
        return out.vertexCount;
    }

    uint32_t outVertexCount() { return out.vertexCount; }
    uint32_t outIndexCount()  { return out.indexCount; }
    uint32_t outHasNrm()      { return out.nrm.empty() ? 0u : 1u; }
    uint32_t outHasUv()       { return out.uv.empty()  ? 0u : 1u; }
    int outPosPtr() { return P(out.pos.data()); }   // f32[vertexCount*3]
    int outNrmPtr() { return P(out.nrm.data()); }   // f32[vertexCount*3] (0 if outHasNrm()==0)
    int outUvPtr()  { return P(out.uv.data()); }    // f32[vertexCount*2] (0 if outHasUv()==0)
    int outIdxPtr() { return P(out.idx.data()); }   // u32[indexCount]
    int outIdPtr()  { return P(out.id.data()); }    // u32[vertexCount] — source item id per vertex
};

} // namespace

EMSCRIPTEN_BINDINGS(bcpp_asset) {
    emscripten::class_<GltfBatch>("GltfBatch")
        .constructor<>()
        .function("reserveBin", &GltfBatch::reserveBin)
        .function("setPrimCount", &GltfBatch::setPrimCount)
        .function("binPtr", &GltfBatch::binPtr)
        .function("descPtr", &GltfBatch::descPtr)
        .function("process", &GltfBatch::process)
        .function("totalVertices", &GltfBatch::totalVertices)
        .function("totalIndices", &GltfBatch::totalIndices)
        .function("outMetaPtr", &GltfBatch::outMetaPtr)
        .function("posPtr", &GltfBatch::posPtr)
        .function("nrmPtr", &GltfBatch::nrmPtr)
        .function("uvPtr", &GltfBatch::uvPtr)
        .function("tanPtr", &GltfBatch::tanPtr)
        .function("idxPtr", &GltfBatch::idxPtr);

    emscripten::class_<GltfPipeline>("GltfPipeline")
        .constructor<>()
        .function("reserveInput", &GltfPipeline::reserveInput)
        .function("inputPtr", &GltfPipeline::inputPtr)
        .function("loadGLB", &GltfPipeline::loadGLB)
        .function("process", &GltfPipeline::process)
        .function("tocPtr", &GltfPipeline::tocPtr)
        .function("tocCount", &GltfPipeline::tocCount)
        .function("errorPtr", &GltfPipeline::errorPtr)
        .function("errorLen", &GltfPipeline::errorLen);

    emscripten::class_<MeshMerger>("MeshMerger")
        .constructor<>()
        .function("reserveInput", &MeshMerger::reserveInput)
        .function("inPosPtr", &MeshMerger::inPosPtr)
        .function("inNrmPtr", &MeshMerger::inNrmPtr)
        .function("inUvPtr", &MeshMerger::inUvPtr)
        .function("inIdxPtr", &MeshMerger::inIdxPtr)
        .function("descPtr", &MeshMerger::descPtr)
        .function("worldPtr", &MeshMerger::worldPtr)
        .function("merge", &MeshMerger::merge)
        .function("outVertexCount", &MeshMerger::outVertexCount)
        .function("outIndexCount", &MeshMerger::outIndexCount)
        .function("outHasNrm", &MeshMerger::outHasNrm)
        .function("outHasUv", &MeshMerger::outHasUv)
        .function("outPosPtr", &MeshMerger::outPosPtr)
        .function("outNrmPtr", &MeshMerger::outNrmPtr)
        .function("outUvPtr", &MeshMerger::outUvPtr)
        .function("outIdxPtr", &MeshMerger::outIdxPtr)
        .function("outIdPtr", &MeshMerger::outIdPtr);
}
#endif
