// FULL PIPELINE BENCHMARK — PIPELINE A (JS) vs PIPELINE B (native C++/WASM),
// GLB bytes -> Asset. CPU, memory, copies, WASM crossings, throughput, scaling,
// cold/warm, SIMD. GPU / first-frame / steady-state are in
// bench/run-glb-pipelines-gpu.mjs (needs a browser).
//
//   npm run build && node --expose-gc bench/run-glb-pipelines.mjs
//   GLB_VITRINE_DIR=/path node --expose-gc bench/run-glb-pipelines.mjs   (+ heavy corpus)
//
// Bench host: numbers ~3x a modern laptop; ratios hold. Best-of-5 sample medians.

import { readFile, cp, mkdtemp } from "node:fs/promises";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");
const fxDir = join(root, "native", "tests", "fixtures", "glb");
const distUrl = pathToFileURL(join(root, "web", "dist", "engine.js")).href;
const eng = await import(distUrl);
const { decodeGLB, parseContainer, loadEngineModule } = eng;
const mod = await loadEngineModule();

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
async function timeit(fn, reps) {
  for (let i = 0; i < Math.max(3, reps >> 2); i++) await fn();
  globalThis.gc?.();
  const samples = [];
  for (let k = 0; k < 5; k++) {
    const s = [];
    for (let i = 0; i < reps; i++) { const a = performance.now(); await fn(); s.push(performance.now() - a); }
    samples.push(median(s));
  }
  return Math.min(...samples);
}

// wasm-heap high-water mark around a call
function heapMB() { return mod.HEAPU8.buffer.byteLength / 1048576; }
async function peakHeap(fn) {
  const before = heapMB(); let peak = before;
  await fn();
  peak = Math.max(peak, heapMB());
  return { before, peak, grew: peak - before };
}

const fixtures = [
  { name: "tri.glb", path: join(fxDir, "tri.glb"), tier: "tiny" },
  { name: "two-boxes.glb", path: join(fxDir, "two-boxes.glb"), tier: "tiny" },
  ...(existsSync(join(fxDir, "real")) ? readdirSync(join(fxDir, "real")).filter((f) => f.endsWith(".glb") && !f.startsWith("_")).map((f) => ({ name: "real/" + f, path: join(fxDir, "real", f), tier: "small" })) : []),
];
if (process.env.GLB_VITRINE_DIR && existsSync(process.env.GLB_VITRINE_DIR)) {
  const d = process.env.GLB_VITRINE_DIR;
  const vs = readdirSync(d).filter((f) => f.toLowerCase().endsWith(".glb"));
  for (const f of vs.filter((_, i) => i % Math.ceil(vs.length / 5) === 0).slice(0, 5))
    fixtures.push({ name: "vitrine/" + f, path: join(d, f), tier: "huge" });
}

// ---- warm the module once (so its ~70 ms instantiate is out of the numbers) --
const warm = new Uint8Array(await readFile(fixtures[0].path));
const coldT0 = performance.now();
await decodeGLB(warm, { parser: "native" });
const wasmInitMs = performance.now() - coldT0;

const rows = [];
console.log(`\nWASM init (one-off): ~${wasmInitMs.toFixed(0)} ms\n`);
console.log(
  `${"fixture".padEnd(24)} ${"MB".padStart(6)} ${"verts".padStart(9)}  ` +
  `${"A js".padStart(8)} ${"A auto".padStart(8)} ${"A eff".padStart(8)} ${"B nat".padStart(8)}  ${"Aeff/B".padStart(7)}  ` +
  `${"xB".padStart(3)} ${"blob→B KB".padStart(9)} ${"json ms".padStart(8)} ${"meta ms".padStart(8)}`,
);
console.log("-".repeat(130));

