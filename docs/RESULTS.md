# Results — the answer

> **"How much of a JavaScript engine like Babylon.js can actually benefit from a
> C++/WebAssembly implementation while keeping WebGPU as the graphics backend?"**

Answer, from this experiment. All numbers reproducible via `npm run` scripts
(see `README.md` / [BENCHMARK_METHODOLOGY.md](BENCHMARK_METHODOLOGY.md)).

---

## Current Results (v0.1.0 — frozen)

Bench host: Intel Xeon E5-2620 v3 @ 2.4 GHz (2014), Windows 10, **no discrete
GPU** (WebGPU on Microsoft WARP), Node 22.19, Emscripten 6.0.9, g++ 16.1.
Absolute ms ≈ 3× a modern laptop; **ratios transfer, WebGPU absolutes do not**.

| metric | result | source |
|---|---|---|
| **Equivalence** | 4/4 impls, visible set byte-identical to Babylon; `test_equiv` 19,457 checks / 0 failures (maxRel 8e-4) | `npm run test:equivalence` |
| **Ladder** (4000-node fixture) | Babylon OO 13.3 ms → JS data-oriented 7.3 ms (1.8×) → **C++/WASM 1.46 ms (9.1×)** → C++ native 1.26 ms (10.6×) | `bench:compare` |
| **Scaling** `evaluate()` | ≈ linear 1k→250k; ~250→350 ns/entity; ~4× vs JS kernel at every size; 100k = 37 ms WASM / 144 ms JS; 250k = 88 / 369 ms | `bench:scale` |
| **WASM SIMD** | `-O3 -msimd128` = 1.46 ms vs `-O3` = 2.40 ms → **1.65×** | `bench:wasm --profile engine-o3` |
| **Memory** | 248 B/entity (SoA, exact); 64 MB `INITIAL_MEMORY` ⇒ ~270k entities, no growth; JS heap flat ~4.7 MB | `bench:memory` |
| **Real WebGPU** (CPU-frame FPS, software GPU) | heavyCulling 62→205 · cpuBound 52→277 · manyObjects 38→154 · manyVisible 39→225 (eval 7×, GPU-paced ~1.2×) · **medium 610→1587 but both GPU-bound → GPU-paced ~1×** | `bench:browser` |
| **Visual smoke** | 10k + 20k render without a black screen; frustum/batching/NDC/depth sane | `npm run test:visual` |
| **WASM init** | ~90–150 ms one-off (fetch + instantiate; `engine.wasm` ≈ 31 KB, dominated by glue parse) | `engine.wasmInitMs` |

---

## 1. There is exactly one CPU hot path worth moving

`Scene._evaluateActiveMeshes` — transform propagation + world-bounding refit +
frustum culling + render-list build — is **96–99 % of the CPU frame** in every
non-trivial scene (`docs/PROFILING.md`). Everything else (animation, geometry,
serialization, WebGPU calls) is either already cheap, rare, or unmovable.

## 2. Moving it: the ladder (same workload, byte-identical visible set)

| implementation | ms/frame (4000 nodes) | vs Babylon |
|---|---|---|
| Babylon per-mesh OO path | 13.3 | 1× |
| hand-written data-oriented **JS** | 6–8 | ~1.8–2× |
| **C++/WASM** `-O3 -msimd128`, 1 boundary crossing/frame | **1.3–1.7** | **8–11×** |
| C++ native (ceiling) | 1.15 | 11.5× |

(Bench host is a loaded 2014 Xeon; the WASM row moves 1.26→1.71 ms with
background load. `docs/COMPARISON.md` is regenerated from the last run.)

- **~1.8× is free** — pure data-oriented JS, no WASM. Babylon's overhead is
  mostly `SmartArray`/`Map`/observer/`_activate` bookkeeping, not math.
- **The remaining ~6× needs native code.**
- **WASM keeps 92 % of the native ceiling** — *only* because the interface is
  "upload once, one `evaluate()` per frame, read back a heap view". A per-object
  boundary would erase the entire win. This is the single most important design
  decision.

