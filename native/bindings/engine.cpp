// engine.cpp — the ONE embind surface for the WASM-first runtime.
//
// Contract: JS writes component data straight into WASM-owned staging arrays
// (pointers below), then calls evaluate() once per frame. Results are read back
// as typed-array views over WASM memory. There are deliberately NO per-entity
// entry points — the whole hot path is `evaluate`.

#ifdef __EMSCRIPTEN__
#include <emscripten/bind.h>
#include "bcpp/world.hpp"

using namespace bcpp;
using emscripten::val;

namespace {

// int (not uintptr_t) — wasm32 pointers fit, and embind maps int cleanly.
static int P(const void* p) { return (int)(intptr_t)p; }

struct WasmWorld {
    World w;
    float viewProj[16] = {1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1};

    void resize(uint32_t n) { w.resize(n); }
    void setCount(uint32_t n) { w.setCount(n); }

    // staging inputs (JS writes here in bulk)
    int posPtr()      { return P(w.localPos.data()); }   // f32 x3 x count
    int rotPtr()      { return P(w.localRot.data()); }   // f32 x4 x count
    int scalePtr()    { return P(w.localScale.data()); } // f32 x3 x count
    int parentPtr()   { return P(w.parent.data()); }     // i32 x count
    int localMinPtr() { return P(w.localMin.data()); }   // f32 x3 x count
    int localMaxPtr() { return P(w.localMax.data()); }   // f32 x3 x count
    int meshIdPtr()   { return P(w.meshId.data()); }     // u32 x count
    int materialIdPtr(){ return P(w.materialId.data()); }// u32 x count
    int flagsPtr()    { return P(w.flags.data()); }      // u32 x count
    int dirtyPtr()    { return P(w.dirty.data()); }      // u8 x count — JS sets 1 when a local transform changes
    int viewProjPtr() { return P(viewProj); }            // f32 x16

    void markAllDirty() { w.markAllDirty(); }

    // one boundary crossing per frame. `hierarchyDirty` is tracked JS-side so
    // per-entity setParent() calls during scene build cost zero crossings.
    uint32_t evaluate(uint32_t strategy, bool sortByMesh, bool hierarchyDirty) {
        if (hierarchyDirty) w.markHierarchyDirty();
        Mat4 vp;
        for (int i = 0; i < 16; ++i) vp.m[i] = viewProj[i];
        w.evaluate(vp, static_cast<CullStrategy>(strategy), sortByMesh);
        return w.stats.visible;
    }

    // structured render list (views valid until next evaluate/resize)
    int visibleIdPtr()      { return P(w.visibleId.data()); }        // u32 x visible
    int instanceWorldPtr()  { return P(w.instanceWorld.data()); }    // f32 x16 x visible
    int instanceMeshIdPtr() { return P(w.instanceMeshId.data()); }   // u32 x visible
    int batchesPtr()        { return P(w.batches.data()); }          // {u32 mesh,u32 first,u32 count} x batchCount
    uint32_t batchCount()   { return (uint32_t)w.batches.size(); }
    int worldMatricesPtr()  { return P(w.world.data()); }            // f32 x16 x count (ALL entities)
    int worldSpherePtr()    { return P(w.worldSphere.data()); }      // f32 x4 x count
    int worldMinPtr()       { return P(w.worldMin.data()); }         // f32 x3 x count
    int worldMaxPtr()       { return P(w.worldMax.data()); }         // f32 x3 x count

    // stats
    uint32_t sVisible()       { return w.stats.visible; }
    uint32_t sTraversed()     { return w.stats.traversed; }
    uint32_t sCulledDisabled(){ return w.stats.culledDisabled; }
    uint32_t sCulledFrustum() { return w.stats.culledFrustum; }
    uint32_t sBatches()       { return w.stats.batches; }
    uint32_t sHierRebuilds()  { return w.stats.hierarchyRebuilds; }
    uint32_t sTransformsRecomputed() { return w.stats.transformsRecomputed; }
    uint32_t sFrameChanged() { return w.stats.frameChanged; }
    uint32_t sBvhBuilds()    { return w.stats.bvhBuilds; }
    uint32_t sBvhNodes()     { return w.stats.bvhNodes; }

