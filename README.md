# Browser Runtime

**A WASM-first 3D runtime experiment using C++, WebAssembly and WebGPU.**

`v0.1.0` · experimental · [CHANGELOG](CHANGELOG.md)

---

## What this is

An empirical investigation into whether a **browser-first** 3D runtime can be
built on:

```
TypeScript  +  C++/WASM  +  data-oriented memory  +  WebGPU
```

with the **browser as the execution platform** — not as a secondary export
target of a native engine.

```
TypeScript API          web/api/        Engine · Scene · Entity · Camera · box()/sphere()
     │
WASM bindings           web/bindings/   WasmCore — the one module that touches engine.wasm
     │                                  1 JS→WASM call per frame
C++ runtime             native/         bcpp::World (ECS / SoA) — evaluate() = the whole CPU frame
     │
WebGPU renderer         web/renderer/   1 instanced-indexed draw per mesh batch
     │
    GPU
```

The C++ toolchain (Emscripten) is a **build-time** dependency of this repo only.
A consumer gets `web/dist/` (`engine.js` + `engine.mjs` + `engine.wasm`) and:

```ts
import { Engine, box } from "browser-runtime";

const engine = await Engine.create(canvas);
const scene  = engine.createScene();

const e = scene.createEntity();
e.transform.position.set(0, 1, 0);
e.mesh = box();

engine.start();
```

This is **not** a replacement for Babylon.js, three.js, or any other engine.
Babylon.js is used only as a behavioural reference and benchmark baseline.

---

## Why these choices

| choice | why |
|---|---|
| **Investigate, don't assume** | Find *where* native code helps and *by how much* — and publish where it doesn't. |
| **Data-oriented (SoA)** | Profiling Babylon showed its per-frame cost is mostly per-object machinery (`SmartArray`, `Map`, observers), not arithmetic. A flat SoA removes that *before* any language change — ~1.8× in plain JS. |
| **C++ / WASM** | On top of data-oriented layout, native SIMD over the SoA is a further ~6×. WASM keeps most of the native ceiling **because the API crosses the JS↔WASM boundary once per frame, never per object.** |
| **WebGPU, kept in JS** | WASM can't call `navigator.gpu`. The renderer stays in JS; the C++ core produces GPU-ready data and JS submits it. |

---

## Quick start

Requirements: **Node ≥ 20**, **git**, **Python 3** (Emscripten only), a **C++
compiler** (`g++`/`clang++`, for the native equivalence tests only), and for the
browser benchmarks a **Chromium with WebGPU** (`npx playwright install chromium`).

```bash
npm install
npm run doctor            # reports exactly what your machine is still missing
npm run setup:emsdk       # one-time, ~2 GB — Emscripten 6.0.9 toolchain
npm run setup:reference   # optional — clones Babylon.js for `analyze` / `bench:baseline`

npm run build             # build:wasm (em++) + build:api (esbuild) → web/dist/
npm run test:equivalence  # every impl vs Babylon fixtures — must be byte-identical
npm run demo              # http://localhost:8080  → engine-demo.html
                          #   ?count=20000&scene=field|hierarchy|culling
```

Reproduce the measurements (see [docs/BENCHMARK_METHODOLOGY.md](docs/BENCHMARK_METHODOLOGY.md)):

```bash
npm run test:visual       # renders 10k + 20k without a black screen
npm run bench:compare     # the CPU ladder → docs/COMPARISON.md
npm run bench:scale       # evaluate() scaling 1k→250k
npm run bench:memory      # bytes/entity, heap growth
npm run bench:browser     # real WebGPU, 2 backends
npm run bench:native      # C++ ceiling sweep
npm run analyze           # migration analyzer — what to move next
npm run report            # regenerate docs/PROFILING.md + docs/COMPARISON.md
```

---

## Results (v0.1.0 — frozen baseline)

> **Results are workload- and hardware-dependent.** Bench host: Intel Xeon
> E5-2620 v3 (2014), **no discrete GPU** (WebGPU on the Microsoft WARP software
> rasteriser), Node 22, Emscripten 6.0.9, g++ 16.1. Absolute milliseconds are
> ~3× a modern laptop; **the ratios transfer, the WebGPU absolutes do not.**
> Full tables: [docs/COMPARISON.md](docs/COMPARISON.md) · [docs/RESULTS.md](docs/RESULTS.md).

**Scene-evaluation ladder** — 4000-node fixture, byte-identical visible set (asserted):

| implementation | ms/frame |
|---|---|
| Babylon `_evaluateActiveMeshes` (OO) | ~13.3 |
| hand-written data-oriented **JS** | ~7.3 |
| **C++/WASM** (`-O3 -msimd128`, 1 crossing/frame) | ~1.1–1.7 |
| C++ native (ceiling) | ~1.1–1.5 |

**Scaling** (`evaluate()`, Node, no renderer) — ≈ linear, ~4× vs the JS kernel at every size:

| entities | C++/WASM | JS data-oriented |
|---|---|---|
| 10k | 2.5 ms | 12.0 ms |
| 50k | 15.7 ms | 65.4 ms |
| 100k | 37.1 ms | 143.9 ms |
| 250k | 87.8 ms | 369.0 ms |

