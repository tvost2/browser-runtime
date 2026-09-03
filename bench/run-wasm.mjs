// The WASM rung: loads the WASM-first core (engine.wasm via WasmBackend),
// asserts its visible set matches the Babylon-authored fixture, then times
// evaluate() with the standard perturbation loop.
//
//   npm run build:wasm && npm run build:api
//   node --expose-gc bench/run-wasm.mjs [--profile <name>]
//
// --profile picks web/backend/<name>.mjs (build variants: release/o3/simdlto…).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { WasmBackend } from "../web/backend/WasmBackend.mjs";
import { summarize, fmt } from "./stats.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const R = join(__dir, "results");
const fx = join(__dir, "..", "native", "tests", "fixtures");
const rd = (n) => { const b = readFileSync(join(fx, n)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

const pi = process.argv.indexOf("--profile");
const profile = pi > -1 ? process.argv[pi + 1] : "engine";
const wasmUrl = pathToFileURL(join(__dir, "..", "web", "backend", `${profile === "engine" ? "engine" : profile}.mjs`)).href;
if (!existsSync(new URL(wasmUrl))) { console.error(`missing ${wasmUrl} — npm run build:wasm`); process.exit(1); }

const parent = new Int32Array(rd("kernel_parent.bin"));
const trs = new Float32Array(rd("kernel_trs.bin"));
const ext = new Float32Array(rd("kernel_ext.bin"));
const flags = new Uint32Array(new Int32Array(rd("kernel_flags.bin")));
const vp = new Float32Array(rd("kernel_vp.bin"));
const expVisible = new Int32Array(rd("kernel_visible.bin"));
const n = parent.length;
const scene = { count: n, parents: parent, trs, extents: ext, flags };

const be = new WasmBackend();
await be.init(wasmUrl);
be.upload(scene);
const res = be.evaluateFrame(vp, 0, false);

// visible set equality (order-independent — WASM keeps traversal order here)
const got = new Set(res.visibleIds), exp = new Set(expVisible);
let mism = got.size !== exp.size ? 1 : 0;
for (const v of exp) if (!got.has(v)) mism++;
console.log(`wasm [${profile}] equivalence: ${res.visibleCount} visible (exp ${expVisible.length}), mismatches=${mism}`);
if (mism) { console.error("!! wasm visible set != Babylon"); process.exit(2); }

for (let i = 0; i < 500; i++) be.evaluateFrame(vp, 0, false);
if (globalThis.gc) globalThis.gc();
const frames = 3000, s = new Float64Array(frames);
for (let f = 0; f < frames; f++) {
  for (let k = 0; k < n; k += 7) trs[k * 10] += 0.001;
  be.updateTransforms(null, trs);
  const a = performance.now();
  be.evaluateFrame(vp, 0, false);
  s[f] = performance.now() - a;
}
const stats = summarize(Array.from(s));
console.log(`wasm [${profile}]: median=${fmt(stats.median)}ms p95=${fmt(stats.p95)}ms p99=${fmt(stats.p99)}ms`);

const payload = { kind: "wasm", profile, scene: { nodes: n, visible: res.visibleCount }, stats };
// per-profile file (for the SIMD/flag comparison) + canonical wasm.json (the ladder)
writeFileSync(join(R, `wasm.${profile}.json`), JSON.stringify(payload, null, 2));
if (profile === "engine") writeFileSync(join(R, "wasm.json"), JSON.stringify(payload, null, 2));
console.log(`wrote ${join(R, `wasm.${profile}.json`)}`);
