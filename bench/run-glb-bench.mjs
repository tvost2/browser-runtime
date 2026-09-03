// BENCHMARK — GLB geometry processing: JS reference vs C++/WASM.
//   npm run build && node --expose-gc bench/run-glb-bench.mjs
//
// Node, no renderer. Measures the CPU cost of turning GLB bytes into an Asset:
//   container split + JSON.parse  (always JS)
//   geometry decode               (JS reference  vs  C++/WASM batch)
//   total decodeGLB
// plus: ms per million vertices, vertices/s, indices/s, bytes copied into WASM,
// JS↔WASM crossings, one-off WASM init.
//
// GPU upload / first-frame / steady-state are measured in the browser viewer
// (web/harness/glb-viewer.mjs HUD) and bench/run-glb-render.mjs.

import { readFile } from "node:fs/promises";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

const __dir = dirname(fileURLToPath(import.meta.url));
const fxDir = join(__dir, "..", "native", "tests", "fixtures", "glb");
const eng = await import(pathToFileURL(join(__dir, "..", "web", "dist", "engine.js")).href);
const { decodeGLB } = eng;

const fixtures = [
  join(fxDir, "tri.glb"), join(fxDir, "two-boxes.glb"),
  ...(existsSync(join(fxDir, "real")) ? readdirSync(join(fxDir, "real")).filter((f) => f.endsWith(".glb")).map((f) => join(fxDir, "real", f)) : []),
];

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
async function timeit(reps, fn) {
  for (let i = 0; i < Math.max(4, reps >> 2); i++) await fn();       // warmup
  globalThis.gc?.();
  // best-of-K sample medians — trims OS-scheduler noise on the bench host
  const samples = [];
  for (let k = 0; k < 5; k++) {
    const s = [];
    for (let i = 0; i < reps; i++) { const a = performance.now(); await fn(); s.push(performance.now() - a); }
    samples.push(median(s));
  }
  return Math.min(...samples);
}

// warm the WASM module once so its init doesn't land in the first measurement
const wasmInit0 = performance.now();
await decodeGLB(new Uint8Array(await readFile(fixtures[0])), { geometry: "wasm" });
const wasmInitMs = performance.now() - wasmInit0; // includes module instantiate on the first call

console.log(`\nWASM module init (one-off, first decode): ~${wasmInitMs.toFixed(0)} ms\n`);
console.log("full decodeGLB — three geometry paths (median ms). +tan = tangents generated (WASM).\n");
console.log(`${"fixture".padEnd(20)} ${"verts".padStart(7)} ${"idx".padStart(7)}  ${"JS".padStart(8)} ${"WASM".padStart(8)} ${"auto".padStart(8)} ${"WASM+tan".padStart(9)}  ${"JS/WASM".padStart(8)}  ${"cross".padStart(5)} ${"→wasm KB".padStart(9)}`);
console.log("-".repeat(110));

const rows = [];
for (const path of fixtures) {
  const name = path.split(/[\\/]/).pop();
  const bytes = new Uint8Array(await readFile(path));
  const big = bytes.length > 500_000;
  const reps = big ? 40 : 300;

  const jsMs = await timeit(reps, () => decodeGLB(bytes, { geometry: "js" }));
  const wasmMs = await timeit(reps, () => decodeGLB(bytes, { geometry: "wasm" }));
  const autoMs = await timeit(reps, () => decodeGLB(bytes, { geometry: "auto" }));
  const wasmTanMs = await timeit(reps, () => decodeGLB(bytes, { geometry: "wasm", generateTangents: true }));

  const a = await decodeGLB(bytes, { geometry: "wasm" });
  const au = await decodeGLB(bytes, { geometry: "auto" });
  const V = a.stats.vertices, I = a.stats.indices;

  const row = {
    name, bytes: bytes.length, vertices: V, indices: I,
    jsMs, wasmMs, autoMs, wasmTanMs,
    speedupJsOverWasm: jsMs / wasmMs,
    autoPath: au.stats.geometryPath,
    wasmMvPerSec: V / 1e6 / (wasmMs / 1000),
    wasmVertsPerSec: V / (wasmMs / 1000), wasmIndicesPerSec: I / (wasmMs / 1000),
    msPerMVerts: wasmMs / (V / 1e6),
    crossings: a.stats.wasmCrossings, bytesUploaded: a.stats.bytesUploadedToWasm,
  };
  rows.push(row);
  console.log(
    `${name.padEnd(20)} ${String(V).padStart(7)} ${String(I).padStart(7)}  ` +
    `${jsMs.toFixed(3).padStart(8)} ${wasmMs.toFixed(3).padStart(8)} ${autoMs.toFixed(3).padStart(8)} ${wasmTanMs.toFixed(3).padStart(9)}  ` +
    `${(jsMs / wasmMs).toFixed(2).padStart(7)}x  ${String(row.crossings).padStart(5)} ${(row.bytesUploaded / 1024).toFixed(0).padStart(9)}`,
  );
}

// aggregate on the biggest asset(s)
const big = rows.filter((r) => r.vertices > 5000);
if (big.length) {
  const b = big.reduce((m, r) => (r.vertices > m.vertices ? r : m));
  console.log(`\nlargest asset (${b.name}, ${b.vertices.toLocaleString()} verts):`);
  console.log(`  decode:  JS ${b.jsMs.toFixed(2)} ms  ·  WASM ${b.wasmMs.toFixed(2)} ms  ·  auto ${b.autoMs.toFixed(2)} ms  ·  WASM+tangents ${b.wasmTanMs.toFixed(2)} ms`);
  console.log(`  JS reads packed-F32 attributes as zero-copy views; WASM must cross the heap (${(b.bytesUploaded / 1024).toFixed(0)} KB in) → ${b.speedupJsOverWasm.toFixed(2)}x slower for pure decode`);
  console.log(`  WASM decode rate: ${b.wasmMvPerSec.toFixed(1)} M verts/s · ${(b.wasmIndicesPerSec / 1e6).toFixed(1)} M idx/s · ${b.msPerMVerts.toFixed(1)} ms/M verts`);
  console.log(`  ${b.crossings} JS↔WASM crossings total (batch — independent of vertex count)`);
}

writeFileSync(join(__dir, "results", "glb-bench.json"), JSON.stringify({ kind: "glb-bench", wasmInitMs, rows }, null, 2));
console.log(`\nwrote bench/results/glb-bench.json`);
