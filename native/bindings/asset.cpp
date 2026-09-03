// embind surface for batch glTF geometry processing (bcpp::gltf::Batch).
// Same contract as the World bindings: JS writes into WASM-owned buffers,
// calls process() once, reads outputs as typed-array views. No per-element
// calls.

#ifdef __EMSCRIPTEN__
#include <emscripten/bind.h>
#include "bcpp/gltf.hpp"

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
}
#endif
