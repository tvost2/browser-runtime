// Real demo: the public TS API driving the C++/WASM core + WebGPU.
// Orbital camera, thousands of animated entities, frustum culling, mesh batching.
//
//   ?count=10000&scene=field|hierarchy|culling
//
// Nothing here is a mock. `entity.mesh = box()`, `engine.start()` — that's it.

import { Engine, box, sphere } from "../dist/engine.js";

const qs = new URLSearchParams(location.search);
const COUNT = Number(qs.get("count") || 10000);
const MODE = qs.get("scene") || "field";

const canvas = document.getElementById("c");
const hud = document.getElementById("hud");
const dpr = Math.min(devicePixelRatio, 2);
canvas.width = Math.min(2560, innerWidth * dpr);
canvas.height = Math.min(1440, innerHeight * dpr);

const engine = await Engine.create(canvas);
const scene = engine.createScene();

const meshBox = box(1);
const meshSphere = sphere(1.2, 12);

// deterministic RNG
const R = (s => () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)(0xC0FFEE + COUNT);

const spread = MODE === "culling" ? 1100 : Math.cbrt(COUNT) * 16;
scene.createEntities(COUNT, (e, i) => {
  e.mesh = i % 3 === 0 ? meshSphere : meshBox;         // ← ergonomic setter, dedups
  if (MODE === "culling") {
    const th = R() * 6.283, ph = Math.acos(2 * R() - 1), rad = 300 + R() * 600;
    e.transform.position.set(rad * Math.sin(ph) * Math.cos(th), rad * Math.sin(ph) * Math.sin(th), rad * Math.cos(ph));
  } else {
    e.transform.position.set((R() - 0.5) * spread, (R() - 0.5) * spread, (R() - 0.5) * spread);
  }
  const s = 0.6 + R() * 1.6;
  e.transform.scaling.set(s, s, s);
});

if (MODE === "hierarchy")
  for (let i = 1; i < COUNT; i++) if (i % 8 !== 0) scene.entity(i).setParent(scene.entity(i - 1));

scene.camera.fovY = MODE === "culling" ? 0.5 : 0.9;
scene.camera.fit(spread * (MODE === "culling" ? 1.2 : 0.9)); // sane near/far for this scene

const spin = new Float32Array(COUNT);
for (let i = 0; i < COUNT; i++) spin[i] = 0.15 + R() * 1.4;

let t = 0;
engine.onBeforeRender(({ dtMs }) => {
  t += Math.min(dtMs, 50) / 1000;
  const rad = spread * 0.95 + 40;
  scene.camera.position = [Math.cos(t * 0.18) * rad, spread * 0.12, Math.sin(t * 0.18) * rad];
  // per-frame local-transform writes into WASM SoA — the realistic churn
  const C = engine.core.components;
  const N = MODE === "hierarchy" ? COUNT : Math.min(COUNT, 6000);
  for (let i = 0; i < N; i++) {
    const h = t * spin[i] * 0.5;
    C.rot[i * 4 + 1] = Math.sin(h);
    C.rot[i * 4 + 3] = Math.cos(h);
  }
});

const fmt = (x, d = 2) => (x == null ? "—" : x.toFixed(d));
let acc = 0, accE = 0, accN = 0;
function frame() {
  const st = engine.renderOnce();
  acc += st.cpuFrameMs; accE += st.evalMs; accN++;
  if (accN >= 20) {
    hud.innerHTML =
      `<b>bcpp engine</b>  ·  ${MODE}  ·  ${COUNT.toLocaleString()} entities\n` +
      `fps            <b>${fmt(st.fps, 0)}</b>\n` +
      `visible        ${st.visible.toLocaleString()} / ${st.entities.toLocaleString()}  (${fmt(100 * st.visible / st.entities, 0)}%)\n` +
      `eval (WASM)    <b>${fmt(accE / accN, 3)} ms</b>   ← 1 boundary crossing/frame\n` +
      `cpu frame      ${fmt(acc / accN, 3)} ms\n` +
      `gpu            ${fmt(st.gpuMs, 3)} ms\n` +
      `draw calls     ${st.drawCalls}   (batched by mesh)\n` +
      `wasm heap      ${fmt(st.wasmHeapMB, 1)} MB\n` +
      (st.jsHeapMB != null ? `js heap        ${fmt(st.jsHeapMB, 1)} MB\n` : "") +
      `wasm init      ${fmt(engine.wasmInitMs, 1)} ms  (one-off)\n` +
      `adapter        ${engine.renderer.adapter.info?.description || engine.renderer.adapter.info?.vendor || "?"}`;
    acc = accE = 0; accN = 0;
  }
  requestAnimationFrame(frame);
}
frame();
window.__engine = engine;
