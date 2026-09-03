# Architecture — Babylon.js C++/WASM Performance Experiment

> **Phase 2 (WASM-first runtime) is live.** This document covers the original
> measurement experiment (phases 1–11, all complete). The runtime built on top
> of its findings has its own docs:
> [WASM_ARCHITECTURE.md](WASM_ARCHITECTURE.md) ·
> [BENCHMARK_METHODOLOGY.md](BENCHMARK_METHODOLOGY.md) ·
> [MIGRATION_GUIDE.md](MIGRATION_GUIDE.md) · [RESULTS.md](RESULTS.md) ·
> [FINDINGS.md](FINDINGS.md).
>
> The experiment's conclusion — *`Scene._evaluateActiveMeshes` is the whole CPU
> frame; a data-oriented C++/WASM core does it ~10× faster and equals the native
> ceiling* — is now the `bcpp::World` core (`native/include/bcpp/world.hpp`)
> driven by the TypeScript API in `web/api/`.

Nothing here is assumed to be faster in C++ until the profiler in `bench/` says
so. Every claim in the HOT/WARM/COLD table is a *hypothesis to be falsified*.

---

## 0. The question

> "How much of a JavaScript engine like Babylon.js can actually benefit from a
> C++/WebAssembly implementation while keeping WebGPU as the graphics backend?"

We answer it with reproducible benchmarks, not argument.

---

## 1. Layer model

```
┌───────────────────────────────────────────────────────────┐
│ Application / benchmark scenes                             │
│   bench/scenes/*.mjs  — identical workload for both paths  │
└───────────────────────────────┬───────────────────────────┘
                                │  Babylon-compatible API subset
                                ▼
┌───────────────────────────────────────────────────────────┐
│ Engine Backend Interface   web/backend/IBackend.ts         │
│   selectBackend("javascript" | "cpp")                      │
└───────────┬───────────────────────────────┬───────────────┘
            │                               │
   JsBackend │                     WasmBackend │
            ▼                               ▼
┌──────────────────────┐        ┌──────────────────────────────┐
│ Real Babylon.js core │        │ C++ engine compiled to WASM  │
│ (@babylonjs/core)    │        │ native/  (SoA scene, SIMD,   │
│                      │        │  fused per-frame kernel)     │
└──────────┬───────────┘        └──────────────┬───────────────┘
           │ Babylon's WebGPU engine           │ packed render list
           │                                   │ (Float32Array view on
           │                                   │  WASM heap: world mats,
           │                                   │  visible indices)
           ▼                                   ▼
┌──────────────────────┐        ┌──────────────────────────────┐
│ WebGPU (Babylon)     │        │ web/webgpu/Submitter.ts       │
│                      │        │ thin JS that issues the same  │
│                      │        │ WebGPU calls from C++ output  │
└──────────┬───────────┘        └──────────────┬───────────────┘
           └───────────────► GPU ◄─────────────┘
```

### Why C++ does **not** call WebGPU directly

