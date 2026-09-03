# Findings

Running log of what the data says. Newest first. Every entry cites the command
that produced it so it can be re-checked.

Benchmark host: Intel Xeon E5-2620 v3 @ 2.4 GHz, Node v22.19, Windows 10,
g++ 16.1 (MinGW-w64). Absolute numbers are ~3× a modern laptop; ratios hold.

---

## F-017 · Chunk merge — N unique static meshes → a handful of draws (C++ kernel)
Branch `feat/chunk-merge` (off `feat/gpu-frame-block`).
`npm run bench:chunk-merge` · `npm run test:equivalence` (native `test_merge`)

WebGPU has no multi-draw-indirect and no `draw_index` in the shader, so a scene
of N unique static meshes is N `drawIndexedIndirect` + N `setBindGroup` per
frame no matter how the cull is done. The only lever is **fewer, bigger
buckets**: group meshes spatially and bake each group into one mesh.

`bcpp::mergeMeshes` (`native/include/bcpp/merge.hpp`) — the per-vertex work:
world-bake positions (`transformCoord`), transform normals by the
**inverse-transpose** of the upper 3×3 (correct for the non-uniform scale
building footprints routinely have), rebase indices by the running vertex
offset, and tag every output vertex with its **source item id** so a pick pass
can still resolve the individual object. `MeshMerger` embind class: JS packs all
source geometry contiguously + one descriptor row per item, one `merge()` call,
reads views back. TS: `mergeMeshes(sources)` + `groupByCell(centers, cellSize)`.

`bench:chunk-merge`, 4000 unique jittered boxes, 140-unit grid, WARP:

| | draw buckets | entities | cpu/frame (camera orbit) | fps |
|---|--:|--:|--:|--:|
| no merge | **3505** | 4000 | 8.06 ms | 124 |
| merge (Standard cull) | **68** | 72 | **0.53 ms** | 1881 |
| merge (Gpu cull) | 68 | 72 | 1.13 ms | 881 |

**52× fewer draw buckets.** Merge kernel: 58.6 ms one-time for 96k verts /
48k tris across 72 cells. Geometry conserved exactly — vertices 96000→96000,
indices 144000→144000; every merged-vertex id in `[0, 4000)`; merged world-AABB
matches a reference built from source-geometry × transform. `native/test_merge`
checks the same per-triangle against a host-side transform, plus the
inverse-transpose normal and a singular-matrix fallback. No WebGPU validation
errors in any mode.

Note the Standard/Gpu flip: with the entity count collapsed to 72, the GPU
compute-dispatch overhead (a WARP artifact, but the pattern holds) outweighs
its per-frame-upload saving — `CullStrategy.Gpu` is for *many* entities, and
merge removes them. Merge + Standard is the combination for this workload.

### Pick buffer — individual objects stay selectable after the merge

`Renderer.pickAt(x, y)` (→ `Engine.pickAt`) re-draws the last `render()` list
with a pick pipeline that writes each fragment's per-vertex id (a 4th SoA arena
buffer, `r32uint`, flat-interpolated) into an `r32uint` target, then
`copyTextureToBuffer` reads back the one texel under the cursor. Depth-tested,
so the front-most surface wins — occlusion is respected. `mergeMeshes` stamps
every vertex with its source item id, so a merged cell resolves the individual
building; a mesh with no ids reads back `0xffffffff` → `-1`.

Uses the CPU render path's instance buffer (works with `CullStrategy.Auto` /
`Standard` — the pairing for merged scenes; `Gpu` mode needs a standard-path
frame first). `bench:chunk-merge` projects 70 building centroids to screen and
picks: **68/70 resolve to a building, 61 exact** — the 7 non-exact are a nearer
building occluding at that pixel (correct), the 2 misses are screen-edge.

### Next
- wire into the Uberlândia twin (`groupByCell` over building centroids,
  re-merge a cell when its buildings stream in; `pickAt` on click for the
  building info panel).

---

## F-016 · One per-frame WASM→WebGPU upload — C++ lays out the frame block
Branch `feat/gpu-frame-block` (off `feat/gpu-driven-cull`).
`npm run bench:gpu-cull` · `npm run test:equivalence` · `npm run test:render:patch`

`CullStrategy.Gpu` split each frame's fixed CPU→GPU handoff into **four small
`writeBuffer` calls** — camera (64 B), cull head (16 B), frustum planes (96 B,
computed in JS every frame), xform uniform (16 B) — each into its own uniform
buffer, plus a per-frame array-of-arrays allocation in `writePlanes()`.

Now C++ owns a single `GpuFrameBlock` (176 B) laid out in its own memory in the
exact WGSL std140 order:

```
  0   mat4x4<f32>  viewProj
 64   array<vec4,6> planes      // frustum, normalised, Babylon order — Frustum::fromViewProj
160   u32          count, numBuckets, maxDepth, _pad
```

filled inside `evaluate()` (Gpu branch). The renderer does **one**
`writeBuffer(gFrameU, 0, gpu.frame)` per frame and the three shaders (xform,
cull, render) all bind that one uniform at `@group(0) @binding(0)` as `Frame`.

Removed from the JS hot path, per frame:
- 3 of 4 `writeBuffer` calls (driver + staging-copy each)
- `writePlanes()` — 6× Gribb-Hartmann rows + `hypot` normalise, **and** its
  `rows` array-of-6-arrays allocation
- `new Uint32Array(4)` (cull head) + `new Uint32Array([...])` (xform uniform)

≈ 8 short-lived allocations/frame gone → less GC churn (the camera-move stutter
lever), plus the plane math moves to C++ where it's the *same* code path as the
CPU cull (`Frustum::fromViewProj`) instead of a parallel JS reimplementation.

**Equivalence held** — `bench:gpu-cull`, 60k moving camera: GPU misses 0,
over-draws 19 / 32988 (0.058 %), identical to pre-change (the C++ planes match
the old JS planes bit-for-practical-purposes). Many-bucket guard, `test:visual`,
`test:render:patch` all green; no WebGPU validation errors across static / camera
/ transform Gpu runs. WARP per-frame times are submit-bound and unchanged in the
noise; the win is call count + allocation count, which show on a real GPU.

