// Minimal math for the public API. Conventions match native/include/bcpp/math.hpp
// exactly (row-major Mat4, row vectors v·M, translation at m[12..14]) so JS-side
// camera matrices feed the WASM frustum builder correctly.

export type Mat4Array = Float32Array; // length 16, row-major

export class Vec3 {
  constructor(public x = 0, public y = 0, public z = 0) {}
  set(x: number, y: number, z: number): this { this.x = x; this.y = y; this.z = z; return this; }
  copyFrom(v: Vec3): this { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  addInPlace(v: Vec3): this { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  scaleInPlace(s: number): this { this.x *= s; this.y *= s; this.z *= s; return this; }
  length(): number { return Math.hypot(this.x, this.y, this.z); }
  static Zero() { return new Vec3(0, 0, 0); }
}

export class Quat {
  constructor(public x = 0, public y = 0, public z = 0, public w = 1) {}
  set(x: number, y: number, z: number, w: number): this { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
  /** Babylon Quaternion.RotationYawPitchRoll(yaw, pitch, roll) */
  setEuler(pitchX: number, yawY: number, rollZ: number): this {
    const hr = rollZ * 0.5, hp = pitchX * 0.5, hy = yawY * 0.5;
    const sr = Math.sin(hr), cr = Math.cos(hr);
    const sp = Math.sin(hp), cp = Math.cos(hp);
    const sy = Math.sin(hy), cy = Math.cos(hy);
    this.x = cy * sp * cr + sy * cp * sr;
    this.y = sy * cp * cr - cy * sp * sr;
    this.z = cy * cp * sr - sy * sp * cr;
    this.w = cy * cp * cr + sy * sp * sr;
    return this;
  }
  static Identity() { return new Quat(0, 0, 0, 1); }
}

type V = readonly number[];
const sub = (a: V, b: V) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** view * projection, row-major, left-handed — matches Babylon LookAtLH · PerspectiveFovLH */
export function viewProjLH(
  eye: readonly [number, number, number],
  target: readonly [number, number, number],
  up: readonly [number, number, number],
  fovY: number, aspect: number, near: number, far: number,
  out: Mat4Array = new Float32Array(16),
): Mat4Array {
  const z = norm(sub(target, eye));
  const x = norm(cross(up, z));
  const y = cross(z, x);
  const view = [
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ];
  const f = 1 / Math.tan(fovY / 2);
  const A = far / (far - near);
  const proj = [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, A, 1,
    0, 0, -near * A, 0,
  ];
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += view[r * 4 + k] * proj[k * 4 + c];
      out[r * 4 + c] = s;
    }
  return out;
}
