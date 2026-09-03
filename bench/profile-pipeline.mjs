// Stage 4: per-phase profiling of Babylon's per-frame CPU pipeline.
//
// Splits a frame into: animations | worldMatrix | frustumCulling |
// activeMeshesEval(other) | renderRest, using scene observables plus targeted
// monkey-patches with call counters. Instrumentation overhead is measured and
// reported (subtract-and-report, do not hide it).
//
//   node --expose-gc bench/profile-pipeline.mjs [sceneKind ...]

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { SCENES, SCENE_KINDS } from "./scenes.mjs";
import { summarize, fmt } from "./stats.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dir, "results");
mkdirSync(outDir, { recursive: true });

const now = () => performance.now();

// ---- global accumulators (reset per frame) ----
const acc = {
  worldMatrixMs: 0, worldMatrixCalls: 0,
  frustumMs: 0, frustumCalls: 0,
  instrCalls: 0, // # of now() pairs charged, for overhead estimate
};

function patch() {
  const cwmT = TransformNode.prototype.computeWorldMatrix;
  TransformNode.prototype.computeWorldMatrix = function (force) {
    const a = now();
    const r = cwmT.call(this, force);
    acc.worldMatrixMs += now() - a;
    acc.worldMatrixCalls++;
    acc.instrCalls++;
    return r;
  };

  const iif = AbstractMesh.prototype.isInFrustum;
  AbstractMesh.prototype.isInFrustum = function (planes) {
    const a = now();
    const r = iif.call(this, planes);
    acc.frustumMs += now() - a;
    acc.frustumCalls++;
    acc.instrCalls++;
    return r;
  };
}

// crude per-call overhead of one now()-pair, measured on this machine
function measureNowPairOverhead(iters = 200000) {
  let sink = 0;
  const s = now();
  for (let i = 0; i < iters; i++) { const a = now(); sink += a; acc; }
  const total = now() - s;
  return total / iters; // ms per single now() call ~ half a pair
}

async function profileScene(kind, frames = 400, warmup = 90) {
  const ctx = SCENES[kind]();
  const scene = ctx.scene;

  const phase = { animations: [], activeEval: [], renderRest: [], total: [], worldMatrix: [], frustum: [] };
  const counts = { worldMatrixCalls: [], frustumCalls: [] };

  let tEvalStart = 0, tEvalEnd = 0, tFrameStart = 0;

  // "pre-eval" = everything before active-mesh evaluation each frame:
  // animation interpolation + skeleton prep + onBeforeRender observers.
  scene.onBeforeAnimationsObservable.add(() => { tFrameStart = now(); });
  scene.onBeforeActiveMeshesEvaluationObservable.add(() => { tEvalStart = now(); acc.worldMatrixMs = 0; acc.worldMatrixCalls = 0; acc.frustumMs = 0; acc.frustumCalls = 0; acc.instrCalls = 0; });
  scene.onAfterActiveMeshesEvaluationObservable.add(() => { tEvalEnd = now(); });
  scene.onAfterRenderObservable.add(() => {
    const tEnd = now();
    phase.animations.push(tEvalStart - tFrameStart);
    phase.activeEval.push(tEvalEnd - tEvalStart);
    phase.renderRest.push(tEnd - tEvalEnd);
    phase.total.push(tEnd - tFrameStart);
    phase.worldMatrix.push(acc.worldMatrixMs);
    phase.frustum.push(acc.frustumMs);
    counts.worldMatrixCalls.push(acc.worldMatrixCalls);
    counts.frustumCalls.push(acc.frustumCalls);
  });

  for (let i = 0; i < warmup; i++) scene.render();
  if (globalThis.gc) globalThis.gc();
  // discard warmup samples
  for (const k of Object.keys(phase)) phase[k].length = 0;
  for (const k of Object.keys(counts)) counts[k].length = 0;

  for (let i = 0; i < frames; i++) scene.render();

  const meshCount = scene.meshes.length;
  ctx.engine.dispose();

  const nowPair = measureNowPairOverhead();
  const instrOverheadMs = median(counts.worldMatrixCalls.map((_, i) =>
    (counts.worldMatrixCalls[i] + counts.frustumCalls[i]) * nowPair * 2));

  const S = (a) => summarize(a);
  return {
    kind, meshCount, frames,
    nowCallOverheadMs: nowPair,
    estInstrOverheadPerFrameMs: instrOverheadMs,
    phases: {
      total: S(phase.total),
      animations: S(phase.animations),
      activeMeshesEval: S(phase.activeEval),
      renderRest: S(phase.renderRest),
      worldMatrix_in_eval: S(phase.worldMatrix),
      frustumCulling_in_eval: S(phase.frustum),
    },
    calls: {
      worldMatrix: median(counts.worldMatrixCalls),
      frustum: median(counts.frustumCalls),
    },
  };
}

function median(arr) { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; }

const requested = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const kinds = requested.length ? requested : SCENE_KINDS;

patch();

const out = [];
for (const kind of kinds) {
  if (!SCENES[kind]) continue;
  process.stdout.write(`profiling ${kind}... `);
  const r = await profileScene(kind);
  out.push(r);
  const p = r.phases;
  console.log(
    `\n  total=${fmt(p.total.median)}ms  anim=${fmt(p.animations.median)}  ` +
    `eval=${fmt(p.activeMeshesEval.median)} [wm=${fmt(p.worldMatrix_in_eval.median)} x${r.calls.worldMatrix}, ` +
    `cull=${fmt(p.frustumCulling_in_eval.median)} x${r.calls.frustum}]  ` +
    `renderRest=${fmt(p.renderRest.median)}  (instr overhead ~${fmt(r.estInstrOverheadPerFrameMs)}ms)`,
  );
}

const env = {
  node: process.version, platform: process.platform, arch: process.arch,
  cpus: (await import("node:os")).cpus()?.[0]?.model, date: new Date().toISOString(),
};
writeFileSync(join(outDir, "profile.json"), JSON.stringify({ kind: "profile", env, results: out }, null, 2));
console.log(`\nwrote ${join(outDir, "profile.json")}`);
