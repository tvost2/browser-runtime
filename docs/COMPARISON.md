# Comparison — the implementation ladder

_Generated 2026-09-03T00:01:59.946Z._

One workload: the fused per-frame kernel (transform propagation + world bounding refit + STANDARD frustum culling → visible id list) on the Babylon-authored fixture scene of **4000 nodes, 1889 visible**. Every row computes a byte-for-byte identical visible set (asserted).

| implementation                                              | meshes/nodes | median ms/frame | vs Babylon | vs prev rung |
| ----------------------------------------------------------- | ------------ | --------------- | ---------- | ------------ |
| Babylon `_evaluateActiveMeshes` (OO path)                   | 4000         | 13.289          | 1.000×     | —            |
| hand-written data-oriented **JS** kernel (`JsBackend.mjs`)  | 4000         | 6.854           | 1.939×     | 1.939×       |
| **C++/WASM** (`-O3 -msimd128`), one boundary crossing/frame | 4000         | 1.404           | 9.467×     | 4.883×       |
| **C++ native** `-O3 -march=native`, no boundary             | 4000         | 1.259           | 10.558×    | 1.115×       |

### What the ladder says

- Going **data-oriented in plain JavaScript** already buys 1.939× over Babylon's per-mesh object path — **no WASM required**. Much of Babylon's cost is `SmartArray`/`Map`/observer/`_activate` machinery, not arithmetic.
- Dropping to **native C++** buys a further 5.445× over the JS kernel (10.558× vs Babylon) — this is the ceiling, boundary-free.
- **C++/WASM** lands at 9.467× vs Babylon, 4.883× vs the JS kernel. native→wasm gap = 1.115× ("cost of the sandbox + one boundary crossing/frame").

## WASM SIMD contribution

Same core, same workload (4000 nodes), only the emcc flag differs. Both produce an identical visible set.

| build     | flags           | median ms/frame | vs no-SIMD |
| --------- | --------------- | --------------- | ---------- |
| `o3`      | `-O3`           | 2.404           | 1.00×      |
| `release` | `-O3 -msimd128` | 1.404           | 1.713×     |

> WASM SIMD (128-bit) is worth **1.713×** here — LLVM vectorises the matrix compose/multiply and the 8-corner AABB transform. It is on by default (all browsers with WebGPU also have WASM SIMD).

## Scaling — `World.evaluate()` vs entity count

Node, no renderer: isolates the WASM eval + boundary. Shell scene, moderate frustum (~7% visible). `ns/entity` flat ⇒ compute-bound; climbing ⇒ the working set is spilling cache (memory-bound).

| entities | WASM median ms | p95     | JS kernel ms | WASM speedup | WASM ns/entity | visible |
| -------- | -------------- | ------- | ------------ | ------------ | -------------- | ------- |
| 1,000    | 0.338          | 0.544   | 1.146        | 3.39×        | 337.9          | 71      |
| 4,000    | 0.986          | 1.401   | 3.922        | 3.98×        | 246.4          | 258     |
| 10,000   | 2.467          | 3.566   | 12.041       | 4.88×        | 246.7          | 643     |
| 25,000   | 7.602          | 10.336  | 33.762       | 4.44×        | 304.1          | 1,559   |
| 50,000   | 15.744         | 21.717  | 65.378       | 4.15×        | 314.9          | 3,167   |
| 100,000  | 37.065         | 46.493  | 143.921      | 3.88×        | 370.6          | 6,274   |
| 250,000  | 87.801         | 113.684 | 369.003      | 4.20×        | 351.2          | 15,770  |

> ns/entity bottoms at **246.4** (~4,000 entities, working set in L2/L3) and rises to **351.2** at 250,000 (1.43×). Mild — the pass stays mostly compute-bound through this range; SIMD, not threads, is the first lever.

## Memory

Node, no renderer, fresh `WasmCore` per size. The SoA lives in WASM linear memory; the JS heap only holds `TypedArray` views over it.

