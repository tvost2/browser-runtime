// Harness for the chunk-merge benchmark. A field of N unique small meshes
// (jittered boxes). Two modes:
//   ?merge=0  — N entities, N meshes → N draw buckets (the baseline)
//   ?merge=1  — group by a spatial grid, C++ bakes each cell into one mesh →
//               ~cells draw buckets, per-vertex source id preserved
//
//   chunk-merge.html?count=3000&merge=1&cell=120&strategy=0
//     strategy: 0 Standard (default) · 5 Gpu

import { Engine, box, mergeMeshes, groupByCell } from "../dist/engine.js";

const qs = new URLSearchParams(location.search);
const COUNT = Number(qs.get("count") || 3000);
const MERGE = qs.get("merge") === "1";
const CELL = Number(qs.get("cell") || 120);
const STRAT = Number(qs.get("strategy") ?? 0);

function jbox(seed) {
  const b = box(1);
  const p = b.positions.slice();
  let s = (seed * 2654435761) >>> 0;
  for (let i = 0; i < p.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; p[i] += (s / 2 ** 32 - 0.5) * 0.08; }
  return { positions: p, normals: b.normals ? b.normals.slice() : null, indices: b.indices.slice() };
}

// Babylon Matrix.Compose(scale, quat, translation) — row-major, mirrors math.hpp
function composeBabylon(sx, sy, sz, qx, qy, qz, qw, tx, ty, tz) {
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return new Float32Array([
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ]);
}

const R = ((s) => () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)(0xC0FFEE + COUNT);
const spread = Math.cbrt(COUNT) * 42;

// per-source geometry + transform (identical in both modes)
const src = [];
const centers = new Float32Array(COUNT * 3);
for (let i = 0; i < COUNT; i++) {
  const g = jbox(i + 1);
  const px = (R() - 0.5) * spread, py = (R() - 0.5) * spread * 0.25, pz = (R() - 0.5) * spread;
  const sc = 0.6 + R() * 1.6;
  const ry = R() * 6.2832;
  const qy = Math.sin(ry / 2), qw = Math.cos(ry / 2);
  centers[i * 3] = px; centers[i * 3 + 1] = py; centers[i * 3 + 2] = pz;
  src.push({ g, px, py, pz, sc, qy, qw, world: composeBabylon(sc, sc, sc, 0, qy, 0, qw, px, py, pz) });
}

const canvas = document.getElementById("c");
const hud = document.getElementById("hud");
canvas.width = 1280; canvas.height = 720;

const engine = await Engine.create(canvas);
const scene = engine.createScene();
scene.cullStrategy = STRAT;

let mergeMs = 0, buckets = 0, srcVerts = 0, mrgVerts = 0, srcTris = 0, mrgTris = 0;
for (const s of src) { srcVerts += s.g.positions.length / 3; srcTris += s.g.indices.length / 3; }

if (!MERGE) {
  const ids = src.map((s) => scene.registerMesh(s.g));
  scene.createEntities(COUNT, (e, i) => {
    const s = src[i];
    e.setMesh(ids[i]);
    e.transform.position.set(s.px, s.py, s.pz);
    e.transform.scaling.set(s.sc, s.sc, s.sc);
    e.transform.setRotationQuaternion(0, s.qy, 0, s.qw);
  });
  buckets = COUNT;
} else {
  const groups = groupByCell(centers, CELL);
  const t0 = performance.now();
  const merged = [];
  for (const grp of groups) {
    const sources = grp.map((i) => ({
      positions: src[i].g.positions, normals: src[i].g.normals, indices: src[i].g.indices,
      world: src[i].world, id: i,
    }));
    merged.push(await mergeMeshes(sources));
  }
  mergeMs = performance.now() - t0;
  buckets = merged.length;
  for (const m of merged) { mrgVerts += m.vertexCount; mrgTris += m.indexCount / 3; }

  const ids = merged.map((m) => scene.registerMesh(m.mesh));
  scene.createEntities(merged.length, (e, i) => { e.setMesh(ids[i]); }); // identity — geometry is world-baked
  window.__merged = merged; // for the driver's pick / id check
}

scene.camera.fovY = 0.9;
scene.camera.fit(spread * 0.6);
const camRad = spread * 0.7;
let camAngle = 0;
scene.camera.position = [camRad, spread * 0.15, 0];

let scenario = "static";
engine.onBeforeRender(() => {
  scenario = window.__scenario || "static";
  if (scenario === "camera") {
    camAngle += 0.01;
    scene.camera.position = [Math.cos(camAngle) * camRad, spread * 0.15, Math.sin(camAngle) * camRad];
  }
});

const acc = { cpu: [], gpu: [] };
let a = 0, n = 0;
function frame() {
  const st = engine.renderOnce();
  acc.cpu.push(st.cpuFrameMs); acc.gpu.push(st.gpuMs ?? 0);
  if (acc.cpu.length > 240) { acc.cpu.shift(); acc.gpu.shift(); }
  a += st.cpuFrameMs; n++;
  if (n >= 20) {
    hud.textContent =
      `count ${COUNT.toLocaleString()}   ${MERGE ? `MERGE cell=${CELL}` : "no merge"}   strat ${STRAT}\n` +
      `draw buckets ${st.drawCalls}   entities ${engine.core.count}\n` +
      `cpu ${(a / n).toFixed(3)} ms   gpu ${(st.gpuMs ?? 0).toFixed(2)} ms   fps ${st.fps.toFixed(0)}\n` +
      (MERGE ? `merge ${mergeMs.toFixed(1)} ms   verts ${srcVerts}→${mrgVerts}   tris ${srcTris}→${mrgTris}\n` : `verts ${srcVerts}   tris ${srcTris}\n`) +
      `wasm heap ${st.wasmHeapMB.toFixed(1)} MB`;
    a = 0; n = 0;
  }
  requestAnimationFrame(frame);
}
frame();

