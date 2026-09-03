// Harness for the incremental-render benchmark. A grid of boxes; the driver
// (bench/run-renderer-gpu.mjs) picks the per-frame scenario and reads back
// engine.stats + renderer.lastUploadBytes + the eval stage timings.
//
//   cull-bench.html?count=100000&strategy=4
//     strategy: 0 Standard · 3 Bvh · 4 Auto (default)

import { Engine, box } from "../dist/engine.js";

const qs = new URLSearchParams(location.search);
const COUNT = Number(qs.get("count") || 100000);
const STRAT = Number(qs.get("strategy") ?? 4);
const NMESH = Math.max(1, Number(qs.get("meshes") || 1)); // distinct geometries → distinct draw buckets
const STRAT_NAMES = ["Standard", "Sphere", "None", "Bvh", "Auto", "Gpu"];
if (qs.get("scenario")) window.__scenario = qs.get("scenario");
if (qs.get("moverRatio")) window.__moverRatio = Number(qs.get("moverRatio"));

function jbox(seed) {
  const b = box(1);
  const p = b.positions.slice();
  let s = (seed * 2654435761) >>> 0;
  for (let i = 0; i < p.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; p[i] += (s / 2 ** 32 - 0.5) * 0.02; }
  return { positions: p, indices: b.indices.slice() };
}

const canvas = document.getElementById("c");
const hud = document.getElementById("hud");
canvas.width = 1280; canvas.height = 720;

const engine = await Engine.create(canvas);
const scene = engine.createScene();
scene.cullStrategy = STRAT;

const meshIds = [];
for (let k = 0; k < NMESH; k++) meshIds.push(scene.registerMesh(NMESH === 1 ? box(1) : jbox(k + 1)));
const R = ((s) => () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)(0xBEEF + COUNT);
const spread = Math.cbrt(COUNT) * 30;
scene.createEntities(COUNT, (e, i) => {
  e.setMesh(meshIds[i % NMESH]);
  e.transform.position.set((R() - 0.5) * spread, (R() - 0.5) * spread, (R() - 0.5) * spread);
  const s = 0.6 + R() * 1.2;
  e.transform.scaling.set(s, s, s);
});
scene.camera.fovY = 0.9;
scene.camera.fit(spread * 0.55);
const camRad = spread * 0.62;
scene.camera.position = [camRad, spread * 0.1, 0];

// spin phases for the "transform" scenarios
const spin = new Float32Array(COUNT);
for (let i = 0; i < COUNT; i++) spin[i] = 0.2 + R() * 1.5;

let camAngle = 0;
let scenario = "static";
let moverCount = 0;
let t = 0;

// the driver sets window.__scenario each phase
function apply(dtMs) {
  t += Math.min(dtMs, 50) / 1000;
  const s = window.__scenario || "static";
  const mv = window.__moverRatio ?? 0;
  const C = engine.core.components;

  if (s === "camera" || s === "camera+move") {
    camAngle += 0.01;
    scene.camera.position = [Math.cos(camAngle) * camRad, spread * 0.1, Math.sin(camAngle) * camRad];
  }
  if (s === "transform" || s === "camera+move" || s === "churn") {
    const n = s === "churn" ? COUNT : Math.max(1, Math.round(COUNT * mv));
    const step = Math.max(1, Math.floor(COUNT / n));
    for (let k = 0; k < n; k++) {
      const i = (k * step) % COUNT;
      C.pos[i * 3 + 1] += Math.sin(t + spin[i]) * 0.05;
      C.dirty[i] = 1;
    }
  }
}

engine.onBeforeRender(({ dtMs }) => apply(dtMs));

