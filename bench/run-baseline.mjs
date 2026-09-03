// Stage 3: baseline benchmark. JS-only (real Babylon.js). No conclusions about
// C++ here — this just establishes where the time goes today.
//
//   node --expose-gc bench/run-baseline.mjs [sceneKind ...]

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runBenchmark } from "./harness.mjs";
import { SCENES, SCENE_KINDS, frameOf } from "./scenes.mjs";
import { fmt } from "./stats.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dir, "results");
mkdirSync(outDir, { recursive: true });

const requested = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const kinds = requested.length ? requested : SCENE_KINDS;

const env = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  cpus: (await import("node:os")).cpus()?.[0]?.model,
  date: new Date().toISOString(),
  gc: typeof globalThis.gc === "function",
};

console.log("baseline env:", env);
if (!env.gc) console.warn("!! run with --expose-gc for memory/GC metrics");

const results = [];
for (const kind of kinds) {
  if (!SCENES[kind]) { console.warn("unknown scene:", kind); continue; }
  process.stdout.write(`\n[${kind}] building... `);
  const t0 = performance.now();
  const probe = SCENES[kind]();
  const createMs = performance.now() - t0;
  const meshCount = probe.scene.meshes.length;
  probe.engine.dispose();
  process.stdout.write(`${meshCount} meshes, sceneCreate=${fmt(createMs)}ms — benchmarking...\n`);

  const res = await runBenchmark({
    name: kind,
    warmupFrames: Number(process.env.BCPP_WARMUP || 60),
    measureFrames: Number(process.env.BCPP_FRAMES || 250),
    repeats: Number(process.env.BCPP_REPEATS || 3),
    setup: () => SCENES[kind](),
    frame: (ctx) => ctx.scene.render(),
    teardown: (ctx) => ctx.engine.dispose(),
  });

  res.sceneCreateMs = createMs;
  res.meshCount = meshCount;
  results.push(res);

  const f = res.frameTimeMs;
  console.log(
    `  frame: median=${fmt(f.median)}ms p95=${fmt(f.p95)}ms fps=${fmt(res.fps, 1)} ` +
    `cv=${fmt(f.cv)} heapΔ=${fmt(res.heapGrowthBytes / 1e6)}MB ` +
    `gc=${res.gc.count} (${fmt(res.gc.totalMs)}ms)`,
  );
}

const payload = { kind: "baseline", env, results };
writeFileSync(join(outDir, "baseline.json"), JSON.stringify(payload, null, 2));
console.log(`\nwrote ${join(outDir, "baseline.json")}`);
