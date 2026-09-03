# ROADMAP.md

Planning only. Items are **not commitments** and are **not implemented** until
they appear as `[x]` with a link to the commit / benchmark / findings entry that
did it.

## The rule

Nothing is built because it looks interesting. Every hot-path migration must
answer, in `docs/FINDINGS.md`, **before** any code is written:

1. What is the bottleneck?
2. Has it been measured?
3. What is the hypothesis?
4. What is the implementation cost?
5. What is the expected gain?
6. How will equivalence be validated?
7. How will the result be measured?
8. Does the result justify keeping the implementation?

Cycle: **PROFILE → HYPOTHESIS → IMPLEMENT → EQUIVALENCE → BENCHMARK → CONCLUSION.**
A negative result is a valid result and gets published.

---

## Phase 0 — Baseline  ·  `v0.1.0` (frozen)

- [x] C++/WASM runtime (`bcpp::World`, Emscripten `-O3 -msimd128`)
- [x] ECS / SoA storage
- [x] transform evaluation (hierarchy traversal + world matrices)
- [x] bounding-volume refit
- [x] frustum culling
- [x] visibility determination + mesh-batched render list
- [x] WebGPU renderer (instanced-indexed, depth)
- [x] batching (counting sort by mesh id)
- [x] equivalence tests (4 impls, byte-identical visible set, 19 457 checks)
- [x] scaling benchmark (1k → 250k)
- [x] WASM SIMD benchmark (1.65×)
- [x] memory benchmark (248 B/entity)
- [x] real-WebGPU browser benchmark
- [x] visual smoke test (F-009 guard)
- [x] data-calibrated migration analyzer
- [x] docs + public `v0.1.0` release

## Phase 1 — Real assets  ✅ done

Goal: the runtime loads a real GLB and renders it correctly.
**Design + conclusion:** [investigations/glb.md](investigations/glb.md) ·
[FINDINGS F-010](FINDINGS.md#f-010).

- [x] glTF 2.0 subset formalised (mode 4, SCALAR/VEC2-4, F32/U8/U16/U32/I8/I16,
      POSITION/NORMAL/TEXCOORD_0/COLOR_0/TANGENT, TRS or matrix, pbrMetallicRoughness)
- [x] JS parses the JSON + orchestrates; C++/WASM batch core does geometry work;
      per-primitive hybrid dispatch (`geometry: "auto"`)
- [x] small (`tri`, `two-boxes`) + Khronos (`Box`, `BoxTextured`, `Duck`, `DamagedHelmet`) fixtures
- [x] GLB container parser · mesh primitive decode · node hierarchy → entities
- [x] geometry upload to WebGPU · baseColorFactor + baseColorTexture material · texture upload
- [x] `Asset → AssetManager → GPU resources / entities` separation
- [x] equivalence tests — `npm run test:glb` **89/89** (WASM vs JS byte-for-byte + Babylon cross-check)
- [x] visual test — `npm run test:glb:render` **6/6** through the WASM path, screenshots verified
- [x] benchmark — `npm run bench:glb` (JS vs WASM vs auto vs WASM+tangents); optimisations measured

Result: for already-GPU-ready geometry JS zero-copy wins (~1.5–2×) and `"auto"`
keeps it in JS; the C++/WASM core is the real path for tangent/normal generation,
de-quantisation, de-interleave and non-indexed expansion.

Explicitly **not** in Phase 1: skeletal animation, skinning, morph targets,
complex PBR, animation graph, physics, editor.

## Phase 2 — Runtime hot paths

Profile → hypothesis → implement → equivalence → benchmark → conclusion, one at a
time. Analyzer-ranked candidates (`npm run analyze`, all ESTIMATED — not measured):

- [x] **scene evaluation — incremental transforms + spatial index**
      ([investigations/scene-incremental.md](investigations/scene-incremental.md) ·
      [FINDINGS F-012](FINDINGS.md#f-012)). Dirty-tracked transform recompute:
      a static 250k-entity frame went 90 ms → 1.7 ms (~50×; ~680× Babylon-frozen
      at 50k). `bcpp::Bvh` + `raycast()` / `queryBox()`; `CullStrategy.Bvh`
      opt-in. `test:equivalence` 6/6, `test:spatial` 3/3.
- [ ] incremental render list (patch changed instance matrices; persistent BVH
      visibility) — the O(n) cull + O(visible) list-build now dominate a moving frame
- [ ] skeleton / bone matrices
- [ ] CPU particle update
- [ ] geometry processing (`VertexData` transforms, merge, subdivide)
- [ ] normals / tangents (`ComputeNormals`)

## Phase 3 — Runtime features

- [ ] skeletal animation
- [ ] particles
- [ ] physics investigation (is a WASM physics core worth it? measure first)
- [ ] asset streaming
- [ ] instancing improvements (thin instances, indirect draw)

## Phase 4 — Browser as platform

- [ ] PWA packaging (installable from a URL)
- [ ] offline asset cache (Service Worker + Cache API / OPFS / IndexedDB)
- [ ] mobile browser testing (Android Chromium/WebGPU, iOS Safari/WebGPU)
- [ ] memory constraints on mobile
- [ ] thermal / battery behaviour where measurable
- [ ] input: fullscreen, orientation, gamepad

Mobile results are **not** assumed to transfer from desktop WASM — measure
startup, memory, FPS, CPU/GPU time, thermal, battery independently.

## Threads / SIMD

- [x] single-thread + WASM SIMD (`v0.1.0`)
- [ ] WASM pthreads — scaffolded (`build:wasm --profile threads`), **not
      benchmarked**. Deliberate: `evaluate()` is still compute-bound at 250k, so
      SIMD comes first. When it's this component's turn: split pass-1 into N
      worker ranges over `_order`, join, serial pass-2; measure at 10k/50k/250k
      vs single-thread + SIMD; publish the loss cases.
