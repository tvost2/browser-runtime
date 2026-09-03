# Case study: Browser Runtime inside a real digital twin

The **Uberlândia Universal Digital Twin** (`uberlandiacity`, a separate
project — Babylon.js, no build step, real Overture/OSM/3DBAG data) got an
engine toggle: **Babylon.js (WebGL)** ⇄ **Browser Runtime (C++/WASM +
WebGPU)**, rendering the exact same streamed city.

Live: <https://twin.mytheria.com.br> — check "Motor Browser Runtime" in the
top-left panel (needs a real GPU: recent phone, or a desktop with WebGPU).

## Workload

Smart City domain: **298,573 real buildings + 34,088 street segments**,
pre-tiled into 750 m regions, streamed with a camera-driven sliding
window (near tier = individual extruded footprints, far tier = merged
region meshes). At any moment ~1,150–1,500 meshes / ~1.5 M triangles are
resident.

## Integration approach

One new file (`RuntimeRendererAdapter.js`) + ~90 lines of patch across two
files. **The Babylon scene is untouched** — it still builds every mesh
(picking, HTML labels, GPS overlays, the far-tier merge all depend on
it). The adapter:

1. **Mirrors at the mesh level, not the object level.** Every render
   frame (throttled to 250 ms) it walks `scene3d.meshes`, and for each
   changed/new mesh copies world-space `{positions, indices}` + the
   material colour into a parallel `bcpp::World` scene as a pooled
   entity. A per-mesh `nv/ni` signature skips unchanged meshes (no
   readback). Identity world matrix (≈ every twin mesh) → plain memcpy
   instead of 1.5 M per-vertex transforms. The sliding window's
   add/remove falls out for free.
2. **Copies the ArcRotateCamera pose** each frame (`getViewMatrix(true)`
   to force `.position` recompute) into `scene.camera`, then
   `engine.renderOnce()` onto an opaque `<canvas>` stacked over the
   Babylon one.
3. Babylon keeps rendering underneath (hidden) so camera input, picking,
   labels and streaming keep working. The runtime's `cpuFrameMs` /
   `evalMs` / `gpuMs` are measured independently by `renderOnce()`, so
   the HUD comparison stays clean.

Gotchas hit and fixed along the way:

- `wasmUrl` in `RtEngine.create` must point at **`engine.mjs`** (the
  emscripten glue), not `engine.wasm`.
- The renderer resolves material **per mesh** (`renderer.setMeshMaterial`),
  not per entity — `entity.setMaterial` alone leaves everything on the
  default white/back-face-culled material and the whole city renders
  black.
- The overlay `<canvas>` must be laid out (non-zero size) **before**
  `RtEngine.create` configures the WebGPU context.

## Measured (bench host: 2014 Xeon, no GPU → WARP/SwiftShader software rendering)

Absolute ms are meaningless on this box (no GPU); the **CPU scene cost**
and the **ratio** are the story. A real phone/desktop GPU collapses both
`gpu` numbers to single-digit ms.

| | Browser Runtime | Babylon.js |
|---|---|---|
| scene eval (transform + cull + batch, 3,774 entities) | **0.15–0.32 ms** | — |
| CPU frame (steady state) | **~2 ms** | ~160 ms* |
| draw calls | 1,150–1,500 | 1,150–1,500 |
| mirror tax (Babylon → runtime, per 250 ms) | ~10 ms steady, ~200 ms on a region stream (full mesh re-upload) | n/a |
| WASM heap | 64 MB flat | — |

\* Babylon's ~160 ms here is software WebGL rasterising the whole city +
SkyMaterial every frame on a 2014 CPU — not representative of a real GPU,
but it is the same frame the runtime does in ~2 ms of CPU + one WebGPU
submit.

### Update — geometry upload made incremental

`Renderer.uploadMeshes` used to rebuild the whole vertex/index buffer on
any mesh add (O(all meshes), plus a JS interleave loop). Replaced with an
**append-only arena + SoA vertex buffers**: a new mesh is written at the
tail, buffers double only when the tail overflows. Streaming a new city
region now uploads only that region's ~12–22 MB delta, and the frame that
runs `uploadMeshes` no longer touches the ~50 MB already resident.