### Not built (next)
- **chunk merge** — the twin's ~3.7k unique building meshes = ~3.7k
  `drawIndexedIndirect` + 3.7k `setBindGroup` (dynamic offset) per frame. WebGPU
  has no multi-draw / `draw_index`, so the only way to collapse it is fewer,
  bigger buckets: a C++ geometry merge (`mergeMeshes(meshes[], transforms[])` —
  SoA concat + index rebase) grouping buildings by spatial cell → ~50 buckets.
  That's the real FPS lever for the many-unique-mesh case.

---

## F-014 · GPU upload — the two costs, and moving them off the CPU
Branch `feat/gpu-driven-cull` (off `feat/incremental-renderer`).
`npm run bench:mesh-upload` · `npm run bench:gpu-cull`

Two distinct per-frame / per-change CPU→GPU costs, each fixed independently.

### 1 — geometry upload was O(all meshes) on every mesh-set change

`Renderer.uploadMeshes` re-summed every vertex, re-ran a JS interleave loop
(pos+normal+uv → stride-32) and rebuilt the whole vertex/index buffer whenever
any mesh was added. Replaced with **three SoA vertex buffers** (the C++ decode
already stores geometry that way → straight `writeBuffer` per attribute, no
interleave) and an **append-only arena** (new mesh written at the tail; buffers
double via `copyBufferToBuffer` only when the tail overflows; a mesh already in
`slots` is skipped).

`bench/run-mesh-upload.mjs`, 24 batches × 150 unique meshes, WARP:

| | uploadMs, batch 1 | uploadMs, batch 24 (3600 meshes) |
|---|--:|--:|
| old (full rebuild) | 6.0 ms | **40.5 ms**, climbing — O(all) |
| new (append arena) | 2.6 ms | **1.9 ms**, flat — O(new) |

Digital-twin streaming (real Uberlândia data, `twin.mytheria.com.br`): CPU frame
stays 0.8–0.9 ms through four city-region streams; each jump uploads only its
12–22 MB delta instead of the cumulative total (which reached ~97 MB).

### 2 — per-frame instance-matrix upload: `CullStrategy.Gpu`

The Standard path, per moved/panned frame: frustum-cull every entity on the CPU,
counting-sort the survivors by mesh, copy their world matrices into a render-list
buffer, upload `visible·64 B`. `CullStrategy.Gpu` keeps only the (incremental)
transform pass on the CPU:

- C++ builds a durable per-mesh **bucket layout** (entity→bucket, cumulative
  offsets) — rebuilt only when a `meshId` changes
- one compute dispatch frustum-tests `worldSphere[i]` and atomically compacts
  survivors into per-mesh runs of a `visibleIds` buffer; a second fills a
  `DrawIndexedIndirect` args buffer
- render: one `drawIndexedIndirect` per non-empty bucket; the VS indexes
  `worldMats[visibleIds[instance_index]]`
- world matrices live entity-indexed on the GPU, uploaded incrementally (only
  `_recomputed` rows); a still camera skips the dispatch entirely

`bench/run-gpu-cull.mjs` (WARP — compute time not representative; CPU + bytes are):

| scene | Standard cpu | Gpu cpu | Standard upload/frame | Gpu upload/frame |
|---|--:|--:|--:|--:|
| camera-orbit 50k | 19–20 ms | **8 ms** | 1.7 MB | **0** |
| camera-orbit 150k | 49–61 ms | **24 ms** | 5.1 MB | **0** |
| static 150k | 24 ms | 23 ms | 0 | 0 |

Equivalence (60k, moving camera): GPU misses **0** entities the CPU keeps;
over-draws 0.05–0.08 % (frustum-boundary float noise — the safe direction, never
under-draws). Static scenes on WARP pay per-frame compute-dispatch overhead
(situational, like `Bvh`); a real GPU wouldn't. Hierarchy still works — the CPU
transform pass runs first, only cull moved to the GPU.

**Many-bucket bug (fixed):** with one draw bucket it worked; with thousands it
rendered black. WARP / older Dawn don't add `drawIndexedIndirect`'s
`firstInstance` to `@builtin(instance_index)`, so every bucket's VS indexed
`visibleIds[0..]` and drew only bucket 0. Fix: `firstInstance` stays 0, each
bucket's base into `visibleIds` is a per-draw **dynamic uniform-buffer offset**.
The Uberlândia digital twin (`twin.mytheria.com.br`, ~3.7k unique meshes) now
renders on `CullStrategy.Gpu` — HUD shows `matrizes p/ GPU 0 KB/frame`.

### 3 — the transform pass on the GPU too (the endgame)

`CullStrategy.Gpu` now also composes world matrices on the GPU. A compute
dispatch, per entity: compose local TRS → matrix, pointer-chase the parent chain
(capped at 32) multiplying local matrices, refit the 8-corner world AABB, write
the bounding sphere. The cull pass then reads those spheres. C++ `evaluate()` in
Gpu mode computes **no matrices at all** — it only records which local transforms
changed (so the renderer patches those 40-byte TRS rows) and keeps the bucket
layout current. `worldMatrices()` / `raycast()` / `worldBounds()` are stale in
Gpu mode until a non-Gpu `evaluate()` runs — documented.

`bench:gpu-cull` (WARP, 150k entities):

| scenario | Standard cpu | Gpu cpu | Standard upload | Gpu upload |
|---|--:|--:|--:|--:|
| camera-orbit | 58 ms | **20 ms** | 5.1 MB/frame | **0** |
| transform 1 % moving | 45 ms | **29 ms** | 50 KB | 59 KB |
| static | ~20 ms | ~18 ms | 0 | 0 (both WARP-submit-bound) |

Equivalence (60k, moving camera): GPU misses **0** entities the CPU keeps,
over-draws 0.058 % — the GPU-composed matrices match the CPU path (a wrong
convention would scatter the visible set, not nudge its boundary). The Uberlândia
twin renders on it: `eval(cena)` ~0.15 ms for 6.3k entities, 0 bytes of matrices
per frame.

### Not built

- ring buffer for the local-TRS buffer (removes any `writeBuffer` stall)
- C++ emitting a compact dirty *list* instead of a per-entity `_recomputed`
  array (the O(n) copy is the last CPU cost in Gpu mode)

---

