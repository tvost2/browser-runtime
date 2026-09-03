# PERFORMANCE_MODEL.md

A mental model for *predicting* whether moving work into the C++/WASM core will
help, built from this project's measurements. Use it before writing code.

Every frame has a **critical path**. Optimising anything not on it changes
nothing. The critical path is one of:

```
CPU-bound (eval)  →  CPU-bound (submit)  →  GPU-bound  →  memory-bound  →  boundary-bound
```

---

## CPU-bound (scene evaluation)

**Symptom:** `evalMs ≈ cpuFrameMs`, both `> gpuMs`. The frame is spent computing
world matrices / bounds / culling.

**What helps:** data-oriented design, then C++/WASM. This is the whole thesis.

**Measured (4000-node fixture):**
| | ms | vs Babylon |
|---|---|---|
| Babylon OO | 13.3 | 1× |
| data-oriented JS | 7.3 | 1.8× |
| C++/WASM | 1.1–1.7 | ~10× |

**Measured (real WebGPU, `heavyCulling`, GPU only 4.5 ms):** 60 → 265 fps (3.7×).
The eval speedup passes straight through to FPS because eval *is* the critical
path.

**Rule of thumb:** if `evalMs / cpuFrameMs > 0.6` and the scene has > ~2000
active entities, expect a 3–10× reduction in `evalMs` from the WASM core, and a
proportional FPS gain *until another stage becomes the critical path*.

---

## CPU-bound (submission)

**Symptom:** `cpuFrameMs - evalMs` dominates — time is in
`queue.writeBuffer(instanceWorld)`, command recording, `drawIndexed` calls.

**What helps:** fewer, bigger batches (mesh-id sort → 1 draw call per mesh, done
in the WASM core); a persistent-mapped or ring instance buffer; indirect draw.
**Not** helped by making `evaluate()` faster.

**Measured:** the `instanceWorld → GPU storage buffer` copy is
`visibleCount × 64` bytes/frame (e.g. 90k visible ≈ 5.8 MB). At 50k+ entities on
the bench host this copy + record is a measurable slice of `cpuFrameMs` distinct
from `evalMs` (see `docs/COMPARISON.md` scaling table).

---

## GPU-bound

**Symptom:** `gpuMs > cpuFrameMs`.

**What helps:** fewer triangles, fewer pixels, cheaper shaders, better culling
(which the WASM core already does), LOD, occlusion. **Reducing CPU time does
nothing for FPS** — the CPU just waits longer for the GPU.

**Measured (real WebGPU):**
| scene | eval speedup (js→cpp) | GPU-paced FPS | why |
|---|---|---|---|
| `medium` (400) | 3.5× | 307 → 267 (**0.87×**) | both GPU-bound; C++ frees CPU that was never the limit |
| `manyVisible` (7500) | 7.1× | 38 → 40 (**1.06×**) | C++ makes it GPU-bound; further CPU work wasted |

This is the single most important caveat of the whole project: **a 7× faster
CPU produced a 1.06× FPS change** because the GPU was the critical path.

---

## Memory-bound

**Symptom:** `evalMs` grows *faster* than entity count (super-linear); large
working set spills L2/L3; `ns/entity` climbs with `count`.

**What helps:** tighter SoA (drop unused components from the hot loop), splitting
the pass so each sweep touches fewer arrays, prefetch, SIMD (more work per cache
line), `worldMatrix` as `f32` not `f64`. **Adding threads first here usually
loses** — you multiply the bandwidth demand.

**Measured:** see `docs/COMPARISON.md` "Scaling" — `ns/entity` for
`World.evaluate` from 1k to 250k+. If it stays flat the pass is compute-bound; if
it climbs past ~250k the working set (≈ `250k × (10+16+4) floats × 4 B` ≈ 30 MB)
exceeds cache and it becomes bandwidth-bound.

---

## Boundary-bound (JS ↔ WASM)

**Symptom:** time is in marshaling arguments / results across the WASM boundary,
not in either side's work. Happens when you cross per-object.

**What helps:** don't. One `evaluate()` call per frame; SoA arrays as TypedArray
views over linear memory; results as zero-copy views.

**Measured (F-001):** an isolated `Matrix.compose` is **8 ns** native. A single
`wasm.compose(...)` call costs more than that in embind marshaling alone. The
anti-pattern `for (e of entities) wasm.setPosition(e.id, …)` at 20k entities =
20k crossings/frame = the boundary *is* the frame. The whole SoA design exists to
make this impossible.

---

## Startup / init (one-off, never amortised into frame time)

| cost | measured | notes |
|---|---|---|
| WASM fetch + instantiate | ~100 ms (`engine.wasm` ≈ 31 KB + emscripten glue) | dominated by glue parse, not the 31 KB |
| first `resize(n)` | O(n) zero-fill of ~13 arrays | one-time per capacity growth |
| mesh upload to GPU | O(total verts), once | `engine.uploadMeshes` or lazy on frame 1 |
| first-frame shader compile | tens of ms | Chromium caches it |

Report these separately (`wasmInitMs`). A 100 ms init amortises to nothing over a
session but matters for a cold page load — it is a *different* metric from
`ms/frame` and must never be blended in.

---

## Decision table

| critical path | move eval to WASM? | expected FPS effect |
|---|---|---|
| CPU-bound (eval), > 2k entities | **yes** | 3–10× until next stage caps it |
| CPU-bound (submit) | no — batch/indirect instead | none from eval; big from batching |
| GPU-bound | no | ~1× (measured 0.87–1.06×) |
| memory-bound | maybe — SIMD/layout first, threads last | modest, sub-linear |
| boundary-bound | you built it wrong — fix the API | n/a |