## 3. Whether that CPU win becomes FPS depends on the bottleneck

Real WebGPU, backend swapped, identical GPU workload (`docs/COMPARISON.md`):

| scene | what happens |
|---|---|
| `heavyCulling` (light GPU load) | **3.4× more FPS** — the sweet spot |
| `manyObjects` / `cpuBound` | CPU bottleneck removed, then hits the GPU wall → 1.3–1.7× |
| `medium` (small scene) | both backends **GPU-bound** → **C++ buys 0 FPS** despite a 4.5× eval speedup |

The last row is not a failure — it is the expected result and the reason the
brief said "don't assume C++ is faster". C++/WASM helps precisely when the frame
is **CPU-bound on scene evaluation**: many objects, heavy hierarchies, aggressive
culling, lots of animation targets. It does nothing for GPU-bound or
fill-rate-bound frames.

## 4. What did NOT pay off (valid results)

- Isolated `Vector`/`Matrix`/`Quaternion` ops — V8 JITs them well (8 ns/node
  native); the JS↔WASM call cost exceeds the op. Only worth it fused into a
  bigger kernel.
- Animation evaluation — 2500 float tracks = 0.07 ms/frame in Babylon already.
- Anything GPU/driver/string bound — serialization, glTF load, shader compile,
  texture upload, and the WebGPU layer itself.

## 5. Where to look next (`tools/migration-analyzer` ranks these)

Skeleton/bone matrices, CPU particle update, and geometry normal/tangent
computation score highest and are untested — same "big homogeneous array,
trivial math" shape as the kernel that worked.

## 6. Scaling & SIMD (measured, `docs/COMPARISON.md`)

* `World.evaluate()` is **≈ linear** from 1k to 250k entities: ~250 ns/entity in
  cache, rising to ~350 ns/entity at 250k as the working set spills L3. The
  **~4× WASM-vs-JS-kernel speedup holds at every scale.**
* 100k entities: WASM eval **37 ms**, JS kernel 144 ms, Babylon OO ≈ 330 ms
  (extrapolated). 100k is CPU-feasible with the WASM core, not with the others.
* **WASM SIMD (`-msimd128`) is worth ~1.6×** over plain `-O3` on this workload —
  LLVM vectorises the matrix ops and the 8-corner AABB transform. It is free
  (every WebGPU browser has WASM SIMD).

---

## What this experiment does NOT prove

Read this before quoting a number.

1. **WASM is not always faster than JS.** A well-written data-oriented JS kernel
   is only ~1.8× behind WASM here, and *ahead* for tiny scenes where the WASM
   load + boundary cost dominate. Idiomatic OO JS (Babylon's style) is the slow
   one — the lesson is "data-oriented", and C++/WASM is a further multiplier on
   top, not the source of the first win.
2. **C++ is not required for a fast web app.** If your scene has < ~1000 active
   objects, or is GPU-bound, or is dominated by asset loading / UI / networking,
   this entire core buys you nothing measurable.
3. **A 10× faster CPU does not mean 10× more FPS.** Measured: a 7× eval speedup
   moved FPS by 1.06× on a GPU-bound scene, and 0.87× on a small one. FPS only
   moves while scene evaluation is the critical path.
4. **GPU-bound workloads gain ~nothing.** `medium` and `manyVisible` in the
   browser table show it directly.
5. **These numbers are workload- and hardware-specific.** The bench host is a
   2014 Xeon with no discrete GPU (software WARP). Absolute ms are ~3× a modern
   laptop; the *ratios* transfer, the crossover points (where GPU takes over) do
   not — they move to larger scenes on real hardware.
6. **This is not a Babylon replacement.** It implements one hot path
   (scene evaluation) plus a minimal renderer. Materials, lighting, shadows,
   post-processing, physics, animation graphs, asset loading, GUI — none of it
   exists here and most of it *should* stay in JS.
7. **The equivalence guarantee is numeric-within-tolerance, on one culling
   strategy.** `maxRel ≈ 8e-4` from float accumulation order. It is not a
   bit-exact reimplementation of all of Babylon's math.
