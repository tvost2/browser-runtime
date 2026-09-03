# Findings

Running log of what the data says. Newest first. Every entry cites the command
that produced it so it can be re-checked.

Benchmark host: Intel Xeon E5-2620 v3 @ 2.4 GHz, Node v22.19, Windows 10,
g++ 16.1 (MinGW-w64). Absolute numbers are ~3× a modern laptop; ratios hold.

---

## F-009 · Bug caught: far/near ratio destroyed depth precision (black screen)
`bench/test-engine-browser.mjs` visual check

The demo rendered a **black screen** at 10k entities. Not a WASM/culling/batching
bug — the visible set and instance matrices were correct (verified). Cause:
`Camera` defaulted to `near=0.1, far=4000` while the scene sits at ~200 units.
Hyperbolic depth crushed every fragment to `z_ndc ≈ 0.9995`; on WARP's 24-bit
depth buffer with `depthCompare:"less"` and clear `1.0`, the whole scene
collapsed into one depth bucket → z-fight → nothing survived.

Fix: `Camera` defaults tightened to `near=0.5, far=1500`; added
`camera.fit(radius)` to derive sane planes from scene extent; the demo calls it.
**Lesson:** correctness at the API boundary (camera math, depth setup) is as
important as the kernel — and only a *visual* check catches it; the equivalence
tests (visible set) all passed while the screen was black.

## F-008 · Scaling to 250k entities stays linear; WASM SIMD ≈ 1.6×
`node --expose-gc bench/run-scale.mjs 250000` · `bench:wasm --profile engine-o3`

`World.evaluate()`, Node, no renderer, shell scene:

| entities | WASM ms | JS kernel ms | WASM speedup | ns/entity |
|---|---|---|---|---|
| 1 000 | 0.34 | 1.15 | 3.4× | 338 |
| 10 000 | 2.47 | 12.0 | 4.9× | 247 |
| 50 000 | 15.7 | 65.4 | 4.2× | 315 |
| 100 000 | 37.1 | 143.9 | 3.9× | 371 |
| 250 000 | 87.8 | 369.0 | 4.2× | 351 |

- **≈ linear** — ns/entity dips to 247 (working set in L2/L3) then rises to ~350
  as it spills L3. Not super-linear through 250k → still compute-bound, so **SIMD
  is the first lever, not threads**.
- The ~4× WASM-over-JS-kernel ratio is stable at every scale.
- 100k entities: 37 ms WASM eval vs 144 ms JS kernel vs ~330 ms Babylon
  (extrapolated). Only the WASM core makes 100k CPU-feasible.

**WASM SIMD:** `-O3` = 2.40 ms, `-O3 -msimd128` = 1.46 ms → **1.65×**, identical
visible set. LLVM vectorises `Mat4::multiply` / `compose` / the 8-corner
transform. On by default (every WebGPU browser has WASM SIMD).

**Live demo at scale** (`bench/test-engine-browser.mjs field N`, software GPU):
10k → eval 5.7 ms / 101 fps; 50k → eval 13.6 ms / 65 fps; 100k → the software
rasteriser can't keep up (real GPU needed). CPU side is fine at 100k; the GPU is
the wall — exactly the model in `docs/PERFORMANCE_MODEL.md`.

## F-007 · The architecture scales: a WASM-first runtime hits the native ceiling and runs in the browser
`npm run build && node bench/test-engine-browser.mjs` · `npm run bench:compare` · `npm run test:equivalence`

Rebuilt the experiment as a real runtime: TS API (`web/api`) → `WasmCore`
(1 crossing/frame) → `bcpp::World` ECS/SoA core → `Renderer` (WebGPU). The core
does hierarchy traversal + transform propagation + bounds refit + frustum
culling + **meshId batching** (counting sort → one `drawIndexed` per mesh).

Ladder, 4000-node fixture, identical visible set (all 4 impls asserted):

| rung | ms/frame | vs Babylon |
|---|---|---|
| Babylon `_evaluateActiveMeshes` | 13.3 | 1× |
| hand JS data-oriented | 7.3 | 1.8× |
| **C++/WASM World core** | **1.1–1.7** | **8–12×** |
| C++ native World | 1.1–1.5 | 9–12× |

