// VALIDATE (JS binding) — WasmCore.raycast / queryBox against brute force.
// The BVH algorithm itself is covered by native/tests/test_bvh.cpp; this checks
// the TS binding surface (pointer math, view lifetime, heap-growth refresh).
//
//   npm run build && node bench/run-spatial.mjs

import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const { Engine } = await import(pathToFileURL(join(__dir, "..", "web", "dist", "engine.js")).href).catch(() => ({}));
const { WasmCore } = await import(pathToFileURL(join(__dir, "..", "web", "dist", "engine.js")).href);

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d !== undefined ? ` — ${d}` : ""}`); } };

const core = await WasmCore.create();
const N = 20000;
core.setCount(N);
const C = core.components;
let s = 0xC0FFEE;
const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const box = { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] };
for (let i = 0; i < N; i++) {
  C.pos[i * 3] = (rnd() - 0.5) * 2000;
  C.pos[i * 3 + 1] = (rnd() - 0.5) * 2000;
  C.pos[i * 3 + 2] = (rnd() - 0.5) * 2000;
  C.rot[i * 4 + 3] = 1;
  const sc = 0.5 + rnd() * 3;
  C.scale[i * 3] = C.scale[i * 3 + 1] = C.scale[i * 3 + 2] = sc;
  C.localMin.set(box.min, i * 3);
  C.localMax.set(box.max, i * 3);
  C.parent[i] = -1;
  C.flags[i] = 0b011;
  C.dirty[i] = 1;
}
const vp = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.001, 1, 0, 0, 0, 1]);
core.writeViewProj(vp);
core.evaluate(3 /* Bvh */, false);

const wb = core.worldBounds();
const wmin = (i) => [wb.min[i * 3], wb.min[i * 3 + 1], wb.min[i * 3 + 2]];
const wmax = (i) => [wb.max[i * 3], wb.max[i * 3 + 1], wb.max[i * 3 + 2]];

// ---- queryBox vs brute force ----
let qFail = 0;
for (let q = 0; q < 30; q++) {
  const c = [(rnd() - 0.5) * 1600, (rnd() - 0.5) * 1600, (rnd() - 0.5) * 1600];
  const h = 40 + rnd() * 300;
  const qmn = [c[0] - h, c[1] - h, c[2] - h], qmx = [c[0] + h, c[1] + h, c[2] + h];
  const got = new Set(Array.from(core.queryBox(qmn, qmx)));
  const exp = new Set();
  for (let e = 0; e < N; e++) {
    const a = wmin(e), b = wmax(e);
    if (a[0] <= qmx[0] && b[0] >= qmn[0] && a[1] <= qmx[1] && b[1] >= qmn[1] && a[2] <= qmx[2] && b[2] >= qmn[2]) exp.add(e);
  }
  if (got.size !== exp.size || [...exp].some((x) => !got.has(x))) qFail++;
}
ok("queryBox matches brute force (30 boxes)", qFail === 0, `${qFail} mismatches`);

// ---- raycast vs brute force ----
let rFail = 0;
for (let r = 0; r < 30; r++) {
  const o = [(rnd() - 0.5) * 400, (rnd() - 0.5) * 400, -1400];
  const d = [(rnd() - 0.5) * 0.5, (rnd() - 0.5) * 0.5, 1];
  const hit = core.raycast(o, d, 1e5);
  const inv = [1 / d[0], 1 / d[1], 1 / d[2]];
  let bestT = 1e5, best = -1;
  for (let e = 0; e < N; e++) {
    const a = wmin(e), b = wmax(e);
    let t0 = (a[0] - o[0]) * inv[0], t1 = (b[0] - o[0]) * inv[0];
    let tmin = Math.min(t0, t1), tmax = Math.max(t0, t1);
    t0 = (a[1] - o[1]) * inv[1]; t1 = (b[1] - o[1]) * inv[1];
    tmin = Math.max(tmin, Math.min(t0, t1)); tmax = Math.min(tmax, Math.max(t0, t1));
    t0 = (a[2] - o[2]) * inv[2]; t1 = (b[2] - o[2]) * inv[2];
    tmin = Math.max(tmin, Math.min(t0, t1)); tmax = Math.min(tmax, Math.max(t0, t1));
    if (tmax >= tmin && tmax >= 0) { const tt = Math.max(tmin, 0); if (tt < bestT) { bestT = tt; best = e; } }
  }
  if ((hit?.id ?? -1) !== best) rFail++;
  else if (best >= 0 && Math.abs(hit.t - bestT) > 1e-2 * (1 + bestT)) rFail++;
}
ok("raycast matches nearest brute-force AABB hit (30 rays)", rFail === 0, `${rFail} mismatches`);

// ---- query result stays correct after the heap grows ----
core.setCount(N + 40000);   // force a resize / heap growth
const C2 = core.components;
for (let i = N; i < N + 40000; i++) { C2.rot[i * 4 + 3] = 1; C2.scale[i * 3] = C2.scale[i * 3 + 1] = C2.scale[i * 3 + 2] = 1; C2.parent[i] = -1; C2.flags[i] = 0b011; C2.dirty[i] = 1; C2.pos[i * 3] = 9e5; }
core.evaluate(3, false);
const after = core.queryBox([-1e6, -1e6, -1e6], [1e6, 1e6, 1e6]);
ok("queryBox works after heap growth", after.length > N, `${after.length} hits`);

core.dispose();
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
