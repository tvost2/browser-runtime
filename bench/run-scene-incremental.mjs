// BENCHMARK — incremental scene evaluation. World::evaluate() cost as a function
// of how much of the scene actually moved this frame.
//
//   npm run build && node --expose-gc bench/run-scene-incremental.mjs [maxCount]
//
// Compares, at 1k..500k entities and 0 / 1 / 10 / 100 % moving per frame:
//   * C++/WASM World (incremental, this cycle)
//   * the JS data-oriented kernel (always full — no dirty tracking)
//   * Babylon.js NullEngine (full recompute; and with frozen world matrices)
//
// Static scenes are the common case (most entities never move). The number that
// matters: a mostly-static 100k-entity scene should cost ~nothing per frame.

import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { WasmBackend } from "../web/backend/WasmBackend.mjs";
import { JsBackend } from "../web/backend/JsBackend.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const max = Number(process.argv[2] || 250_000);
const SIZES = [1_000, 10_000, 50_000, 100_000, 250_000, 500_000].filter((n) => n <= max);
const RATIOS = [0.001, 0.01, 0.10, 1.0];

// deterministic shell scene — ~half culled by a moderate frustum, ~50% parented
function makeScene(n) {
  const parents = new Int32Array(n).fill(-1);
  const trs = new Float32Array(n * 10);
  const extents = new Float32Array(n * 6);
  const flags = new Uint32Array(n).fill(0b011);
  let s = 0x1234 ^ n;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < n; i++) {
    const b = i * 10;
    if (i > 0 && rnd() < 0.5) parents[i] = (rnd() * i) | 0;
    trs[b] = (rnd() - 0.5) * 800; trs[b + 1] = (rnd() - 0.5) * 800; trs[b + 2] = rnd() * 900 + 50;
    trs[b + 6] = 1;
    const sc = 0.5 + rnd() * 1.5;
    trs[b + 7] = trs[b + 8] = trs[b + 9] = sc;
    extents.set([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5], i * 6);
  }
  return { count: n, parents, trs, extents, flags };
}
const vp = new Float32Array([1.2, 0, 0, 0, 0, 2.1, 0, 0, 0, 0, 1.001, 1, 0, 0, -0.5, 0]);

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// moving-subset indices for a ratio (spread across the scene)
function movingSet(n, ratio) {
  if (ratio >= 1) return null; // null = all
  const m = Math.max(1, Math.round(n * ratio));
  if (m >= n) return null;
  const step = Math.floor(n / m);
  const out = new Uint32Array(m);
  for (let i = 0; i < m; i++) out[i] = (i * step) % n;
  return out;
}

async function benchWasm(scene, frames) {
  const be = new WasmBackend();
  await be.init();
  be.upload(scene);
  be.evaluateFrame(vp, 0, false); // warm / first full recompute
  const rows = {};
  for (const ratio of RATIOS) {
    const mv = movingSet(scene.count, ratio);
    // a couple of settle frames at this ratio
    for (let i = 0; i < 3; i++) { if (mv) be.nudge(mv); else be.markAllDirty(); be.evaluateFrame(vp, 0, false); }
    globalThis.gc?.();
    const s = [];
    let recomp = 0;
    for (let i = 0; i < frames; i++) {
      if (mv) be.nudge(mv); else be.markAllDirty();
      const t = performance.now();
      const r = be.evaluateFrame(vp, 0, false);
      s.push(performance.now() - t);
      recomp = r.stats.transformsRecomputed;
    }
    rows[ratio] = { ms: median(s), recomputed: recomp };
  }
  // fully static (no dirtying at all after warm)
  for (let i = 0; i < 3; i++) be.evaluateFrame(vp, 0, false);
  { const s = []; for (let i = 0; i < frames; i++) { const t = performance.now(); be.evaluateFrame(vp, 0, false); s.push(performance.now() - t); } rows["static"] = { ms: median(s), recomputed: 0 }; }
  be.dispose();
  return rows;
}

async function benchJs(scene, frames) {
  const be = new JsBackend();
  await be.init();
  be.upload(scene);
  for (let i = 0; i < 4; i++) be.evaluateFrame(vp, 0, false);
  globalThis.gc?.();
  const s = [];
  for (let i = 0; i < frames; i++) { const t = performance.now(); be.evaluateFrame(vp, 0, false); s.push(performance.now() - t); }
  be.dispose?.();
  return median(s); // JS kernel has no dirty tracking → same cost every frame
}