WASM ≈ native (within run-to-run noise on this box) — the extra work (batching
sort, topological hierarchy rebuild) did not move it off the ceiling.

Live demo (`web/harness/engine-demo.html`, 4000 mixed cubes+spheres, orbit
camera, per-frame SoA animation writes, software GPU): WASM eval **2.7 ms**,
cpu frame 4.9 ms, **2 draw calls** (batched), 200 fps, 3594/4000 visible,
0 errors. Screenshot: `bench/results/engine-demo.png`.

Browser 2-backend comparison with the new core (scale 0.5, WARP software GPU):

| scene | js fps | cpp fps | GPU-paced | note |
|---|---|---|---|---|
| heavyCulling | 60 | 265 | **3.7×** | genuinely CPU-bound both (GPU 4.5 ms) — the sweet spot |
| cpuBound | 56 | 282 | 2.5× | cpp becomes GPU-bound |
| manyVisible | 38 | 225 | **1.06×** | 7× eval speedup, but cpp is now GPU-bound → no FPS gain |
| medium | 840 | 1667 | **0.87×** | both GPU-bound → C++ buys nothing for FPS |

The last two rows are the headline caveat, measured: a large eval speedup only
becomes FPS while the frame is CPU-bound on evaluation.

## F-006 · Real WebGPU: the CPU speedup shows up as FPS while the scene is CPU-bound
`npm run build:wasm && node bench/run-browser.mjs` (Chromium, `--disable-dawn-features=use_dxc`)

Same instanced-cube WebGPU workload, backend swapped. Bench host has no discrete
GPU → software adapter, so `gpu ms` is inflated and large scenes read CPU-bound.

| scene | meshes | js CPU-frame | cpp CPU-frame | eval speedup | gpu ms js/cpp | js→cpp FPS |
|---|---|---|---|---|---|---|
| medium | 800 | 2.67 ms | 0.80 ms | 5.6× | 6.9 / 5.6 | 375 → 1250 |
| manyObjects | 20000 | 51.9 ms | 13.1 ms | 4.1× | 32.7 / 34.6 | 19 → 77 |

- GPU time is **unchanged** by the backend swap (32.7 vs 34.6 ms) — the design
  goal (identical GPU workload) holds; the delta is entirely CPU-side.
- `manyObjects`: **19 → 77 fps (4×)** — the eval speedup passes straight through
  because the scene is CPU-bound even with software rendering.
- `medium` with the C++ backend: CPU-frame 0.8 ms but GPU 5.6 ms → **now
  GPU-bound**. A vsync/GPU-paced loop would sit at ~5.6 ms/frame regardless of
  backend. This is the crossover the experiment set out to find; on real GPU
  hardware it lands at a much larger mesh count.

**Environment note:** WebGPU device creation initially failed with
`dxil.dll Error 87` (Playwright Chromium ships an incompatible DXC). Forcing the
FXC shader compiler (`--disable-dawn-features=use_dxc`) fixed it. SwiftShader-
WebGPU (`BCPP_GPU=sw`) did not expose `navigator.gpu` on this box.

## F-005 · WASM keeps 92% of the native ceiling
`npm run build:wasm && node bench/run-wasm.mjs`  ·  `bench/run-compare.mjs`

emscripten `em++ -O3 -msimd128`, embind, **one `evaluate()` call per frame**
(viewProj written to the WASM heap, visible list read back as a heap view — no
per-node crossings). Fixture scene, 4000 nodes:

| rung | ms/frame | vs Babylon | vs prev |
|---|---|---|---|
| Babylon `_evaluateActiveMeshes` | 13.3 | 1× | — |
| hand-written data-oriented JS | 6.4–8.3 | ~1.8× | ~1.8× |
| **C++/WASM** (`-O3 -msimd128`) | **1.26** | **10.6×** | ~6× |
| C++ native (`-march=native`) | 1.15 | 11.5× | 1.09× |

Visible set byte-identical to Babylon (asserted every run). The native→wasm gap
is only **1.09×** — for pure float arithmetic over flat arrays with a single
boundary crossing, the sandbox costs almost nothing. Most of the "WASM tax" you
read about comes from chatty boundaries, which this design avoids by construction.

