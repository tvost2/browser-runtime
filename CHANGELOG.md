# Changelog

All notable changes to this experiment. Versioning is `0.MINOR.PATCH` while
experimental — every minor may break the API.

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