**WASM SIMD** — `-O3` = 2.40 ms · `-O3 -msimd128` = 1.46 ms → **1.65×**.

**Memory** — 248 bytes/entity (SoA, exact); 64 MB `INITIAL_MEMORY` covers ~270k
entities with no growth; JS heap flat.

**Equivalence** — 4/4 implementations, byte-identical visible set;
`test_equiv`: **19,457 numeric checks, 0 failures**.

### Browser (real WebGPU, software rasteriser — CPU-frame FPS)

| scene | js → cpp | reading |
|---|---|---|
| heavyCulling | 62 → 205 | CPU-bound → big win |
| cpuBound | 52 → 277 | CPU-bound → big win |
| manyObjects | 38 → 154 | CPU-bound, then GPU-capped |
| manyVisible | (CPU eval improves ~7×) | overall FPS becomes **GPU-paced** |
| medium | 610 → 1587 | both **GPU-bound** (GPU-paced) → C++ buys ~0 real FPS |

**CPU optimisation ≠ proportional FPS improvement.** When the GPU is the
bottleneck, reducing CPU time does not necessarily raise FPS — measured: a 7×
faster CPU moved FPS by ~1.06× on a GPU-bound scene.

---

## What this project does NOT prove

- WASM is **not** automatically faster than JavaScript.
- C++ is **not** required for web applications.
- 10× more CPU does **not** mean 10× more FPS.
- GPU-bound workloads may show **no** FPS gain.
- Results depend on the workload.
- Results depend on the hardware.
- WARP / a software rasteriser does **not** represent a physical modern GPU.
- This is **not** a substitute for Babylon.js.
- Numeric equivalence does **not** guarantee visual correctness (see F-009 in [docs/FINDINGS.md](docs/FINDINGS.md)).
- The runtime is still **experimental**.
- There is **not** yet a complete engine.

Longer form: [docs/RESULTS.md](docs/RESULTS.md#what-this-experiment-does-not-prove).

---

## Documentation

| doc | |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | layer model, the measurement boundary, HOT/WARM/COLD |
| [docs/WASM_ARCHITECTURE.md](docs/WASM_ARCHITECTURE.md) | SoA layout, exact `em++` flags + why, module init, determinism |
| [docs/API.md](docs/API.md) | public TypeScript surface + ownership / lifecycle |
| [docs/PERFORMANCE_MODEL.md](docs/PERFORMANCE_MODEL.md) | CPU / GPU / memory / boundary-bound decision table |
| [docs/BENCHMARK_METHODOLOGY.md](docs/BENCHMARK_METHODOLOGY.md) | every benchmark's env / workload / warmup / metric |
| [docs/PROFILING.md](docs/PROFILING.md) | generated — where Babylon's frame time goes |
| [docs/COMPARISON.md](docs/COMPARISON.md) | generated — the full ladder + scaling + SIMD + memory + browser |
| [docs/RESULTS.md](docs/RESULTS.md) | the answer, and what it does not prove |
| [docs/FINDINGS.md](docs/FINDINGS.md) | running log (F-001 … F-009) |
| [docs/MIGRATION_GUIDE.md](docs/MIGRATION_GUIDE.md) | the process for the next hot path |
| [docs/HOT_WARM_COLD.md](docs/HOT_WARM_COLD.md) | component classification |
| [docs/ROADMAP.md](docs/ROADMAP.md) | phased plan (below in short) |

---

## Roadmap

Each future hot-path migration follows: **PROFILE → HYPOTHESIS → IMPLEMENT →
EQUIVALENCE → BENCHMARK → CONCLUSION.** Nothing ships because it "looks
interesting" — see [docs/ROADMAP.md](docs/ROADMAP.md) for the full plan and the
8 questions every migration must answer.

**Phase 0 — Baseline** ✅ `v0.1.0`
C++/WASM runtime · ECS/SoA · transform evaluation · frustum culling · WebGPU ·
batching · equivalence tests · scaling benchmarks · WASM SIMD · public release.

**Phase 1 — Real assets** (next) — GLB/glTF loader · geometry upload · material
loading · textures · asset lifecycle.

**Phase 2 — Runtime hot paths** — profile skeleton · particles · geometry
processing · normals/tangents (one at a time).

**Phase 3 — Runtime features** — skeletal animation · particles · physics
investigation · asset streaming · instancing.

**Phase 4 — Browser platform** — PWA packaging · offline asset cache · mobile
browser + WebGPU testing · memory constraints · thermal/battery.

The current cycle: **[docs/investigations/glb.md](docs/investigations/glb.md)** —
design work only, not yet implemented.

---

## Development

`v0.1.0` is a **frozen baseline** — its code and benchmark numbers do not change.
New work happens on `develop`; each investigation lands as small, logical commits
(`feat(asset): …`, `test(visual): …`, `bench(asset): …`, `docs(asset): …`).

## License

[MIT](LICENSE). Babylon.js (Apache-2.0) is a behavioural reference and benchmark
baseline only — not vendored, not redistributed.
