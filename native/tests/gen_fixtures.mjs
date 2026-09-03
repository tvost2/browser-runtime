// Emits numeric fixtures from the REAL Babylon.js implementation. The C++
// equivalence test (tests/test_equiv.cpp) reads these and must match within a
// float tolerance.
//
//   node native/tests/gen_fixtures.mjs
//
// Format: little-endian Float32 / Int32 blobs + a JSON manifest describing
// shapes. Kept dumb on purpose so the C++ side needs no JSON parser for data.

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Frustum } from "@babylonjs/core/Maths/math.frustum.js";
import { rng } from "../../bench/scenes.mjs";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
mkdirSync(dir, { recursive: true });

const r = rng(0xC0FFEE);
const rand = (a = -3, b = 3) => a + (b - a) * r();
const f32 = (arr) => Buffer.from(Float32Array.from(arr).buffer);
const i32 = (arr) => Buffer.from(Int32Array.from(arr).buffer);

const manifest = {};

// ---- 1. compose(scale, quat, translation) ----
{
  const K = 512, inp = [], out = [];
  for (let i = 0; i < K; i++) {
    const s = [Math.abs(rand(0.1, 3)), Math.abs(rand(0.1, 3)), Math.abs(rand(0.1, 3))];
    const q = Quaternion.RotationYawPitchRoll(rand(-3.1, 3.1), rand(-3.1, 3.1), rand(-3.1, 3.1)).normalize();
    const t = [rand(-50, 50), rand(-50, 50), rand(-50, 50)];
    inp.push(...s, q.x, q.y, q.z, q.w, ...t);
    const m = Matrix.Compose(new Vector3(...s), q, new Vector3(...t));
    out.push(...m.m);
  }
  writeFileSync(join(dir, "compose_in.bin"), f32(inp));
  writeFileSync(join(dir, "compose_out.bin"), f32(out));
  manifest.compose = { count: K, inStride: 10, outStride: 16 };
}

// ---- 2. multiply(a, b) = a.multiply(b) ----
{
  const K = 512, inp = [], out = [];
  const randMat = () => { const m = Matrix.Identity(); for (let j = 0; j < 16; j++) m.m[j] = rand(); m.markAsUpdated(); return m; };
  for (let i = 0; i < K; i++) {
    const a = randMat(), b = randMat();
    inp.push(...a.m, ...b.m);
    out.push(...a.multiply(b).m);
  }
  writeFileSync(join(dir, "multiply_in.bin"), f32(inp));
  writeFileSync(join(dir, "multiply_out.bin"), f32(out));
  manifest.multiply = { count: K, inStride: 32, outStride: 16 };
}

// ---- 3. frustum planes from a viewProj matrix ----
{
  const K = 128, inp = [], out = [];
  for (let i = 0; i < K; i++) {
    const view = Matrix.LookAtLH(new Vector3(rand(-20, 20), rand(-20, 20), rand(-40, -10)), new Vector3(rand(-5, 5), rand(-5, 5), 0), Vector3.Up());
    const proj = Matrix.PerspectiveFovLH(0.6 + r(), 16 / 9, 0.1, 1000);
    const vp = view.multiply(proj);
    const planes = Frustum.GetPlanes(vp);
    inp.push(...vp.m);
    for (const p of planes) out.push(p.normal.x, p.normal.y, p.normal.z, p.d);
  }
  writeFileSync(join(dir, "frustum_in.bin"), f32(inp));
  writeFileSync(join(dir, "frustum_out.bin"), f32(out));
  manifest.frustum = { count: K, inStride: 16, outStride: 24 };
}