## F-013 · Incremental rendering — patch the cull + render list + GPU upload, not rebuild them
`npm run build && npm run test:equivalence && npm run test:render:patch`
`node --expose-gc bench/run-renderer-incremental.mjs 250000 · npm run bench:renderer:gpu`
Cycle: [docs/investigations/incremental-renderer.md](investigations/incremental-renderer.md). Branch `feat/incremental-renderer`.
Builds on F-012 (that cycle merged; v0.1.0 untouched).

### PROFILE — after F-012, where the "something moved" frame goes

`evaluate()` stage split (steady_clock in C++), `Standard`, 250k entities:

| scenario | transform | **cull** | list build | total |
|---|--:|--:|--:|--:|
| static | 1.7 ms | 0 (fast path) | 0 | **1.7 ms** |
| transform 0.1 % moving | 2.6 ms | **10.3 ms** | 0.1 ms | 13.0 ms |
| camera pan | 1.7 ms | **10.2 ms** | 1.4 ms | 13.5 ms |
| transform 10 % moving | 21.7 ms | 10.3 ms | 0.3 ms | 32.5 ms |

The **O(n) frustum cull dominates** any frame where the camera or an object
moved — it re-ran the 6-plane + 8-corner test for every entity. The
render-list build (counting-sort + full `instanceWorld` copy) and the renderer's
**full 4 MB instance-buffer upload every frame** were the next layer.

### IMPLEMENT

1. **Incremental linear cull** — when the camera is unchanged, only an entity
   that *moved this frame* can have crossed a frustum plane. Re-test just the
   `_recomputed` entities; reuse a persistent `_visibleBit` for the rest. The
   O(n) scan that rebuilds `visibleId` in topo order stays (~7 ns/entity); the
   ~30 ns/entity frustum math is skipped for what didn't move. Full re-test on
   any camera move / structural change / strategy switch.
2. **Incremental render list** — if the visible set + batch layout are identical
   to last frame (same entities, same cull order, same sort mode, no meshId /
   visibility edits), the counting-sort slot assignment is identical. Overwrite
   only the `instanceWorld` rows of entities that moved (`_entitySlot[e]`) and
   hand the renderer a **dirty-slot list**. `stats.listRebuilt` / `dirtySlots`.
3. **Partial GPU upload** — `Renderer.render()` coalesces the dirty slots into
   runs and issues partial `writeBuffer` calls; `lastUploadBytes` tracks it.
   Skips the upload entirely when nothing moved.
4. **`CullStrategy.Auto`** (new default) — per frame: `Bvh` while the camera
   moves over a large scene (>20k, light churn), else the incremental linear
   cull.

Two latent renderer bugs fixed along the way (they only bite once uploads are
conditional): the depth texture must resize with the canvas or `beginRenderPass`
silently drops the frame; and the partial path must not run against a
never-fully-uploaded instance buffer (a standalone `evaluate()` for a query /
camera framing desyncs it).

### VALIDATE

- `test:equivalence` **6/6** — `test_incremental` extended: over 200
  random-motion frames the patched render list (matrices **and** batches) is
  byte-identical to a from-scratch rebuild (199/200 frames patched in place); a
  moved-behind-camera entity leaves the set; camera-pan set + list == from
  scratch; a visibility toggle invalidates the list.
- `test:render:patch` **5/5** (browser) — nudging 50 visible entities patches
  in place; the patched `instanceWorld` == a forced full rebuild; no GPU errors
  on a partial-upload frame; a visibility toggle removes the entity from the draw.
- `test:visual` PASS (engine-demo: camera + per-frame object motion, `Auto`,
  120+ frames — frustum, on-screen, batching, depth, no GPU errors) ·
  `test:glb` 89/89 · `test:glb:native` 114/114 · `test:glb:render` 6/6 · v0.1.0 4/4.

### BENCHMARK — `evaluate()` ms, 250k entities, best-of-5 (`bench:renderer`)

| scenario | F-012 `Standard` | this cycle `Standard` | this cycle `Bvh` | **`Auto`** (default) |
|---|--:|--:|--:|--:|
| static | 1.8 | 1.8 | 2.0 | **1.7** |
| transform 0.1 % moving | 13.0 | 7.5 | 8.4 | **5.0** |
| transform 1 % moving | 15.8 | 11.9 | 19.4 | **8.4** |
| transform 10 % moving | 32.5 | 32.4 | 49.9 | 34.3 |
| camera pan | 13.5 | 17.0 | 6.4 | **6.3** |
| camera + 1 % moving | 17.6 | 21.1 | 20.4 | **18.9** |
| visibility flip 0.1 % | (bug — ignored) | 1.7 | 3.2 | 2.9 |
| high churn 100 % moving | 95 | 100 | 108 | **95** |

- **`Auto` is the best or near-best in every scenario.** Object-manipulation with
  a still camera (an editor, a simulation, a strategy game) — the common
  interactive case — is **2.6× faster** (0.1 % moving: 13 → 5 ms); a moving
  camera is **2.1× faster** (13.5 → 6.3 ms, `Auto` picks `Bvh`); static is
  unchanged; the worst case (everything moves) has no regression.

### BENCHMARK — GPU upload (`bench:renderer:gpu`, browser, WARP)

Instance storage-buffer upload per frame, 60k entities (~33k visible):

| scenario | before | this cycle |
|---|--:|--:|
| static | 4.1 MB | **0** |
| transform 0.1 % moving | 4.1 MB | **2 KB** |
| transform 1 % moving | 4.1 MB | **19 KB** (≈ 210×) |
| camera move | 4.1 MB | 4.1 MB (full rebuild — expected) |

`listRebuilt` is 0 % of frames for static + object motion, 100 % for camera
moves. On the WARP bench host every fixture is GPU-bound (no discrete GPU), so
the CPU-pipeline win shows in `bench:renderer` (Node), not in WARP FPS — the
same F-008 caveat. The upload-bandwidth reduction is real and measurable.

### DECIDE — ship

Incremental cull + incremental render list + partial upload, with
`CullStrategy.Auto` as the default. Object motion under a still camera — the
dominant interactive workload — went from re-culling and re-uploading the whole
scene every frame to touching only what moved: 2.6× less CPU, ~200× less upload
bandwidth, no regression on static or worst-case. `Standard` / `Bvh` / `None`
remain selectable; the situational-BVH decision from F-012 stands, now folded
into `Auto`.