let acc = 0, accN = 0;
function frame() {
  const st = engine.renderOnce();
  window.__bench?.collect?.();
  acc += st.cpuFrameMs; accN++;
  if (accN >= 20) {
    const upB = STRAT === 5 ? (engine.renderer.lastGpuUploadBytes ?? 0) : engine.renderer.lastUploadBytes;
    hud.textContent =
      `count ${COUNT.toLocaleString()}  strategy ${STRAT_NAMES[STRAT] ?? STRAT}\n` +
      `scenario ${window.__scenario || "static"}\n` +
      `cpu ${(acc / accN).toFixed(3)} ms   gpu ${(st.gpuMs ?? 0).toFixed(2)} ms   fps ${st.fps.toFixed(0)}\n` +
      `visible ${st.visible.toLocaleString()}   draws ${st.drawCalls}\n` +
      `upload ${(upB / 1024).toFixed(0)} KB`;
    acc = 0; accN = 0;
  }
  requestAnimationFrame(frame);
}
frame();

// expose for the driver: it sets __scenario / __moverRatio, spins ~40 frames,
// then reads sample() (medians accumulated in the render loop)
const acc2 = { cpu: [], gpu: [], up: [], tr: [], cu: [], li: [], reb: [], dirty: [] };
const _origFrame = frame;
window.__bench = {
  engine, scene,
  reset() { for (const k in acc2) acc2[k].length = 0; },
  collect() {
    const st = engine.stats;
    const ev = scene._lastFrame;
    acc2.cpu.push(st.cpuFrameMs); acc2.gpu.push(st.gpuMs ?? 0);
    acc2.up.push(STRAT === 5 ? (engine.renderer.lastGpuUploadBytes ?? 0) : engine.renderer.lastUploadBytes);
    if (ev) {
      acc2.tr.push(ev.stats.transformUs); acc2.cu.push(ev.stats.cullUs); acc2.li.push(ev.stats.listUs);
      acc2.reb.push(ev.stats.listRebuilt); acc2.dirty.push(ev.stats.dirtySlots);
    }
  },
  result() {
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] ?? 0; };
    const ev = scene._lastFrame;
    return {
      cpuFrameMs: med(acc2.cpu), gpuMs: med(acc2.gpu), fps: 1000 / med(acc2.cpu),
      uploadBytesMed: med(acc2.up), uploadBytesMax: Math.max(0, ...acc2.up),
      transformUs: med(acc2.tr), cullUs: med(acc2.cu), listUs: med(acc2.li),
      listRebuiltFrac: acc2.reb.length ? acc2.reb.reduce((a, b) => a + b, 0) / acc2.reb.length : 1,
      dirtySlots: med(acc2.dirty),
      visible: ev?.visibleCount ?? 0, drawCalls: engine.renderer.drawCalls,
      transformsRecomputed: ev?.stats.transformsRecomputed ?? 0,
      wasmHeapMB: engine.stats.wasmHeapMB, jsHeapMB: engine.stats.jsHeapMB,
    };
  },
};
// GPU-cull equivalence: the visible id set the compute shader produced,
// vs the CPU Standard path on the identical frame.
window.__equiv = async () => {
  const savedStrat = scene.cullStrategy, savedScen = window.__scenario;
  window.__scenario = "frozen"; // apply() no-ops → identical camera for both passes
  // nudge every entity so the transform pass fully repopulates world state, then
  // let both strategies see the SAME frame
  scene.cullStrategy = 0; engine.core.markAllDirty(); engine.renderOnce(); engine.renderOnce();
  const cpu = new Set(scene._lastFrame.visibleIds);
  scene.cullStrategy = 5; engine.core.markAllDirty(); engine.renderOnce(); engine.renderOnce();
  const gpuIds = await engine.renderer.readbackGpuVisible();
  const gpu = new Set(gpuIds);
  scene.cullStrategy = savedStrat; window.__scenario = savedScen;
  let missing = 0, extra = 0;
  for (const id of cpu) if (!gpu.has(id)) missing++;
  for (const id of gpu) if (!cpu.has(id)) extra++;
  return { cpu: cpu.size, gpu: gpu.size, missing, extra };
};
window.__ready = true;
