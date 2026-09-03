# Changelog

All notable changes to this experiment. Versioning is `0.MINOR.PATCH` while
experimental — every minor may break the API.

## [Unreleased] — `develop`

Cycles since `v0.1.0`, each on its own branch, merged to `develop`. `v0.1.0`
stays frozen; its benchmark results are not modified.

### GLB / glTF assets  (F-010, F-011)

- **`bcpp::gltf::Batch`** — batch geometry core in C++/WASM: accessor decode
  (memcpy fast paths + SIMD), index widening, non-indexed expansion,
  area-weighted normal generation, Lengyel tangents, AABB. ~9 JS↔WASM crossings
  per asset, flat.
- **Hybrid dispatch** `decodeGLB(bytes, { geometry: "auto" })` — already-GPU-ready
  geometry stays JS zero-copy; work (tangents / normal-gen / de-quant /
  de-interleave / non-indexed) goes to the batch core.
- **`bcpp::gltf::Pipeline`** — the *whole* GLB→Asset decode in C++
  (`parser: "native"`): container walk + JSON parse (vendored yyjson) + glTF
  metadata → data-oriented `Document` + geometry via `Batch`. 5 crossings/asset.
- Renderer: base-colour materials + textures, `Camera.fit()` depth tuning.
- `test:glb` 89/89 · `test:glb:native` 114/114 · `test:glb:render` 6/6 (both
  pipelines, render equivalence). `bench:glb*` — the C++ front-end is ~free
  (~0.1 ms flat); native is +18–30 % on geometry-heavy real content, −36 % on
  texture-heavy GPU-ready assets → route by workload.

### Scene evaluation  (F-012)

- **Incremental transforms** — `World::evaluate()` recomputes a world matrix +
  bounding refit only for entities whose local transform changed (`dirty[i]`) or
  whose ancestor moved. A fully static 250k-entity frame: ~90 ms → **1.7 ms**
  (~50×; ~680× Babylon with `freezeWorldMatrix` + `freezeActiveMeshes` at 50k).
  No regression at 100 % moving. Bit-exact equivalence (`test_incremental`).
- Fast path: nothing moved + camera unchanged → render list reused,
  `stats.frameChanged = 0`, renderer skips the instance re-upload.
- **`bcpp::Bvh`** — flat, refittable BVH over world AABBs. `WasmCore.raycast()`
  (nearest entity-AABB hit) and `WasmCore.queryBox()` (overlap). `CullStrategy.Bvh`
  (opt-in, situational — large calm scenes). `test:spatial` 3/3, `test_bvh` in
  `test:equivalence` (now 6/6).
- Fix: `World::resize()` now preserves entity data on a capacity grow (was
  zeroing it — latent corruption for scenes built one entity at a time).

### Incremental rendering  (F-013)

- **Incremental linear cull** — a still camera re-tests only the entities that
  moved this frame (persistent `_visibleBit`); a moving camera does the full
  re-test. **Incremental render list** — an unchanged visible set + batch layout
  patches only the moved `instanceWorld` rows; `Renderer.render()` coalesces the
  dirty slots and issues **partial `writeBuffer`** calls instead of re-uploading
  the whole instance buffer.
- **`CullStrategy.Auto`** — new default: `Bvh` while the camera moves over a
  large scene, else the incremental linear cull. 250k entities: object motion
  under a still camera **13 → 5 ms** (2.6×), moving camera **13.5 → 6.3 ms**,
  static unchanged; instance-buffer upload **4 MB → ~19 KB/frame** at 1 % moving.
- `EvalStats` gains `transformUs` / `cullUs` / `listUs` / `listRebuilt` /
  `dirtySlots`. New: `test:render:patch` (browser partial-upload equivalence),
  `bench:renderer`, `bench:renderer:gpu`.
- Fixes: the depth texture now resizes with the canvas (a mismatch silently
  dropped every frame → black screen); the partial-upload path is guarded
  against a never-fully-uploaded instance buffer; `requestAdapter()` retries
  without `powerPreference` and with a fallback adapter.
- `npm run compare` — side-by-side Browser Runtime vs Babylon.js GLB viewer
  (`web/harness/vitrine-compare/`).

