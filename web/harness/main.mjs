// Browser harness: runs one backend on one scene, renders the visible set with
// WebGPU, collects CPU frame time / eval time / FPS / GPU time, and exposes the
// summary on window.__result for Playwright (bench/run-browser.mjs) to read.
//
//   index.html?backend=js|cpp&scene=manyObjects&scale=1&frames=600&warmup=120

import { buildScene, makeViewProj } from "./scene-gen.mjs";
import { Submitter } from "../webgpu/Submitter.mjs";
import { JsBackend } from "../backend/JsBackend.mjs";
import { WasmBackend } from "../backend/WasmBackend.mjs";

const qs = new URLSearchParams(location.search);
const backendKind = qs.get("backend") || "js";
const sceneKind = qs.get("scene") || "manyObjects";
const scale = Number(qs.get("scale") || 1);
const frames = Number(qs.get("frames") || 600);
const warmup = Number(qs.get("warmup") || 120);
const hud = document.getElementById("hud");
const canvas = document.getElementById("c");
canvas.width = Math.min(1600, innerWidth); canvas.height = Math.min(900, innerHeight);

function pctl(a, p) { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; }
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

async function run() {
  if (!navigator.gpu) { report({ error: "no WebGPU" }); hud.textContent = "no WebGPU in this browser"; return; }

  const { scene, camera, animate } = buildScene(sceneKind, scale);
  const aspect = canvas.width / canvas.height;
  const t0 = performance.now();

  const backend = backendKind === "cpp" ? new WasmBackend() : new JsBackend();
  await backend.init();
  const initMs = performance.now() - t0;

  const tUp = performance.now();
  backend.upload(scene);
  const uploadMs = performance.now() - tUp;

  const sub = new Submitter();
  await sub.init(canvas, scene.count);

  const evalMs = [], frameMs = [], gpuMs = [];
  const perfMem = () => (performance.memory ? performance.memory.usedJSHeapSize : 0);
  const memBefore = perfMem();

  let f = 0;
  const trs = scene.trs;
  await new Promise((resolve) => {
    function loop() {
      const fStart = performance.now();
      if (animate) {
        // cheap per-frame local-transform churn -> exercises transform propagation
        for (let i = 0; i < scene.count; i += 3) trs[i * 10 + 1] += Math.sin(f * 0.05 + i) * 0.01;
        backend.updateTransforms?.(null, trs);
      }
      const vp = makeViewProj(camera.pos, [0, 0, 0], aspect, camera.fov);

      const e0 = performance.now();
      const res = backend.evaluateFrame(vp, 0);
      const e1 = performance.now();

      sub.render(vp, res);
      const fEnd = performance.now();

      if (f >= warmup) {
        evalMs.push(e1 - e0);
        frameMs.push(fEnd - fStart);
        if (sub.gpuMs) gpuMs.push(sub.gpuMs);
      }
      hud.textContent =
        `${backendKind} · ${sceneKind} ×${scale}\n` +
        `frame ${f}/${warmup + frames}\n` +
        `visible ${res.visibleCount}/${scene.count}\n` +
        `eval ${(e1 - e0).toFixed(3)} ms\n` +
        `frame ${(fEnd - fStart).toFixed(3)} ms`;

      if (++f >= warmup + frames) return resolve();
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  });

  const result = {
    backend: backendKind, scene: sceneKind, scale, meshCount: scene.count,
    frames, gpu: { adapter: sub.adapter?.info?.description || "?", timestamps: sub.canTimestamp },
    initMs, uploadMs,
    evalMs: { mean: mean(evalMs), median: pctl(evalMs, 0.5), p95: pctl(evalMs, 0.95) },
    frameMs: { mean: mean(frameMs), median: pctl(frameMs, 0.5), p95: pctl(frameMs, 0.95) },
    fps: 1000 / pctl(frameMs, 0.5),
    gpuMs: gpuMs.length ? { median: pctl(gpuMs, 0.5), p95: pctl(gpuMs, 0.95) } : null,
    jsHeapGrowthBytes: perfMem() - memBefore,
  };
  report(result);
  hud.textContent = JSON.stringify(result, null, 1);
}

function report(r) { window.__result = r; window.__done = true; }
run().catch((e) => { window.__result = { error: String(e && e.stack || e) }; window.__done = true; hud.textContent = String(e); });
