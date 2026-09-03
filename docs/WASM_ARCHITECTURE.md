# WASM_ARCHITECTURE.md — the WASM-first runtime

```
Browser
  │
  ├─ TypeScript API           web/api/        Engine · Scene · Entity · Camera · meshes
  │      (public, ergonomic; owns nothing hot)
  │
  ├─ WASM bindings            web/bindings/   WasmCore.ts  — the ONLY module that
  │                                            touches engine.wasm; exposes SoA
  │                                            component arrays as heap VIEWS
  │
  ├─ C++ engine core          native/         bcpp::World (world.hpp) — ECS/SoA,
  │      engine.wasm                           evaluate() = the whole CPU frame
  │
  └─ WebGPU renderer          web/renderer/   Renderer.ts — consumes the render
         (thin consumer)                       list, 1 instanced-indexed draw/batch
              ↓
             GPU
```

Same `bcpp::World` core is used by:
* the public API (`web/api/Engine`) — the product
* the benchmark `WasmBackend` (`web/backend/WasmBackend.mjs`) — measurement
* native ceiling bench (`native/tests/bench_world.cpp`)
* equivalence test (`native/tests/test_world_equiv.cpp`)

There is exactly **one** WASM module and **one** evaluation path.

---

## The boundary rule (the whole point)

Per frame, JS ↔ WASM crossings = **2**: one write region for the view-projection
matrix (16 floats), one `world.evaluate()` call. Everything else is JS writing
into typed-array views over WASM linear memory — no function calls.

```
JS: write SoA rows (pos/rot/scale/parent/flags/…) directly into WASM heap views
JS: write camera viewProj (16 f32) into WASM heap
JS: world.evaluate(strategy, sortByMesh)      ← the one call
        C++: rebuild traversal order iff hierarchy dirty  (topological, O(n log n))
        C++: for each entity in topo order:
               local = compose(scale, rot, pos)
               world = local · world[parent]
               refit world AABB (8 corners) + world sphere
               cull: 6-plane sphere reject → 8-corner box reject
        C++: counting-sort visible by meshId → instanceWorld[], batches[]
JS: read visibleCount, then views over instanceWorld / instanceMeshId / batches
JS: renderer draws — 1 drawIndexed(indexCount, instanceCount, …) per batch
```

Forbidden by construction: there are **no** per-entity WASM entry points. You
cannot write `wasm.setPosition(id, …)` — you write `core.components.pos[id*3]`.

---

## Data layout (SoA)

`shared/layout.ts` is the single source of truth; `native/include/bcpp/world.hpp`
mirrors it. Every component is one contiguous `std::vector<T>` indexed by a dense
entity slot `[0, count)`:

| component | type | stride | notes |
|---|---|---|---|
| localPos | f32 | 3 | |
| localRot | f32 | 4 | quaternion x,y,z,w |
| localScale | f32 | 3 | |
| parent | i32 | 1 | −1 = root; any order (topo-sorted internally) |
| localMin/localMax | f32 | 3 | mesh AABB, set on `setMesh` |
| meshId / materialId | u32 | 1 | |
| flags | u32 | 1 | ENABLED\|VISIBLE\|ALWAYS_ACTIVE\|CAST_SHADOW |
| world (out) | f32 | 16 | row-major, Babylon layout |
| worldSphere (out) | f32 | 4 | xyz center, w radius |

Outputs of `evaluate`: `visibleId[]`, `instanceWorld[]` (batch-sorted, GPU-ready),
`instanceMeshId[]`, `batches[] = {meshId, firstInstance, instanceCount}`.

Design choices, each reversible and measured:
* **no per-entity objects** in the core — `Entity`/`Transform` in TS are handles
  that index the arrays; created at build time, never per frame.
* **no per-frame allocation** — all vectors sized once (1.5× growth), reused.
* **no `std::map`** — `meshId` batching is a counting sort over a small histogram.
* **no virtual dispatch** in `evaluate`.
* **topological order rebuilt only when the hierarchy changes** (parent set) —
  `markHierarchyDirty()`; steady-state frames skip it.