In a browser, `wasm` cannot reach `navigator.gpu` without going through JS glue
(Emscripten's `webgpu.h` marshals every call to JS anyway). Rather than hide that
cost inside Emscripten glue, we make it explicit and measurable:

* **C++ produces data** — a compact, GPU-ready render list in linear memory.
* **A ~200-line JS submitter consumes it** — same buffer writes, same
  `setBindGroup`/`drawIndexed` calls Babylon would make.

This isolates the metric *"overhead WASM → WebGPU"* as the cost of reading a
typed-array view over the WASM heap plus the JS submit loop. We additionally
keep an Emscripten-`webgpu.h` variant behind a flag to measure that path too.

---

## 2. The measurement boundary (core design constraint)

The backend interface is shaped so a **frame** can run one of two ways:

| Phase                        | JsBackend            | WasmBackend                              |
|------------------------------|----------------------|-----------------------------------------|
| animation eval               | Babylon              | 1 wasm call → writes local transforms   |
| world-matrix propagation     | Babylon per-node     | inside the same wasm call (linear pass) |
| bounding-volume update       | Babylon per-mesh     | same wasm call (SoA pass)               |
| frustum culling              | Babylon per-mesh     | same wasm call (SoA pass, opt. SIMD)    |
| render-list build + sort     | Babylon              | same wasm call → emits visible indices  |
| **boundary crossings/frame** | n/a                  | **1 in, 1 out**                          |
| WebGPU submission            | Babylon              | JS submitter over WASM-heap views        |

This is the *"JS → C++/WASM → whole computation → minimal result → JS"* pattern
from the brief. Anti-pattern (JS→WASM→JS→WASM→JS per object) is explicitly
forbidden by the interface: there are no per-node wasm entry points on the hot
path.

---

## 3. Data-oriented scene model (WasmBackend)

```cpp
struct SceneData {
  // Structure-of-arrays, all contiguous, indexable by node id.
  // Nodes are stored in topological order: parent index < child index,
  // so propagation is a single forward linear pass — no recursion, no
  // pointer chasing, no per-node virtual dispatch.
  std::vector<int32_t>  parent;          // -1 = root
  std::vector<float>    localPos;        // xyz interleaved  (3N)
  std::vector<float>    localRot;        // quat xyzw        (4N)
  std::vector<float>    localScale;      // xyz              (3N)
  std::vector<float>    localMatrix;     // 16N  (scratch)
  std::vector<float>    worldMatrix;     // 16N
  std::vector<uint8_t>  dirty;           // dirty flag per node
  // bounding data in world space, refit each frame from local extents
  std::vector<float>    localExtentMin;  // 3N
  std::vector<float>    localExtentMax;  // 3N
  std::vector<float>    worldSphere;     // xyzr  (4N)
  std::vector<float>    worldAABB;       // min3+max3 (6N)
  std::vector<uint32_t> renderableFlags; // visible / enabled / alwaysActive
};
```

Output of the fused kernel: `uint32_t visibleCount` + `uint32_t* visibleIds` +
`float* visibleWorldMatrices` (all views into WASM memory, zero-copy to JS).

Optimizations, each **gated behind a profiler result**:
* wasm SIMD (128-bit) 4-wide sphere/plane tests
* multi-thread culling via pthreads → Web Workers + SharedArrayBuffer
* avoid all per-frame allocation (pre-sized vectors, generational reuse)
* branch-free plane/sphere classification

---

## 4. Dependency map

```
math (Vec3 / Vec4 / Quat / Mat4)  ◄── everything
        ▲
Transform ──────────────┐
        ▲               │
BoundingInfo ◄── geometry extents
        ▲               │
Frustum ◄── camera view/proj
        ▲               │
Culling ◄── Frustum, BoundingInfo, Transform, (Octree)
        ▲
RenderList / draw-call prep ◄── Culling, materials, RenderingManager
        ▲
Animation ─► writes Transform      Skeleton ─► bone Mat4      Particles ─► math
```

Everything on the hot path bottoms out in `Mat4`/`Vec3` arithmetic. That is why
the math library is component #0 for *correctness* testing — but likely **not**
the best first migration target for *performance* (see §6).

---

## 5. Repository layout

```
babylonc++/
  reference/          full Babylon.js source, shallow clone — read-only, analysis
  tools/emsdk/        Emscripten SDK (build-time only; consumers never touch it)

  shared/layout.ts    SoA strides + flag bits — single source of truth (C++ mirrors)

  native/                              the C++ engine core
    include/bcpp/
      math.hpp         Vec3/Vec4/Quat/Mat4/Plane/Frustum — Babylon-exact
      world.hpp        bcpp::World  — ECS/SoA, evaluate() = the whole CPU frame
      scene.hpp        earlier fused kernel (kept for the reference equiv test)
    bindings/engine.cpp   the ONE embind surface (World + staging ptrs + evaluate)
    build-wasm.mjs        em++ → web/backend/engine.{mjs,wasm}, --profile variants
    tests/               test_equiv · test_world_equiv · bench_world · gen_fixtures
    CMakeLists.txt

  web/
    api/               PUBLIC TS API — Engine · Scene · Entity · Camera · meshes · math
    bindings/WasmCore.ts   the only module that touches engine.wasm; SoA heap views
    renderer/Renderer.ts   WebGPU: mesh registry + 1 instanced-indexed draw / batch
    backend/           IFrameBackend impls for the benchmark:
      JsBackend.mjs        hand-written data-oriented JS (rung 2)
      WasmBackend.mjs      the World core via WasmCore (rung 4)  ← primary path
    harness/           engine-demo (real API) + main (2-backend browser bench)
    build-api.mjs      esbuild → web/dist/engine.js  (+ engine.mjs/.wasm/.d.ts)
    serve.mjs          static server w/ COOP-COEP headers
    dist/              the shippable package payload

  bench/               run-baseline · profile-pipeline · run-wasm · run-compare ·
                       native-ceiling · run-browser · run-equivalence · report
  docs/                ARCHITECTURE · HOT_WARM_COLD · PROFILING · FINDINGS ·
                       COMPARISON · RESULTS · WASM_ARCHITECTURE ·
                       BENCHMARK_METHODOLOGY · MIGRATION_GUIDE
  tools/migration-analyzer/   data-calibrated "should this move to WASM?" scorer
```

---

## 6. First migration candidate (hypothesis)

Ranked by expected benefit ÷ difficulty, to be confirmed by `bench/`:

1. **Fused per-frame CPU pipeline** (transform propagation + bounding refit +
   frustum culling + render-list build). Pure array arithmetic, runs every
   frame, spread in Babylon across many small virtual calls with temp-vector
   churn, and — critically — returns a *tiny* result. Ideal for the
   one-boundary-crossing pattern.
2. **Skeleton / bone matrix computation** — dense Mat4 chains, every frame for
   skinned meshes.
3. **CPU particle update** — large homogeneous arrays, simple physics.
4. **Geometry processing** (normals/tangents, VertexData transform) — WARM, big
   arrays, but infrequent.

Explicitly *expected to lose or break even*, and we will publish that:

* Isolated `Vec3`/`Mat4` micro-ops — V8 JITs these well; JS↔WASM call overhead
  dominates for sub-microsecond operations.
* Anything GPU-bound — moving CPU code cannot help a GPU bottleneck.
* Serialization / glTF load / shader compile — string/IO/driver bound.

---

## 7. Stage checklist

- [x] 1. Architecture (this doc)
- [x] 2. Reference clone + runnable Babylon (`reference/`, `@babylonjs/core`)
- [x] 3. Baseline benchmark (`bench:baseline` → `bench/results/baseline.json`)
- [x] 4. Profiling (`profile:pipeline` → `docs/PROFILING.md`)
- [x] 5. Hot-path identification → `docs/HOT_WARM_COLD.md`, `docs/FINDINGS.md`
       (winner: fused `_evaluateActiveMeshes` kernel)
- [x] 6. First C++ component (`native/include/bcpp/{math,scene}.hpp`, `src/engine.cpp`)
- [x] 7. WASM compilation (`npm run build:wasm` → `web/backend/bcpp.{mjs,wasm}`;
       emsdk in `tools/emsdk`). WASM rung = 1.26 ms (10.6× vs Babylon, 92% of native)
- [x] 8. WebGPU integration (`web/webgpu/Submitter.mjs`, `web/harness/`,
       `bench/run-browser.mjs` via Playwright)
- [x] 9. Equivalence tests (`native/tests/test_equiv.cpp` — 19457 checks, 0 fail;
       `run-compare`/`run-wasm` assert visible sets match Babylon byte-for-byte)
- [x] 10. Comparative benchmark — full ladder in `docs/COMPARISON.md`; browser
       adds real-WebGPU frame-vs-eval-vs-GPU + CPU/GPU-bound classification
- [x] 11. Automatic report (`bench/report.mjs` → PROFILING.md + COMPARISON.md + CSVs)
- [x] +. Migration analyzer (`tools/migration-analyzer/analyze.mjs`)
