# Investigation: GLB / glTF loader

**Branch:** `feat/glb-loader` (off `develop`). **Status:**

| step | state |
|---|---|
| PROFILE | ✅ [FINDINGS F-010](../FINDINGS.md#f-010) · `npm run glb:profile` |
| DESIGN | ✅ decisions below |
| IMPLEMENT (JS loader) | ✅ `web/asset/` — `glb.ts` (container) · `gltf.ts` (decode → `Asset`) · `Asset.ts` · `AssetManager.ts` · `scene.loadAsset(url)` |
| IMPLEMENT (C++/WASM core) | ✅ `native/include/bcpp/gltf.hpp` (`bcpp::gltf::Batch`) · `native/bindings/asset.cpp` (`GltfBatch`) · `web/asset/wasm.ts` (JS batch API) · hybrid `"auto"` dispatch in `gltf.ts` |
| VALIDATE (equivalence) | ✅ `npm run test:glb` — **89/89**: WASM vs JS reference byte-for-byte + exact known values + `@babylonjs/loaders` cross-check |
| VALIDATE (render) | ✅ `npm run test:glb:render` — **6/6** fixtures through the forced WASM path to the pixels, screenshots visually verified |
| BENCHMARK | ✅ `npm run bench:glb` — JS vs WASM vs `auto` vs WASM+tangents, all fixtures |
| DECIDE | ✅ [Conclusion](#conclusion) |

## Decisions

1. **Parsing runs in JS.** `JSON.parse` is 0.02–0.06 ms for any file size (the
   JSON chunk is metadata). No reason to marshal it into WASM. Metadata and
   orchestration (nodes, materials, textures, hierarchy) stay in TypeScript.
2. **Geometry that is already GPU-ready stays zero-copy in JS.** Non-interleaved
   `FLOAT` accessor with normals + accessor min/max + U16/U32 indices →
   `new Float32Array(bin, byteOffset, count*comps)` view, no decode, no copy.
   The benchmark shows this beats any path that crosses the WASM heap.
3. **Geometry that needs *work* goes to the C++/WASM batch core.** Tangent
   generation, area-weighted normal generation when absent, de-quantising
   normalized / integer attributes, de-interleaving, non-indexed expansion,
   index widening. One `process()` call per asset, ~9 JS↔WASM crossings total —
   never per primitive, never per vertex. The dispatch is per-primitive
   (`geometry: "auto"`, the default); `"wasm"` / `"js"` force one path.
4. **Images stay bytes until upload.** `Asset.images[]` holds `{ mimeType, bytes }`;
   `createImageBitmap` → `OffscreenCanvas` → `writeTexture` happen in
   `AssetManager` / the renderer.
5. **glTF subset for this pass:** `mode: 4` primitives; accessors
   SCALAR/VEC2/VEC3/VEC4 with componentType FLOAT / UNSIGNED_SHORT /
   UNSIGNED_INT / UNSIGNED_BYTE / BYTE / SHORT; attributes POSITION, NORMAL,
   TEXCOORD_0, COLOR_0, TANGENT; nodes with TRS or `matrix`;
   `pbrMetallicRoughness` (baseColorFactor, baseColorTexture, metallicFactor,
   roughnessFactor); `alphaMode`, `doubleSided`. **Out:** animations, skins,
   morph targets, cameras/lights, all `KHR_*` / `EXT_*` extensions. Sparse
   accessors → JS reference path. Everything unsupported → `asset.ignored[]`,
   never silent.
6. **`Asset` is immutable + GPU-free** — fully unit-testable in Node. The loader
   (`glb` + `gltf` + `Asset`) imports nothing from `web/renderer`; `wasm.ts` is
   the only loader file that touches the WASM module, and only for geometry that
   opts into it.

## Goal

The runtime loads a **real GLB file** and renders it **correctly**. Not "the
parser finished without an error" — the criterion is:

```
GLB  →  runtime  →  correct render (visually verified)
```

## Target pipeline

```
GLB  →  glTF parser  →  scene / nodes  →  geometry  →  materials  →  textures
     →  C++/WASM runtime  →  WebGPU
```

Minimal first pass:

```
GLB → nodes → transforms → mesh primitives → indices → positions → basic material → WebGPU
```

## Implementation (as built)

```
web/asset/
  glb.ts          parseContainer(bytes) → { json: <parsed glTF>, bin: Uint8Array|null }
                  · GLB header + chunk walk · plain .gltf + data-URI buffers · GlbError
  gltf.ts         decodeContainer({json,bin}, opts) → Asset
                  · per-primitive dispatch: gpuReady() → JS zero-copy view;
                    else → C++/WASM batch core (opts.geometry: "auto" | "wasm" | "js")
                  · JS path: FLOAT/packed → Float32Array VIEW; else copy + widen / normalize
                  · nodes: topological re-order (parents first), matrix→TRS decompose
                  · materials: pbrMetallicRoughness, emissive, alphaMode, doubleSided
                  · textures/images: bytes kept raw (decode deferred)
                  · everything unsupported → asset.ignored[] (never silent)
                  · stats: geometryPath ("wasm"|"js"|"mixed"), wasmCrossings, bytesUploadedToWasm
  wasm.ts         processPrimitivesWasm(container, specs[], opts) → { geometries, crossings, bytesUploaded }
                  · builds one contiguous BIN blob — ONLY the byte ranges the geometry
                    accessors touch (not embedded texture bytes) — + a flat PrimDesc[] table
                  · one reused GltfBatch instance; one process() call; reads SoA outputs as views
  Asset.ts        the immutable data shapes (no renderer / WASM import)
  AssetManager.ts load(url, opts) → {asset, timing} · instantiate(asset, scene) → Entity[]
                  · decodeImage() bytes → RGBA8 via createImageBitmap + OffscreenCanvas
                  · registers each primitive once; shared meshes reused; materials + textures
                    to the renderer here, never before
web/api/Scene.ts  scene.loadAsset(url, { geometry, generateTangents })  (lazy AssetManager)

native/
  include/bcpp/gltf.hpp   bcpp::gltf::Batch — header-only batch geometry processor
                          · PrimDesc[96 B] in, PrimOut[64 B] + SoA pos/nrm/uv/tan + u32 idx out
                          · decodeVec(): memcpy fast path for tightly-packed non-normalized F32
                          · index widen (u8/u16→u32, memcpy for u32) · non-indexed expansion
                          · genNormals() area-weighted · genTangents() Lengyel + Gram-Schmidt
                          · AABB from accessor min/max or computed
                          · decode semantics bit-match web/asset/gltf.ts (the reference)
  bindings/asset.cpp      embind GltfBatch: reserveBin / setPrimCount / binPtr / descPtr /
                          process(flags) / totalVertices / totalIndices / {pos,nrm,uv,tan,idx,outMeta}Ptr
```

### Memory flow (one asset, WASM path)

```
GLB bytes ──JS──▶ parseContainer ──▶ glTF JSON (parsed in JS)
                                     BIN chunk (Uint8Array view)
                    │
   wasm.ts: for each geometry accessor, union its [byteOffset, end) window
            copy ONLY those bytes ──▶ HEAPU8 at batch.binPtr()      (1 copy, geometry only)
            write PrimDesc[] ────────▶ HEAP32 at batch.descPtr()
                    │
   batch.process(flags)  ── C++ ──▶ decode → pos/nrm/uv/(tan) : std::vector<float>
                                    indices                    : std::vector<uint32_t>
                                    per-primitive PrimOut
                    │
   read back as Float32Array/Uint32Array VIEWS over the heap ──▶ gltf.ts .slice() ──▶ AssetPrimitive
                    │
   AssetManager ──▶ renderer.uploadMeshes ──▶ GPUBuffer ──▶ WebGPU
```

**JS↔WASM crossings per asset: ~9** — `reserveBin`, `setPrimCount`, `process`,
and 6 pointer getters. Flat: `tri.glb` (3 verts) and `DamagedHelmet.glb`
(14 556 verts, 3.7 MB file) both cross 9 times.

### What runs where

| in C++/WASM (`bcpp::gltf::Batch`) | stays in JS/TS |
|---|---|
| accessor decode (all component types) | GLB container split, `JSON.parse` |
| index widening u8/u16 → u32, non-indexed expansion | node hierarchy, topological order, matrix→TRS |
| area-weighted normal generation | material / texture / image metadata |
| Lengyel tangent generation | `PrimDesc[]` construction, path dispatch |
| per-primitive AABB (min/max or computed) | zero-copy decode of already-GPU-ready F32 accessors |
| SoA layout for GPU upload | `AssetManager.instantiate`, GPU upload orchestration |

The loader (`glb` + `gltf` + `Asset`) imports **nothing** from `web/renderer`.
`wasm.ts` is the only loader file that loads the WASM module. `AssetManager` is
the only file that bridges to `Scene` / the renderer.

## Questions to answer first

*(answered — see "Decisions" above and FINDINGS F-010)*

1. **glTF subset.** Which of glTF 2.0 does the minimal pass need? (nodes, meshes,
   primitives with mode 4, accessors POSITION / NORMAL / TEXCOORD_0 / indices,
   buffers, bufferViews, materials.pbrMetallicRoughness.baseColorFactor,
   images/samplers/textures for baseColor.) Everything else is out.
2. **Extensions.** Almost certainly none for the minimal pass. Candidates for
   later, decided explicitly: `KHR_draco_mesh_compression`,
   `KHR_texture_basisu`, `KHR_materials_*`, `EXT_meshopt_compression`.
3. **Parsing cost.** Measure JSON-chunk parse + accessor walk on small / medium /
   large fixtures before deciding where it runs.
4. **Buffer ownership.** Who owns the decoded vertex/index bytes — JS, or copied
   straight into WASM linear memory? When are they freed?
5. **JS vs WASM parsing.** The glTF JSON chunk is small and string-y (JS is
   fine). The BIN chunk is bytes. Hypothesis: parse JSON in JS, hand typed-array
   views of the BIN chunk to WASM (or straight to `queue.writeBuffer`). Measure
   before committing.
6. **Geometry storage.** Does decoded geometry live in an `Asset` (CPU side), in
   WASM, or only on the GPU after upload? The runtime already keeps only a local
   AABB per entity for culling — geometry itself is renderer-owned.
7. **Texture upload.** Decode via `createImageBitmap` → `copyExternalImageToTexture`?
   Mip generation? sRGB handling? Deferred vs eager.
8. **Small fixture.** A hand-authored GLB: 2–3 nodes, 1–2 primitives, one
   baseColor texture, a parent/child transform. Committed under
   `native/tests/fixtures/glb/` (small, text-inspectable where possible).
9. **Complex fixture.** A real-world GLB (public-domain, e.g. a Khronos sample
   model) exercising multiple meshes, multiple materials, shared geometry,
   nested nodes. Vendored or fetched by a `setup:` script — decided by size.

## Asset architecture (proposed — validate during implementation)

```
Asset            immutable CPU-side decode of one GLB
  .nodes[]       { name, parentIndex, localTRS, meshIndex }
  .meshes[]      { primitives: [{ positions, normals, uv0, indices, materialIndex }] }
  .materials[]   { baseColorFactor, baseColorTextureIndex? }
  .images[]      decoded pixel data (or ImageBitmap)
      │
AssetManager     owns Asset lifetime; dedups; async load queue
      │
  ┌───┴───────────────┬─────────────────────┐
GPU resources     runtime entities        (kept separate)
(Renderer owns    (Scene.createEntities    — the loader must NOT
 vertex/index/    from Asset.nodes,          import the renderer or
 texture)          setMesh/setMaterial)      the Scene directly)
```

Rule: the loader produces an `Asset` (plain data). Turning an `Asset` into a
live scene + GPU resources is a separate step (`AssetManager.instantiate(asset,
scene)`), so the loader stays testable without a GPU.

## Test plan

Equivalence / correctness tests (a passing parse is **not** a pass):

- [ ] node hierarchy (parent indices, order)
- [ ] node transforms (matrix vs TRS; matches a reference decode)
- [ ] mesh primitives count + attribute presence
- [ ] indices (count, values, primitive restart / none)
- [ ] vertex attributes (POSITION / NORMAL / TEXCOORD_0 — stride, offset, type)
- [ ] bounding boxes (accessor min/max vs recomputed)
- [ ] material assignment (primitive → material index)
- [ ] multiple meshes
- [ ] multiple nodes referencing the same mesh (shared geometry — one GPU upload)
- [ ] at least one **visual** test: fixture GLB → runtime → screenshot passes the
      same structural checks as `bench/run-visual.mjs` (frustum, on-screen,
      draw-call count, depth headroom, no GPU errors)

## Benchmark plan

Measure **separately** (never blend startup into steady-state):

| stage | notes |
|---|---|
| download | fetch time (or `file://` for a local fixture) |
| parse | JSON chunk → object graph |
| decode | accessor walk → typed arrays |
| CPU conversion | interleave / de-interleave / recompute normals if absent |
| WASM upload | if any geometry crosses into linear memory |
| GPU upload | `writeBuffer` / texture copy |
| first frame | time to first correct render |
| steady-state frame | median over N, after warmup |

Fixtures: small / medium / large GLB. Report in a new `docs/` section and
`bench/results/glb.json`, on the same host as `bench/results/HARDWARE.md`.

## Explicitly not in this cycle

skeletal animation · skinning · morph targets · complex PBR (metallic-roughness
textures, normal maps, emissive, KHR material extensions) · animation graph ·
physics · editor · Draco / meshopt / KTX2 decompression.

## Conclusion

The C++/WASM batch geometry core exists, is integrated as a real runtime path,
produces data byte-equivalent to the JS reference (89/89), and renders every
fixture correctly through the forced WASM path to the pixels (6/6, screenshots
visually verified).

**The benchmark result, recorded honestly:** for GLB geometry that is already in
GPU-ready layout — packed-F32 POSITION/NORMAL/TEXCOORD_0, present normals, U16/U32
indices, accessor min/max — the JS zero-copy path is **~1.5–2× faster** than the
C++/WASM path (`bench:glb`, DamagedHelmet: JS 1.3 ms vs WASM 1.9 ms). JS reads
those accessors as typed-array views straight over the GLB `ArrayBuffer` with
zero copies; the WASM path must always cross the heap boundary (BIN → linear
memory, decode → SoA vectors, SoA → JS slice) regardless of how little
transformation the bytes need. No amount of in-core optimisation removes that
structural asymmetry.

**Therefore the runtime dispatches per primitive (`geometry: "auto"`):** already-
GPU-ready geometry → JS zero-copy; geometry that needs real work → C++/WASM. The
native core is the *only* path that generates tangents (required by every
normal-mapped PBR asset — the JS path does not implement it), generates missing
normals, de-quantises KHR-quantised / normalized attributes, de-interleaves, and
expands non-indexed geometry — and it does all of that for a whole asset in one
batched call with a flat 9 boundary crossings. It is not a parallel unused
implementation and it is not dead code; it is the path for every asset that is
not trivially copyable.

**Real-world corpus** (`npm run bench:glb:vitrine`, `GLB_VITRINE_DIR` — 108 GLBs,
~3.6 GB, not vendored): ~1 M-vertex / ~6 M-index single-primitive scanned meshes,
**no source normals**, no textures. Every one routes to the WASM core under
`"auto"` (a JS-only decode leaves them unshadeable — `normals: null`). The core
generates area-weighted normals at **~12 M triangles/s** (~160 ms for a 34 MB /
1 M-vertex file), positions bit-identical to the JS views, indices identical,
normals unit-length — 8/8 equivalence. `gaia.glb` and `shivas.glb` rendered
through the forced WASM path: correct full-surface shading from the generated
normals (screenshots in `bench/results/`). For this content the native core is
the only path that yields a renderable asset.

**Optimisations applied (each measured, DamagedHelmet decode):**

| change | before → after |
|---|---|
| upload only referenced accessor byte ranges (skip embedded texture bytes) | 11.8 ms → 4.3 ms · 3683 KB → 545 KB in |
| memcpy fast path for packed F32 attributes + U32 indices | 4.3 ms → 3.8 ms |
| one reused `GltfBatch` (buffers grow and stay — zero steady-state alloc) | 3.8 ms → ~1.9 ms |
| `resize` vs `assign` for fully-overwritten output vectors | within noise |
| **net WASM decode** | **11.8 ms → 1.9 ms** |

SIMD (`-O3 -msimd128`) speeds decode 2.46 → 1.90 ms (LLVM vectorises the copy /
AABB loops) but not tangent generation 3.99 → 3.95 ms (scalar indexed scatter).
It stays on — it is the shipping profile.

**Stability:** the v0.1.0 equivalence gate (`bench/run-equivalence.mjs`) stayed
4/4 throughout; v0.1.0 frozen benchmarks were not touched. The cycle is
mergeable to `develop`.

### Limitations / follow-ups

- No JS tangent/normal *generator* — generation is WASM-only, so there is no
  pure-JS fallback for a primitive that both lacks normals *and* cannot use WASM
  (only possible today via a sparse POSITION accessor with no NORMAL — not seen
  in any fixture). Would be a small port of `genNormals`/`genTangents`.
- `bench:glb` absolute ms are noisy on the 2014 Xeon bench host (best-of-5 sample
  medians mitigate it); ratios are stable, absolutes are indicative.
- Multi-buffer `.gltf` with external `.bin` files: the byte-range upload unions
  per buffer, correct but untested against a fixture (all fixtures are
  single-buffer GLB).
- KHR_mesh_quantization / KHR_draco_mesh_compression not decoded — quantised
  attributes that *are* plain accessors (normalized ints) already route to WASM
  and decode correctly; Draco/meshopt need their own cycle.
