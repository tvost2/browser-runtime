// WasmCore — the ONLY module that talks to engine.wasm.
//
// It owns the C++ `World` and exposes its SoA component arrays as typed-array
// VIEWS over WASM linear memory. Callers write into those views directly (no
// copies, no per-entity calls), then call `evaluate()` once per frame.
//
// Memory growth: ALLOW_MEMORY_GROWTH replaces Module.HEAP* on growth, but only
// `resize()` can grow the heap here, so views are refreshed right after it.

import { STRIDE, CullStrategy, type FrameResult, type RenderBatch } from "../../shared/layout.js";
import { loadEngineModule } from "./module.js";

type EmModule = {
  HEAPF32: Float32Array; HEAPU32: Uint32Array; HEAP32: Int32Array; HEAPU8: Uint8Array;
  World: new () => WasmWorld;
};
interface WasmWorld {
  resize(n: number): void;
  setCount(n: number): void;
  posPtr(): number; rotPtr(): number; scalePtr(): number; parentPtr(): number;
  localMinPtr(): number; localMaxPtr(): number;
  meshIdPtr(): number; materialIdPtr(): number; flagsPtr(): number; dirtyPtr(): number; viewProjPtr(): number;
  markAllDirty(): void;
  evaluate(strategy: number, sortByMesh: boolean, hierarchyDirty: boolean): number;
  visibleIdPtr(): number; instanceWorldPtr(): number; instanceMeshIdPtr(): number;
  batchesPtr(): number; batchCount(): number;
  worldMatricesPtr(): number; worldSpherePtr(): number; worldMinPtr(): number; worldMaxPtr(): number;
  sVisible(): number; sTraversed(): number; sCulledDisabled(): number;
  sCulledFrustum(): number; sBatches(): number; sHierRebuilds(): number;
  sTransformsRecomputed(): number; sFrameChanged(): number;
}

export interface CoreComponents {
  pos: Float32Array; rot: Float32Array; scale: Float32Array;
  parent: Int32Array;
  localMin: Float32Array; localMax: Float32Array;
  meshId: Uint32Array; materialId: Uint32Array; flags: Uint32Array;
  /** 1 = this entity's local transform (or localMin/Max) changed — set by Transform setters */
  dirty: Uint8Array;
}

export class WasmCore {
  private mod!: EmModule;
  private world!: WasmWorld;
  private capacity = 0;
  private _count = 0;
  private viewProj!: Float32Array;

  readonly components = {} as CoreComponents;
  initMs = 0;

  static async create(wasmUrl?: string): Promise<WasmCore> {
    const t0 = performance.now();
    const c = new WasmCore();
    c.mod = await loadEngineModule(wasmUrl) as unknown as EmModule;
    c.world = new c.mod.World();
    c.initMs = performance.now() - t0;
    return c;
  }

  get count() { return this._count; }
  get capacityEntities() { return this.capacity; }
  /** total WASM linear memory in bytes (grows with ALLOW_MEMORY_GROWTH) */
  get heapBytes() { return this.mod.HEAPU8.buffer.byteLength; }

  private _hierarchyDirty = true;

  /** Grow storage if needed and set the live entity count. Cheap when capacity suffices. */
  setCount(n: number) {
    if (n > this.capacity) {
      // grow with headroom to avoid frequent reallocation
      this.capacity = Math.max(n, Math.ceil(this.capacity * 1.5), 256);
      this.world.resize(this.capacity);
      this.refreshComponentViews();
    }
    this._count = n;
    this.world.setCount(n);
    this._hierarchyDirty = true;
  }

  /** JS-side flag — NOT a WASM call. Per-entity setParent() during scene build
   *  costs zero boundary crossings; the flag rides into evaluate(). */
  markHierarchyDirty() { this._hierarchyDirty = true; }

