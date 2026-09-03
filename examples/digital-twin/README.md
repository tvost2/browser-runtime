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

### Honest limitations

- **No lighting** in the runtime path — flat unlit colour per face
  (Babylon has hemispheric + directional). Fine for a cost comparison,
  not a beauty match.
- **Mesh re-upload is all-or-nothing.** `Renderer.uploadMeshes` rebuilds
  the entire vertex/index buffer whenever any mesh is added, so a
  region-boundary crossing costs a ~200 ms spike. The engine's GLB path
  uploads once; a streaming mesh set is a workload it wasn't tuned for.
  An incremental mesh-buffer API would remove the spike.
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
