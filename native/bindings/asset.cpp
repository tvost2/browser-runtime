// embind surface for batch glTF geometry processing (bcpp::gltf::Batch).
// Same contract as the World bindings: JS writes into WASM-owned buffers,
// calls process() once, reads outputs as typed-array views. No per-element
// calls.

#ifdef __EMSCRIPTEN__
#include <emscripten/bind.h>
#include "bcpp/gltf.hpp"
#include "bcpp/gltf_pipeline.hpp"

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
}
#endif
