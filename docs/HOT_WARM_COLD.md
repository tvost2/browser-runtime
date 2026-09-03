# HOT / WARM / COLD classification

Component list from `reference/packages/dev/core/src`. Classification is a
**hypothesis** refined by `bench/` data. "Falsification status" tracks whether
profiling has confirmed or contradicted it.

Frequency legend: **HOT** = runs O(nodes) or O(visible) every rendered frame ·
**WARM** = runs often but not per-frame (on change, on load, on interval) ·
**COLD** = rare, or cost dominated by IO / driver / string work that native
code cannot remove.

---

## HOT

| Component | Babylon location | Per-frame cost driver | Native benefit hypothesis | Falsification status |
|---|---|---|---|---|
| Vector / Matrix / Quaternion math | `Maths/math.vector.pure.ts`, `Maths/ThinMaths/*` | called from everything below | **LOW in isolation** — V8 JITs numeric code well; JS↔WASM call cost dwarfs a single op | confirmed low: `compose` alone is 8 ns/node native, not a bottleneck by itself |
| Transform / world-matrix propagation | `Meshes/transformNode.ts::computeWorldMatrix`, `scene.pure.ts::_evaluateActiveMeshes` (calls `mesh.computeWorldMatrix()` per mesh) | 1 compose + 1 matrix-multiply per node, per frame; pointer-chasing parent chain; `Tmp` vector churn | **HIGH** — linear SoA pass, parents-before-children ordering, no dispatch | **CONFIRMED**: Babylon eval = 3.7 µs/mesh; native compose+multiply = 0.05 µs/node |
| Bounding-volume world refit | `Culling/boundingInfo.ts`, `boundingBox.ts::_update`, `boundingSphere.ts::_update` | transform 8 corners + recompute sphere per mesh per frame | **HIGH** — pure arithmetic, vectorizable | CONFIRMED as arithmetic-bound (native: 0.13 µs/node for 8× transformCoord+minmax after removing a libm `fmin` stall) |
| Frustum culling | `scene.pure.ts::_evaluateActiveMeshes` → `AbstractMesh.isInFrustum` → `BoundingInfo.isInFrustum` → sphere test then 8-corner box test vs 6 planes | 6 plane · dot per mesh (sphere), up to 48 dots (box) | **HIGH** — data-parallel, SIMD 4-wide, branch-light | CONFIRMED: whole native fused kernel (transform+bounds+cull) = **2.2 ms / 7000 nodes** vs Babylon `_evaluateActiveMeshes` **25.6 ms / 7000** |
| Render-list build + dispatch | `scene.pure.ts::_evaluateActiveMeshes` tail, `Rendering/renderingManager.ts`, `_evaluateSubMesh`, `_activeMesh` | SmartArray pushes, LOD `Map` get/set, `_preActivate`/`_activate`, observer notifications, submesh dispatch, material collection | **MEDIUM** — the ~60% of eval that is *not* math; a SoA design removes the per-mesh object overhead but the output (draw list) must still cross back to JS | UNTESTED — needs stage 6-10; this is the risk area |
| Animation evaluation | `Animations/animation.ts::_interpolate`, `animatable.ts`, `scene.pure.ts` animation step | key search + lerp per animated property per frame | **LOW–MEDIUM** — cheaper than expected | **CONTRADICTED (partly)**: 2500 float animations = 0.07 ms/frame; not a bottleneck at this scale. Re-test with quaternion/matrix tracks + skeletons |
| Skeleton / bone matrices | `Bones/skeleton.ts::prepare`, `bone.ts::computeWorldMatrix` | Mat4 chain per bone per frame for skinned meshes | **HIGH** (hypothesis) — dense Mat4 chains, same shape as transform propagation | UNTESTED — no skinned scene yet (add scene 10) |
| Morph targets | `Morph/morphTargetManager.ts` | per-vertex blend when CPU-side | **MEDIUM** | UNTESTED |
| CPU particle update | `Particles/particleSystem.ts::_update` | position/color/age integration over N particles | **HIGH** (hypothesis) — large homogeneous arrays, trivial physics, SIMD-friendly | UNTESTED — add a particle scene |

## WARM

| Component | Babylon location | Benefit hypothesis | Notes |
|---|---|---|---|
| Geometry: normals / tangents | `Meshes/mesh.vertexData.ts::ComputeNormals`, `Maths/math.functions.ts` | HIGH per call, but infrequent | big flat Float32Array; ideal WASM shape, runs on mesh edit not per frame |
| `VertexData` transform / merge | `mesh.vertexData.ts::transform`, `merge` | HIGH per call | matrix-transform a vertex buffer |
| Mesh building | `Meshes/Builders/*` | MEDIUM | allocation-heavy; amortized at load |
| Octree build / refit | `Culling/Octrees/*` | MEDIUM | only if `createOrUpdateSelectionOctree` used; our scenes don't |
| Buffer packing (thin instances) | `Meshes/thinInstanceMesh.ts` | HIGH | writing instance matrices into a Float32Array — natural WASM output |
| Bounding hierarchy recompute | `AbstractMesh.refreshBoundingInfo` | HIGH per call | on geometry change |

## COLD — poor ROI, keep in JS

| Component | Why native won't help |
|---|---|
| Scene serialization / deserialization (`serialization` in `Misc/`, `SceneSerializer`) | string / JSON bound; marshaling into WASM costs more than it saves |
| glTF / OBJ / STL loaders (`Loading/`, `@babylonjs/loaders`) | IO + parsing + string bound |
| Shader / effect compilation (`Materials/effect.ts`, `Engines/`) | GPU-driver bound; not CPU |
| Texture decode / upload | browser codec + driver bound |
| Material property system, `Materials/*` config | cold setters; not per-frame hot |
| WebGPU device / pipeline / bind-group management (`Engines/WebGPU/*`) | **cannot move** — this is the graphics backend the experiment explicitly keeps; wasm would just proxy every call back to JS |
| Observers / event bus (`Misc/observable.ts`) | control-flow glue, not compute |
| Input / picking / gizmos / GUI | interaction-rate, not frame-rate-critical for the compute question |

---

## Dependency graph (HOT core)

```
math (compose, multiply, transformCoord, dot)
  └─> transform propagation ──┐
  └─> bounding world refit ────┼─> frustum culling ──> render-list build ──> [JS: submit to WebGPU]
                    camera view·proj ┘
animation ──> writes local TRS (upstream of propagation)
skeleton  ──> parallel Mat4 chain, feeds skinning
```

The first four boxes form one data-parallel pass with a single small output
(visible ids + their world matrices). That fused pass is **component #1**.
`native/` implements it; `tests/test_equiv.cpp` proves it matches Babylon
numerically (19 457 checks, 0 failures); `bench/native-ceiling.mjs` measures
its ceiling. Stage 6-10 port it to WASM and measure what survives the boundary.
