# Investigation: incremental rendering / GPU synchronization

**Branch:** `feat/incremental-renderer` (off `develop`). Follows F-012.
Full results: [FINDINGS F-013](../FINDINGS.md#f-013).

| step | state |
|---|---|
| MEASURE / PROFILE | ✅ after F-012 the O(n) cull + O(visible) list-build + full 4 MB upload dominate any "something moved" frame |
| HYPOTHESIS | ✅ the cull, the render list, and the GPU upload can all be patched instead of rebuilt |
| IMPLEMENT | ✅ incremental linear cull · incremental render list + dirty-slot list · partial `writeBuffer` · `CullStrategy.Auto` |
| EQUIVALENCE | ✅ `test:equivalence` 6/6 (patched list == full rebuild, 200 random frames) · `test:render:patch` 5/5 (browser) · `test:visual` PASS |
| BENCHMARK | ✅ `bench:renderer` (Node, stage split) · `bench:renderer:gpu` (browser, upload bytes) |
| DECIDE | ✅ [ship](../FINDINGS.md#f-013) — `Auto` default |

## Why this subsystem (from the cycle brief)

F-012 made the transform pass incremental; the profile then showed the **O(n)
frustum cull** is 80–90 % of any frame where the camera or an object moved, with
the counting-sort render-list build and the renderer's unconditional full
instance-buffer upload behind it.

## As built

### Incremental linear cull (`native/include/bcpp/world.hpp`)

- Persistent `_visibleBit` per entity. Camera unchanged → re-test only
  `_recomputed` entities, reuse the bit for the rest. The O(n) `visibleId`
  rebuild in topo order stays (~7 ns/entity); the ~30 ns/entity frustum math is
  skipped for what didn't move.
- Full re-test on `camMoved || structChanged || strategy switch || _visibleBit
  stale` (the last happens after a `Bvh` frame, which doesn't maintain the bit).

### Incremental render list

- After the cull, if `visibleId == _visiblePrev` (same entities, same order) and
  no meshId / visibility edit and the sort mode is unchanged → the counting-sort
  slot assignment is identical. Overwrite `instanceWorld[_entitySlot[e]]` only
  for `_recomputed` entities; emit `_dirtySlots`. `stats.listRebuilt = 0`.
- Otherwise full rebuild (`buildSortedBatches` / `buildRunBatches`, which now
  also fill `_entitySlot`), refresh `_visiblePrev`.

### Partial GPU upload (`web/renderer/Renderer.ts`)

- `render()`: `frameChanged == 0` → no upload; `listRebuilt == 1` → one full
  `writeBuffer`; `listRebuilt == 0` → coalesce `dirtySlots` into runs, one
  `writeBuffer` per run. `lastUploadBytes` tracks it.
- Guarded by `modelBufValid` + `lastUploadedVisible` — a fresh buffer or a
  standalone `evaluate()` (spatial query / camera framing not paired with a
  render) forces a full upload.
- The depth texture now resizes with the canvas (a mismatch silently drops the
  frame → black screen).

### `CullStrategy.Auto` (`shared/layout.ts` = 4, `Scene.cullStrategy` default)

Per frame, resolved after the transform pass: `camMoved && count > 20000 &&
recomputed·8 ≤ count` → `Bvh`, else `Standard`. Gets the incremental linear
cull for a still camera and the sub-linear BVH traversal for a moving one.

## Results

[FINDINGS F-013](../FINDINGS.md#f-013). Headline (250k entities, `Auto`):

| | before (F-012) | after |
|---|--:|--:|
| object motion, still camera (0.1 % moving) | 13 ms | **5 ms** (2.6×) |
| moving camera | 13.5 ms | **6.3 ms** (2.1×) |
| static | 1.8 ms | 1.7 ms |
| instance-buffer upload (1 % moving) | 4.1 MB | **19 KB** (~210×) |

## Limitations / next

- The `visibleId` rebuild and the render-list build are still O(n) / O(visible).
  A dirty *list* (not the O(n) bitset scan) for the transform pass and a
  persistent per-node visibility cache in the BVH are the next levers.
- On the WARP bench host every render workload is GPU-bound — the CPU-pipeline
  win is a `bench:renderer` (Node) number, not a WARP-FPS number. Verify on a
  discrete GPU.
- `bench/results/renderer-gpu.json` `cpuFrameMs` is contaminated by GPU
  backpressure on WARP; the `evalMs` (steady_clock in C++) column is clean.
