// BENCHMARK / VALIDATE — real-world heavy GLBs (the "vitrine" corpus): ~1M-vertex
// single-primitive meshes with NO source normals. This is the case the C++/WASM
// core exists for — the JS zero-copy path cannot produce a renderable mesh here
// (no normals → no shading), so "auto" routes every one of these to WASM.
//
//   GLB_VITRINE_DIR=/path/to/models node --expose-gc bench/run-glb-vitrine.mjs
//
// The corpus is not vendored (108 files, ~3.6 GB). Point GLB_VITRINE_DIR at it;
// the script samples a handful and skips cleanly if the dir is absent.

import { readFile } from "node:fs/promises";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

const __dir = dirname(fileURLToPath(import.meta.url));
const dir = process.env.GLB_VITRINE_DIR
  || "E:/Nova pasta (2)/vitrine-glb/assets/models"; // bench-host default

if (!existsSync(dir)) {
  console.log(`vitrine corpus not found (set GLB_VITRINE_DIR) — skipping\n  looked in: ${dir}`);
  process.exit(0);
}

const eng = await import(pathToFileURL(join(__dir, "..", "web", "dist", "engine.js")).href);
const { decodeGLB } = eng;

const all = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".glb"));
// a spread across the corpus, capped so the run stays a few minutes
const pick = process.env.GLB_VITRINE_ALL ? all
  : all.filter((_, i) => i % Math.ceil(all.length / 8) === 0).slice(0, 8);

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
async function timeit(reps, fn) {
  await fn(); globalThis.gc?.();
  const s = [];
  for (let i = 0; i < reps; i++) { const a = performance.now(); await fn(); s.push(performance.now() - a); }
  return median(s);
}

console.log(`vitrine corpus: ${all.length} files · sampling ${pick.length}\n`);
console.log(`${"file".padEnd(16)} ${"verts".padStart(9)} ${"indices".padStart(10)}  ${"JS*".padStart(7)} ${"WASM".padStart(8)} ${"auto".padStart(8)}  ${"path".padStart(5)} ${"cross".padStart(5)} ${"Ngen Mtri/s".padStart(11)}  eq`);
console.log("-".repeat(104));

const rows = [];
for (const f of pick) {
  const bytes = new Uint8Array(await readFile(join(dir, f)));
  const reps = 5;

  const jsMs = await timeit(reps, () => decodeGLB(bytes, { geometry: "js" }));      // *views only — leaves normals null
  const wasmMs = await timeit(reps, () => decodeGLB(bytes, { geometry: "wasm" }));
  const autoMs = await timeit(reps, () => decodeGLB(bytes, { geometry: "auto" }));

  const w = await decodeGLB(bytes, { geometry: "wasm" });
  const j = await decodeGLB(bytes, { geometry: "js" });
  const a = await decodeGLB(bytes, { geometry: "auto" });

  // equivalence: positions + indices bit-identical WASM vs JS; generated normals unit-length
  let posMax = 0, idxOk = true, unit = true, genN = 0;
  for (let mi = 0; mi < w.meshes.length; mi++) {
    for (let pi = 0; pi < w.meshes[mi].primitives.length; pi++) {
      const wp = w.meshes[mi].primitives[pi], jp = j.meshes[mi].primitives[pi];
      for (let k = 0; k < wp.positions.length; k++) { const d = Math.abs(wp.positions[k] - jp.positions[k]); if (d > posMax) posMax = d; }
      if (wp.indices.length !== jp.indices.length) idxOk = false;
      else for (let k = 0; k < wp.indices.length; k++) if (wp.indices[k] !== jp.indices[k]) { idxOk = false; break; }
      if (!jp.normals && wp.normals) genN++;
      if (wp.normals) for (let v = 0; v < wp.normals.length; v += 3) {
        const l = Math.hypot(wp.normals[v], wp.normals[v + 1], wp.normals[v + 2]);
        if (l > 1e-4 && Math.abs(l - 1) > 2e-3) { unit = false; break; }
      }
    }
  }
  const V = w.stats.vertices, I = w.stats.indices;
  const nGenMtriPerSec = (I / 3) / 1e6 / (wasmMs / 1000);
  const eq = posMax === 0 && idxOk && unit;

  const row = {
    file: f, bytes: bytes.length, vertices: V, indices: I,
    jsViewsMs: jsMs, wasmMs, autoMs, autoPath: a.stats.geometryPath,
    crossings: w.stats.wasmCrossings, bytesUploaded: w.stats.bytesUploadedToWasm,
    normalsGeneratedByWasm: genN, jsLeftNormalsNull: !j.meshes[0].primitives[0].normals,
    normalGenMtriPerSec: nGenMtriPerSec, msPerMVerts: wasmMs / (V / 1e6),
    posMaxDiff: posMax, indicesIdentical: idxOk, generatedNormalsUnit: unit, equivalent: eq,
  };
  rows.push(row);
  console.log(
    `${f.padEnd(16)} ${V.toLocaleString().padStart(9)} ${I.toLocaleString().padStart(10)}  ` +
    `${jsMs.toFixed(1).padStart(7)} ${wasmMs.toFixed(1).padStart(8)} ${autoMs.toFixed(1).padStart(8)}  ` +
    `${row.autoPath.padStart(5)} ${String(row.crossings).padStart(5)} ${nGenMtriPerSec.toFixed(1).padStart(11)}  ${eq ? "ok" : "FAIL"}`,
  );
}

const allEq = rows.every((r) => r.equivalent);
const allAutoWasm = rows.every((r) => r.autoPath === "wasm");
const allJsNull = rows.every((r) => r.jsLeftNormalsNull);

console.log(`\n* JS column is zero-copy VIEW creation only — it leaves normals null` +
  ` (${allJsNull ? "all" : "some"} sampled models have no source normals), so a JS-only` +
  ` decode of this corpus does not yield a shadeable mesh.`);
console.log(`  "auto" routes ${allAutoWasm ? "every" : "most"} model here to the C++/WASM core, which generates` +
  ` area-weighted normals: median ${median(rows.map((r) => r.normalGenMtriPerSec)).toFixed(1)} Mtri/s,` +
  ` ${median(rows.map((r) => r.msPerMVerts)).toFixed(0)} ms/M verts.`);
console.log(`  WASM↔JS crossings: ${rows[0].crossings} per asset (files up to ${(Math.max(...rows.map((r) => r.bytes)) / 1048576).toFixed(0)} MB).`);
console.log(`\nequivalence (positions bit-identical, indices identical, normals unit): ${allEq ? "PASS" : "FAIL"}`);

writeFileSync(join(__dir, "results", "glb-vitrine.json"), JSON.stringify({ kind: "glb-vitrine", dir, sampled: pick.length, total: all.length, allEquivalent: allEq, rows }, null, 2));
console.log(`wrote bench/results/glb-vitrine.json`);
process.exit(allEq ? 0 : 1);
