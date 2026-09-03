// JsBackend — hand-written, optimised JavaScript implementation of the SAME
// per-frame kernel as native/include/bcpp/world.hpp. Flat typed arrays, no
// per-node objects, no allocation in the hot loop.
//
// The honest "JavaScript" side of the comparison: NOT Babylon's OO path (that
// is measured separately by bench/profile-pipeline.mjs), but the best a
// competent JS author would write for this task. If C++/WASM can't beat THIS,
// the boundary isn't worth crossing. See web/backend/README.md.

const F = Math.fround;

export class JsBackend {
  name = "javascript";
  async init() {}

  upload(scene) {
    const n = (this.n = scene.count);
    this.parent = scene.parents;
    this.trs = scene.trs; // n*10
    this.ext = scene.extents; // n*6
    this.flags = scene.flags; // n
    this.world = new Float32Array(n * 16);
    this.visibleIds = new Uint32Array(n);
    this.visibleWorld = new Float32Array(n * 16);
    this._scratchLocal = new Float32Array(16);
  }

  updateTransforms(indices, trs) {
    if (indices === null) {
      this.trs.set(trs);
    } else {
      for (let k = 0; k < indices.length; k++) {
        const i = indices[k];
        this.trs.set(trs.subarray(k * 10, k * 10 + 10), i * 10);
      }
    }
  }

  evaluateFrame(vp, strategy = 0) {
    const n = this.n, trs = this.trs, ext = this.ext, flags = this.flags;
    const parent = this.parent, world = this.world;
    const vId = this.visibleIds, vW = this.visibleWorld;
    const L = this._scratchLocal;

    // frustum planes from viewProj (Babylon order: near,far,left,right,top,bottom)
    const pl = this._planes || (this._planes = new Float32Array(24));
    setPlane(pl, 0, vp[3] + vp[2], vp[7] + vp[6], vp[11] + vp[10], vp[15] + vp[14]);
    setPlane(pl, 1, vp[3] - vp[2], vp[7] - vp[6], vp[11] - vp[10], vp[15] - vp[14]);
    setPlane(pl, 2, vp[3] + vp[0], vp[7] + vp[4], vp[11] + vp[8], vp[15] + vp[12]);
    setPlane(pl, 3, vp[3] - vp[0], vp[7] - vp[4], vp[11] - vp[8], vp[15] - vp[12]);
    setPlane(pl, 4, vp[3] - vp[1], vp[7] - vp[5], vp[11] - vp[9], vp[15] - vp[13]);
    setPlane(pl, 5, vp[3] + vp[1], vp[7] + vp[5], vp[11] + vp[9], vp[15] + vp[13]);

    let vis = 0, tested = 0, culledFlags = 0, culledFrustum = 0;

    for (let i = 0; i < n; i++) {
      const b = i * 10;
      // normalize quaternion (Babylon composes with it as-is; fixtures pre-normalize)
      let qx = trs[b + 3], qy = trs[b + 4], qz = trs[b + 5], qw = trs[b + 6];
      const ql = Math.hypot(qx, qy, qz, qw) || 1;
      qx /= ql; qy /= ql; qz /= ql; qw /= ql;
      compose(L, trs[b + 7], trs[b + 8], trs[b + 9], qx, qy, qz, qw, trs[b], trs[b + 1], trs[b + 2]);

      const w = i * 16;
      const p = parent[i];
      if (p < 0) { for (let k = 0; k < 16; k++) world[w + k] = L[k]; }
      else multiply(world, w, L, 0, world, p * 16);

      // world AABB from 8 local corners
      const e = i * 6;
      let mnx = 1e30, mny = 1e30, mnz = 1e30, mxx = -1e30, mxy = -1e30, mxz = -1e30;
      for (let c = 0; c < 8; c++) {
        const lx = (c & 1) ? ext[e + 3] : ext[e], ly = (c & 2) ? ext[e + 4] : ext[e + 1], lz = (c & 4) ? ext[e + 5] : ext[e + 2];
        const rw = 1 / (lx * world[w + 3] + ly * world[w + 7] + lz * world[w + 11] + world[w + 15]);
        const X = (lx * world[w] + ly * world[w + 4] + lz * world[w + 8] + world[w + 12]) * rw;
        const Y = (lx * world[w + 1] + ly * world[w + 5] + lz * world[w + 9] + world[w + 13]) * rw;
        const Z = (lx * world[w + 2] + ly * world[w + 6] + lz * world[w + 10] + world[w + 14]) * rw;
        if (X < mnx) mnx = X; if (Y < mny) mny = Y; if (Z < mnz) mnz = Z;
        if (X > mxx) mxx = X; if (Y > mxy) mxy = Y; if (Z > mxz) mxz = Z;
      }
      const cx = (mnx + mxx) * 0.5, cy = (mny + mxy) * 0.5, cz = (mnz + mxz) * 0.5;
      const rad = Math.hypot((mxx - mnx) * 0.5, (mxy - mny) * 0.5, (mxz - mnz) * 0.5);

      const fl = flags[i];
      if ((fl & 1) === 0 || (fl & 2) === 0) { culledFlags++; continue; }
      tested++;

      if ((fl & 4) === 0) {
        let inside = true;
        for (let k = 0; k < 6; k++) {
          if (pl[k * 4] * cx + pl[k * 4 + 1] * cy + pl[k * 4 + 2] * cz + pl[k * 4 + 3] <= -rad) { inside = false; break; }
        }
        if (inside && strategy === 0) inside = boxIn(pl, mnx, mny, mnz, mxx, mxy, mxz);
        if (!inside) { culledFrustum++; continue; }
      }
      vId[vis] = i;
      vW.set(world.subarray(w, w + 16), vis * 16);
      vis++;
    }

    this._result = {
      visibleCount: vis,
      visibleIds: vId.subarray(0, vis),
      visibleWorld: vW.subarray(0, vis * 16),
      stats: { tested, culledByFlags: culledFlags, culledByFrustum: culledFrustum },
    };
    return this._result;
  }

