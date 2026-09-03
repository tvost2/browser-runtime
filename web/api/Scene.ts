import { WasmCore } from "../bindings/WasmCore.js";
import { Entity } from "./Entity.js";
import { Camera } from "./Camera.js";
import { CullStrategy, FLAG, type FrameResult } from "../../shared/layout.js";

export interface MeshData {
  positions: Float32Array; // xyz
  indices: Uint32Array;
  normals?: Float32Array;
}

/** A scene = one WASM `World` + a mesh registry + a camera. Entities are dense
 *  ids [0, count). Deletion is not yet implemented (append-only) — measured
 *  decision: the demo/benchmark workloads build once. */
export class Scene {
  readonly camera = new Camera();
  cullStrategy = CullStrategy.Standard;
  sortByMesh = true;

  /** @internal */ _core: WasmCore;
  /** @internal */ _meshBounds = new Map<number, { min: Float32Array; max: Float32Array }>();
  /** @internal */ _meshData = new Map<number, MeshData>();
  /** @internal set by Engine when the renderer has uploaded the current mesh set */
  _meshesDirty = true;
  private _meshByData = new Map<MeshData, number>();
  private _nextMeshId = 0;
  private _entities: Entity[] = [];

  /** @internal */
  constructor(core: WasmCore) { this._core = core; }

  /** Register geometry. Returns a stable mesh id; calling again with the same
   *  MeshData object returns the same id (dedup). The renderer uploads the
   *  vertex/index data once; the core only keeps the AABB for culling. */
  registerMesh(data: MeshData): number {
    const existing = this._meshByData.get(data);
    if (existing !== undefined) return existing;
    const id = this._nextMeshId++;
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    const p = data.positions;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i] < mnx) mnx = p[i]; if (p[i] > mxx) mxx = p[i];
      if (p[i + 1] < mny) mny = p[i + 1]; if (p[i + 1] > mxy) mxy = p[i + 1];
      if (p[i + 2] < mnz) mnz = p[i + 2]; if (p[i + 2] > mxz) mxz = p[i + 2];
    }
    this._meshBounds.set(id, { min: Float32Array.of(mnx, mny, mnz), max: Float32Array.of(mxx, mxy, mxz) });
    this._meshData.set(id, data);
    this._meshByData.set(data, id);
    this._meshesDirty = true;
    return id;
  }

  createEntity(): Entity {
    const id = this._entities.length;
    this._core.setCount(id + 1);
    this._core.components.flags[id] = FLAG.ENABLED | FLAG.VISIBLE;
    this._core.components.parent[id] = -1;
    const e = new Entity(this, id);
    this._entities.push(e);
    return e;
  }

  /** Bulk-create — the fast path for large scenes. `fill(entity, i)` runs once
   *  per entity with the SoA rows already allocated. */
  createEntities(n: number, fill?: (e: Entity, i: number) => void): Entity[] {
    const start = this._entities.length;
    this._core.setCount(start + n);
    const out: Entity[] = [];
    for (let i = 0; i < n; i++) {
      const id = start + i;
      this._core.components.flags[id] = FLAG.ENABLED | FLAG.VISIBLE;
      this._core.components.parent[id] = -1;
      this._core.components.scale[id * 3] = this._core.components.scale[id * 3 + 1] = this._core.components.scale[id * 3 + 2] = 1;
      this._core.components.rot[id * 4 + 3] = 1;
      const e = new Entity(this, id);
      this._entities.push(e);
      out.push(e);
      fill?.(e, i);
    }
    this._core.markHierarchyDirty();
    return out;
  }

  get entityCount() { return this._entities.length; }

  /** Handle for an entity id. Ids are dense (0 … entityCount-1), assigned on
   *  creation, and never recycled (there is no per-entity delete in v0.1).
   *  Returns `undefined` for an out-of-range id. */
  entity(id: number): Entity | undefined { return this._entities[id]; }

  /** Drop all entities (resets the shared World to 0). Meshes stay registered.
   *  For full teardown use `engine.dispose()`. */
  dispose() {
    this._entities.length = 0;
    this._core.setCount(0);
  }

  /** Run the whole per-frame CPU pipeline in WASM. One boundary crossing. */
  evaluate(aspect: number): FrameResult {
    this._core.writeViewProj(this.camera.viewProj(aspect));
    return this._core.evaluate(this.cullStrategy, this.sortByMesh);
  }

  private _assets?: import("../asset/AssetManager.js").AssetManager;

  /** Load a .glb / .gltf and instantiate it into this scene. Convenience over
   *  `new AssetManager().loadInto(url, scene)` (import from `web/asset`). */
  async loadAsset(url: string) {
    if (!this._assets) {
      const { AssetManager } = await import("../asset/AssetManager.js");
      this._assets = new AssetManager();
    }
    return this._assets.loadInto(url, this);
  }
}
