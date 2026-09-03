# Investigation: GLB / glTF loader

**Branch:** `feat/glb-loader` (off `develop`). **Status:**

| step | state |
|---|---|
| PROFILE | ✅ [FINDINGS F-010](../FINDINGS.md#f-010--glb--the-loader-belongs-entirely-in-javascript-profile--hypothesis) · `npm run glb:profile` |
| HYPOTHESIS | ✅ the minimal loader is 100 % JavaScript; WASM stays out |
| DESIGN | ✅ decisions below |
| IMPLEMENT | ✅ `web/asset/` — `glb.ts` (container) · `gltf.ts` (decode → `Asset`) · `Asset.ts` · `AssetManager.ts` (instantiate) · `scene.loadAsset(url)` |
| VALIDATE (decode) | ✅ `npm run test:glb` — **60/60**: hand-authored fixtures vs exact known values + Khronos fixtures cross-checked against `@babylonjs/loaders` (vertex counts match) |
| VALIDATE (render) | 🚧 browser test: fixture GLB → `AssetManager.instantiate` → WebGPU → structural checks |
| BENCHMARK | ⬜ download / parse / decode / GPU upload / first frame / steady-state, small→large |
| DECIDE | ⬜ |

It will gain a `## Conclusion` section once the cycle completes.

## Decisions (from PROFILE)

1. **Parsing runs in JS.** `JSON.parse` is 0.02–0.06 ms for any file size (the
   JSON chunk is metadata). No reason to marshal it into WASM.
2. **Accessors are zero-copy where possible.** Non-interleaved `FLOAT` / `UNSIGNED_SHORT`
   accessor → `new Float32Array(bin, byteOffset, count*comps)` view, no decode.
   A copy happens only for: interleaved data (`byteStride`), normalized ints,
   `UNSIGNED_BYTE` indices (→ Uint16), sparse accessors.
3. **Geometry does not enter WASM.** It goes `bin bytes → GPUBuffer` via
   `queue.writeBuffer`. The C++ `World` only needs the per-mesh local AABB
   (accessor `min`/`max`, or recomputed once).
4. **Images stay bytes until upload.** `Asset.images[]` holds `{ mimeType, bytes }`;
   `createImageBitmap` + `copyExternalImageToTexture` happen in the renderer.
5. **glTF subset for this pass:** `mode: 4` primitives; accessors
   SCALAR/VEC2/VEC3/VEC4 with componentType FLOAT / UNSIGNED_SHORT /
   UNSIGNED_INT / UNSIGNED_BYTE; attributes POSITION, NORMAL, TEXCOORD_0,
   COLOR_0; nodes with TRS or `matrix`; `pbrMetallicRoughness` (baseColorFactor,
   baseColorTexture, metallicFactor, roughnessFactor); `alphaMode`,
   `doubleSided`. **Out:** animations, skins, morph targets, cameras/lights,
   all `KHR_*` / `EXT_*` extensions, sparse accessors (parse-time error, not
   silent).
6. **`Asset` is immutable + GPU-free + WASM-free** — fully unit-testable in Node.

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
                  · accessor reader: FLOAT/packed/aligned → Float32Array VIEW (zero-copy);
                    else copy + widen (u8/u16 indices → u32) / normalize / densify sparse
                  · nodes: topological re-order (parents first), matrix→TRS decompose,
                    parent index resolved
                  · primitives: POSITION/NORMAL/TEXCOORD_0/COLOR_0, indices, AABB (accessor
                    min/max or recomputed), material index
                  · materials: pbrMetallicRoughness (baseColorFactor/Texture, metallic,
                    roughness), emissive, alphaMode, doubleSided
                  · textures/images: bytes kept raw (decode deferred)
                  · everything unsupported → asset.ignored[] (never silent)
  Asset.ts        the immutable data shapes (no renderer / WASM import)
  AssetManager.ts load(url) → {asset, timing} · instantiate(asset, scene) → Entity[]
                  (registers each primitive's geometry once; shared meshes reused;
                  multi-primitive mesh → child entity per primitive) · loadInto(url, scene)
web/api/Scene.ts  scene.loadAsset(url)  (lazy AssetManager)
```

The loader (`glb` + `gltf` + `Asset`) imports **nothing** from `web/renderer`,
`web/bindings`, or the WASM core — it runs and is tested in plain Node.
`AssetManager` is the only file that bridges to `Scene` / the renderer.

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