for (const fx of fixtures) {
  const bytes = new Uint8Array(await readFile(fx.path));
  const MB = bytes.length / 1048576;
  const heavy = bytes.length > 400_000;
  const reps = heavy ? 25 : 250;

  // end-to-end decode
  const jsMs   = await timeit(() => decodeGLB(bytes, { geometry: "js" }), reps);
  const autoMs = await timeit(() => decodeGLB(bytes, { geometry: "auto" }), reps);
  const natMs  = await timeit(() => decodeGLB(bytes, { parser: "native" }), reps);
  const natTanMs = await timeit(() => decodeGLB(bytes, { parser: "native", generateTangents: true }), reps);

  // stage split
  const containerMs = await timeit(() => parseContainer(bytes), reps);   // JS: header + JSON.parse
  const a = await decodeGLB(bytes, { geometry: "js" });
  const b = await decodeGLB(bytes, { parser: "native" });
  const V = a.stats.vertices, I = a.stats.indices, TRIS = I / 3;
  const ns = b.nativeStats;

  // does the pure-JS path even produce a shadeable mesh? (no — if a primitive
  // has no source normals and the JS path has no generator). When it doesn't,
  // the fair comparison for A is "auto" (which routes to the WASM core).
  const jsShadeable = a.meshes.every((m) => m.primitives.every((p) => p.normals));
  const A_effective_ms = jsShadeable ? jsMs : autoMs;

  // memory: wasm heap growth around each pipeline
  const hJs = await peakHeap(() => decodeGLB(bytes, { geometry: "js" }));
  const hNat = await peakHeap(() => decodeGLB(bytes, { parser: "native" }));

  const row = {
    fixture: fx.name, tier: fx.tier, bytes: bytes.length, vertices: V, indices: I, triangles: TRIS,
    // CPU end-to-end (ms, median)
    A_js_ms: jsMs, A_auto_ms: autoMs, B_native_ms: natMs, B_native_tan_ms: natTanMs,
    jsShadeable, A_effective_ms,
    speedup_Aeff_over_B: A_effective_ms / natMs,
    speedup_Ajs_over_B: jsMs / natMs,
    // stage split
    js_container_ms: containerMs,
    js_meta_geom_ms: jsMs - containerMs,
    native_container_ms: ns.timings.container,
    native_json_ms: ns.timings.jsonParse,
    native_metadata_ms: ns.timings.metadata,
    native_primdesc_ms: ns.timings.primDesc,
    native_geometry_ms: ns.timings.geometry,
    native_process_ms: ns.timings.processTotal,
    native_load_ms: ns.timings.loadTotal,
    // crossings
    crossings_A_js: a.stats.wasmCrossings,          // 0
    crossings_A_auto: (await decodeGLB(bytes, { geometry: "auto" })).stats.wasmCrossings,
    crossings_B_native: b.stats.wasmCrossings,
    // copies / memory
    bytesInB: ns.counters.blobBytes,
    binCopyB: ns.counters.binCopyBytes,
    auxbinB: ns.counters.auxbinBytes,
    geomOutB: ns.counters.geomOutBytes,
    metaB: ns.counters.metaBytes,
    stringsB: ns.counters.stringsBytes,
    binZeroCopy: ns.binZeroCopy,
    wasmHeapGrewJs_MB: hJs.grew, wasmHeapGrewNat_MB: hNat.grew,
    // throughput (native)
    B_Mverts_per_s: V / 1e6 / (natMs / 1000),
    B_Mtris_per_s: TRIS / 1e6 / (natMs / 1000),
    B_MB_per_s: MB / (natMs / 1000),
    B_ms_per_Mverts: natMs / (V / 1e6),
    B_ms_per_Mtris: natMs / (TRIS / 1e6),
    B_ms_per_MB: natMs / MB,
  };
  rows.push(row);
  console.log(
    `${fx.name.padEnd(24).slice(0, 24)} ${MB.toFixed(1).padStart(6)} ${V.toLocaleString().padStart(9)}  ` +
    `${jsMs.toFixed(2).padStart(8)} ${autoMs.toFixed(2).padStart(8)} ${A_effective_ms.toFixed(2).padStart(8)} ${natMs.toFixed(2).padStart(8)}  ${(A_effective_ms / natMs).toFixed(2).padStart(6)}x  ` +
    `${String(row.crossings_B_native).padStart(3)} ${(row.bytesInB / 1024).toFixed(0).padStart(9)} ${ns.timings.jsonParse.toFixed(2).padStart(8)} ${ns.timings.metadata.toFixed(2).padStart(8)}`,
  );
}

// ---- cold / warm: fresh module vs cached, first/second/third asset ----
console.log(`\ncold vs warm — module instantiate + first decode vs steady state:`);
{
  const sample = fixtures.find((f) => f.tier === "small") ?? fixtures[0];
  const bytes = new Uint8Array(await readFile(sample.path));
  // native, cached module: 1st..4th decode
  const seq = [];
  for (let i = 0; i < 5; i++) { const t = performance.now(); await decodeGLB(bytes, { parser: "native" }); seq.push(performance.now() - t); }
  console.log(`  native ${sample.name}: decode #1..#5 = ${seq.map((x) => x.toFixed(2)).join("  ")} ms  (module already warm)`);
  console.log(`  module instantiate (one-off, measured at start): ~${wasmInitMs.toFixed(0)} ms`);
}

// ---- SIMD: -O3 vs -O3 -msimd128 (native pipeline) ----
let simd = null;
if (existsSync(join(root, "web", "backend", "engine-o3.mjs"))) {
  const o3dst = join(root, "web", "dist");
  try {
    await cp(join(root, "web", "backend", "engine-o3.mjs"), join(o3dst, "engine-o3.mjs"));
    await cp(join(root, "web", "backend", "engine-o3.wasm"), join(o3dst, "engine-o3.wasm"));
    const o3url = pathToFileURL(join(o3dst, "engine-o3.mjs")).href;
    console.log(`\nSIMD — native pipeline, -O3 vs -O3 -msimd128:`);
    console.log(`${"fixture".padEnd(20)} ${"noSIMD".padStart(9)} ${"SIMD".padStart(9)} ${"ratio".padStart(7)}   (json/meta/geom split, noSIMD)`);
    simd = [];
    for (const fx of fixtures.filter((f) => f.tier !== "tiny")) {
      const bytes = new Uint8Array(await readFile(fx.path));
      const reps = bytes.length > 400_000 ? 20 : 120;
      const s = await timeit(() => decodeGLB(bytes, { parser: "native" }), reps);
      const n = await timeit(() => decodeGLB(bytes, { parser: "native", wasmUrl: o3url }), reps);
      const bn = await decodeGLB(bytes, { parser: "native", wasmUrl: o3url });
      const t = bn.nativeStats.timings;
      simd.push({ fixture: fx.name, simd_ms: s, nosimd_ms: n, ratio: n / s,
        nosimd_json: t.jsonParse, nosimd_meta: t.metadata, nosimd_geom: t.geometry });
      console.log(`${fx.name.padEnd(20)} ${n.toFixed(2).padStart(9)} ${s.toFixed(2).padStart(9)} ${(n / s).toFixed(2).padStart(6)}x   ${t.jsonParse.toFixed(2)}/${t.metadata.toFixed(2)}/${t.geometry.toFixed(1)}`);
    }
  } catch (e) { console.log(`  SIMD compare skipped: ${e.message}`); }
} else {
  console.log(`\nSIMD compare skipped — run 'npm run build:wasm:nosimd' first`);
}

writeFileSync(join(__dir, "results", "glb-pipelines.json"),
  JSON.stringify({ kind: "glb-pipelines", wasmInitMs, rows, simd }, null, 2));
console.log(`\nwrote bench/results/glb-pipelines.json`);