**HYPOTHESIS (next):** the render-list build is still O(visible) and the cull's
topo scan is still O(n). A dirty *list* (not a bitset scan) for the transform
pass, and persistent per-node visibility in the BVH, are the next levers.
Instancing / thin-instances is the next subsystem — the instance buffer +
per-instance slot map this cycle built is its foundation.

---

## F-012 · Incremental scene evaluation — a static 250k-entity frame costs 1.7 ms (was ~90 ms); + a spatial index for queries
`npm run build && npm run test:equivalence && npm run test:spatial`
`node --expose-gc bench/run-scene-incremental.mjs 250000`
Cycle: [docs/investigations/scene-incremental.md](investigations/scene-incremental.md). Branch `feat/incremental-scene`.
Improves the v0.1.0 `evaluate()` (F-008); v0.1.0 frozen benchmarks untouched.

### The problem

`World::evaluate()` recomputed **every** entity's world matrix + 8-corner
bounding refit **every frame**, regardless of whether anything moved. F-008
measured this as ~250–350 ns/entity → ~90 ms for a 250k-entity frame. But most
entities in most scenes never move.

### IMPLEMENT — dirty-tracked incremental transforms

`evaluate()` splits into a **transform pass** and a **cull pass**. The transform
pass recomputes `world[i]` + `worldMin/Max[i]` only for entities whose local
transform changed (`dirty[i]`, set by the TS `Transform` setters) **or whose
ancestor moved this frame** — the topological order propagates that in one
forward sweep (`_recomputed[parent] → recompute child`). World AABBs are now
persistent, not transient.

Fast path: `recomputed == 0 && camera unchanged && no structural change` → the
render list is reused verbatim, `stats.frameChanged = 0`, and the renderer skips
the instance-matrix storage-buffer re-upload.

`World::resize()` also fixed to grow storage **preserving** existing entity data
(was `assign` — zeroed everything; latent corruption when a scene built one
entity at a time crossed a capacity boundary, e.g. a GLB with >256 nodes).

### VALIDATE — `npm run test:equivalence` **6/6** (was 4/4)

`test_incremental.cpp`: a 5000-entity forest through random edits — only the
moved subtree is recomputed (`transformsRecomputed` exact), every world matrix
stays **bit-identical** to a `markAllDirty()` full recompute, the visible set
matches, `frameChanged` is 0 iff nothing moved + camera unchanged, `resize()`
preserves data. 200-iteration golden comparison against a shadow `World` that
always does a full recompute. The existing Babylon-fixture equivalence
(`test_world_equiv`, JS kernel, WASM core) still passes unchanged.

### BENCHMARK — `evaluate()` ms, bench host, best-of-5 medians

Shell scene, ~50 % on-screen (`dense`), by fraction of the scene moving per frame:

| entities | static | 0.1 % | 1 % | 10 % | 100 % | JS kernel (full) | Babylon 50k |
|---|--:|--:|--:|--:|--:|--:|--:|
| 10 000 | 0.06 | 0.5 | 0.6 | 1.0 | 2.5 | 10 | dflt 49 / froz 38 |
| 50 000 | 0.30 | 3.1 | 3.2 | 5.7 | 14 | 58 | dflt 237 / froz 205 |
| 250 000 | **1.7** | 11 | 13 | 35 | 90 | ~390 | — (build too heavy) |

- **A fully static 250k frame: 1.7 ms** — was ~90 ms (F-008), a **~50×** drop;
  **~230×** the JS data-oriented kernel; Babylon can't make a 50k static scene
  cheaper than ~205 ms even with `freezeWorldMatrix()` + `freezeActiveMeshes()`
  → our 0.3 ms at 50k static is **~680×**.
- **100 % moving is unchanged** (90 ms @ 250k) — no regression on the worst case.
- Between: cost tracks the moved fraction *plus* the O(n) cull pass, which still
  visits every entity (the camera usually moves). At 0.1 % moving, 250k, only
  ~4900 transforms recompute — the remaining ~11 ms is the linear cull + the
  O(visible) render-list build.

### IMPLEMENT — `bcpp::Bvh` spatial index (+ `CullStrategy::Bvh`, `raycast`, `queryBox`)

A flat, refittable BVH over the world AABBs: binned-SAH build (iterative),
`refitDirty()` that updates only moved leaves + ancestors (O(moved·depth) via an
`entityLeaf`/`nodeParent` map), node-AABB frustum classify that prunes whole
subtrees and marks fully-inside nodes to skip the per-entity test.
`CullStrategy::Bvh` builds on setup, refits on light-motion frames, and on a
heavy-churn frame (`recomputed·8 > count`) does a cheap full refit + culls
linearly — so the worst case is bounded to ≈ Standard, never a per-frame SAH
rebuild.

### VALIDATE — `test_bvh.cpp` + `npm run test:spatial`

The BVH visible set is **identical** to `Standard` across build / refit /
camera-move / 100 random-motion frames; `queryBox` and `raycast` (nearest
entity-AABB hit) match brute-force scans, in C++ and through the TS binding
(incl. across a heap growth).

### BENCHMARK — `CullStrategy::Bvh` vs `Standard`, 250k entities

| | static | 0.1 % moving | 1 % moving | 10 % moving | 100 % moving |
|---|--:|--:|--:|--:|--:|
| Standard | 1.7 | 11–13 | 11–13 | 25–35 | 88–93 |
| Bvh | 1.7 | **7–10** | 12 | 40–46 | 100 |

