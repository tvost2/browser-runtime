// bcpp/gltf_doc.hpp — GLB container split + glTF 2.0 metadata parse, in C++.
//
// This is PIPELINE B's front half: the same job web/asset/glb.ts + the metadata
// part of web/asset/gltf.ts do, but on the raw blob already sitting in WASM
// memory. Output is a data-oriented Document (flat POD arrays + a packed string
// blob) that JS reads back as typed-array views — no per-element crossing.
//
// Semantics mirror the JS reference exactly so the equivalence tests can compare.

#pragma once
#include <cstdint>
#include <cstring>
#include <cmath>
#include <string>
#include <vector>
#include "yyjson.h"

namespace bcpp::gltf {

// ---------------------------------------------------------------- container ----

struct Container {
    const uint8_t* json = nullptr; uint32_t jsonLen = 0;   // slices into the blob
    const uint8_t* bin  = nullptr; uint32_t binLen  = 0;
    uint32_t version = 0;
    bool ok = false;
    const char* error = "";
};

// GLB: 12-byte header (magic 'glTF', u32 version, u32 length) then chunks
// [u32 len][u32 type][data]. JSON = 0x4E4F534A, BIN = 0x004E4942.
inline Container parseContainer(const uint8_t* blob, uint32_t len) {
    Container c;
    if (len < 12) { c.error = "blob shorter than a GLB header"; return c; }
    auto rd32 = [&](uint32_t o) { uint32_t v; std::memcpy(&v, blob + o, 4); return v; };
    if (rd32(0) != 0x46546C67u) {
        // plain .gltf (JSON text) — the whole blob is the JSON chunk
        c.json = blob; c.jsonLen = len; c.version = 2; c.ok = true; return c;
    }
    c.version = rd32(4);
    if (c.version != 2) { c.error = "unsupported GLB version (need 2)"; return c; }
    uint32_t declared = rd32(8);
    if (declared > len) { c.error = "GLB truncated (length > blob)"; return c; }
    uint32_t off = 12;
    while (off + 8 <= declared) {
        uint32_t clen = rd32(off), ctype = rd32(off + 4);
        uint32_t dstart = off + 8;
        if ((uint64_t)dstart + clen > len) { c.error = "GLB chunk overruns blob"; return c; }
        if (ctype == 0x4E4F534Au) { c.json = blob + dstart; c.jsonLen = clen; }
        else if (ctype == 0x004E4942u) { c.bin = blob + dstart; c.binLen = clen; }
        off = dstart + clen;
    }
    if (!c.json) { c.error = "GLB has no JSON chunk"; return c; }
    c.ok = true;
    return c;
}

// ------------------------------------------------------------ base64 (RFC4648) --

inline std::vector<uint8_t> base64Decode(const char* s, size_t n) {
    static int8_t T[256]; static bool init = false;
    if (!init) {
        for (int i = 0; i < 256; ++i) T[i] = -1;
        const char* A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        for (int i = 0; i < 64; ++i) T[(uint8_t)A[i]] = (int8_t)i;
        init = true;
    }
    std::vector<uint8_t> out;
    out.reserve(n * 3 / 4 + 3);
    int val = 0, bits = -8;
    for (size_t i = 0; i < n; ++i) {
        int8_t d = T[(uint8_t)s[i]];
        if (d < 0) continue;                 // skip '=' and whitespace
        val = (val << 6) | d; bits += 6;
        if (bits >= 0) { out.push_back((uint8_t)((val >> bits) & 0xFF)); bits -= 8; }
    }
    return out;
}

// ------------------------------------------------------------ POD metadata -----
// All fields 4 bytes; mirrored in web/asset/native.ts. -1 == absent.

struct DBufferView { int32_t buffer; uint32_t byteOffset, byteLength; int32_t byteStride; };
static_assert(sizeof(DBufferView) == 16, "");

struct DAccessor {
    int32_t  bufferView; uint32_t byteOffset;
    int32_t  componentType; uint32_t comps;   // comps: 1/2/3/4/9/16
    uint32_t normalized; uint32_t count;
    uint32_t hasMinMax; uint32_t sparse;
    float    mn[3]; float mx[3];
};
static_assert(sizeof(DAccessor) == 56, "");

struct DPrimitive {
    int32_t position, normal, texcoord0, tangent, color0, indices, material;
    int32_t mode;
};
static_assert(sizeof(DPrimitive) == 32, "");

struct DMesh { uint32_t primFirst, primCount; uint32_t nameOff, nameLen; };
static_assert(sizeof(DMesh) == 16, "");

struct DNode {
    float t[3]; float r[4]; float s[3];        // TRS (matrix already decomposed)
    int32_t mesh; int32_t parent; int32_t srcIndex;
    uint32_t nameOff, nameLen;
};
static_assert(sizeof(DNode) == 60, "");

struct DMaterial {
    float baseColorFactor[4];
    int32_t baseColorTexture;
    float metallic, roughness;
    float emissive[3];
    int32_t alphaMode;            // 0 opaque 1 mask 2 blend
    float alphaCutoff;
    uint32_t doubleSided;
    uint32_t nameOff, nameLen;
};
static_assert(sizeof(DMaterial) == 60, "");

struct DTexture { int32_t source, sampler; };
struct DSampler { int32_t magFilter, minFilter, wrapS, wrapT; };
struct DImage {
    int32_t bufferView;          // -1 if from a uri
    int32_t uriKind;             // 0 = in BIN via bufferView, 1 = data-URI (in auxbin), 2 = external (unavailable)
    uint32_t dataOffset, dataLen;// into BIN or auxbin
    uint32_t mimeOff, mimeLen;
};

struct Document {
    std::vector<DBufferView> bufferViews;
    std::vector<DAccessor>   accessors;
    std::vector<DPrimitive>  primitives;
    std::vector<DMesh>       meshes;
    std::vector<DNode>       nodes;        // topological, parents first
    std::vector<int32_t>     roots;
    std::vector<DMaterial>   materials;
    std::vector<DTexture>    textures;
    std::vector<DSampler>    samplers;
    std::vector<DImage>      images;
    std::vector<char>        strings;      // packed UTF-8; structs hold (off,len)
    std::vector<uint8_t>     auxbin;       // decoded data-URI buffers/images
    std::string              ignored;      // '\n'-joined, matches JS note() text
    bool ok = false;
    std::string error;