## [0.1.0] — 2026-09-02 — Experimental baseline

First reproducible, publishable baseline. **One hot path implemented**
(scene evaluation); everything else is measurement, docs, and scaffolding.

### Runtime

- **C++ engine core** (`native/include/bcpp/world.hpp`) — data-oriented ECS/SoA
  `World`. `evaluate()` does hierarchy traversal → transform propagation → world
  matrices → bounding refit → frustum culling → visibility → mesh-batched render
  list, in one pass, no per-frame allocation, no virtual dispatch.
- **Compiled to WASM** via Emscripten `em++ -O3 -msimd128` (`native/build-wasm.mjs`).
- **TypeScript API** (`web/api/`) — `Engine` · `Scene` · `Entity` · `Camera` ·
  `box()`/`sphere()`. Handles hold no data; every property writes the shared SoA
  in WASM linear memory. `entity.mesh = box()` ergonomic setter with identity
  dedup. `engine.dispose()` / `scene.dispose()` / `camera.fit()`.
- **WASM boundary** (`web/bindings/WasmCore.ts`) — the only module that touches
  `engine.wasm`. Exactly **1 JS→WASM call per frame** (`evaluate`); the
  view-projection is a heap write; component updates are `TypedArray` writes;
  the render list is read back as zero-copy views. `setParent()` during scene
  build costs **zero** crossings (hierarchy-dirty flag rides into `evaluate`).
- **WebGPU renderer** (`web/renderer/Renderer.ts`) — mesh registry packed into
  one vertex/index buffer, per-instance world matrix storage buffer, one
  `drawIndexed` per mesh batch, depth. Deliberately minimal.
- **Live demo** (`web/harness/engine-demo.html`) — orbital camera, animated
  field, verified rendering at 10k and 20k entities.

### Measurement (results frozen for v0.1.0 — see `docs/`)

- **Equivalence** (`npm run test:equivalence`) — 4 implementations
  (Babylon-authored fixture · C++ math+scene kernel · C++ `World` · JS
  data-oriented · C++/WASM) produce a **byte-identical visible set**.
  `test_equiv`: 19,457 numeric checks, 0 failures.
- **Ladder** (4000-node fixture): Babylon OO 13.3 ms → data-oriented JS 7.3 ms
  (1.8×) → C++/WASM 1.46 ms (9.1×) → C++ native 1.26 ms (10.6×).
- **Scaling** 1k→250k: `evaluate()` ≈ linear, ~250→350 ns/entity, ~4× vs JS
  kernel at every size. 100k = 37 ms WASM vs 144 ms JS.
- **WASM SIMD** (`-msimd128` vs `-O3`): 1.65×.
- **Memory**: 248 bytes/entity (SoA, exact); `INITIAL_MEMORY` 64 MB covers
  ~270k entities with no growth; JS heap flat.
- **Real WebGPU** (browser, software adapter): heavyCulling 62→205 fps,
  cpuBound 52→277, manyObjects 38→154. `medium` GPU-bound → ~1× (documented).
- **Visual smoke** (`npm run test:visual`) — checks pixels, not just numbers
  (added after F-009).

### Tooling

- `npm run doctor` — prerequisite check.
- `npm run setup:emsdk` / `setup:reference` — one-time environment prep.
- **Migration analyzer** — 4 tiers × `MEASURED` / `ESTIMATED` / `UNKNOWN`
  confidence; explicit `HYPOTHESES` queue kept separate from results.

### Fixed

- **F-009** — black screen from `Camera` default `far/near ≈ 40000` crushing
  hyperbolic depth. Defaults tightened; `camera.fit(radius)` added. Lesson:
  equivalence PASS ≠ rendering correct.
- **F-003** — MinGW `std::fmin`/`std::fmax` not inlined, cost 3× the kernel;
  replaced with branchless ternaries.

### Not in this release (next cycles, one at a time)

skeleton/bone matrices · CPU particle update · normals/tangents · geometry
processing · WASM threads (scaffolded, not benchmarked) · physics · materials
beyond a lambert · asset pipeline · editor · networking.