  dispose() {}
}

function setPlane(pl, i, nx, ny, nz, d) {
  const inv = 1 / (Math.hypot(nx, ny, nz) || 1);
  pl[i * 4] = nx * inv; pl[i * 4 + 1] = ny * inv; pl[i * 4 + 2] = nz * inv; pl[i * 4 + 3] = d * inv;
}

function boxIn(pl, mnx, mny, mnz, mxx, mxy, mxz) {
  for (let p = 0; p < 6; p++) {
    const a = pl[p * 4], bb = pl[p * 4 + 1], cc = pl[p * 4 + 2], dd = pl[p * 4 + 3];
    let canFalse = true;
    for (let c = 0; c < 8; c++) {
      const x = (c & 1) ? mxx : mnx, y = (c & 2) ? mxy : mny, z = (c & 4) ? mxz : mnz;
      if (a * x + bb * y + cc * z + dd >= 0) { canFalse = false; break; }
    }
    if (canFalse) return false;
  }
  return true;
}

// Babylon ComposeToRef
function compose(m, sx, sy, sz, x, y, z, w, tx, ty, tz) {
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  m[0] = (1 - (yy + zz)) * sx; m[1] = (xy + wz) * sx; m[2] = (xz - wy) * sx; m[3] = 0;
  m[4] = (xy - wz) * sy; m[5] = (1 - (xx + zz)) * sy; m[6] = (yz + wx) * sy; m[7] = 0;
  m[8] = (xz + wy) * sz; m[9] = (yz - wx) * sz; m[10] = (1 - (xx + yy)) * sz; m[11] = 0;
  m[12] = tx; m[13] = ty; m[14] = tz; m[15] = 1;
}

// out[oo..] = a[aa..] * b[bb..]  (Babylon MultiplyMatricesToArray)
function multiply(out, oo, a, aa, b, bb) {
  const t0 = a[aa], t1 = a[aa + 1], t2 = a[aa + 2], t3 = a[aa + 3];
  const t4 = a[aa + 4], t5 = a[aa + 5], t6 = a[aa + 6], t7 = a[aa + 7];
  const t8 = a[aa + 8], t9 = a[aa + 9], t10 = a[aa + 10], t11 = a[aa + 11];
  const t12 = a[aa + 12], t13 = a[aa + 13], t14 = a[aa + 14], t15 = a[aa + 15];
  const o0 = b[bb], o1 = b[bb + 1], o2 = b[bb + 2], o3 = b[bb + 3];
  const o4 = b[bb + 4], o5 = b[bb + 5], o6 = b[bb + 6], o7 = b[bb + 7];
  const o8 = b[bb + 8], o9 = b[bb + 9], o10 = b[bb + 10], o11 = b[bb + 11];
  const o12 = b[bb + 12], o13 = b[bb + 13], o14 = b[bb + 14], o15 = b[bb + 15];
  out[oo] = t0 * o0 + t1 * o4 + t2 * o8 + t3 * o12;
  out[oo + 1] = t0 * o1 + t1 * o5 + t2 * o9 + t3 * o13;
  out[oo + 2] = t0 * o2 + t1 * o6 + t2 * o10 + t3 * o14;
  out[oo + 3] = t0 * o3 + t1 * o7 + t2 * o11 + t3 * o15;
  out[oo + 4] = t4 * o0 + t5 * o4 + t6 * o8 + t7 * o12;
  out[oo + 5] = t4 * o1 + t5 * o5 + t6 * o9 + t7 * o13;
  out[oo + 6] = t4 * o2 + t5 * o6 + t6 * o10 + t7 * o14;
  out[oo + 7] = t4 * o3 + t5 * o7 + t6 * o11 + t7 * o15;
  out[oo + 8] = t8 * o0 + t9 * o4 + t10 * o8 + t11 * o12;
  out[oo + 9] = t8 * o1 + t9 * o5 + t10 * o9 + t11 * o13;
  out[oo + 10] = t8 * o2 + t9 * o6 + t10 * o10 + t11 * o14;
  out[oo + 11] = t8 * o3 + t9 * o7 + t10 * o11 + t11 * o15;
  out[oo + 12] = t12 * o0 + t13 * o4 + t14 * o8 + t15 * o12;
  out[oo + 13] = t12 * o1 + t13 * o5 + t14 * o9 + t15 * o13;
  out[oo + 14] = t12 * o2 + t13 * o6 + t14 * o10 + t15 * o14;
  out[oo + 15] = t12 * o3 + t13 * o7 + t14 * o11 + t15 * o15;
}