* deletion is **not** implemented (append-only). Measured decision: the demo and
  all 9 benchmark workloads build once. A slotmap with generation indices is the
  planned addition when a workload needs churn — it adds one indirection to the
  hot loop, so it will be benchmarked before it lands.

---

## Memory & copies

| hop | cost | mitigation |
|---|---|---|
| JS → WASM heap (SoA writes) | direct typed-array writes, no copy | views refreshed only after `resize()` grows the heap |
| WASM compute | in-place over `std::vector` | — |
| WASM → JS (render list) | zero-copy: `new Float32Array(HEAP.buffer, ptr, len)` | valid only until next `evaluate()` |
| JS → GPU (`instanceWorld`) | one `queue.writeBuffer` of `visibleCount*64` bytes | the only unavoidable copy; WebGPU has no way to map WASM memory as a GPU buffer |
| vertex/index data → GPU | once, at `uploadMeshes()` | — |

The `instanceWorld → GPU storage buffer` copy is the irreducible one. It is
`visibleCount × 64` bytes/frame (e.g. 4000 visible ≈ 256 KB) and shows up as
part of "cpu frame" in the browser stats, distinct from "eval".

---

## Build (`npm run build:wasm` → `native/build-wasm.mjs`)

**Toolchain:** Emscripten **6.0.9** (pinned in `native/setup-emsdk.mjs`; clang
21, binaryen from that release). `npm run setup:emsdk` fetches + activates it
into `tools/emsdk/`. The primary build is a **direct `em++` call** — not CMake
(CMake target in `native/CMakeLists.txt` mirrors it as an alternative).

**Exact command** (profile `release`):

```
em++ -std=c++20 -O3 -msimd128
     -I native/include
     native/bindings/engine.cpp
     --bind
     -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createEngine
     -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=1073741824
     -sSTACK_SIZE=2097152
     -sENVIRONMENT=web,worker,node
     -sEXPORTED_RUNTIME_METHODS=HEAPF32,HEAPU32,HEAP32,HEAPU8
     -o web/backend/engine.mjs
```

**Flags — why:**
| flag | reason |
|---|---|
| `-O3` | full optimisation; measured 1.6× over `-O2` on this kernel |
| `-msimd128` | WASM 128-bit SIMD; measured **1.65×** over `-O3` alone (LLVM vectorises `Mat4::multiply`/`compose` + the 8-corner AABB transform) |
| `--bind` (embind) | the JS↔C++ glue. **Requires RTTI** — do NOT add `-fno-rtti`. |
| no `-fno-exceptions`, no `-flto` | both, with this toolchain + embind + libc++, cause `undefined symbol: operator new` at link. See `docs/FINDINGS.md` F-005. |
| `MODULARIZE` + `EXPORT_ES6` + `EXPORT_NAME=createEngine` | emits an ESM factory: `const mod = await createEngine()` |
| `ALLOW_MEMORY_GROWTH` | linear memory grows past `INITIAL_MEMORY` on demand |
| `INITIAL_MEMORY=64 MB` | covers ~270k entities with zero growth (SoA = 248 B/entity) |
| `MAXIMUM_MEMORY=1 GB` | hard cap |
| `STACK_SIZE=2 MB` | headroom for the recursive `computeDepth` in topological sort (guarded against cycles, but deep hierarchies need stack) |
| `ENVIRONMENT=web,worker,node` | the same `engine.mjs` loads in a page, a Worker, and Node (used by the benchmarks) |
| `EXPORTED_RUNTIME_METHODS=HEAP*` | JS reads the SoA as typed-array views over these |

**Module init (JS side, `web/bindings/WasmCore.ts`):**
`await createEngine()` → `new mod.World()` (embind object; must be
`.delete()`d — `WasmCore.dispose()` does). `WasmCore` then reads the staging +
result pointers once and builds `Float32Array`/`Int32Array`/`Uint32Array` views
over `mod.HEAPF32.buffer` etc. Views are rebuilt only when `resize()` grows the
heap (entity capacity growth).

