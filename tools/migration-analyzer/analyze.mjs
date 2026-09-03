// Migration analyzer — estimates whether moving a piece of Babylon to C++/WASM
// is worth it. Data-driven: calibrated against what the benchmarks ACTUALLY
// measured, not arbitrary rules.
//
//   node tools/migration-analyzer/analyze.mjs [path-to-babylon-core-src]
//
// Output: ranked table + tools/migration-analyzer/report.json
// Tiers: DO NOT MIGRATE · MAYBE · GOOD CANDIDATE · HIGH VALUE

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] || join(here, "..", "..", "reference", "packages", "dev", "core", "src");
if (!existsSync(root)) {
  console.error(
    `Babylon source not found at ${root}\n` +
    `The analyzer scans the real Babylon.js tree. Get it with:\n` +
    `  npm run setup:reference\n` +
    `(or:  git clone --depth 1 https://github.com/BabylonJS/Babylon.js reference )`,
  );
  process.exit(1);
}
const resultsDir = join(here, "..", "..", "bench", "results");
const load = (f) => (existsSync(join(resultsDir, f)) ? JSON.parse(readFileSync(join(resultsDir, f), "utf8")) : null);

// ---------- ground truth from the benchmarks ----------
// Anything we actually built + measured pins the model.
const MEASURED = {
  // component-name-substring -> { benefit 0..1, difficulty 0..1, note }
  "scene.pure":     { benefit: 1.00, difficulty: 0.15, note: "MEASURED: _evaluateActiveMeshes → World.evaluate, ~11× vs Babylon, ~1.8× vs good JS, done" },
  "transformNode":  { benefit: 0.95, difficulty: 0.15, note: "MEASURED: transform propagation folded into World.evaluate" },
  "boundingInfo":   { benefit: 0.90, difficulty: 0.15, note: "MEASURED: world AABB/sphere refit folded into World.evaluate" },
  "boundingBox":    { benefit: 0.85, difficulty: 0.15, note: "MEASURED: 8-corner frustum test in World" },
  "boundingSphere": { benefit: 0.85, difficulty: 0.15, note: "MEASURED: sphere frustum test in World" },
  "math.frustum":   { benefit: 0.80, difficulty: 0.10, note: "MEASURED: Frustum::fromViewProj in World" },
  "math.vector":    { benefit: 0.25, difficulty: 0.10, note: "MEASURED CONTRA (F-001): isolated Mat/Vec ops = 8 ns/node native; boundary cost dominates. Only valuable fused." },
  "animation":      { benefit: 0.30, difficulty: 0.40, note: "MEASURED CONTRA (F-001): 2500 float tracks = 0.07 ms/frame. Re-check with quat/matrix tracks + skeletons." },
};

// ---------- explicit hypotheses (NOT measured) — the human queue from MIGRATION_GUIDE.
// These raise the benefit estimate but keep confidence = ESTIMATED, never MEASURED.
const HYPOTHESES = {
  "Bones/skeleton":       { benefit: 0.80, difficulty: 0.35, note: "ESTIMATED: dense Mat4 bone chains / frame — same shape as transform propagation" },
  "Bones/bone":           { benefit: 0.75, difficulty: 0.35, note: "ESTIMATED: bone.computeWorldMatrix chain" },
  "particleSystem":       { benefit: 0.70, difficulty: 0.40, note: "ESTIMATED: flat SoA, trivial integration, SIMD-friendly — own pass" },
  "math.functions":       { benefit: 0.65, difficulty: 0.25, note: "ESTIMATED: ComputeNormals/tangents — one big Float32Array in/out (WARM not HOT)" },
  "morphTargetManager":   { benefit: 0.55, difficulty: 0.45, note: "ESTIMATED: per-vertex blend, CPU path" },
  "thinInstanceMesh":     { benefit: 0.60, difficulty: 0.35, note: "ESTIMATED: pack instance matrices — close to how instanceWorld already works" },
};

