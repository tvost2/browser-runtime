// Entity — a thin, ergonomic handle over a row of the SoA store. It holds no
// data itself: every property reads/writes the shared typed arrays in WASM
// linear memory. Creating one is cheap (three small view objects) and happens
// at scene-build time, never per frame.

import type { Scene, MeshData } from "./Scene.js";
import { STRIDE, FLAG } from "../../shared/layout.js";

class ComponentVec3 {
  constructor(private arr: () => Float32Array, private base: number, private touch: () => void) {}
  get x() { return this.arr()[this.base]; }
  set x(v: number) { this.arr()[this.base] = v; this.touch(); }
  get y() { return this.arr()[this.base + 1]; }
  set y(v: number) { this.arr()[this.base + 1] = v; this.touch(); }
  get z() { return this.arr()[this.base + 2]; }
  set z(v: number) { this.arr()[this.base + 2] = v; this.touch(); }
  set(x: number, y: number, z: number): this {
    const a = this.arr(); a[this.base] = x; a[this.base + 1] = y; a[this.base + 2] = z; this.touch(); return this;
  }
  copyFromFloats = this.set;
}

export class Transform {
  readonly position: ComponentVec3;
  readonly scaling: ComponentVec3;

  /** flag this entity's transform dirty so evaluate() recomputes its subtree */
  private touch = () => { this.scene._core.components.dirty[this.id] = 1; };

  constructor(private scene: Scene, readonly id: number) {
    const C = scene._core.components;
    this.position = new ComponentVec3(() => C.pos, id * STRIDE.pos, this.touch);
    this.scaling = new ComponentVec3(() => C.scale, id * STRIDE.scale, this.touch);
    this.scaling.set(1, 1, 1);
  }

  /** quaternion (x,y,z,w) */
  setRotationQuaternion(x: number, y: number, z: number, w: number): this {
    const r = this.scene._core.components.rot, b = this.id * STRIDE.rot;
    r[b] = x; r[b + 1] = y; r[b + 2] = z; r[b + 3] = w;
    this.touch();
    return this;
  }
  /** Babylon-order Euler (pitch X, yaw Y, roll Z) */
  setRotationEuler(pitchX: number, yawY: number, rollZ: number): this {
    const hr = rollZ * 0.5, hp = pitchX * 0.5, hy = yawY * 0.5;
    const sr = Math.sin(hr), cr = Math.cos(hr), sp = Math.sin(hp), cp = Math.cos(hp), sy = Math.sin(hy), cy = Math.cos(hy);
    return this.setRotationQuaternion(
      cy * sp * cr + sy * cp * sr,
      sy * cp * cr - cy * sp * sr,
      cy * cp * sr - sy * sp * cr,
      cy * cp * cr + sy * sp * sr,
    );
  }
}

export class Entity {
  readonly transform: Transform;

  constructor(readonly scene: Scene, readonly id: number) {
    this.transform = new Transform(scene, id);
  }

  private flag(bit: number, on: boolean) {
    const f = this.scene._core.components.flags;
    if (on) f[this.id] |= bit; else f[this.id] &= ~bit;
  }
  get enabled() { return !!(this.scene._core.components.flags[this.id] & FLAG.ENABLED); }
  set enabled(v: boolean) { this.flag(FLAG.ENABLED, v); }
  get visible() { return !!(this.scene._core.components.flags[this.id] & FLAG.VISIBLE); }
  set visible(v: boolean) { this.flag(FLAG.VISIBLE, v); }
  /** skip frustum culling for this entity */
  set alwaysActive(v: boolean) { this.flag(FLAG.ALWAYS_ACTIVE, v); }

  setMesh(mesh: number | MeshData): this {
    const meshId = typeof mesh === "number" ? mesh : this.scene.registerMesh(mesh);
    const C = this.scene._core.components;
    C.meshId[this.id] = meshId;
    const b = this.scene._meshBounds.get(meshId);
    if (b) {
      C.localMin.set(b.min, this.id * STRIDE.localMin);
      C.localMax.set(b.max, this.id * STRIDE.localMax);
      C.dirty[this.id] = 1; // local AABB changed → world AABB refit needed
    }
    return this;
  }
  /** ergonomic form:  entity.mesh = box();  (auto-registers + dedups) */
  set mesh(mesh: number | MeshData) { this.setMesh(mesh); }
  get mesh(): number { return this.scene._core.components.meshId[this.id]; }
  setMaterial(materialId: number): this {
    this.scene._core.components.materialId[this.id] = materialId;
    return this;
  }

  setParent(parent: Entity | null): this {
    this.scene._core.components.parent[this.id] = parent ? parent.id : -1;
    this.scene._core.markHierarchyDirty();
    return this;
  }
}