// Babylon NullEngine: build a matching hierarchy, measure the per-frame CPU
// (world matrix + bounding + active-mesh selection). Also the frozen variant.
async function benchBabylon(scene, frames) {
  const n = scene.count;
  if (n > 60_000) return { note: "skipped >60k (Babylon per-mesh build too heavy for this host)" };
  let mod;
  try {
    await import("@babylonjs/core/Materials/standardMaterial.js"); // side-effect: default material for render()
    mod = {
      NullEngine: (await import("@babylonjs/core/Engines/nullEngine.js")).NullEngine,
      Scene: (await import("@babylonjs/core/scene.js")).Scene,
      FreeCamera: (await import("@babylonjs/core/Cameras/freeCamera.js")).FreeCamera,
      Vector3: (await import("@babylonjs/core/Maths/math.vector.js")).Vector3,
      Mesh: (await import("@babylonjs/core/Meshes/mesh.js")).Mesh,
      Geometry: (await import("@babylonjs/core/Meshes/geometry.js")).Geometry,
      CreateBoxVertexData: (await import("@babylonjs/core/Meshes/Builders/boxBuilder.js")).CreateBoxVertexData,
    };
  } catch (e) { return { note: "babylon import failed: " + e.message }; }
  const { NullEngine, Scene, FreeCamera, Vector3, Mesh, Geometry, CreateBoxVertexData } = mod;

  const engine = new NullEngine({ renderWidth: 256, renderHeight: 256, deterministicLockstep: true, lockstepMaxSteps: 1 });
  const s = new Scene(engine);
  s.autoClear = false;
  const cam = new FreeCamera("c", new Vector3(0, 0, -10), s);
  cam.setTarget(Vector3.Zero());
  const geo = new Geometry("g", s, CreateBoxVertexData({ size: 1 }));
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const m = new Mesh("m" + i, s);
    geo.applyToMesh(m);                 // shares the vertex/index buffers
    const b = i * 10;
    m.position.set(scene.trs[b], scene.trs[b + 1], scene.trs[b + 2]);
    m.scaling.set(scene.trs[b + 7], scene.trs[b + 8], scene.trs[b + 9]);
    nodes.push(m);
  }
  for (let i = 0; i < n; i++) if (scene.parents[i] >= 0) nodes[i].parent = nodes[scene.parents[i]];

  s.render(); s.render(); // warm
  globalThis.gc?.();

  // default: full recompute every frame (nudge one node so nothing is auto-frozen)
  const def = [];
  for (let i = 0; i < frames; i++) {
    nodes[i % n].position.z += (i & 1) ? 0.001 : -0.001;
    const t = performance.now();
    s.render();
    def.push(performance.now() - t);
  }
  // frozen: freeze every world matrix + freeze active meshes (Babylon's own "static scene" path)
  for (const m of nodes) m.freezeWorldMatrix();
  s.freezeActiveMeshes();
  s.render(); s.render();
  const frz = [];
  for (let i = 0; i < frames; i++) { const t = performance.now(); s.render(); frz.push(performance.now() - t); }

  engine.dispose();
  return { defaultMs: median(def), frozenMs: median(frz) };
}

const out = { kind: "scene-incremental", ratios: RATIOS, rows: [] };
console.log(`\nincremental scene eval — evaluate() ms (median), shell scene, ~50% culled\n`);
console.log(`${"N".padStart(8)}  ${"static".padStart(8)} ${"0.1%".padStart(8)} ${"1%".padStart(8)} ${"10%".padStart(8)} ${"100%".padStart(8)}  ${"JS full".padStart(8)}  ${"Bab dflt".padStart(9)} ${"Bab froz".padStart(9)}`);
console.log("-".repeat(104));

for (const n of SIZES) {
  const scene = makeScene(n);
  const frames = n >= 250_000 ? 40 : 120;
  const wasm = await benchWasm(scene, frames);
  const js = await benchJs(scene, frames);
  const bab = await benchBabylon(scene, frames);
  const row = { n, wasm, jsFullMs: js, babylon: bab };
  out.rows.push(row);
  const f = (x) => (x == null ? "  —  " : x.toFixed(2));
  console.log(
    `${n.toLocaleString().padStart(8)}  ${f(wasm.static.ms).padStart(8)} ${f(wasm[0.001].ms).padStart(8)} ${f(wasm[0.01].ms).padStart(8)} ${f(wasm[0.1].ms).padStart(8)} ${f(wasm[1].ms).padStart(8)}  ` +
    `${f(js).padStart(8)}  ${f(bab?.defaultMs).padStart(9)} ${f(bab?.frozenMs).padStart(9)}`,
  );
}

// headline ratios on the largest common size
const big = out.rows[out.rows.length - 1];
console.log(`\nlargest (${big.n.toLocaleString()} entities):`);
console.log(`  static frame:      WASM ${big.wasm.static.ms.toFixed(2)} ms   vs  JS-kernel full ${big.jsFullMs.toFixed(2)} ms   → ${(big.jsFullMs / big.wasm.static.ms).toFixed(0)}x`);
console.log(`  100% moving frame: WASM ${big.wasm[1].ms.toFixed(2)} ms  (== old full-recompute behaviour)`);
console.log(`  1% moving frame:   WASM ${big.wasm[0.01].ms.toFixed(2)} ms  (${big.wasm[0.01].recomputed} transforms recomputed)`);
if (big.babylon?.defaultMs) console.log(`  Babylon default:   ${big.babylon.defaultMs.toFixed(2)} ms   Babylon frozen: ${big.babylon.frozenMs.toFixed(2)} ms`);

writeFileSync(join(__dir, "results", "scene-incremental.json"), JSON.stringify(out, null, 2));
console.log(`\nwrote bench/results/scene-incremental.json`);
