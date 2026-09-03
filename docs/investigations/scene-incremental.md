# Investigation: incremental scene evaluation + spatial index

**Branch:** `feat/incremental-scene` (off `develop`). Improves the v0.1.0
`World::evaluate()` (Phase 0 / F-008). Full results: [FINDINGS F-012](../FINDINGS.md#f-012).

| step | state |
|---|---|
| PROFILE | ✅ F-008 — `evaluate()` is 96–99 % of the CPU frame; within it, transform recompute is ~250 ns/entity paid **every frame regardless of movement** |
| IMPLEMENT | ✅ dirty-tracked incremental transforms · `bcpp::Bvh` (`CullStrategy::Bvh`, `raycast`, `queryBox`) |
| VALIDATE | ✅ `test:equivalence` 6/6 (`test_incremental` + `test_bvh` added) · `test:spatial` 3/3 · `test:glb*` / `test:visual` unchanged |
| BENCHMARK | ✅ `bench:scene` — `evaluate()` ms at 1k–500k × {static, 0.1/1/10/100 % moving} × {Standard, Bvh} vs JS kernel vs Babylon |
| DECIDE | ✅ [below](#decide) |

## Why this subsystem

Selection criteria (from the cycle brief): CPU/frame impact · architectural
leverage · scalability · dependency on existing systems · Babylon-compat value ·
potential architectural advantage.

`evaluate()` is 96–99 % of the CPU frame at every non-trivial scale. Its
transform pass is O(n) *every frame* even when nothing moved — and **most
entities in most scenes never move**. Babylon separates static/dynamic
(`freezeWorldMatrix`, `freezeActiveMeshes`); our runtime did not. Fixing this:

- attacks the single largest CPU cost directly,
- needs nothing new from other subsystems (it consumes the world AABBs
  `evaluate()` already produces),
- is the substrate for a spatial index → picking, triggers, physics broadphase,
  occlusion culling, LOD, clustered lighting,
- is an architectural advantage a class-per-node engine cannot match: a dirty
  bitset over SoA + a flat BVH in WASM, zero per-node JS.

## As built

### 1. Incremental transforms (`native/include/bcpp/world.hpp`)

- New component `dirty` (u8). The TS `Transform` position/scaling/rotation
  setters and `Entity.setMesh` set `dirty[id] = 1`.
- `evaluate()` = **transform pass** (recompute `world[i]` + `worldMin/Max[i]` +
  sphere only if `structChanged || dirty[i] || _recomputed[parent]`; topo order
  makes one forward sweep propagate ancestor motion) then **cull pass** (visits
  every entity — the camera usually moves — but that test is cheap).
- Persistent `worldMin` / `worldMax` (were transient).
- Fast path: `recomputed == 0 && !cameraChanged && !structChanged` → reuse the
  render list, `stats.frameChanged = 0`, renderer skips the instance re-upload.
- `resize()` now grows storage **preserving** existing data (`std::vector::resize`,
  not `assign`) — fixes latent corruption for scenes built one entity at a time.
- New stats: `transformsRecomputed`, `frameChanged`, `bvhBuilds`, `bvhNodes`.

### 2. Spatial index (`native/include/bcpp/bvh.hpp`)

- Flat `BvhNode[]` (32 B: min/max/leftFirst/count), Bikker-style (child index >
  parent). Binned-SAH build (12 bins, 3 axes, iterative with an explicit stack).
- `refitDirty(recomputed, …)` — bottom-up AABB update of only the leaves holding
  a moved entity + their ancestors, via `entityLeaf[]` / `nodeParent[]`.
  O(moved·depth).
- `frustumCull(fr, visit)` — node classify: fully-outside → prune subtree,
  fully-inside → accept all (skip per-entity test), straddling → recurse.
- `raycastLeaves` / `queryBox` visitor traversals.
- `World::raycast(o, d, maxT)` → nearest entity whose world AABB the ray hits
  (precise slab test); `World::queryBox(min, max)` → overlapping entity slots.
  Both drive `WasmCore.raycast()` / `WasmCore.queryBox()`.
- `CullStrategy::Bvh` (new, **opt-in**): build on setup, `refitDirty` on a
  light-motion frame, and on a heavy-churn frame (`recomputed·8 > count`) a
  cheap full refit + linear cull — worst case bounded to ≈ `Standard`.

## DECIDE

Data in [FINDINGS F-012](../FINDINGS.md#f-012).

- **Incremental transforms: ship.** Static 250k frame 90 ms → **1.7 ms**
  (~50×); ~230× the JS kernel; ~680× Babylon-frozen at 50k. No regression at
  100 % moving. Bit-exact equivalence.
- **BVH: ship for the queries.** `raycast` / `queryBox` have no substitute and
  are needed by interaction + physics. `CullStrategy::Bvh` is **situational** —
  it wins only for a large scene with <~1 % moving per frame (~1.3–1.5×), ties
  on static, mildly loses above ~10 % moving. `Standard` stays the default.

## Limitations / next

- The **cull pass is still O(n)** for `Standard` and the **render-list build is
  O(visible)** — these now dominate any frame where something moved. Next levers:
  an incremental render list (patch changed instance matrices), a persistent
  BVH-node visibility cache, and a dirty *list* (not an O(n) bitset scan) for the
  transform pass.
- BVH tree quality decays under sustained partial motion (refit never
  repartitions); a periodic rebuild-when-calm heuristic exists but isn't tuned.
- `raycast` / `queryBox` are AABB-level (broadphase). Exact triangle picking is a
  later, separate concern.
- No multi-threading — the transform and cull passes are parallel-ready (range
  split over `_order`) but not split.