const med = (arr) => { const s = [...arr].sort((x, y) => x - y); return s[s.length >> 1] ?? 0; };
window.__bench = {
  engine, scene,
  reset() { acc.cpu.length = 0; acc.gpu.length = 0; },
  result() {
    return {
      count: COUNT, merge: MERGE, cell: CELL, strat: STRAT,
      drawBuckets: engine.renderer.drawCalls,
      entities: engine.core.count,
      cpuFrameMs: med(acc.cpu), gpuMs: med(acc.gpu), fps: 1000 / med(acc.cpu),
      mergeMs, buckets, srcVerts, mrgVerts, srcTris, mrgTris,
      wasmHeapMB: engine.stats.wasmHeapMB,
    };
  },
  // pick correctness: project each source centroid to screen, pick there, and
  // check the id-buffer resolves to a real building (exact when unoccluded).
  async pick() {
    if (!MERGE) return { ok: true, note: "baseline (meshes carry no pick id)" };
    const W = canvas.width, H = canvas.height;
    const vp = scene.camera.viewProj(W / H);
    const project = (x, y, z) => {
      const cx = x * vp[0] + y * vp[4] + z * vp[8] + vp[12];
      const cy = x * vp[1] + y * vp[5] + z * vp[9] + vp[13];
      const cw = x * vp[3] + y * vp[7] + z * vp[11] + vp[15];
      if (cw <= 0) return null;
      return [(cx / cw * 0.5 + 0.5) * W, (1 - (cy / cw * 0.5 + 0.5)) * H];
    };
    let tried = 0, hit = 0, exact = 0;
    const step = Math.max(1, (COUNT / 80) | 0);
    for (let k = 0; k < COUNT && tried < 80; k += step) {
      const sp = project(centers[k * 3], centers[k * 3 + 1], centers[k * 3 + 2]);
      if (!sp || sp[0] < 2 || sp[0] >= W - 2 || sp[1] < 2 || sp[1] >= H - 2) continue;
      tried++;
      const id = await engine.pickAt(sp[0], sp[1]);
      if (id >= 0 && id < COUNT) hit++;
      if (id === k) exact++;
    }
    return { ok: tried > 10 && hit / tried > 0.75 && exact / tried > 0.35, tried, hit, exact };
  },
  // correctness: merged geometry conserves triangle count + world AABB, and
  // every merged vertex id maps back to a real source item.
  check() {
    if (!MERGE) return { ok: true, note: "baseline" };
    const merged = window.__merged;
    let vSum = 0, iSum = 0, idOk = true, idMin = Infinity, idMax = -Infinity;
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (const m of merged) {
      vSum += m.vertexCount; iSum += m.indexCount;
      for (const id of m.vertexId) { if (id < 0 || id >= COUNT) idOk = false; idMin = Math.min(idMin, id); idMax = Math.max(idMax, id); }
      const p = m.mesh.positions;
      for (let i = 0; i < p.length; i += 3) {
        mnx = Math.min(mnx, p[i]); mxx = Math.max(mxx, p[i]);
        mny = Math.min(mny, p[i + 1]); mxy = Math.max(mxy, p[i + 1]);
        mnz = Math.min(mnz, p[i + 2]); mxz = Math.max(mxz, p[i + 2]);
      }
    }
    // reference world AABB from source geometry × its transform
    let rnx = Infinity, rny = Infinity, rnz = Infinity, rxx = -Infinity, rxy = -Infinity, rxz = -Infinity;
    for (const s of src) {
      const w = s.world, p = s.g.positions;
      for (let i = 0; i < p.length; i += 3) {
        const x = p[i], y = p[i + 1], z = p[i + 2];
        const wx = x * w[0] + y * w[4] + z * w[8] + w[12];
        const wy = x * w[1] + y * w[5] + z * w[9] + w[13];
        const wz = x * w[2] + y * w[6] + z * w[10] + w[14];
        rnx = Math.min(rnx, wx); rxx = Math.max(rxx, wx);
        rny = Math.min(rny, wy); rxy = Math.max(rxy, wy);
        rnz = Math.min(rnz, wz); rxz = Math.max(rxz, wz);
      }
    }
    const near = (a, b) => Math.abs(a - b) < 1e-2 * (1 + Math.abs(b));
    const aabbOk = near(mnx, rnx) && near(mny, rny) && near(mnz, rnz) && near(mxx, rxx) && near(mxy, rxy) && near(mxz, rxz);
    return {
      ok: vSum === srcVerts && iSum === srcTris * 3 && idOk && aabbOk,
      vSum, srcVerts, iSum, srcI: srcTris * 3, idOk, idMin, idMax, aabbOk,
    };
  },
};
window.__ready = true;
