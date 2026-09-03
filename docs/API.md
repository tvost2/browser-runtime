# API.md — the public TypeScript surface (v0.1.0)

> Experimental. Small on purpose. It covers scene evaluation + a minimal
> renderer — nothing else (see *Known Limitations* in `README.md`).

```ts
import { Engine, box, sphere } from "browser-runtime";

const engine = await Engine.create(canvas);        // loads engine.wasm + WebGPU
const scene  = engine.createScene();

const e = scene.createEntity();
e.transform.position.set(0, 1, 0);
e.transform.scaling.set(2, 2, 2);
e.mesh = box();                                     // auto-registers + dedups

engine.start();                                     // rAF loop; meshes upload lazily
// ...
engine.dispose();                                   // stop + free WASM + GPU
```

---

## Engine

| member | notes |
|---|---|
| `static Engine.create(canvas, { wasmUrl? })` → `Promise<Engine>` | loads the WASM core and a WebGPU device in parallel. Throws if `navigator.gpu` is absent or no adapter. `wasmUrl` overrides the default `engine.mjs` location. |
| `engine.createScene()` → `Scene` | v0.1: use one scene. Multiple scenes share one WASM `World`. |
| `engine.uploadMeshes(scene)` | optional — meshes upload on the first frame otherwise. Call it to pay the GPU cost before `start()`. |
| `engine.onBeforeRender(fn)` | `fn({ frame, dtMs, time })` runs each frame before `evaluate()`. Do your per-frame SoA writes / camera moves here. |
| `engine.renderOnce()` → `EngineStats` | one frame, synchronous up to `queue.submit` (does not block on the GPU). |
| `engine.start()` / `engine.stop()` | rAF loop on/off. |
| `engine.dispose()` | stop, destroy GPU resources + device, free the WASM `World`. Engine/scenes/views are dead after. |
| `engine.stats` → `EngineStats` | last frame's numbers (see below). |
| `engine.wasmInitMs` | one-off WASM load+instantiate cost. |
| `engine.core` → `WasmCore` | escape hatch: raw SoA component views (`engine.core.components`). |
| `engine.renderer` → `Renderer` | escape hatch: the WebGPU renderer. |

### EngineStats

`frame · cpuFrameMs · evalMs · gpuMs|null · fps · visible · entities · batches ·
drawCalls · wasmHeapMB · jsHeapMB|null`

`cpuFrameMs` = hooks + `evaluate()` + WebGPU record + submit. `evalMs` = just the
one WASM call. `gpuMs` is `null` unless the adapter supports `timestamp-query`.

---

## Scene

| member | notes |
|---|---|
| `scene.registerMesh(data)` → `number` | returns a stable mesh id. Called again with the **same `MeshData` object** → same id (identity dedup; no content hashing). |
| `scene.createEntity()` → `Entity` | one entity. Id = current `entityCount`. |
| `scene.createEntities(n, fill?)` → `Entity[]` | bulk fast path. `fill(entity, i)` runs with the SoA rows pre-allocated. Marks the hierarchy dirty once at the end. |
| `scene.entity(id)` → `Entity \| undefined` | handle by id. Out-of-range → `undefined`. |
| `scene.entityCount` | number of entities. |
| `scene.camera` → `Camera` | see below. |
| `scene.cullStrategy` | `CullStrategy.Standard` (default) / `BoundingSphereOnly` / `None`. |
| `scene.sortByMesh` | default `true` — counting-sort visible entities by mesh id so the renderer does 1 draw call per mesh. |
| `scene.dispose()` | drop all entities (`World` count → 0). Meshes stay registered. |
| `scene.evaluate(aspect)` → `FrameResult` | run the whole CPU pipeline in WASM (1 boundary crossing). Normally the engine calls this. |

---

## Entity  (a handle, not an object — holds no data)

| member | notes |
|---|---|
| `entity.id` | dense, stable, **never recycled** (no per-entity delete in v0.1). |
| `entity.transform.position` | `.set(x,y,z)` or `.x/.y/.z` — writes straight into the WASM SoA. |
| `entity.transform.scaling` | same. |
| `entity.transform.setRotationQuaternion(x,y,z,w)` / `setRotationEuler(pitchX,yawY,rollZ)` | Babylon-order Euler. |
| `entity.mesh` | getter returns mesh id; setter takes a mesh id **or** a `MeshData` (auto-registers). |
| `entity.setMesh(idOrData)` / `entity.setMaterial(id)` | chainable. `setMesh` also copies the mesh AABB into the entity for culling. |
| `entity.setParent(parent \| null)` | sets `parent` index and marks the hierarchy dirty (triggers one topological re-sort on the next `evaluate`). |
| `entity.enabled` / `entity.visible` | flag bits. `enabled=false` or `visible=false` → skipped by `evaluate`. |
| `entity.alwaysActive = true` | skip the frustum test for this entity. |

Writing an out-of-range id via the raw component arrays is a silent no-op
(TypedArray OOB write); via a stale `Entity` handle after `scene.dispose()` it
writes into freed rows — don't retain handles across `dispose()`.

---

## Camera

`position` `target` `up` (tuples) · `fovY` `near` `far` `aspect` · `viewProj(aspect?)`
→ `Float32Array(16)` row-major LH.

**`camera.fit(radius)`** — sets `near`/`far` from the scene's half-extent so
hyperbolic depth stays usable. The F-009 black-screen bug was `far/near ≈
40000`; `fit()` keeps it ~60–130. Call it once after building the scene.

---

## Meshes

`box(size = 1)` · `sphere(diameter = 1, segments = 16)` · `subdivSphere(d, segments = 96)`
→ `MeshData { positions: Float32Array, indices: Uint32Array, normals?: Float32Array }`.

Bring your own: any object of that shape works. The renderer packs all registered
meshes into one vertex + one index buffer at `uploadMeshes`.

---

## Ownership & lifecycle

```
Engine  ── owns ──▶ WasmCore (1 C++ World)   ── freed by engine.dispose()
        ── owns ──▶ Renderer (GPU device+buffers) ── freed by engine.dispose()
        ── owns ──▶ Scene[]                    ── data lives in the shared World

Scene   ── owns ──▶ Entity[] handles          ── plain JS, GC'd
        ── owns ──▶ mesh registry (id → MeshData + AABB)
```

* **One `WasmCore` per `Engine`.** Scenes are views onto it; `scene.dispose()`
  only resets the entity count.
* **No `GC` for WASM/GPU.** `engine.dispose()` is required to free them; there
  are no finalizers.
* **Component views** (`engine.core.components.pos` …) are `TypedArray`s over
  WASM memory. They are replaced when the entity capacity grows
  (`createEntities` past the current capacity) — always index
  `engine.core.components.pos` fresh, don't cache the array.
* **`FrameResult`** typed arrays (`instanceWorld`, `visibleIds`) are views valid
  only until the next `evaluate()` — copy if you need to keep them.