**Artifacts:** `engine.mjs` (~41 KB glue) + `engine.wasm` (~31 KB). `build:api`
copies both into `web/dist/` next to the bundled `engine.js`.

### Determinism

The build is **not bit-reproducible** across machines: Emscripten embeds
absolute temp paths and the wasm-opt pass order can vary. What IS stable:
* the **exported symbol set** and the module ABI,
* the **numeric output** — `evaluate()` is deterministic for given inputs
  (no RNG, no threads, IEEE-754 float; equivalence tests assert this every run),
* performance within run-to-run noise (CV ~0.2–0.35 on the bench host).

Pin the Emscripten version (`setup-emsdk.mjs`) to reproduce the *same* codegen.

### Build variants (`--profile X [--out engine-<x>]`)

| profile | flags | purpose |
|---|---|---|
| `release` | `-O3 -msimd128` | ships (default) |
| `o3` | `-O3` | isolate the WASM-SIMD contribution (`bench:wasm --profile engine-o3`) |
| `debug` | `-O0 -g3 -sASSERTIONS=2` | dev |
| `simdlto` | `-O3 -msimd128 -flto` | test LTO (see F-005 — currently breaks) |
| `threads` | `+ -pthread -sPTHREAD_POOL_SIZE=4` | scaffolded, **not benchmarked** — needs COOP/COEP headers (`web/serve.mjs` sets them) |

`bench:wasm --profile <name>` benchmarks each; results carry the profile label.

### Measured so far (4000-node fixture, `docs/COMPARISON.md`)

| build | median ms | vs `o3` |
|---|---|---|
| `o3` (`-O3`) | 2.40 | 1.00× |
| `release` (`-O3 -msimd128`) | 1.46 | **1.65×** |

WASM SIMD is worth ~1.6× here — LLVM vectorises `Mat4::multiply`/`compose` and
the 8-corner AABB transform. On by default (every WebGPU browser has WASM SIMD).

### Threads — deferred, not measured

Order is deliberate: **single-thread → SIMD → threads**, each measured before the
next. Single-thread + SIMD is done. Threads (`--profile threads`) is scaffolded
but **not benchmarked**, because:

* `World.evaluate()` scaling is still ≈ linear at 250k entities (`docs/COMPARISON.md`
  "Scaling"): the pass is compute-bound, not yet bandwidth-bound. Threads help
  most when you're *not* bandwidth-bound — so there may be a real win here — but
  the topological hierarchy pass has a serial dependency (parent before child)
  that limits the parallel fraction. The cull + bounds passes are embarrassingly
  parallel.
* pthreads needs `SharedArrayBuffer` → COOP/COEP headers on every response
  (`web/serve.mjs` sets them), which also breaks some third-party embeds.
* Worker spin-up + the per-frame barrier cost must be amortised over the eval
  work; at < ~20k entities it likely loses.

Plan when it's this component's turn: split pass-1 (compute local→world→bounds→cull)
into N ranges over `_order`, each worker owning a contiguous slice, join, then a
serial pass-2 (batch sort). Measure at 10k / 50k / 250k against single-thread +
SIMD. Publish the loss cases.

---

## Browser limitations encountered

* WASM cannot call `navigator.gpu` — the renderer stays in JS by necessity.
* WebGPU cannot import WASM linear memory as a `GPUBuffer` — the instance-matrix
  upload copy is unavoidable.
* Playwright Chromium's bundled DXC is broken → need
  `--disable-dawn-features=use_dxc`; SwiftShader-WebGPU didn't expose
  `navigator.gpu` on the bench host at all.
* `timestamp-query` (GPU timing) is not guaranteed; the renderer degrades to
  `gpuMs = null`.
* pthreads needs `SharedArrayBuffer` → cross-origin isolation headers on every
  response.
