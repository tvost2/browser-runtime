// Times the hand-written data-oriented JS kernel (web/backend/JsBackend.mjs) on
// the Babylon-authored fixture, asserts its visible set matches Babylon
// (so the timing is honest), and stitches it with:
//   - babylon : real Scene._evaluateActiveMeshes  (scaled from profile.json)
//   - native  : C++ -O3, no boundary              (interpolated from native.json)
// into compare.json. The WASM rung comes from bench/run-wasm.mjs (wasm.json);
// bench/report.mjs assembles the full ladder in docs/COMPARISON.md.
//
//   node --expose-gc bench/run-compare.mjs   (run bench:wasm first for the WASM rung)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { JsBackend } from "../web/backend/JsBackend.mjs";
import { summarize, fmt } from "./stats.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const R = join(__dir, "results");
const fx = join(__dir, "..", "native", "tests", "fixtures");
// Node Buffers are views into a shared pool — copy to a tight ArrayBuffer.
const rd = (n) => {
  const b = readFileSync(join(fx, n));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

if (!existsSync(join(fx, "kernel_trs.bin"))) {
  console.error("run: node native/tests/gen_fixtures.mjs first");
  process.exit(1);
}

// ---- load the Babylon-authored fixture scene ----
const parent = new Int32Array(rd("kernel_parent.bin"));
const trs = new Float32Array(rd("kernel_trs.bin"));
const ext = new Float32Array(rd("kernel_ext.bin"));
const flagsRaw = new Int32Array(rd("kernel_flags.bin"));
const flags = new Uint32Array(flagsRaw); // bit0 enabled, bit1 visible
const vp = new Float32Array(rd("kernel_vp.bin"));
const expVisible = new Int32Array(rd("kernel_visible.bin"));
const n = parent.length;

const scene = { count: n, parents: parent, trs, extents: ext, flags };

// ---- equivalence check ----
const jb = new JsBackend();
await jb.init();
jb.upload(scene);
const res = jb.evaluateFrame(vp, 0);
let mism = 0;
if (res.visibleCount !== expVisible.length) mism = -1;
else for (let i = 0; i < expVisible.length; i++) if (res.visibleIds[i] !== expVisible[i]) mism++;
console.log(`js-kernel equivalence: got ${res.visibleCount} visible, expected ${expVisible.length}, mismatches=${mism}`);
if (mism !== 0) { console.error("!! js-kernel does NOT match Babylon — fix before trusting timings"); process.exit(2); }

// ---- time js-kernel ----
function timeBackend(be, frames = 3000, warmup = 500) {
  be.upload(scene);
  for (let i = 0; i < warmup; i++) be.evaluateFrame(vp, 0);
  if (globalThis.gc) globalThis.gc();
  const s = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    // perturb like the native bench does
    for (let k = 0; k < n; k += 7) trs[k * 10] += 0.001;
    const a = performance.now();
    be.evaluateFrame(vp, 0);
    s[i] = performance.now() - a;
  }
  return summarize(Array.from(s));
}

const jsStats = timeBackend(jb);
console.log(`js-kernel: median=${fmt(jsStats.median)}ms p95=${fmt(jsStats.p95)}ms`);

// ---- assemble comparison vs other implementations ----
const profile = existsSync(join(R, "profile.json")) ? JSON.parse(readFileSync(join(R, "profile.json"), "utf8")) : null;
const native = existsSync(join(R, "native.json")) ? JSON.parse(readFileSync(join(R, "native.json"), "utf8")) : null;

const results = [];
// Babylon eval for the closest mesh count we profiled
if (profile) {
  // _evaluateActiveMeshes is ~linear in mesh count; scale the nearest large
  // profiled point to n so the comparison is at matched size.
  const big = profile.results.filter((r) => r.meshCount >= 2000)
    .reduce((best, r) => Math.abs(r.meshCount - n) < Math.abs(best.meshCount - n) ? r : best);
  const perMesh = big.phases.activeMeshesEval.median / big.meshCount;
  results.push({ name: `babylon _evaluateActiveMeshes (scaled to ${n} from ${big.meshCount})`, js: { median: perMesh * n }, wasm: jsStats });
}
if (native) {
  const pts = native.results.filter((r) => r.nodes >= 2000).sort((a, b) => a.nodes - b.nodes);
  // linear interpolate/extrapolate native median at n
  let lo = pts[0], hi = pts[pts.length - 1];
  for (let i = 0; i < pts.length - 1; i++) if (pts[i].nodes <= n && pts[i + 1].nodes >= n) { lo = pts[i]; hi = pts[i + 1]; }
  const t = (n - lo.nodes) / (hi.nodes - lo.nodes || 1);
  const natMs = lo.medianMs + t * (hi.medianMs - lo.medianMs);
  results.push({ name: `native C++ ceiling (interp to ${n} nodes)`, js: jsStats, wasm: { median: natMs } });
}

// The WASM rung is measured by bench/run-wasm.mjs (writes wasm.json); the ladder
// in bench/report.mjs stitches compare.json + wasm.json + native.json together.

writeFileSync(join(R, "compare.json"), JSON.stringify({
  kind: "compare", scene: { nodes: n, visible: res.visibleCount },
  jsKernel: jsStats, results,
}, null, 2));
console.log(`wrote ${join(R, "compare.json")}`);
