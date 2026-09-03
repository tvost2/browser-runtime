# web/backend/ — benchmark backends

Three implementations of the **same** per-frame kernel (transform propagation +
world bounds + STANDARD frustum culling → mesh-batched visible list), compared
by `bench/` on identical workloads. All produce a byte-identical visible set
(asserted by `npm run test:equivalence`).

| file | what | rung |
|---|---|---|
| — | real Babylon `Scene._evaluateActiveMeshes` | measured by `bench/profile-pipeline.mjs` (needs `npm run setup:reference` / `@babylonjs/core`) |
| `JsBackend.mjs` | hand-written data-oriented **JavaScript** — flat typed arrays, no per-node objects, no hot-loop allocation. The honest "a competent JS author wrote this" baseline. | rung 2 |
| `WasmBackend.mjs` | thin adapter over the shipped **C++/WASM** core (`web/bindings/WasmCore` → `bcpp::World`). Same core the public `Engine` API drives. | rung 4 |
| — | C++ **native** (`native/tests/bench_world.cpp`, `-O3 -march=native`, no boundary) | rung 3 — the ceiling |

## Shape (informal — plain `.mjs`, no TS interface)

```js
await backend.init(wasmUrl?)                    // async setup
backend.upload({ count, parents, trs, extents, flags })   // bulk, one time
backend.updateTransforms(indices|null, trs)     // per-frame SoA writes (bulk)
backend.evaluateFrame(viewProj16, strategy, sortByMesh)   // → { visibleCount, visibleIds, visibleWorld, stats }
backend.dispose()
```

`trs` is `[count*10]` = pos3 · quat4 · scale3. `viewProj16` is row-major LH.
The result typed arrays are views valid only until the next `evaluateFrame`.

## Build artifacts (git-ignored, produced by `npm run build`)

`engine.mjs` + `engine.wasm` (the C++ core, from `native/build-wasm.mjs`) ·
`engine-o3.*` etc. (build variants) · `*.build.json` (build metadata).
