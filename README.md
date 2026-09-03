# bcpp-engine — a WASM-first 3D runtime experiment

**v0.1.0 · experimental**

An empirical investigation: *how much of a JavaScript 3D engine's per-frame CPU
work actually benefits from a C++/WebAssembly core, keeping WebGPU as the
graphics backend?* Not a Babylon.js rewrite. Not a mock. A real runtime that
runs in the browser, built **only** on hot paths the benchmarks proved matter.

```
   TypeScript API          web/api/        Engine · Scene · Entity · Camera · box()/sphere()
        │
   WASM bindings           web/bindings/   WasmCore — the one module that touches engine.wasm
        │                                  1 JS→WASM call per frame
   C++ engine core         native/         bcpp::World  (ECS / SoA)  — evaluate() = the whole CPU frame
        │
   WebGPU renderer         web/renderer/   1 instanced-indexed draw per mesh batch
        │
       GPU
```

The C++ toolchain is a **build-time** dependency of this repo only. A consumer
gets `web/dist/` (`engine.js` + `engine.mjs` + `engine.wasm`) and:

```ts
import { Engine, box } from "bcpp-engine";

const engine = await Engine.create(canvas);
const scene  = engine.createScene();

const e = scene.createEntity();
e.transform.position.set(0, 1, 0);
e.mesh = box();

engine.start();
```

---

## The question, and why each choice

| choice | why |
|---|---|
| **Investigate, don't assume** | The point is to find *where* native code helps and *by how much* — and to publish where it doesn't. See *"What this does NOT prove"* in [docs/RESULTS.md](docs/RESULTS.md). |
| **Data-oriented (SoA)** | Profiling Babylon showed its per-frame cost is mostly per-object machinery (`SmartArray`, `Map`, observers, `_activate`), not arithmetic. A flat SoA over contiguous arrays removes that *before* any language change — worth ~1.8× in plain JS. ([docs/HOT_WARM_COLD.md](docs/HOT_WARM_COLD.md), [docs/PERFORMANCE_MODEL.md](docs/PERFORMANCE_MODEL.md)) |
| **C++ / WASM** | On top of data-oriented layout, native SIMD arithmetic over the SoA is a further ~6×. WASM keeps ~85–90% of the native ceiling **because the API crosses the JS↔WASM boundary once per frame**, never per object. |
| **WebGPU, kept in JS** | WASM can't call `navigator.gpu`. The renderer stays JS by necessity; the C++ core produces GPU-ready data and JS submits it. |

---

## Measured results (v0.1.0, frozen — full tables in [docs/COMPARISON.md](docs/COMPARISON.md))

Bench host: Intel Xeon E5-2620 v3 (2014), **no discrete GPU** (WebGPU on the
Microsoft WARP software rasteriser), Node 22, Emscripten 6.0.9, g++ 16.1.
**Absolute ms are ~3× a modern laptop; ratios transfer, WebGPU absolutes do not.**

**Scene-evaluation ladder** — 4000-node fixture, byte-identical visible set (asserted):

| implementation | ms/frame | vs Babylon |
|---|---|---|
| Babylon `_evaluateActiveMeshes` (OO) | 13.3 | 1× |
| hand-written data-oriented **JS** | 7.3 | 1.8× |
| **C++/WASM** (`-O3 -msimd128`, 1 crossing/frame) | 1.46 | **9.1×** |
| C++ native (ceiling) | 1.26 | 10.6× |

**Scaling** (`evaluate()`, no renderer): ≈ linear 1k→250k, ~4× vs JS kernel at
every size · 100k = 37 ms WASM vs 144 ms JS · 250k = 88 ms vs 369 ms.

**WASM SIMD**: `-O3 -msimd128` is **1.65×** over `-O3`.

**Memory**: 248 bytes/entity (SoA, exact) · 64 MB `INITIAL_MEMORY` covers ~270k
entities with no growth · JS heap flat.

**Real WebGPU** (browser, software GPU — CPU-frame FPS):

| scene | js → cpp | reading |
|---|---|---|
| heavyCulling | 62 → 205 | CPU-bound → big win |
| cpuBound | 52 → 277 | CPU-bound → big win |
| manyObjects | 38 → 154 | CPU-bound, then GPU-capped |
| manyVisible | 39 → 225 (eval 7×) | becomes GPU-bound → GPU-paced only ~1.2× |
| medium | 610 → 1587 | **both GPU-bound → C++ buys ~0 FPS** |

> A large eval speedup becomes FPS **only while scene evaluation is the critical
> path.** Measured: a 7× faster CPU moved FPS 1.06× on a GPU-bound scene.

---

## Quick start

