// Single source of truth for the SoA memory layout shared by:
//   native/include/bcpp/world.hpp   (C++ side)
//   web/bindings/WasmCore.ts        (JS staging + readback)
//   web/backend/JsBackend.mjs
//
// If you change a stride here, change world.hpp to match — the equivalence
// tests will catch a mismatch, but keep them in sync on purpose.

export const STRIDE = {
  pos: 3,        // f32
  rot: 4,        // f32 (quat x,y,z,w)
  scale: 3,      // f32
  parent: 1,     // i32 (-1 = root)
  localMin: 3,   // f32
  localMax: 3,   // f32
  meshId: 1,     // u32
  materialId: 1, // u32
  flags: 1,      // u32
  worldMatrix: 16, // f32, row-major (Babylon layout)
  worldSphere: 4,  // f32 (xyz center, w radius)
  batch: 3,        // u32 (meshId, firstInstance, instanceCount)
} as const;

export const FLAG = {
  ENABLED: 1 << 0,
  VISIBLE: 1 << 1,
  ALWAYS_ACTIVE: 1 << 2, // skip frustum test
  CAST_SHADOW: 1 << 3,
} as const;

export const CullStrategy = {
  Standard: 0,          // sphere reject, then 8-corner box reject (Babylon default)
  BoundingSphereOnly: 1,
  None: 2,
} as const;
export type CullStrategy = (typeof CullStrategy)[keyof typeof CullStrategy];

export interface RenderBatch {
  meshId: number;
  firstInstance: number;
  instanceCount: number;
}

export interface EvalStats {
  visible: number;
  traversed: number;
  culledDisabled: number;
  culledFrustum: number;
  batches: number;
  hierarchyRebuilds: number;
}

/** Result of one World.evaluate() — all typed arrays are VIEWS over WASM/JS
 *  memory and are only valid until the next evaluate()/resize(). Copy if you
 *  need to retain. */
export interface FrameResult {
  visibleCount: number;
  visibleIds: Uint32Array;      // [visibleCount] entity ids, render order
  instanceWorld: Float32Array;  // [visibleCount*16] world matrices, batch-sorted
  instanceMeshId: Uint32Array;  // [visibleCount]
  batches: RenderBatch[];
  stats: EvalStats;
}