    // ---- spatial queries ----
    float _rayT = 0;
    int raycast(float ox, float oy, float oz, float dx, float dy, float dz, float maxT) {
        float t;
        uint32_t hit = w.raycast({ox, oy, oz}, {dx, dy, dz}, maxT, t);
        _rayT = t;
        return hit == UINT32_MAX ? -1 : (int)hit;
    }
    float raycastT() { return _rayT; }

    std::vector<uint32_t> _queryResult;
    uint32_t queryBox(float minx, float miny, float minz, float maxx, float maxy, float maxz) {
        _queryResult.clear();
        w.queryBox({minx, miny, minz}, {maxx, maxy, maxz}, _queryResult);
        return (uint32_t)_queryResult.size();
    }
    int queryResultPtr() { return P(_queryResult.data()); }  // u32 x (last queryBox return)
};

} // namespace

EMSCRIPTEN_BINDINGS(bcpp_engine) {
    emscripten::class_<WasmWorld>("World")
        .constructor<>()
        .function("resize", &WasmWorld::resize)
        .function("setCount", &WasmWorld::setCount)
        .function("posPtr", &WasmWorld::posPtr)
        .function("rotPtr", &WasmWorld::rotPtr)
        .function("scalePtr", &WasmWorld::scalePtr)
        .function("parentPtr", &WasmWorld::parentPtr)
        .function("localMinPtr", &WasmWorld::localMinPtr)
        .function("localMaxPtr", &WasmWorld::localMaxPtr)
        .function("meshIdPtr", &WasmWorld::meshIdPtr)
        .function("materialIdPtr", &WasmWorld::materialIdPtr)
        .function("flagsPtr", &WasmWorld::flagsPtr)
        .function("dirtyPtr", &WasmWorld::dirtyPtr)
        .function("markAllDirty", &WasmWorld::markAllDirty)
        .function("viewProjPtr", &WasmWorld::viewProjPtr)
        .function("evaluate", &WasmWorld::evaluate)
        .function("visibleIdPtr", &WasmWorld::visibleIdPtr)
        .function("instanceWorldPtr", &WasmWorld::instanceWorldPtr)
        .function("instanceMeshIdPtr", &WasmWorld::instanceMeshIdPtr)
        .function("batchesPtr", &WasmWorld::batchesPtr)
        .function("batchCount", &WasmWorld::batchCount)
        .function("worldMatricesPtr", &WasmWorld::worldMatricesPtr)
        .function("worldSpherePtr", &WasmWorld::worldSpherePtr)
        .function("worldMinPtr", &WasmWorld::worldMinPtr)
        .function("worldMaxPtr", &WasmWorld::worldMaxPtr)
        .function("sVisible", &WasmWorld::sVisible)
        .function("sTraversed", &WasmWorld::sTraversed)
        .function("sCulledDisabled", &WasmWorld::sCulledDisabled)
        .function("sCulledFrustum", &WasmWorld::sCulledFrustum)
        .function("sBatches", &WasmWorld::sBatches)
        .function("sHierRebuilds", &WasmWorld::sHierRebuilds)
        .function("sTransformsRecomputed", &WasmWorld::sTransformsRecomputed)
        .function("sFrameChanged", &WasmWorld::sFrameChanged)
        .function("sBvhBuilds", &WasmWorld::sBvhBuilds)
        .function("sBvhNodes", &WasmWorld::sBvhNodes)
        .function("raycast", &WasmWorld::raycast)
        .function("raycastT", &WasmWorld::raycastT)
        .function("queryBox", &WasmWorld::queryBox)
        .function("queryResultPtr", &WasmWorld::queryResultPtr);
}
#endif