| entities | WASM heap MB | grew MB | JS heap MB | visible |
| -------- | ------------ | ------- | ---------- | ------- |
| 10,000   | 64.0         | 0       | 4.7        | 661     |
| 50,000   | 64.0         | 0       | 4.7        | 3273    |
| 100,000  | 64.0         | 0       | 4.7        | 6644    |
| 250,000  | 64.0         | 0       | 4.7        | 16582   |
| 500,000  | 137.5        | 73.5    | 3.9        | 33111   |

- **Computed SoA cost: 248 bytes/entity** (exact, from `world.hpp`): localPos 12 · localRot 16 · localScale 12 · parent 4 · localMin 12 · localMax 12 · meshId 4 · materialId 4 · flags 4 · world 64 · worldSphere 16 · _order 4 · _depth 4 · renderList(reserved) 72 · _sortKeys(reserved) 8.
- `INITIAL_MEMORY` (64 MB) covers ~270k entities with **zero heap growth**. Beyond that, `ALLOW_MEMORY_GROWTH` kicks in (dlmalloc; pages may not return to the OS).
- **JS heap is flat (~4.7 MB) at every size** — SoA is in WASM.
- The public-API `Entity`/`Transform` handles add **~200 B/entity on the JS heap _if created_** (`scene.createEntities` does; writing the raw SoA arrays does not).

## Visual smoke test (`npm run test:visual`)

F-009 showed equivalence PASS ≠ rendering correct. This checks the *pixels*, coarsely (no pixel-perfect matching):

| entities | result | checks                                          |
| -------- | ------ | ----------------------------------------------- |
| 10,000   | PASS   | ✓frustum ✓most ✓batched ✓sampled ✓depth ✓no ✓no |
| 20,000   | PASS   | ✓frustum ✓most ✓batched ✓sampled ✓depth ✓no ✓no |

Checks: render target is not black (PNG size) · frustum culls · visible entities land on screen · draw calls == mesh count · NDC in cube · depth headroom (median z < 0.999, the F-009 guard) · no GPU/page errors.

## Real WebGPU (browser harness)

Chromium, WebGPU on, instanced cube draw of the visible set. Same GPU workload for both backends — any `frame` or `eval` delta is CPU-side. `cpp` = C++/WASM `WasmBackend`, `js` = `JsBackend.mjs`.

| scene        | meshes | js CPU-frame | cpp CPU-frame | eval speedup | gpu ms js/cpp | js bound | cpp bound | GPU-paced FPS js→cpp |
| ------------ | ------ | ------------ | ------------- | ------------ | ------------- | -------- | --------- | -------------------- |
| medium       | 400    | 1.640        | 0.630         | 4.327×       | 3.823/4.365   | GPU      | GPU       | 262→229 (0.876×)     |
| manyObjects  | 10000  | 26.540       | 6.485         | 4.615×       | 16.374/17.197 | CPU      | GPU       | 38→58 (1.543×)       |
| manyVisible  | 7500   | 25.950       | 4.805         | 6.884×       | 21.776/21.985 | CPU      | GPU       | 39→45 (1.180×)       |
| heavyCulling | 10000  | 16.205       | 4.870         | 3.440×       | 4.099/3.422   | CPU      | CPU       | 62→205 (3.328×)      |
| cpuBound     | 6000   | 19.275       | 3.615         | 7.421×       | 9.852/7.710   | CPU      | GPU       | 52→130 (2.500×)      |

- **CPU-frame** = `evaluateFrame` + WebGPU command recording + submit (does not block on the GPU). **eval speedup** isolates the migrated kernel.
- **bound** = whether GPU time exceeds the CPU frame for that config. **GPU-paced FPS** = `1000 / max(cpuFrame, gpuMs)` — the ceiling if the loop were vsync/GPU-limited. Where a config is already **GPU-bound**, the C++ speedup does **not** move that number — a valid, expected result.
- GPU here is a software adapter (no discrete GPU on the bench host), so `gpu ms` is inflated and every large scene reads CPU-bound. On real GPU hardware the crossover point (where C++/WASM stops helping FPS) moves to much larger scenes — re-run `bench/run-browser.mjs` there to place it.