  private refreshComponentViews() {
    const m = this.mod, w = this.world, cap = this.capacity;
    const f32 = (ptr: number, len: number) => new Float32Array(m.HEAPF32.buffer, ptr, len);
    const i32 = (ptr: number, len: number) => new Int32Array(m.HEAP32.buffer, ptr, len);
    const u32 = (ptr: number, len: number) => new Uint32Array(m.HEAPU32.buffer, ptr, len);
    const C = this.components;
    C.pos = f32(w.posPtr(), cap * STRIDE.pos);
    C.rot = f32(w.rotPtr(), cap * STRIDE.rot);
    C.scale = f32(w.scalePtr(), cap * STRIDE.scale);
    C.parent = i32(w.parentPtr(), cap * STRIDE.parent);
    C.localMin = f32(w.localMinPtr(), cap * STRIDE.localMin);
    C.localMax = f32(w.localMaxPtr(), cap * STRIDE.localMax);
    C.meshId = u32(w.meshIdPtr(), cap * STRIDE.meshId);
    C.materialId = u32(w.materialIdPtr(), cap * STRIDE.materialId);
    C.flags = u32(w.flagsPtr(), cap * STRIDE.flags);
    C.dirty = new Uint8Array(m.HEAPU8.buffer, w.dirtyPtr(), cap);
    this.viewProj = f32(w.viewProjPtr(), 16);
  }

  /** All-entity world-space AABB (min, max). Views over WASM memory; valid until
   *  the next evaluate()/resize(). For the spatial index / physics sync / debug. */
  worldBounds(): { min: Float32Array; max: Float32Array } {
    const m = this.mod, w = this.world;
    return {
      min: new Float32Array(m.HEAPF32.buffer, w.worldMinPtr(), this._count * 3),
      max: new Float32Array(m.HEAPF32.buffer, w.worldMaxPtr(), this._count * 3),
    };
  }

  writeViewProj(m16: Float32Array) { this.viewProj.set(m16); }

  /** One boundary crossing. Returns views over WASM memory — valid until next call. */
  evaluate(strategy: CullStrategy = CullStrategy.Standard, sortByMesh = true): FrameResult {
    const w = this.world, m = this.mod;
    const visible = w.evaluate(strategy, sortByMesh, this._hierarchyDirty);
    this._hierarchyDirty = false;

    const bc = w.batchCount();
    const braw = new Uint32Array(m.HEAPU32.buffer, w.batchesPtr(), bc * STRIDE.batch);
    const batches: RenderBatch[] = new Array(bc);
    for (let b = 0; b < bc; b++)
      batches[b] = { meshId: braw[b * 3], firstInstance: braw[b * 3 + 1], instanceCount: braw[b * 3 + 2] };

    return {
      visibleCount: visible,
      visibleIds: new Uint32Array(m.HEAPU32.buffer, w.visibleIdPtr(), visible),
      instanceWorld: new Float32Array(m.HEAPF32.buffer, w.instanceWorldPtr(), visible * STRIDE.worldMatrix),
      instanceMeshId: new Uint32Array(m.HEAPU32.buffer, w.instanceMeshIdPtr(), visible),
      batches,
      stats: {
        visible: w.sVisible(), traversed: w.sTraversed(),
        culledDisabled: w.sCulledDisabled(), culledFrustum: w.sCulledFrustum(),
        batches: w.sBatches(), hierarchyRebuilds: w.sHierRebuilds(),
        transformsRecomputed: w.sTransformsRecomputed(), frameChanged: w.sFrameChanged(),
      },
    };
  }

  /** Mark every entity's transform dirty — forces a full recompute next
   *  evaluate(). Use after a bulk write that bypassed the Transform setters. */
  markAllDirty() { this.world.markAllDirty(); }

  /** All-entity world matrices (not just visible) — for gizmos, physics sync, debug. */
  worldMatrices(): Float32Array {
    return new Float32Array(this.mod.HEAPF32.buffer, this.world.worldMatricesPtr(), this._count * STRIDE.worldMatrix);
  }

  /** Free the C++ World. The core (and any component views) are invalid after. */
  dispose() {
    // embind objects must be explicitly freed — no finalizer.
    (this.world as unknown as { delete(): void }).delete();
  }
}
