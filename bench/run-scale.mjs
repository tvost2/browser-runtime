// Scaling curve for World.evaluate() — how the WASM-first CPU pipeline behaves
// as entity count grows. Node, no renderer: isolates the WASM eval + boundary.
//
//   npm run build:wasm && npm run build:api
//   node --expose-gc bench/run-scale.mjs [maxCount]
//
// Also runs the JS data-oriented kernel at each size for the relative curve.
// Writes bench/results/scale.json → folded into docs/COMPARISON.md.

import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { WasmBackend } from "../web/backend/WasmBackend.mjs";
import { JsBackend } from "../web/backend/JsBackend.mjs";
import { summarize, fmt } from "./stats.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const engineMjs = pathToFileURL(join(__dir, "..", "web", "backend", "engine.mjs")).href;

const max = Number(process.argv[2] || 250_000);
const SIZES = [1_000, 4_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000].filter((n) => n <= max);

// deterministic scene: shell so ~55% is culled by a moderate frustum
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
    trs[b + 6] = 1; // quat w
    const sc = 0.5 + rnd() * 1.5;
    trs[b + 7] = trs[b + 8] = trs[b + 9] = sc;
    extents.set([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5], i * 6);
  }
  return { count: n, parents, trs, extents, flags };
}

const vp = new Float32Array([1.2, 0, 0, 0, 0, 2.1, 0, 0, 0, 0, 1.001, 1, 0, 0, -0.5, 0]);

async function timeBackend(be, scene, frames, warmup) {
  be.upload(scene);
  for (let i = 0; i < warmup; i++) be.evaluateFrame(vp, 0, false);
  if (globalThis.gc) { globalThis.gc(); globalThis.gc(); }
  const m0 = process.memoryUsage();
  const s = new Float64Array(frames);
  const trs = scene.trs, n = scene.count;
  let vis = 0;
  for (let f = 0; f < frames; f++) {
    for (let k = 0; k < n; k += 13) trs[k * 10] += 0.002;
    be.updateTransforms?.(null, trs);
    const a = performance.now();
    const r = be.evaluateFrame(vp, 0, false);
    s[f] = performance.now() - a;
    vis = r.visibleCount;
  }
  const m1 = process.memoryUsage();
  return { stats: summarize(Array.from(s)), visible: vis, heapGrowthMB: (m1.heapUsed - m0.heapUsed) / 1048576 };
}

const wasm = new WasmBackend(); await wasm.init(engineMjs);
const js = new JsBackend(); await js.init();

const rows = [];
for (const n of SIZES) {
  const frames = n >= 100_000 ? 200 : n >= 25_000 ? 400 : 800;
  const warmup = Math.min(120, frames / 4);
  const scene = makeScene(n);

  const w = await timeBackend(wasm, scene, frames, warmup);
  const wasmHeapMB = wasm.__core ? 0 : 0; // heapBytes not exposed on backend; report via demo
  const j = await timeBackend(js, structuredCloneScene(scene), frames, warmup);

  const row = {
    count: n,
    wasmMs: w.stats.median, wasmP95: w.stats.p95, wasmP99: w.stats.p99,
    jsMs: j.stats.median, jsP95: j.stats.p95,
    speedup: j.stats.median / w.stats.median,
    visible: w.visible,
    nsPerEntityWasm: (w.stats.median * 1e6) / n,
    jsHeapGrowthMB: j.heapGrowthMB,
  };
  rows.push(row);
  console.log(
    `${String(n).padStart(7)}  wasm ${fmt(row.wasmMs, 3).padStart(8)}ms  js ${fmt(row.jsMs, 3).padStart(8)}ms  ` +
    `${fmt(row.speedup, 2)}×   ${fmt(row.nsPerEntityWasm, 1)} ns/entity   vis ${row.visible}`,
  );
}

// is the curve linear? fit ns/entity trend
const first = rows[0].nsPerEntityWasm, last = rows[rows.length - 1].nsPerEntityWasm;
console.log(`\nns/entity: ${fmt(first, 1)} → ${fmt(last, 1)}  (${last > first * 1.4 ? "SUPER-LINEAR — cache pressure kicks in" : "≈ linear"})`);

writeFileSync(join(__dir, "results", "scale.json"), JSON.stringify({
  kind: "scale", vp: Array.from(vp), rows,
  note: "Node, no renderer. WASM eval + boundary only. JS = hand data-oriented kernel.",
}, null, 2));
console.log(`wrote ${join(__dir, "results", "scale.json")}`);

function structuredCloneScene(s) {
  return { count: s.count, parents: s.parents.slice(), trs: s.trs.slice(), extents: s.extents.slice(), flags: s.flags.slice() };
}