// ---- 4. full per-frame kernel on a synthetic scene ----
{
  const NNODES = 4000;
  const parent = new Int32Array(NNODES).fill(-1);
  const trs = []; // pos3 rot4 scale3
  const ext = []; // min3 max3
  const flags = new Int32Array(NNODES);
  for (let i = 0; i < NNODES; i++) {
    if (i > 0 && r() < 0.5) parent[i] = Math.floor(r() * i); // parent index < i => topological
    trs.push(rand(-100, 100), rand(-100, 100), rand(-20, 200));
    const q = Quaternion.RotationYawPitchRoll(rand(), rand(), rand()).normalize();
    trs.push(q.x, q.y, q.z, q.w);
    const sc = Math.abs(rand(0.3, 2));
    trs.push(sc, sc, sc);
    ext.push(-0.5, -0.5, -0.5, 0.5, 0.5, 0.5);
    flags[i] = (r() < 0.95 ? 1 : 0) | (r() < 0.98 ? 2 : 0); // enabled | visible
  }
  const view = Matrix.LookAtLH(new Vector3(0, 0, -60), Vector3.Zero(), Vector3.Up());
  const proj = Matrix.PerspectiveFovLH(0.9, 16 / 9, 0.5, 2000);
  const vp = view.multiply(proj);
  const planes = Frustum.GetPlanes(vp);

  // reference: replicate Babylon world-matrix + STANDARD culling
  const world = Array.from({ length: NNODES }, () => Matrix.Identity());
  const visible = [];
  for (let i = 0; i < NNODES; i++) {
    const p = new Vector3(trs[i * 10], trs[i * 10 + 1], trs[i * 10 + 2]);
    const q = new Quaternion(trs[i * 10 + 3], trs[i * 10 + 4], trs[i * 10 + 5], trs[i * 10 + 6]);
    const s = new Vector3(trs[i * 10 + 7], trs[i * 10 + 8], trs[i * 10 + 9]);
    const local = Matrix.Compose(s, q, p);
    world[i] = parent[i] < 0 ? local : local.multiply(world[parent[i]]);
    if (!(flags[i] & 1) || !(flags[i] & 2)) continue;
    // world AABB from 8 local corners
    let mn = new Vector3(1e30, 1e30, 1e30), mx = new Vector3(-1e30, -1e30, -1e30);
    for (let c = 0; c < 8; c++) {
      const lc = new Vector3(c & 1 ? 0.5 : -0.5, c & 2 ? 0.5 : -0.5, c & 4 ? 0.5 : -0.5);
      const w = Vector3.TransformCoordinates(lc, world[i]);
      mn = Vector3.Minimize(mn, w); mx = Vector3.Maximize(mx, w);
    }
    const center = mn.add(mx).scale(0.5);
    const radius = mx.subtract(mn).scale(0.5).length();
    let inside = true;
    for (let pl = 0; pl < 6; pl++) if (planes[pl].dotCoordinate(center) <= -radius) { inside = false; break; }
    if (inside) {
      // box test (8 corners)
      const corners = [];
      for (let c = 0; c < 8; c++) corners.push(new Vector3(c & 1 ? mx.x : mn.x, c & 2 ? mx.y : mn.y, c & 4 ? mx.z : mn.z));
      for (let pl = 0; pl < 6; pl++) {
        let canFalse = true;
        for (let c = 0; c < 8; c++) if (planes[pl].dotCoordinate(corners[c]) >= 0) { canFalse = false; break; }
        if (canFalse) { inside = false; break; }
      }
    }
    if (inside) visible.push(i);
  }

  writeFileSync(join(dir, "kernel_parent.bin"), i32(parent));
  writeFileSync(join(dir, "kernel_trs.bin"), f32(trs));
  writeFileSync(join(dir, "kernel_ext.bin"), f32(ext));
  writeFileSync(join(dir, "kernel_flags.bin"), i32(flags));
  writeFileSync(join(dir, "kernel_vp.bin"), f32(Array.from(vp.m)));
  writeFileSync(join(dir, "kernel_visible.bin"), i32(visible));
  manifest.kernel = { nodes: NNODES, visibleCount: visible.length };
  console.log(`kernel fixture: ${visible.length}/${NNODES} visible`);
}

writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("fixtures written to", dir);