Measured on the live twin, jumping between avenues (WARP):

| | before | after |
|---|---|---|
| `cpu frame` after a region stream | spike (full re-upload) | **0.8–0.9 ms** (flat) |
| geometry re-uploaded per jump | cumulative total (up to ~97 MB) | **the delta only** (12–22 MB) |
| `bench/run-mesh-upload.mjs`, 3600 meshes | uploadMs 6 → 40 ms, climbing | **2.6 → 1.9 ms, flat** |

The `espelhar` (mirror) spike of ~100 ms on a big stream is what remains —
that's the adapter's JS mesh readback + world-matrix bake, i.e. the cost
of copying *out of Babylon*, not the engine.

### `CullStrategy.Gpu` — on

The adapter sets `scene.cullStrategy = CullStrategy.Gpu`: a compute shader
does the frustum cull + per-mesh compaction + draw-args, the CPU builds no
render list and uploads **0 bytes of matrices per frame** (F-014). HUD
shows `matrizes p/ GPU 0 KB/frame`, `eval(cena)` ~0.15 ms for 5.7k
entities.

The many-bucket case (~3.7k unique meshes) exposed a WARP / older-Dawn bug
— `drawIndexedIndirect`'s `firstInstance` isn't added to
`@builtin(instance_index)`, so every bucket drew only the first bucket's
instances (black screen). Fixed by passing each bucket's base into
`visibleIds` as a per-draw dynamic uniform-buffer offset instead of
`firstInstance`.

### Cell merge — 3,774 building meshes → ~90 draws (F-017)

The near tier is thousands of individually-extruded footprints, each its own
draw. The adapter now groups them by a **grid cell** (`DEFAULT_CELL` 1500 m) ×
a coarse-quantised colour and hands each group to the C++ `mergeMeshes` kernel,
which world-bakes + concatenates them into one mesh. A group is re-merged only
when its membership changes (a cell streams in/out); big meshes (ground,
far-tier merges, ≥ 12k verts) bypass the grid 1:1.

Every merged vertex keeps its source mesh's `uniqueId`, so `runtimePick(x, y)`
resolves the individual building through the renderer's `r32uint` id buffer —
verified against Babylon's own picker on the live twin.

Measured on the live twin (WARP, camera over central Uberlândia, ~3,774
resident building meshes):

| | per-mesh (`CullStrategy.Gpu`) | cell merge (`CullStrategy.Auto`) |
|---|---|---|
| draw calls (visible) | ~1,150–1,500 | **~90** |
| runtime entities | 3,774 | **~690** |
| `cpu frame` | ~2 ms | **~0.8 ms** |
| pick | Babylon raycast | + pixel-accurate id buffer |

`CullStrategy` flips to `Auto` in merge mode — with the entity count collapsed
the incremental CPU cull beats the GPU compute path (whose dispatch overhead
now dominates), and `pickAt` needs the CPU render list anyway. Toggle from the
console: `__RTR.runtimeSetMerge(false)` / `window.__twinCell = 2500`.

**Still fragmented by colour** (~36 quantised materials → ~690 groups, not
~50). The clean fix is a per-vertex colour attribute on the merged mesh so a
cell is one group regardless of colour — next step.

### Honest limitations

- **No lighting** in the runtime path — flat unlit colour per face
  (Babylon has hemispheric + directional). Fine for a cost comparison,
  not a beauty match.
- Billboards (POIs), terrain and the LiDAR point cloud are not mirrored —
  Babylon still draws those; the comparison is the building + street mesh
  workload only.
- Entities are pooled and only hidden, never deleted (v0.1 has no
  per-entity delete), so the entity count grows to the session's
  high-water mark.

## Files

- `RuntimeRendererAdapter.js` — the adapter (drop into
  `src/digitalTwin/`, point the two imports at wherever `engine.js` /
  `engine.mjs` / `engine.wasm` live).
- `patches/*.patch` — the wiring into `digital-twin-universal.html` and
  `digitalTwinDemoMain.js`.
