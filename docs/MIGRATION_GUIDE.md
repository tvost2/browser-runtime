# MIGRATION_GUIDE.md — moving a hot path into the WASM core

The process for every module after Scene evaluation. One at a time. Never skip
a step; the point of the project is the evidence, not the code.

## The loop

```
1. profile     add a workload that exercises the module; measure where its time goes
2. hypothesis  write it down in docs/FINDINGS.md BEFORE coding (benefit tier + why)
3. implement   SoA in native/include/bcpp/<module>.hpp, fold into World or a sibling pass
4. equivalence native/tests/test_<module>_equiv.cpp vs a Babylon-authored fixture
5. benchmark   native ceiling + WASM rung + browser, same 5-way ladder
6. conclude    update FINDINGS with the number; if it lost, say so and move on
```

## Design rules (enforced, not aspirational)

* **SoA, indexed by entity slot.** No component gets a struct-of-fields layout
  unless a benchmark shows AoS wins for that access pattern.
* **Fold into `World.evaluate()` when the data dependency allows** — one pass
  over `_order` already has the world matrices hot in cache. A separate pass
  only when it needs a different traversal (e.g. particles are flat, not
  hierarchical).
* **One boundary crossing.** New work is either inside `evaluate()` or its own
  single `wasm.<thing>()` call that consumes staged arrays and emits a compact
  result. If you're tempted to add `wasm.updateX(id, …)`, stop.
* **No per-frame allocation.** Size vectors once (`resize`), reuse. A `_hist`
  scratch buffer is fine; a `std::vector` created inside the loop is not.
* **No `std::map` on the hot path.** Counting sort / radix / dense arrays.
* **Keep the JS side.** Anything touching `document`, `fetch`, WebGPU objects,
  observers, or the asset pipeline stays in TypeScript.

## What the analyzer says to do next (`tools/migration-analyzer`)

Calibrated against the measured scene-eval result. Ranked GOOD CANDIDATE / HIGH
VALUE with no ✓ = untested hypothesis:

| module | tier | shape | hypothesis |
|---|---|---|---|
| **skeleton / bone matrices** | HIGH VALUE (hyp) | dense Mat4 chains per bone per frame | same as transform propagation — should be ~native ceiling |
| **CPU particle update** | GOOD CANDIDATE (hyp) | flat SoA, trivial integration, SIMD-friendly | own pass (not hierarchical); big homogeneous arrays |
| **normals / tangents** (`Maths/math.functions.ts`) | GOOD CANDIDATE (hyp) | one big Float32Array in, one out | WARM not HOT — runs on mesh edit; measure the per-call win |
| **thin instances** (`thinInstanceMesh`) | GOOD CANDIDATE (hyp) | pack instance matrices into a buffer | natural WASM output; already close to how `instanceWorld` works |
| `math.vector` isolated | DO NOT MIGRATE | — | **measured** F-001: boundary cost > op cost |
| `animation` (float tracks) | MAYBE | — | **measured** F-001: 0.07 ms/frame; revisit with quat/matrix/skeletal |

## Packaging (the consumer never sees C++)

`npm run build:wasm && npm run build:api` produces `web/dist/`:

```
engine.js     bundled TS API  (the import target)
engine.mjs    emscripten loader
engine.wasm   the C++ core
engine.d.ts   types
```

`package.json` `exports` points at `./web/dist/engine.js`. A consumer does:

```ts
import { Engine, box } from "your-engine";
const engine = await Engine.create(canvas);
const scene = engine.createScene();
const mesh = scene.registerMesh(box(1));
scene.createEntity().setMesh(mesh).transform.position.set(0, 1, 0);
engine.uploadMeshes(scene);
engine.start();
```

No emsdk, no CMake, no compiler, no native deps. The toolchain lives in
`tools/emsdk` and is a **build-time** dependency of the engine repo only.

## Adding a build variant to measure a flag

`native/build-wasm.mjs` `PROFILES` — add an entry, then
`node native/build-wasm.mjs --profile <name> --out engine-<name>` and
`node bench/run-wasm.mjs --profile engine-<name>`. Results carry the label so
`docs/COMPARISON.md` can show the flag's contribution (e.g. SIMD on vs off).