- The BVH cull **only wins for a large scene with <~1 % moving per frame**
  (~1.3–1.5×); it **ties** on static (Standard's fast-path already returns) and
  is **mildly worse** above ~10 % moving (the full-refit tax on churn frames).
- MEASURED conclusion: the cull strategy is **situational, not the default**.

### DECIDE

- **Ship incremental transforms** — unambiguous, no regression, bit-exact. This
  is the win: mostly-static large scenes now cost almost nothing per frame,
  which is the common case and something Babylon's freeze APIs cannot achieve.
- **Ship the BVH for its queries.** `raycast()` / `queryBox()` are needed for
  picking, triggers, spatial audio, and a future physics broadphase, and have no
  substitute. `CullStrategy::Bvh` ships as a documented option for large, calm
  scenes; `Standard` stays the default.
- **HYPOTHESIS (next):** the O(n) cull pass and the O(visible) render-list build
  now dominate the "some movement" frame. An **incremental render list** (patch
  only changed instance matrices; keep the visible set when the frustum result
  is stable) and **persistent per-node visibility** in the BVH are the next
  levers. Occlusion culling and clustered lighting can reuse the same index.

`develop` green; v0.1.0 untouched.

---

## F-011 · Full C++/WASM GLB pipeline — the front-end is ~free in C++, geometry work is where B wins
`npm run build && npm run build:wasm:nosimd`
`npm run test:glb:native && npm run test:glb:render`
`GLB_VITRINE_DIR=<dir> npm run bench:glb:pipelines && npm run bench:glb:gpu`
Cycle: [docs/investigations/glb.md](investigations/glb.md). Branch `feat/glb-native-pipeline`.
Builds on **F-010** (that cycle stays intact — v0.1.0 gate 4/4, `test:glb` 89/89).

**Question of the cycle:** what is the real difference between the GLB/glTF
decode done *entirely* in JS versus done *entirely* in C++/WASM inside this
runtime? Build both end to end, then measure — no advantage assumed.

### Built — PIPELINE B (`parser: "native"`)

`GLB bytes → WASM → bcpp::gltf::Pipeline` : container split
(`parseContainer`, blob header/magic/chunk walk, no copy) · JSON parse
(vendored **yyjson**, read-only) · glTF metadata (`parseMetadata` → a
data-oriented `Document`: flat POD arrays for buffers/bufferViews/accessors/
meshes/primitives/nodes/materials/textures/samplers/images + one packed string
blob) · nodes topological + matrix→TRS · accessor→PrimDesc · geometry via
**`bcpp::gltf::Batch` reused unchanged** (F-010's core) → one flat **TOC** int32
array carrying every pointer + count + per-stage timing. JS
(`web/asset/native.ts`) hands over the blob, calls `loadGLB` + `process`, reads
the TOC, slices typed-array **views** out of WASM memory. **5 JS↔WASM crossings
per asset**, flat (F-010's hybrid path is 9; pure JS is 0). BIN-embedded image
bytes are returned as **zero-copy views over the caller's ArrayBuffer** — the
native path never copies texture bytes into WASM.

### VALIDATE — `npm run test:glb:native`: **114/114**

PIPELINE B vs PIPELINE A (the JS front-end, `geometry:"js"` — the functional
reference). Per fixture: container version/chunks, **all metadata** (buffers,
bufferViews, accessors, meshes, primitives, materials, textures, samplers,
image mime + bytes), **geometry** (positions / indices / UVs bit-identical,
normals within `3e-4` where the source had them, AABB within `1e-4`, generated
normals unit-length), **scene** (hierarchy, names, TRS within `1e-5`, roots),
**asset** (primitive / vertex / index counts, material + texture refs, ignored
features by subject). Plus exact known values for `tri` / `two-boxes`.

### RENDER — `npm run test:glb:render`: **6/6**, both pipelines

Every fixture rendered through A **and** B all the way to the pixels (Chromium
WebGPU / WARP). Each side passes its structural checks (path, frustum, draw
count, depth headroom, no GPU errors, not black); **render equivalence** holds —
same vertex / draw / visible counts, screenshots match within mean channel
Δ 0.0013–0.011. `DamagedHelmet` through the full native pipeline: base-colour
texture, correct geometry, 5 crossings. Screenshots `bench/results/glb-*__B-native.png`.

### BENCHMARK — GLB → Asset (Node, bench host, best-of-5 medians)

| fixture | MB | verts | A (js / auto-eff) | B native | Aeff/B | x A | x B | blob→B |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| tri / two-boxes / Box / BoxTextured | ~0 | 3–24 | 0.07–0.09 | 0.11–0.13 | 0.56–0.77× | 0 | 5 | 1–6 KB |
| Duck | 0.1 | 2 399 | 0.49 | 0.38 | **1.27×** | 0 | 5 | 118 KB |
| DamagedHelmet | 3.6 | 14 556 | 1.29 | 2.01 | 0.64× | 0 | 5 | 3 685 KB |
| vitrine ×5 (no normals) | 28–34 | ~1 M | 144–168 (auto) | 122–135 | **1.18–1.30×** | 9 | 5 | 28–35 MB |

- **The C++ front-end is essentially free.** Container split ≈ 0, **JSON parse
  0.02–0.06 ms**, metadata build 0.03–0.07 ms — *flat*, independent of file size
  (the JSON chunk is small metadata; `DamagedHelmet` 3.6 MB and `tri` 0.8 KB
  parse their JSON in the same 0.04 ms). Everything else in B's time is the
  geometry core (identical to F-010) plus the blob copy.
- **B wins where there is geometry work.** The vitrine corpus (real content:
  ~1 M-vertex meshes, no source normals) decodes **18–30 % faster** in the full
  native pipeline than in F-010's hybrid — fewer crossings (5 vs 9), metadata +
  dispatch in C++ not JS, geometry read zero-copy straight from the blob, no
  JS-side mega-buffer assembly. Duck (2.4 K verts) likewise **1.27×**.
- **B loses on tiny assets** — fixed overhead (5 crossings + blob copy + yyjson
  setup) is 0.13 ms vs JS's 0.08 ms. Absolute difference is 50 µs; irrelevant.
- **B loses on texture-heavy already-GPU-ready assets** — `DamagedHelmet` 0.64×.
  B copies the whole 3.6 MB blob (≈ 3 MB of it JPEG) into WASM to parse it;
  A's JS front-end reads the packed-F32 attributes as zero-copy views and never
  touches the texture bytes until GPU upload. (The image-view optimisation below
  removed the *return* copy: native decode 4.57 ms → **1.95 ms**; the remaining
  gap is the parse-time blob copy, which is architectural — C++ owning the
  container parse means the bytes must be in linear memory.)
- **Crossings:** A-js 0, A-auto 9, **B-native 5**, flat per asset regardless of
  size (a 34 MB vitrine GLB crosses 5 times).
- **Memory:** wasm-heap growth 0 for both once warm (reused `Batch` / `Pipeline`
  buffers). SoA geometry output is the large allocation (45–55 MB for a 1 M-vertex
  vitrine mesh) and is identical for both — same `Batch`.

### SIMD — `-O3` vs `-O3 -msimd128`, native pipeline

| stage | ratio |
|---|---|
| JSON parse / metadata | ~1.0× (not the bottleneck; ~0.03 ms either way) |
| geometry — normal generation (vitrine) | **~1.00×** — indexed scatter, does not vectorise |
| tiny fixtures | noise (0.7–1.4×, sub-0.2 ms) |

Consistent with F-010: SIMD helps straight-line copy/AABB loops, not the
scatter-heavy generation kernels. It stays on (shipping profile).

### GPU / first-frame / steady-state — `npm run bench:glb:gpu` (browser, WARP)

Every fixture is **upload-bound**. `createImageBitmap` (texture decode) dwarfs
the GLB decode by 10–100×: `DamagedHelmet` image decode **~1050 ms** vs GLB
decode ~3 ms; first-frame (GPU buffer + pipeline) 40–160 ms; steady frame
0.2–0.5 ms; 1500–5000 fps. **The decode-pipeline choice is invisible at the
render level** — load-to-render A/B is 0.82–1.38×, all of it first-frame and
image-decode noise. (Same lesson as F-008: a CPU-side win is not an FPS win.)

### Optimisations applied (each measured)

| change | before → after |
|---|---|
| pipeline parses the blob in place (no second copy into its own vector) | DamagedHelmet native 6.4 → 4.6 ms |
| one `GltfPipeline` per module instance (no per-call alloc) | steady decode #1 0.3 ms → #5 0.1 ms |
| BIN image bytes returned as zero-copy views (not sliced out of WASM) | DamagedHelmet native 4.6 → **2.0 ms** |

### A vs B — per aspect (bench host; "winner" = on this axis, for real content)

| aspect | PIPELINE A (JS front-end) | PIPELINE B (native) | winner |
|---|---|---|---|
| GLB container parse | ~0 (DataView walk) | ~0 (pointer walk, no copy) | tie |
| JSON parse | 0.02–0.06 ms (`JSON.parse`) | 0.02–0.06 ms (yyjson) | tie |
| glTF metadata build | in JS, ~0.05–0.3 ms, grows with node/mesh count | in C++, 0.03–0.07 ms, flat | **B** |
| accessor decode (packed F32, GPU-ready) | zero-copy typed-array view | copy into linear memory | **A** |
| accessor decode (needs convert / widen / de-interleave) | per-element JS loop | `bcpp::gltf::Batch` (memcpy fast paths, SIMD) | **B** |
| normal / tangent generation | not implemented in JS | `bcpp::gltf::Batch` | **B** (only path) |
| AABB | accessor min/max or JS scan | accessor min/max or C++ scan | tie |
| JS↔WASM crossings | 0 (js) / 9 (auto) | **5**, flat | **B** vs auto |
| bytes copied into WASM | referenced geometry ranges (auto) | whole blob once (parse) | **A** (texture-heavy) / tie (geometry-heavy) |
| allocations (steady state) | 0 wasm-heap; JS GC pressure from views/slices | 0 wasm-heap (reused `Pipeline`) | **B** |
| CPU throughput — tiny asset | 0.08 ms | 0.12 ms (fixed overhead) | **A** (moot) |
| CPU throughput — geometry-heavy real asset | 144–168 ms (auto) | **122–135 ms** | **B** (+18–30 %) |
| CPU throughput — texture-heavy GPU-ready | **1.3 ms** (js, zero-copy) | 2.0 ms (blob copy) | **A** |
| GPU upload / first frame / steady frame | identical — same `Batch` output, same renderer | identical | tie (invisible) |
| startup (module instantiate) | shared ~40–115 ms one-off | same module | tie |
| warm load | ~0.1 ms overhead settled | ~0.1 ms overhead settled | tie |
| integration with the runtime | JS orchestration, familiar | one C++ path, reusable as a standalone glTF core | **B** (qualitative) |
| predictable memory / data-oriented | JS heap + views | flat POD `Document`, arena-like vectors | **B** (qualitative) |

### DECIDE — result **C / D** (the benchmark's answer, not a prior assumption)

**The full C++/WASM pipeline is a complete, validated alternative — 114/114 data
equivalence, 6/6 render equivalence — and it is the faster path for
geometry-heavy assets that need work (the real vitrine content: +18–30 %), with
fewer boundary crossings (5 vs 9).** It is *not* faster across the board: for
tiny assets the fixed overhead loses by microseconds, and for texture-heavy
already-GPU-ready assets it loses because C++ owning the container parse forces
the whole blob (textures included) into linear memory, where the JS front-end
reads packed-F32 as zero-copy views.

Crucially, **doing the container + JSON + metadata parse in C++ costs almost
nothing** (~0.1 ms, flat) — there is no penalty to routing structural parsing
through C++, so the boundary can sit wherever the geometry workload wants it:

- `parser: "native"` — geometry-heavy / needs-work assets (vitrine-class real
  content). One coherent C++ path, 5 crossings, fastest.
- default (F-010's JS front-end + hybrid `geometry:"auto"`) — mixed / small /
  texture-heavy-GPU-ready workloads.
- future `parser: "auto"` — a cheap JSON peek (normals present + packed F32 +
  textures → JS; else → native) could pick per asset.

`develop` stays green; v0.1.0 untouched; F-010 stands as the previous cycle.

---

## F-010 · GLB — JS parses, a C++/WASM core does the geometry work, hybrid dispatch picks per primitive
`node bench/make-glb-fixtures.mjs && node --expose-gc bench/run-glb-profile.mjs`
`npm run build && npm run test:glb && npm run test:glb:render && npm run bench:glb`
Cycle: [docs/investigations/glb.md](investigations/glb.md). Branch `feat/glb-loader`.

> **Update (WASM-core cycle).** The PROFILE below stands. Its *conclusion* —
> "the loader is 100 % JavaScript, WASM stays out" — was **superseded**: a
> follow-up cycle implemented the C++/WASM batch geometry core, integrated it as
> the real runtime path, validated numerical equivalence, rendered every fixture
> through it, and benchmarked JS vs WASM vs hybrid. Results in
> **VALIDATE / RENDER / BENCHMARK / DECIDE** below.

**PROFILE** — raw cost of what a loader must do, before any loader exists:

| fixture | size | JSON % of file | `JSON.parse` | naive accessor decode | verts |
|---|---|---|---|---|---|
| tri (hand-authored) | 0.8 KB | 87 % | 0.02 ms | 0.02 ms | 3 |
| two-boxes (hand-authored) | 2 KB | 57 % | 0.04 ms | 0.01 ms | 24 |
| Box (Khronos) | 2 KB | 59 % | 0.03 ms | 0.01 ms | 24 |
| BoxTextured | 6 KB | 22 % | 0.04 ms | 0.02 ms | 24 |
| Duck | 118 KB | 2 % | 0.06 ms | 0.82 ms | 2 399 |
| DamagedHelmet | 3.7 MB | ~0 % | 0.05 ms | 5.0 ms | 14 556 |

- **`JSON.parse` is free** — 0.02–0.06 ms regardless of file size. The JSON chunk
  is metadata; the bytes live in the BIN chunk. → parse in JS.
- The "decode" column is the **pessimistic** path (per-element `DataView`
  reads). For the common case — accessors that are non-interleaved and already
  `FLOAT`/`UNSIGNED_SHORT` — the decode is a **zero-copy `new Float32Array(bin,
  offset, len)`**, i.e. ~0 ms. A copy is only needed for interleaved data,
  normalized ints, or `UNSIGNED_BYTE` indices.
- Embedded images (PNG/JPEG in BIN) — decode is a browser codec job
  (`createImageBitmap`), not ours. We slice the bytes.
- Geometry does **not** need to enter WASM linear memory: it goes straight to
  GPU buffers. The C++ core only needs the per-mesh local AABB (cheap, from the
  accessor `min`/`max` when present).

**HYPOTHESIS** — the minimal GLB loader (nodes, transforms, mesh primitives,
indices, POSITION/NORMAL/TEXCOORD_0, `baseColorFactor` + one texture) is
**100 % JavaScript**. WASM stays out of it. This matches the project rule
(Phase 35): use JS when parsing is cheap and the boundary cost is irrelevant.
The only future WASM candidates: `ComputeNormals`/tangents for GLBs that omit
them, and Draco / meshopt / KTX2 decompression — none in this pass; each gets
its own PROFILE → HYPOTHESIS later.

**DESIGN** — loader (`web/asset/{glb,gltf}.ts` + `Asset`) has **zero** imports of
the renderer or WASM. `AssetManager.instantiate(asset, scene)` is the only
bridge: Asset → `scene.createEntity()` + `renderer.registerMesh()`. Geometry
reaches the GPU there, never before.

**IMPLEMENT** — `web/asset/{glb,gltf,Asset,AssetManager}.ts` + `scene.loadAsset(url)`.
The loader is pure JS with zero renderer/WASM imports (runs in Node).

**VALIDATE (decode)** — `npm run test:glb`: **60/60**.
- hand-authored `tri.glb` / `two-boxes.glb` checked against exact known values:
  node count/names/hierarchy, topological order, TRS, positions, normals,
  indices (widened u16→u32), AABB (from accessor min/max), material factors,
  UVs, shared-mesh-not-duplicated, zero-copy views.
- Khronos `Box` / `BoxTextured` / `Duck` / `DamagedHelmet`: structural sanity
  (topological nodes, in-range indices, sane AABB) + **vertex count matches
  `@babylonjs/loaders`** (Duck 2399, DamagedHelmet 14556).
- unsupported input is surfaced in `asset.ignored[]`, not dropped: Duck's
  camera, DamagedHelmet's normal/occlusion/metallicRoughness textures.

**IMPLEMENT (C++/WASM core)** — `native/include/bcpp/gltf.hpp` (`bcpp::gltf::Batch`)
+ `native/bindings/asset.cpp` (embind `GltfBatch`). One contiguous BIN blob + a
flat `PrimDesc[]` table in → concatenated SoA `pos / nrm / uv / tan` + `idx` +
`PrimOut[]` out. One `process()` call decodes every primitive of an asset: accessor
decode (with a memcpy fast path for tightly-packed F32 and U32 indices), index
widening (u8/u16 → u32), non-indexed expansion, area-weighted normal generation
when a primitive has none, Lengyel tangent generation on request, AABB (accessor
min/max or computed). **~9 JS↔WASM crossings per asset**, flat regardless of
vertex count — never per-primitive, never per-vertex. JS side (`web/asset/wasm.ts`)
parses the glTF JSON, builds `PrimDesc`, uploads **only the byte ranges the
geometry accessors touch** (not the embedded texture bytes in the BIN), and reads
outputs back as typed-array views. One reused `GltfBatch` instance — its buffers
grow and stay, so steady-state decoding does zero WASM-heap allocation.

Integration (`web/asset/gltf.ts`): `geometry: "auto" | "wasm" | "js"`, default
`"auto"` — per primitive, geometry already in GPU-ready layout (packed-F32
attributes, normals present, U16/U32 indices, accessor min/max) takes the JS
**zero-copy view** path; anything needing real work (tangent generation, missing
normals, de-quantising normalized/integer attrs, de-interleaving, non-indexed
expansion) goes to the C++/WASM core. `scene.loadAsset(url, { geometry, generateTangents })`
threads the choice through. Sparse accessors and `COLOR_0` always use JS.

**VALIDATE (equivalence)** — `npm run test:glb`: **89/89**.
- `tri.glb` / `two-boxes.glb` forced through the WASM core, checked against exact
  known values (positions bit-identical, normals bit-identical, u32 indices, AABB
  from accessor min/max, hierarchy/TRS, material factors).
- every fixture: **WASM output vs the JS reference decoder** — positions
  bit-identical (`maxΔ = 0`), indices identical, UVs bit-identical, normals within
  `3e-4` where the source had them, AABB within `1e-4`, node/mesh/primitive/material
  counts and total vertex/index counts equal, generated normals unit-length.
- `"auto"` dispatch produces byte-identical data to the JS reference on every
  fixture (it just chooses the faster path).
- Babylon.js cross-check: vertex counts match `@babylonjs/loaders` (Box 24,
  BoxTextured 24, Duck 2399, DamagedHelmet 14556).

**RENDER** — `npm run test:glb:render` (Playwright + Chromium WebGPU / WARP):
every fixture loaded **forcing `geometry: "wasm"` + tangent generation**, all the
way to the pixels. `tri` · `two-boxes` · Khronos `Box` · `BoxTextured` · `Duck` ·
`DamagedHelmet` — **6/6 PASS**: geometry path = wasm, instances in frustum,
draw-call count sane, depth headroom (no F-009 z-collapse), no GPU validation
errors, not a black frame. Screenshots in `bench/results/glb-*.png` visually
verified: red cubes with correct parent/child transforms, the Duck yellow with
its texture, BoxTextured showing the UV test pattern, DamagedHelmet with its
base-colour texture and shape. Two bugs found and fixed here that the numerical
tests could not catch (F-009 lesson):
- `defaultTex` 1×1 write had no `bytesPerRow` → device-level validation error that
  poisoned every later bind group. `writeTexture` needs an explicit data layout.
- `decodeImage` read `ImageBitmap.width/height` *after* `.close()` → `0×0` →
  `createTexture` rejected. Read dimensions before closing.

**BENCHMARK** — `npm run bench:glb`. Node, no renderer. Full `decodeGLB`, median
ms, bench host (numbers ~3× a modern laptop; ratios hold). WASM module init
one-off ≈ 70 ms.

| fixture | verts | idx | JS | WASM | auto | WASM+tan | JS/WASM | →wasm |
|---|---|---|---|---|---|---|---|---|
| tri | 3 | 3 | 0.07 | 0.15 | 0.06 | 0.20 | 0.47× | 0 KB |
| two-boxes | 24 | 36 | 0.10 | 0.12 | 0.05 | 0.10 | 0.80× | 1 KB |
| Box | 24 | 36 | 0.11 | 0.12 | 0.06 | 0.10 | ~1× | 1 KB |
| BoxTextured | 24 | 36 | 0.09 | 0.15 | 0.10 | 0.12 | 0.62× | 1 KB |
| Duck | 2 399 | 12 636 | 0.41 | 0.49 | 0.34 | 0.78 | 0.83× | 100 KB |
| DamagedHelmet | 14 556 | 46 356 | 1.29 | 1.87 | 1.21 | 3.41 | 0.69× | 545 KB |

- **For geometry already in GPU-ready layout, JS is faster** (0.5–0.9×). JS reads
  packed-F32 attributes as zero-copy typed-array views over the GLB ArrayBuffer —
  0 copies. The WASM path must cross the heap (BIN→heap, decode→SoA, SoA→JS slice)
  no matter how little "processing" the data needs. This is recorded as a
  technical result: **`"auto"` keeps these primitives in JS.**
- **The WASM core carries its own weight where there is work to do.** Tangent
  generation (needed by every normal-mapped PBR asset — the JS path does not
  implement it at all) is `WASM+tan`. Missing-normal generation, KHR-quantised /
  normalized attributes, interleaved buffers, non-indexed geometry all route to
  WASM under `"auto"`.
- Optimisations applied this cycle, each measured on DamagedHelmet:
  upload only referenced byte ranges (11.8 → 4.3 ms, 3683 → 545 KB in) ·
  memcpy fast paths for packed F32 + U32 indices (4.3 → 3.8 ms) ·
  one reused `GltfBatch`, no per-call allocation (3.8 → ~1.9 ms) ·
  `resize` instead of `assign` for fully-overwritten output vectors (within noise).
  Net WASM decode: **11.8 ms → 1.9 ms**.
- SIMD (`-O3 -msimd128` vs `-O3`): decode 1.90 vs 2.46 ms (LLVM vectorises the
  copy/AABB loops); tangent gen 3.95 vs 3.99 ms (scalar, indexed scatter — does
  not vectorise). SIMD stays on (it is the shipping profile and it helps decode).
- Crossings: **9 per asset**, tri.glb and the 3.7 MB DamagedHelmet alike.

**RENDER + BENCHMARK — real heavy corpus** (`bench:glb:vitrine`, 108 GLBs, ~3.6 GB,
`GLB_VITRINE_DIR`). These are ~1 M-vertex / ~6 M-index single-primitive scanned
meshes with **no source normals** and no textures — the case the native core
exists for. 8-file sample:

| | verts | indices | JS* | WASM | auto | path | crossings |
|---|---|---|---|---|---|---|---|
| median | ~985 k | ~5.9 M | 0.3 ms | ~160 ms | ~160 ms | wasm | 9 |

- `JS*` is **zero-copy view creation only** — 0.3 ms because it does no work and
  **leaves normals `null`**. A JS-only decode of this corpus does not produce a
  shadeable mesh. There is no JS normal generator.
- `"auto"` routes **every** model to the C++/WASM core, which generates
  area-weighted normals at **~12 M triangles/s (~168 ms / M verts)**, positions
  bit-identical to the JS views, indices identical, generated normals unit-length
  (8/8 equivalence PASS). **9 crossings** for a 34 MB file.
- Rendered through the forced WASM path (`test:glb:render`): `gaia.glb` (1.0 M
  verts) and `shivas.glb` (0.76 M verts) both render correctly — full surface
  shading from the generated normals, screenshots in `bench/results/`. Decode +
  normal-gen ~250–650 ms, one draw call, no GPU errors.

This is the concrete answer to "is the native core dead code": for the real
content in hand, it is the **only** path that yields a renderable asset.

**DECIDE** — **Keep the C++/WASM batch core as the real runtime path for geometry
that needs work; keep the JS zero-copy path for geometry that does not; dispatch
per primitive (`"auto"`).** The native core is not dead code — it is the only
path that generates tangents and normals, de-quantises, de-interleaves, and
expands non-indexed geometry, and it does so in one batched call with a flat 9
crossings. The benchmark says plainly that a straight copy of already-GPU-ready
F32 is cheaper in JS than across the WASM heap; the runtime honours that. Both
paths are proven byte-equivalent (89/89) and both render correctly (6/6). The
cycle is mergeable: `develop` stays green (v0.1.0 equivalence gate 4/4 throughout),
v0.1.0 benchmarks untouched.

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