Build gotchas (documented so the next person skips them): embind needs RTTI (no
`-fno-rtti`); `-fno-exceptions` + `-flto` break libc++ `operator new` resolution;
use `em++` not `emcc` for the C++ link; `import()` of an absolute Windows path
needs `pathToFileURL`.

## F-004 · Native fused kernel: ~12× the eval math, numerically exact
`node bench/native-ceiling.mjs` · `native/tests/test_equiv.cpp`

The C++ kernel does, in one linear pass over SoA arrays:
local compose → world = local·parentWorld → world AABB from 8 corners →
world sphere → 6-plane sphere reject → 8-corner box reject → emit visible id + world matrix.

| meshes | Babylon `_evaluateActiveMeshes` | native fused kernel | ratio |
|---|---|---|---|
| 800 | 1.77 ms | 0.30 ms | 5.9× |
| 5000 | 16.6 ms | 1.44 ms | 11.6× |
| 7000 | 25.7 ms | 2.14 ms | 12.0× |

Equivalence: 19 457 numeric checks (compose, multiply, frustum planes, full
visible-set), **0 failures**, max abs error 1.2e-4, max rel error 8.2e-4
(float32 accumulation order differences only). Visible set identical
(1889/4000 on the fixture scene).

**Caveat:** this is a ceiling. It excludes render-list build, submesh dispatch,
material collection, LOD, observers — which Babylon does inside the same 25.7 ms
and which (mostly) stay in JS in the experimental design. Stage 10 measures the
real end-to-end number.

## F-003 · One `std::fmin` call cost 3× the whole kernel
`native/tests/micro.cpp`

First native build: 12.7 ms / 7000 nodes — barely 2× Babylon, suspicious.
Isolation showed the 8×-per-node bounding-box corner loop jumped from 0.25 ms
to 3.9 ms purely from `std::fmin`/`std::fmax` (MinGW libm, not inlined).
Replacing with branchless ternaries: 3.9 ms → 0.98 ms; full kernel 12.7 → 2.2 ms.
*Lesson for the WASM port: audit every libm call; Emscripten has the same trap.*

## F-002 · `_evaluateActiveMeshes` IS the CPU frame
`npm run profile:pipeline` → `docs/PROFILING.md`

| scene | meshes | frame | activeMeshesEval | share |
|---|---|---|---|---|
| medium | 800 | 1.84 ms | 1.77 ms | 96% |
| manyObjects | 7000 | 25.8 ms | 25.7 ms | 99% |
| manyVisible | 6000 | 25.5 ms | 25.4 ms | 99% |
| cpuBound | 5000 | 16.7 ms | 16.6 ms | 99.6% |

`renderRest` (draw phase) is <0.06 ms on NullEngine — real GPU submission cost
is measured separately in the browser harness. `preEval` (animation + skeleton)
is negligible at these scales.

Within eval, direct `computeWorldMatrix` + `isInFrustum` timing accounts for
~35–40%; the other ~60% is per-mesh object machinery (SmartArray, LOD `Map`
get/set, `_preActivate`/`_activate`, observer notify, `_evaluateSubMesh`).
A data-oriented backend removes *both* parts.

## F-001 · Isolated math is not a target; animation is not a bottleneck
`native/tests/micro.cpp`, `npm run profile:pipeline`

- `Matrix.Compose` native: **8 ns/node**. Even 20000×/frame = 0.16 ms. Moving
  matrix ops alone across the JS↔WASM boundary would lose to call overhead.
  → math library is component #0 for *correctness*, not for *speed*.
- 2500 float animation tracks: **0.07 ms/frame**. Babylon's float interpolation
  is already cheap. Re-evaluate with quaternion/matrix tracks + skeletons before
  classifying animation as HOT.

---

## Open questions for the next stages

1. How much of the 12× ceiling survives WASM compilation? (Emscripten `-O3
   -msimd128`, expect 1.5–3× slower than native → still 4–8× vs Babylon.)
2. How much survives the boundary + JS render-list build? (stage 8–10)
3. Skeleton/bone matrices — untested, hypothesised HIGH.
4. CPU particles — untested, hypothesised HIGH.
5. Geometry normals/tangents (WARM) — big flat buffers, may be the easiest win.
