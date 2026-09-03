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
  Standard: 0,          // incremental linear cull — re-tests only movers when the camera is still
  BoundingSphereOnly: 1,
  None: 2,
  Bvh: 3,              // spatial-index traversal — best for a moving camera over a large scene
  Auto: 4,             // per frame: Bvh while the camera moves over a big scene, else Standard (default)
  Gpu: 5,             // transform on CPU (incremental), cull + compaction + draw-args on a compute shader
} as const;
export type CullStrategy = (typeof CullStrategy)[keyof typeof CullStrategy];

export const STRIDE_EXTRA = {
  dirty: 1,       // u8 — 1 = local transform changed since last evaluate()
  worldMin: 3,    // f32
  worldMax: 3,    // f32
} as const;

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
  /** entities whose world matrix was (re)computed this frame — 0 = fully static frame */
  transformsRecomputed: number;
  /** 0 = nothing moved and the camera is unchanged; the render list was reused verbatim */
  frameChanged: number;
  /** 1 = the spatial index was rebuilt this frame (CullStrategy.Bvh); 0 = refit or reused */
  bvhBuilds: number;
  bvhNodes: number;
  /** per-stage cost of evaluate() in microseconds (steady_clock) */
  transformUs: number;
  cullUs: number;
  listUs: number;
  /** 1 = the render list was rebuilt from scratch this frame; 0 = matrix rows patched in place */
  listRebuilt: number;
  /** instance-buffer rows whose matrix changed (when listRebuilt === 0) — for a partial GPU upload */
  dirtySlots: number;
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
  /** when the render list was NOT rebuilt (stats.listRebuilt === 0): the
   *  instanceWorld rows whose matrix changed — the renderer patches just those.
   *  null when a full rebuild happened. */
  dirtySlots: Uint32Array | null;
  stats: EvalStats;
}