    uint32_t addString(const char* s, size_t n) {
        uint32_t off = (uint32_t)strings.size();
        strings.insert(strings.end(), s, s + n);
        return off;
    }
    void note(const std::string& s) {
        // de-dup like the JS `ignored` array
        size_t pos = 0;
        while (pos < ignored.size()) {
            size_t nl = ignored.find('\n', pos);
            if (nl == std::string::npos) nl = ignored.size();
            if (ignored.compare(pos, nl - pos, s) == 0) return;
            pos = nl + 1;
        }
        if (!ignored.empty()) ignored.push_back('\n');
        ignored += s;
    }
};

// ------------------------------------------------------------- yyjson helpers --

inline yyjson_val* obj_get(yyjson_val* o, const char* k) { return o ? yyjson_obj_get(o, k) : nullptr; }
inline int32_t   ji(yyjson_val* v, int32_t d = 0) { return v && yyjson_is_int(v) ? (int32_t)yyjson_get_sint(v) : (v && yyjson_is_num(v) ? (int32_t)yyjson_get_num(v) : d); }
inline uint32_t  ju(yyjson_val* v, uint32_t d = 0) { return v && yyjson_is_num(v) ? (uint32_t)yyjson_get_num(v) : d; }
inline double    jd(yyjson_val* v, double d = 0) { return v && yyjson_is_num(v) ? yyjson_get_num(v) : d; }
inline bool      jb(yyjson_val* v, bool d = false) { return v && yyjson_is_bool(v) ? yyjson_get_bool(v) : d; }
inline const char* js(yyjson_val* v, size_t* n) { if (v && yyjson_is_str(v)) { *n = yyjson_get_len(v); return yyjson_get_str(v); } *n = 0; return nullptr; }

inline uint32_t typeComps(const char* t, size_t n) {
    if (!t) return 1;
    if (n == 6 && !std::memcmp(t, "SCALAR", 6)) return 1;
    if (n == 4 && !std::memcmp(t, "VEC2", 4)) return 2;
    if (n == 4 && !std::memcmp(t, "VEC3", 4)) return 3;
    if (n == 4 && !std::memcmp(t, "VEC4", 4)) return 4;
    if (n == 4 && !std::memcmp(t, "MAT2", 4)) return 4;
    if (n == 4 && !std::memcmp(t, "MAT3", 4)) return 9;
    if (n == 4 && !std::memcmp(t, "MAT4", 4)) return 16;
    return 1;
}

// column-major mat4 -> TRS (mirrors decomposeColumnMajor in gltf.ts)
inline void decomposeColumnMajor(const double m[16], float t[3], float r[4], float s[3]) {
    t[0] = (float)m[12]; t[1] = (float)m[13]; t[2] = (float)m[14];
    double sx = std::sqrt(m[0]*m[0] + m[1]*m[1] + m[2]*m[2]);
    double sy = std::sqrt(m[4]*m[4] + m[5]*m[5] + m[6]*m[6]);
    double sz = std::sqrt(m[8]*m[8] + m[9]*m[9] + m[10]*m[10]);
    double det = m[0]*(m[5]*m[10]-m[6]*m[9]) - m[4]*(m[1]*m[10]-m[2]*m[9]) + m[8]*(m[1]*m[6]-m[2]*m[5]);
    if (det < 0) sz = -sz;
    double R[9] = { m[0]/sx, m[1]/sx, m[2]/sx, m[4]/sy, m[5]/sy, m[6]/sy, m[8]/sz, m[9]/sz, m[10]/sz };
    double tr = R[0] + R[4] + R[8], qx, qy, qz, qw;
    if (tr > 0) { double u = std::sqrt(tr + 1) * 2; qw = u/4; qx = (R[7]-R[5])/u; qy = (R[2]-R[6])/u; qz = (R[3]-R[1])/u; }
    else if (R[0] > R[4] && R[0] > R[8]) { double u = std::sqrt(1 + R[0] - R[4] - R[8]) * 2; qw = (R[7]-R[5])/u; qx = u/4; qy = (R[1]+R[3])/u; qz = (R[2]+R[6])/u; }
    else if (R[4] > R[8]) { double u = std::sqrt(1 + R[4] - R[0] - R[8]) * 2; qw = (R[2]-R[6])/u; qx = (R[1]+R[3])/u; qy = u/4; qz = (R[5]+R[7])/u; }
    else { double u = std::sqrt(1 + R[8] - R[0] - R[4]) * 2; qw = (R[3]-R[1])/u; qx = (R[2]+R[6])/u; qy = (R[5]+R[7])/u; qz = u/4; }
    r[0] = (float)qx; r[1] = (float)qy; r[2] = (float)qz; r[3] = (float)qw;
    s[0] = (float)sx; s[1] = (float)sy; s[2] = (float)sz;
}

// ------------------------------------------------------------- metadata parse --
// `bin` is the container BIN slice (may be null). Fills `doc`.
inline void parseMetadata(yyjson_doc* jd_, const Container& c, Document& doc) {
    yyjson_val* root = yyjson_doc_get_root(jd_);
    if (!root || !yyjson_is_obj(root)) { doc.error = "glTF root is not an object"; return; }

    auto arr = [&](const char* k) -> yyjson_val* { yyjson_val* v = yyjson_obj_get(root, k); return (v && yyjson_is_arr(v)) ? v : nullptr; };
    size_t sn;

    // asset.version check
    if (yyjson_val* a = obj_get(obj_get(root, "asset"), "version")) {
        const char* v = js(a, &sn);
        if (v && sn && v[0] != '2') { doc.error = "glTF asset version is not 2.x"; return; }
    }

    for (yyjson_val* e : { arr("extensionsRequired"), arr("extensionsUsed") }) {}
    if (yyjson_val* er = arr("extensionsRequired")) {
        size_t i, m; yyjson_val* v;
        yyjson_arr_foreach(er, i, m, v) { const char* s = js(v, &sn); if (s) doc.note("extensionsRequired: " + std::string(s, sn) + " (not supported)"); }
    }
    if (yyjson_val* eu = arr("extensionsUsed")) {
        size_t i, m; yyjson_val* v;
        yyjson_arr_foreach(eu, i, m, v) { const char* s = js(v, &sn); if (s) doc.note("extensionsUsed: " + std::string(s, sn) + " (ignored)"); }
    }
    if (yyjson_val* an = arr("animations")) doc.note(std::to_string(yyjson_arr_size(an)) + " animation(s) (Phase 8)");
    if (yyjson_val* sk = arr("skins"))      doc.note(std::to_string(yyjson_arr_size(sk)) + " skin(s) (Phase 9)");
    if (yyjson_val* cm = arr("cameras"))    doc.note(std::to_string(yyjson_arr_size(cm)) + " camera(s) (Phase 3 owns cameras)");

    // buffers — only needed to know uriKind; buffer 0 with no uri == BIN.
    // data-URI buffers are decoded into doc.auxbin (offset tracked per buffer).
    std::vector<int32_t> bufKind;      // 0 BIN, 1 auxbin, 2 external
    std::vector<uint32_t> bufAux;      // offset into auxbin for kind 1
    if (yyjson_val* bufs = arr("buffers")) {
        size_t i, m; yyjson_val* v;
        yyjson_arr_foreach(bufs, i, m, v) {
            yyjson_val* uri = obj_get(v, "uri");
            if (!uri) { bufKind.push_back(0); bufAux.push_back(0); }
            else {
                const char* u = js(uri, &sn);
                if (u && sn > 5 && !std::memcmp(u, "data:", 5)) {
                    const char* comma = (const char*)std::memchr(u, ',', sn);
                    std::vector<uint8_t> d = comma ? base64Decode(comma + 1, sn - (comma + 1 - u)) : std::vector<uint8_t>{};
                    uint32_t off = (uint32_t)doc.auxbin.size();
                    doc.auxbin.insert(doc.auxbin.end(), d.begin(), d.end());
                    bufKind.push_back(1); bufAux.push_back(off);
                } else {
                    bufKind.push_back(2); bufAux.push_back(0);
                    doc.note("buffer " + std::to_string(i) + ": external uri (no resolver)");
                }
            }
        }
    }

    // bufferViews
    if (yyjson_val* bvs = arr("bufferViews")) {
        size_t i, m; yyjson_val* v;
        yyjson_arr_foreach(bvs, i, m, v) {
            DBufferView bv;
            bv.buffer     = ji(obj_get(v, "buffer"), 0);
            bv.byteOffset = ju(obj_get(v, "byteOffset"), 0);
            bv.byteLength = ju(obj_get(v, "byteLength"), 0);
            bv.byteStride = obj_get(v, "byteStride") ? ji(obj_get(v, "byteStride")) : -1;
            doc.bufferViews.push_back(bv);
        }
    }

    // accessors
    if (yyjson_val* accs = arr("accessors")) {
        size_t i, m; yyjson_val* v;
        yyjson_arr_foreach(accs, i, m, v) {
            DAccessor a{};
            a.bufferView    = obj_get(v, "bufferView") ? ji(obj_get(v, "bufferView")) : -1;
            a.byteOffset    = ju(obj_get(v, "byteOffset"), 0);
            a.componentType = ji(obj_get(v, "componentType"), 5126);
            const char* tp  = js(obj_get(v, "type"), &sn);
            a.comps         = typeComps(tp, sn);
            a.normalized    = jb(obj_get(v, "normalized"), false) ? 1u : 0u;
            a.count         = ju(obj_get(v, "count"), 0);
            a.sparse        = obj_get(v, "sparse") ? 1u : 0u;
            yyjson_val* mn = obj_get(v, "min"); yyjson_val* mx = obj_get(v, "max");
            if (mn && mx && yyjson_is_arr(mn) && yyjson_is_arr(mx) && yyjson_arr_size(mn) >= 3) {
                a.hasMinMax = 1;
                for (int k = 0; k < 3; ++k) { a.mn[k] = (float)jd(yyjson_arr_get(mn, k)); a.mx[k] = (float)jd(yyjson_arr_get(mx, k)); }
            }
            if (a.sparse) doc.note("accessor " + std::to_string(i) + ": sparse (densified via copy)");
            doc.accessors.push_back(a);
        }
    }

    // meshes / primitives
    bool genTanNoted = false;
    if (yyjson_val* ms = arr("meshes")) {
        size_t mi, mm; yyjson_val* mv;
        yyjson_arr_foreach(ms, mi, mm, mv) {
            DMesh mesh{};
            mesh.primFirst = (uint32_t)doc.primitives.size();
            const char* nm = js(obj_get(mv, "name"), &sn);
            if (nm) { mesh.nameOff = doc.addString(nm, sn); mesh.nameLen = (uint32_t)sn; }
            yyjson_val* prims = obj_get(mv, "primitives");
            size_t pi, pm; yyjson_val* pv;
            if (prims && yyjson_is_arr(prims)) yyjson_arr_foreach(prims, pi, pm, pv) {
                DPrimitive p{ -1,-1,-1,-1,-1,-1,-1, 4 };
                yyjson_val* at = obj_get(pv, "attributes");
                if (at) {
                    p.position  = obj_get(at, "POSITION")   ? ji(obj_get(at, "POSITION"))   : -1;
                    p.normal    = obj_get(at, "NORMAL")     ? ji(obj_get(at, "NORMAL"))     : -1;
                    p.texcoord0 = obj_get(at, "TEXCOORD_0") ? ji(obj_get(at, "TEXCOORD_0")) : -1;
                    p.tangent   = obj_get(at, "TANGENT")    ? ji(obj_get(at, "TANGENT"))    : -1;
                    p.color0    = obj_get(at, "COLOR_0")    ? ji(obj_get(at, "COLOR_0"))    : -1;
                    // unknown attributes
                    size_t ai, am; yyjson_val* akv; yyjson_obj_iter it = yyjson_obj_iter_with(at);
                    while ((akv = yyjson_obj_iter_next(&it))) {
                        const char* k = js(akv, &sn);
                        if (k && !(sn==8&&!std::memcmp(k,"POSITION",8)) && !(sn==6&&!std::memcmp(k,"NORMAL",6))
                              && !(sn==10&&!std::memcmp(k,"TEXCOORD_0",10)) && !(sn==7&&!std::memcmp(k,"COLOR_0",7))
                              && !(sn==7&&!std::memcmp(k,"TANGENT",7)))
                            doc.note("attribute " + std::string(k, sn) + " (ignored)");
                    }
                }
                p.indices  = obj_get(pv, "indices")  ? ji(obj_get(pv, "indices"))  : -1;
                p.material = obj_get(pv, "material") ? ji(obj_get(pv, "material")) : -1;
                p.mode     = obj_get(pv, "mode") ? ji(obj_get(pv, "mode"), 4) : 4;
                if (p.mode != 4) doc.note("mesh " + std::to_string(mi) + " primitive " + std::to_string(pi) + ": mode " + std::to_string(p.mode) + " (only TRIANGLES=4)");
                if (p.tangent >= 0 && !genTanNoted) { doc.note("TANGENT (ignored — pass generateTangents to regenerate)"); genTanNoted = true; }
                if (p.color0 >= 0) doc.note("mesh " + std::to_string(mi) + " primitive " + std::to_string(pi) + ": COLOR_0 (js path only)");
                doc.primitives.push_back(p);
            }
            mesh.primCount = (uint32_t)doc.primitives.size() - mesh.primFirst;
            doc.meshes.push_back(mesh);
        }
    }

    // materials
    if (yyjson_val* mats = arr("materials")) {
        size_t i, m; yyjson_val* v;
        yyjson_arr_foreach(mats, i, m, v) {
            DMaterial mt{};
            mt.baseColorFactor[0] = mt.baseColorFactor[1] = mt.baseColorFactor[2] = mt.baseColorFactor[3] = 1.f;
            mt.metallic = 1.f; mt.roughness = 1.f; mt.baseColorTexture = -1; mt.alphaCutoff = 0.5f;
            yyjson_val* pbr = obj_get(v, "pbrMetallicRoughness");
            if (pbr) {
                if (yyjson_val* bcf = obj_get(pbr, "baseColorFactor"); bcf && yyjson_is_arr(bcf))
                    for (int k = 0; k < 4 && k < (int)yyjson_arr_size(bcf); ++k) mt.baseColorFactor[k] = (float)jd(yyjson_arr_get(bcf, k));
                if (yyjson_val* bct = obj_get(pbr, "baseColorTexture")) mt.baseColorTexture = ji(obj_get(bct, "index"), -1);
                if (obj_get(pbr, "metallicFactor"))  mt.metallic  = (float)jd(obj_get(pbr, "metallicFactor"), 1);
                if (obj_get(pbr, "roughnessFactor")) mt.roughness = (float)jd(obj_get(pbr, "roughnessFactor"), 1);
                if (obj_get(pbr, "metallicRoughnessTexture")) doc.note("material " + std::to_string(i) + ": metallicRoughnessTexture (Phase 5)");
            }
            if (obj_get(v, "normalTexture"))    doc.note("material " + std::to_string(i) + ": normalTexture (Phase 5)");
            if (obj_get(v, "occlusionTexture")) doc.note("material " + std::to_string(i) + ": occlusionTexture (Phase 5)");
            if (yyjson_val* ef = obj_get(v, "emissiveFactor"); ef && yyjson_is_arr(ef))
                for (int k = 0; k < 3 && k < (int)yyjson_arr_size(ef); ++k) mt.emissive[k] = (float)jd(yyjson_arr_get(ef, k));
            const char* am = js(obj_get(v, "alphaMode"), &sn);
            mt.alphaMode = (am && sn == 4 && !std::memcmp(am, "MASK", 4)) ? 1 : (am && sn == 5 && !std::memcmp(am, "BLEND", 5)) ? 2 : 0;
            if (obj_get(v, "alphaCutoff")) mt.alphaCutoff = (float)jd(obj_get(v, "alphaCutoff"), 0.5);
            mt.doubleSided = jb(obj_get(v, "doubleSided"), false) ? 1u : 0u;
            const char* nm = js(obj_get(v, "name"), &sn);
            if (nm) { mt.nameOff = doc.addString(nm, sn); mt.nameLen = (uint32_t)sn; }
            doc.materials.push_back(mt);
        }
    }

    // samplers / textures
    if (yyjson_val* sm = arr("samplers")) {
        size_t i, m; yyjson_val* v;
        yyjson_arr_foreach(sm, i, m, v) {
            DSampler s;
            s.magFilter = obj_get(v, "magFilter") ? ji(obj_get(v, "magFilter")) : 9729;
            s.minFilter = obj_get(v, "minFilter") ? ji(obj_get(v, "minFilter")) : 9987;
            s.wrapS     = obj_get(v, "wrapS") ? ji(obj_get(v, "wrapS")) : 10497;
            s.wrapT     = obj_get(v, "wrapT") ? ji(obj_get(v, "wrapT")) : 10497;
            doc.samplers.push_back(s);
        }
    }
    if (yyjson_val* tx = arr("textures")) {
        size_t i, m; yyjson_val* v;
        yyjson_arr_foreach(tx, i, m, v) {
            DTexture t;
            t.source  = obj_get(v, "source") ? ji(obj_get(v, "source")) : 0;
            t.sampler = obj_get(v, "sampler") ? ji(obj_get(v, "sampler")) : -1;
            doc.textures.push_back(t);
        }
    }

    // images — resolve byte range now (BIN via bufferView, or data-URI into auxbin)
    if (yyjson_val* im = arr("images")) {
        size_t i, m; yyjson_val* v;
        yyjson_arr_foreach(im, i, m, v) {
            DImage img{ -1, 2, 0, 0, 0, 0 };
            const char* mime = js(obj_get(v, "mimeType"), &sn);
            if (mime) { img.mimeOff = doc.addString(mime, sn); img.mimeLen = (uint32_t)sn; }
            yyjson_val* bvi = obj_get(v, "bufferView");
            if (bvi) {
                int32_t bvIdx = ji(bvi);
                if (bvIdx >= 0 && bvIdx < (int32_t)doc.bufferViews.size()) {
                    const DBufferView& bv = doc.bufferViews[bvIdx];
                    img.bufferView = bvIdx; img.uriKind = 0;
                    img.dataOffset = bv.byteOffset; img.dataLen = bv.byteLength;
                }
                if (img.mimeLen == 0) { const char* png = "image/png"; img.mimeOff = doc.addString(png, 9); img.mimeLen = 9; }
            } else if (const char* u = js(obj_get(v, "uri"), &sn); u && sn > 5 && !std::memcmp(u, "data:", 5)) {
                const char* comma = (const char*)std::memchr(u, ',', sn);
                std::vector<uint8_t> d = comma ? base64Decode(comma + 1, sn - (comma + 1 - u)) : std::vector<uint8_t>{};
                img.uriKind = 1; img.dataOffset = (uint32_t)doc.auxbin.size(); img.dataLen = (uint32_t)d.size();
                doc.auxbin.insert(doc.auxbin.end(), d.begin(), d.end());
                // mime from "data:<mime>;base64," if not given
                if (img.mimeLen == 0) {
                    const char* semi = (const char*)std::memchr(u, ';', sn);
                    if (semi && semi > u + 5) { img.mimeOff = doc.addString(u + 5, semi - (u + 5)); img.mimeLen = (uint32_t)(semi - (u + 5)); }
                }
            } else if (obj_get(v, "uri")) {
                doc.note("image " + std::to_string(i) + ": external uri (no resolver)");
            }
            doc.images.push_back(img);
        }
    }

    // nodes — topological order (parents first), matrix -> TRS, parent index
    yyjson_val* ns = arr("nodes");
    uint32_t nodeCount = ns ? (uint32_t)yyjson_arr_size(ns) : 0;
    std::vector<yyjson_val*> nv(nodeCount);
    std::vector<int32_t> parentOf(nodeCount, -1);
    std::vector<std::vector<int32_t>> childrenOf(nodeCount);
    if (ns) {
        size_t i, m; yyjson_val* v;
        yyjson_arr_foreach(ns, i, m, v) {
            nv[i] = v;
            if (yyjson_val* ch = obj_get(v, "children"); ch && yyjson_is_arr(ch)) {
                size_t ci, cm; yyjson_val* cvv;
                yyjson_arr_foreach(ch, ci, cm, cvv) {
                    int32_t c = ji(cvv);
                    if (c >= 0 && c < (int32_t)nodeCount) { parentOf[c] = (int32_t)i; childrenOf[i].push_back(c); }
                }
            }
        }
    }
    // scene roots
    std::vector<int32_t> sceneRoots;
    {
        yyjson_val* scenes = arr("scenes");
        int32_t sceneIdx = obj_get(root, "scene") ? ji(obj_get(root, "scene"), 0) : 0;
        yyjson_val* sc = scenes ? yyjson_arr_get(scenes, sceneIdx) : nullptr;
        yyjson_val* sn2 = obj_get(sc, "nodes");
        if (sn2 && yyjson_is_arr(sn2)) { size_t i, m; yyjson_val* v; yyjson_arr_foreach(sn2, i, m, v) sceneRoots.push_back(ji(v)); }
        else for (uint32_t i = 0; i < nodeCount; ++i) if (parentOf[i] == -1) sceneRoots.push_back((int32_t)i);
    }
    std::vector<int32_t> order; order.reserve(nodeCount);
    std::vector<uint8_t> seen(nodeCount, 0);
    // iterative DFS matching the JS recursive walk order
    auto walk = [&](int32_t start) {
        std::vector<int32_t> stack{ start };
        while (!stack.empty()) {
            int32_t i = stack.back(); stack.pop_back();
            if (i < 0 || i >= (int32_t)nodeCount || seen[i]) continue;
            seen[i] = 1; order.push_back(i);
            const auto& ch = childrenOf[i];
            for (auto it = ch.rbegin(); it != ch.rend(); ++it) stack.push_back(*it);
        }
    };
    for (int32_t r : sceneRoots) walk(r);
    for (uint32_t i = 0; i < nodeCount; ++i) walk((int32_t)i);

    std::vector<int32_t> remap(nodeCount, -1);
    for (uint32_t ni = 0; ni < order.size(); ++ni) remap[order[ni]] = (int32_t)ni;

    for (int32_t oldIdx : order) {
        yyjson_val* v = nv[oldIdx];
        DNode n{};
        n.t[0] = n.t[1] = n.t[2] = 0; n.r[0] = n.r[1] = n.r[2] = 0; n.r[3] = 1; n.s[0] = n.s[1] = n.s[2] = 1;
        n.srcIndex = oldIdx;
        if (yyjson_val* mx = obj_get(v, "matrix"); mx && yyjson_is_arr(mx) && yyjson_arr_size(mx) == 16) {
            double m[16]; for (int k = 0; k < 16; ++k) m[k] = jd(yyjson_arr_get(mx, k));
            decomposeColumnMajor(m, n.t, n.r, n.s);
        } else {
            if (yyjson_val* tr = obj_get(v, "translation"); tr && yyjson_is_arr(tr)) for (int k = 0; k < 3; ++k) n.t[k] = (float)jd(yyjson_arr_get(tr, k));
            if (yyjson_val* ro = obj_get(v, "rotation"); ro && yyjson_is_arr(ro)) for (int k = 0; k < 4; ++k) n.r[k] = (float)jd(yyjson_arr_get(ro, k));
            if (yyjson_val* sc = obj_get(v, "scale"); sc && yyjson_is_arr(sc)) for (int k = 0; k < 3; ++k) n.s[k] = (float)jd(yyjson_arr_get(sc, k));
        }
        n.mesh   = obj_get(v, "mesh") ? ji(obj_get(v, "mesh")) : -1;
        n.parent = parentOf[oldIdx] >= 0 ? remap[parentOf[oldIdx]] : -1;
        const char* nm = js(obj_get(v, "name"), &sn);
        if (nm) { n.nameOff = doc.addString(nm, sn); n.nameLen = (uint32_t)sn; }
        doc.nodes.push_back(n);
    }
    for (int32_t r : sceneRoots) doc.roots.push_back(remap[r]);

    (void)bufKind; (void)bufAux; (void)c;
    doc.ok = doc.error.empty();
}

} // namespace bcpp::gltf