// ---------- static scan ----------
const FRAME_HOT = /scene\.pure|transformNode|abstractMesh|boundingInfo|boundingBox|boundingSphere|math\.frustum|renderingManager|animation|bones\/|bone\.|skeleton|particleSystem|thinInstance|morphTarget|bakedVertexAnimation/i;
const DRIVER = /WebGPU|WebGL|Engines\/|engine\.|Shader|Effect\b|Texture|Materials\/|pipeline|bindGroup|drawElements|gl\.[a-z]|_gl\b|glContext/i;
const JS_API = /document\.|window\.|navigator\.|fetch\(|XMLHttpRequest|Blob|FileReader|Image\b|localStorage|addEventListener|Observable/g;
const MATH = /Vector[234]|Matrix|Quaternion|Math\.(sqrt|sin|cos|abs|min|max|hypot|acos|atan)|dot\(|cross\(|normalize/g;
const LOOP = /\b(for|while)\s*\(/g;
const ALLOC = /\bnew\s+[A-Z]|\.push\(|\.slice\(|Array\.from|\{\s*\}(?!\s*[,)])/g;
const BRANCH = /\b(if|switch|case)\b|&&|\|\||\?\s*[^:]/g;
const TYPED = /Float(32|64)Array|Uint(8|16|32)Array|Int(8|16|32)Array|ArrayBuffer|DataView/g;
const SIMD_SHAPE = /for\s*\([^)]*\)\s*\{[^}]*\[[a-z]\w*\s*[+*]\s*\d/i; // indexed arithmetic in a loop

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const count = (s, re) => (s.match(re) || []).length;

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (extname(p) === ".ts" && !p.endsWith(".d.ts") && !/\.test\.|\.spec\./.test(p)) acc.push(p);
  }
  return acc;
}

function scoreFile(file, src) {
  const loc = src.split("\n").length;
  const rel = file.slice(root.length + 1).replace(/\\/g, "/");

  const perLoc = (re) => count(src, re) / loc;
  const mathDensity = clamp01(perLoc(MATH) * 6);
  const loopIntensity = clamp01(perLoc(LOOP) * 8 + (/for[^]{0,300}?for\s*\(/.test(src) ? 0.4 : 0));
  const allocPressure = clamp01(perLoc(ALLOC) * 4);
  const dataRegularity = clamp01(count(src, TYPED) / 5 + (src.includes("VertexData") ? 0.3 : 0));
  const simdPotential = SIMD_SHAPE.test(src) ? clamp01(mathDensity * 0.6 + loopIntensity * 0.6) : 0.1;
  const frameHot = FRAME_HOT.test(file) ? 1 : 0;
  const driverBound = clamp01(count(src, DRIVER) / 30);
  const jsApiDep = clamp01(perLoc(JS_API) * 12);
  const complexity = clamp01(perLoc(BRANCH) * 3 + loc / 3000);

  // benefit ∝ hot math over regular data that vectorises; killed by driver/GPU dependence
  let benefit = clamp01(
    0.30 * mathDensity + 0.22 * loopIntensity + 0.15 * allocPressure +
    0.15 * frameHot + 0.10 * dataRegularity + 0.08 * simdPotential,
  );
  benefit = clamp01(benefit - 0.7 * driverBound - 0.25 * jsApiDep);

  // difficulty ∝ complexity + how tangled with JS APIs / the GPU + size
  const difficulty = clamp01(
    0.35 * complexity + 0.30 * driverBound + 0.20 * jsApiDep + 0.15 * clamp01(loc / 2000),
  );

  // confidence: MEASURED (we benchmarked it) · ESTIMATED (heuristic, clear shape)
  //             · UNKNOWN (heuristic, ambiguous — treat as a guess only)
  let note = "";
  let confidence = "ESTIMATED";
  for (const [k, v] of Object.entries(MEASURED)) {
    if (rel.includes(k)) { benefit = v.benefit; note = v.note; confidence = "MEASURED"; }
  }
  if (confidence !== "MEASURED") {
    for (const [k, v] of Object.entries(HYPOTHESES)) {
      if (rel.includes(k)) { benefit = Math.max(benefit, v.benefit); note = v.note; }
    }
  }
  if (confidence !== "MEASURED") {
    // ESTIMATED = the shape is legible (clearly compute/data OR clearly not).
    // UNKNOWN  = mixed signals; the heuristic is guessing, treat as such.
    const clearlyCompute = (mathDensity > 0.3 || simdPotential > 0.4 || dataRegularity > 0.45)
      && driverBound < 0.25 && jsApiDep < 0.3;
    const clearlyNot = driverBound > 0.4 || jsApiDep > 0.5 || (mathDensity < 0.1 && loopIntensity < 0.1);
    confidence = clearlyCompute || clearlyNot ? "ESTIMATED" : "UNKNOWN";
  }

  return {
    component: rel, loc, note, confidence,
    factors: {
      cpuHotness: +frameHot.toFixed(2),
      mathDensity: +mathDensity.toFixed(2),
      loopIntensity: +loopIntensity.toFixed(2),
      allocPressure: +allocPressure.toFixed(2),
      dataRegularity: +dataRegularity.toFixed(2),
      simdPotential: +simdPotential.toFixed(2),
      driverBound: +driverBound.toFixed(2),
      jsApiDep: +jsApiDep.toFixed(2),
      complexity: +complexity.toFixed(2),
    },
    estimatedBenefit: +benefit.toFixed(3),
    migrationDifficulty: +difficulty.toFixed(3),
    tier: tierOf(benefit, difficulty),
  };
}

function tierOf(b, d) {
  if (b < 0.25 || d > 0.75) return "DO NOT MIGRATE";
  const roi = b - d * 0.5;
  if (roi >= 0.55) return "HIGH VALUE";
  if (roi >= 0.35) return "GOOD CANDIDATE";
  return "MAYBE";
}

const rows = [];
for (const file of walk(root)) {
  const src = readFileSync(file, "utf8");
  if (src.split("\n").length < 40) continue;
  rows.push(scoreFile(file, src));
}
rows.sort((a, b) => (b.estimatedBenefit - b.migrationDifficulty * 0.5) - (a.estimatedBenefit - a.migrationDifficulty * 0.5));

// ---------- report ----------
const tiers = { "HIGH VALUE": [], "GOOD CANDIDATE": [], MAYBE: [], "DO NOT MIGRATE": [] };
for (const r of rows) tiers[r.tier].push(r);

const confCount = { MEASURED: 0, ESTIMATED: 0, UNKNOWN: 0 };
for (const r of rows) confCount[r.confidence]++;

console.log(`\nscanned ${rows.length} components in ${root.replace(/\\/g, "/")}`);
console.log(`confidence:  MEASURED ${confCount.MEASURED}   ESTIMATED ${confCount.ESTIMATED}   UNKNOWN ${confCount.UNKNOWN}\n`);
for (const t of ["HIGH VALUE", "GOOD CANDIDATE"]) {
  console.log(`── ${t} ──`);
  for (const r of tiers[t].slice(0, 15)) {
    const tag = r.confidence === "MEASURED" ? "✓ MEASURED" : r.confidence === "UNKNOWN" ? "? UNKNOWN" : "~ estimated";
    console.log(`  ${r.estimatedBenefit.toFixed(2)} b / ${r.migrationDifficulty.toFixed(2)} d  [${tag}]  ${r.component}`);
  }
  console.log("");
}
console.log(`MAYBE: ${tiers.MAYBE.length}   DO NOT MIGRATE: ${tiers["DO NOT MIGRATE"].length}`);
console.log(`\nNEXT (GOOD CANDIDATE / HIGH VALUE, not yet MEASURED, ranked):`);
for (const r of rows.filter((r) => r.confidence !== "MEASURED" && /HIGH VALUE|GOOD CANDIDATE/.test(r.tier)).slice(0, 6))
  console.log(`  ${r.component}  (${r.tier}, ${r.confidence})`);

const bench = { profile: load("profile.json"), native: load("native.json"), wasm: load("wasm.json"), compare: load("compare.json") };
writeFileSync(join(here, "report.json"), JSON.stringify({
  generated: new Date().toISOString(), root,
  calibration: MEASURED, hypotheses: HYPOTHESES,
  benchInputs: Object.fromEntries(Object.entries(bench).map(([k, v]) => [k, !!v])),
  tiers: Object.fromEntries(Object.entries(tiers).map(([k, v]) => [k, v.length])),
  ranked: rows,
}, null, 2));
console.log(`\n→ tools/migration-analyzer/report.json`);
console.log(`Tiers are calibrated against measured results; a HIGH VALUE with no ✓ is still a hypothesis.`);