```bash
# prerequisites: Node ≥ 20, git, Python 3 (emsdk only), a C++ compiler (native tests only)
npm install
npm run doctor                # what's still missing
npm run setup:emsdk           # one-time, ~2 GB — Emscripten toolchain

npm run build                 # build:wasm (em++) + build:api (esbuild) → web/dist/
npm run demo                  # http://localhost:8080  → engine-demo.html  (?count=20000&scene=field|hierarchy|culling)
```

## Reproduce the benchmarks

```bash
npm run test:equivalence      # 4 impls vs Babylon fixtures — byte-identical visible set
npm run test:visual           # renders 10k + 20k without a black screen (needs: npx playwright install chromium)
npm run bench:compare         # the CPU ladder → docs/COMPARISON.md
npm run bench:scale           # eval() scaling 1k→250k
npm run bench:memory          # bytes/entity, heap growth
npm run bench:wasm -- --profile engine-o3   # SIMD-off, to measure the SIMD win  (needs: npm run build:wasm:nosimd)
npm run bench:native          # C++ ceiling sweep (needs a C++ compiler)
npm run bench:browser         # real WebGPU, 2 backends
npm run bench:baseline        # Babylon _evaluateActiveMeshes (needs: npm run setup:reference)
npm run analyze               # migration analyzer — what to move next (needs: npm run setup:reference)
npm run report                # regenerate docs/PROFILING.md + docs/COMPARISON.md
```

Methodology, hardware, warmup/run counts, and the CPU-vs-browser-vs-GPU
separation: [docs/BENCHMARK_METHODOLOGY.md](docs/BENCHMARK_METHODOLOGY.md).

---

## Docs

[ARCHITECTURE](docs/ARCHITECTURE.md) · [WASM_ARCHITECTURE](docs/WASM_ARCHITECTURE.md) ·
[API](docs/API.md) · [PERFORMANCE_MODEL](docs/PERFORMANCE_MODEL.md) ·
[BENCHMARK_METHODOLOGY](docs/BENCHMARK_METHODOLOGY.md) · [MIGRATION_GUIDE](docs/MIGRATION_GUIDE.md) ·
[RESULTS](docs/RESULTS.md) · [FINDINGS](docs/FINDINGS.md) · [COMPARISON](docs/COMPARISON.md) ·
[PROFILING](docs/PROFILING.md) · [HOT_WARM_COLD](docs/HOT_WARM_COLD.md) · [CHANGELOG](CHANGELOG.md)

---

## Known Limitations

This is an experimental baseline, not a production engine.

- **Single-threaded.** WASM threads are scaffolded (`build:wasm --profile threads`) but **not benchmarked** — deliberate: `evaluate()` is still compute-bound at 250k, so SIMD comes first.
- **One hot path.** Only scene evaluation is in C++. Skeletal animation, CPU particles, normals/tangents, and geometry processing are **not migrated** (they're the next cycles, see [MIGRATION_GUIDE](docs/MIGRATION_GUIDE.md)).
- **No physics, no animation graph, no asset pipeline, no editor, no networking.**
- **Renderer is minimal & experimental** — one lambert-ish shader, instanced draw per mesh, depth. No shadows, PBR, post-processing, transparency sorting, LOD.
- **No entity deletion in v0.1** — ids are dense and never recycled (append-only). A generational slotmap is planned and will be benchmarked (it adds one indirection to the hot loop).
- **Equivalence is numeric-within-tolerance** (`maxRel ≈ 8e-4` from float accumulation order), on the STANDARD culling strategy. Not a bit-exact reimplementation of Babylon's math.
- **Benchmark host has no GPU.** Every browser scene reads CPU-bound because WARP is slow; on real hardware the CPU→GPU crossover moves to much larger scenes.
- **No production hardening** — error handling, context-loss recovery, memory limits, and browser-compat testing are minimal.

## What this does NOT prove

(full list in [docs/RESULTS.md](docs/RESULTS.md#what-this-experiment-does-not-prove))

WASM is not automatically faster than JS · C++ is not needed for most web apps ·
10× CPU ≠ 10× FPS · GPU-bound workloads may gain nothing · results are
workload- and hardware-specific · WARP ≠ a real GPU · this is not a Babylon.js
replacement · numeric equivalence ≠ visual correctness (see F-009).

---

## Roadmap

Each next cycle is a fresh investigation, one component at a time:
**profile → hypothesis → implement → equivalence → benchmark → conclusion.**

1. skeleton / bone matrices  ·  2. CPU particle update  ·  3. normals / tangents
·  4. geometry processing  ·  then: WASM threads (measure vs single-thread + SIMD).

No new hot path starts until v0.1.0 is a stable baseline.

## License

[MIT](LICENSE). Babylon.js (Apache-2.0) is used as a behavioural reference and
benchmark baseline only — not vendored, not redistributed.
