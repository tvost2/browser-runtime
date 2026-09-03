// PROFILE + BENCHMARK — incremental render list. Where does evaluate() spend its
// time once transforms are incremental (F-012), and does patching the render
// list in place (instead of rebuilding + re-uploading) help?
//
//   npm run build && node --expose-gc bench/run-renderer-incremental.mjs [maxN]
//
// Node, no GPU — isolates the CPU pipeline: transform pass / cull pass / list
// build, plus how many instance rows a partial GPU upload would touch. The
// browser GPU cost (upload bandwidth, submit, FPS) is bench:renderer:gpu.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { WasmBackend } from "../web/backend/WasmBackend.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const max = Number(process.argv[2] || 250_000);
const SIZES = [10_000, 50_000, 100_000, 250_000, 500_000].filter((n) => n <= max);
const STRAT = { Standard: 0, Bvh: 3, Auto: 4 };

function makeScene(n) {
  const parents = new Int32Array(n).fill(-1);
  const trs = new Float32Array(n * 10);
  const extents = new Float32Array(n * 6);
  const flags = new Uint32Array(n).fill(0b011);
  let s = 0x51ce ^ n;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < n; i++) {
    const b = i * 10;
    if (i > 0 && rnd() < 0.5) parents[i] = (rnd() * i) | 0;
    trs[b] = (rnd() - 0.5) * 900; trs[b + 1] = (rnd() - 0.5) * 900; trs[b + 2] = rnd() * 1000 + 50;
    trs[b + 6] = 1;
    const sc = 0.5 + rnd() * 1.5;
    trs[b + 7] = trs[b + 8] = trs[b + 9] = sc;
    extents.set([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5], i * 6);
  }
  return { count: n, parents, trs, extents, flags };
}
const vp0 = new Float32Array([1.2, 0, 0, 0, 0, 2.1, 0, 0, 0, 0, 1.001, 1, 0, 0, -0.5, 0]);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
function movers(n, ratio) {
  const m = Math.max(0, Math.round(n * ratio));
  const step = m ? Math.max(1, Math.floor(n / m)) : n + 1;
  const out = [];
  for (let i = 0; i < m; i++) out.push((i * step) % n);
  return new Uint32Array(out);
}

const scenarios = [
  { name: "static", setup: () => {} },
  { name: "transform 0.1%", mv: (n) => movers(n, 0.001) },
  { name: "transform 1%", mv: (n) => movers(n, 0.01) },
  { name: "transform 10%", mv: (n) => movers(n, 0.10) },
  { name: "camera pan", cam: true },
  { name: "camera + 1%", mv: (n) => movers(n, 0.01), cam: true },
  { name: "visibility flip 0.1%", flip: (n) => movers(n, 0.001) },
  { name: "high churn 100%", mv: (n) => null /* all */ },
];

async function run(n, strat, frames) {
  const scene = makeScene(n);
  const be = new WasmBackend();
  await be.init();
  be.upload(scene);
  const C = be.__proto__; // no-op
  const core = be; // WasmBackend
  const rows = {};
  for (const sc of scenarios) {
    // fresh warm
    be.markAllDirty();
    be.evaluateFrame(vp0, strat, true);
    const mv = sc.mv ? sc.mv(n) : null;
    const flip = sc.flip ? sc.flip(n) : null;
    let vp = new Float32Array(vp0);
    const isHigh = sc.name.startsWith("high");
    // settle
    for (let i = 0; i < 4; i++) {
      if (isHigh) be.markAllDirty();
      else if (mv) be.nudge(mv);
      if (sc.cam) vp[12] += 0.7;
      if (flip) { const F = be.components.flags; for (const e of flip) F[e] ^= 0b010; }
      be.evaluateFrame(vp, strat, true);
    }
    globalThis.gc?.();
    const tot = [], tr = [], cu = [], li = [], dirty = [], rebuilt = [];
    for (let i = 0; i < frames; i++) {
      if (isHigh) be.markAllDirty();
      else if (mv) be.nudge(mv);
      if (sc.cam) vp[12] += 0.7;
      if (flip) { const F = be.components.flags; for (const e of flip) F[e] ^= 0b010; }
      const t = performance.now();
      const r = be.evaluateFrame(vp, strat, true);
      tot.push(performance.now() - t);
      tr.push(r.stats.transformUs); cu.push(r.stats.cullUs); li.push(r.stats.listUs);
      dirty.push(r.stats.dirtySlots); rebuilt.push(r.stats.listRebuilt);
    }
    rows[sc.name] = {
      totalMs: median(tot), transformUs: median(tr), cullUs: median(cu), listUs: median(li),
      dirtySlots: median(dirty), listRebuilt: median(rebuilt),
      uploadRows: median(rebuilt) ? -1 : median(dirty),   // -1 = full upload
    };
  }
  be.dispose();
  return rows;
}

const out = { kind: "renderer-incremental", sizes: SIZES, rows: [] };
console.log(`\nincremental render list — evaluate() ms + stage split (us), CullStrategy.Standard\n`);
for (const n of SIZES) {
  const frames = n >= 250_000 ? 40 : 150;
  const r = await run(n, STRAT.Standard, frames);
  out.rows.push({ n, standard: r });
  console.log(`  ${n.toLocaleString()} entities:`);
  for (const [name, v] of Object.entries(r)) {
    const up = v.listRebuilt ? `full upload` : `patch ${v.dirtySlots} rows`;
    console.log(`    ${name.padEnd(20)} ${v.totalMs.toFixed(3).padStart(8)} ms   (transform ${v.transformUs.toFixed(0)}us · cull ${v.cullUs.toFixed(0)}us · list ${v.listUs.toFixed(0)}us)   → ${up}`);
  }
}

// Standard vs Bvh vs Auto on the biggest common size
const big = SIZES[SIZES.length - 1];
console.log(`\nStandard vs Bvh vs Auto — ${big.toLocaleString()} entities:`);
const rs = out.rows.find((x) => x.n === big).standard;
const rb = await run(big, STRAT.Bvh, big >= 250_000 ? 40 : 100);
const ra = await run(big, STRAT.Auto, big >= 250_000 ? 40 : 100);
out.rows.find((x) => x.n === big).bvh = rb;
out.rows.find((x) => x.n === big).auto = ra;
console.log(`    ${"scenario".padEnd(20)} ${"Standard".padStart(10)} ${"Bvh".padStart(10)} ${"Auto".padStart(10)}`);
for (const name of Object.keys(rs))
  console.log(`    ${name.padEnd(20)} ${rs[name].totalMs.toFixed(2).padStart(10)} ${rb[name].totalMs.toFixed(2).padStart(10)} ${ra[name].totalMs.toFixed(2).padStart(10)}`);

writeFileSync(join(__dir, "results", "renderer-incremental.json"), JSON.stringify(out, null, 2));
console.log(`\nwrote bench/results/renderer-incremental.json`);
