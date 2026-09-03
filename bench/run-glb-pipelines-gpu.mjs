// GPU / FIRST-FRAME / STEADY-STATE / LOAD-TO-RENDER — PIPELINE A vs PIPELINE B,
// in a real browser (Chromium WebGPU / WARP on the bench host).
//
//   npm run build && npx playwright install chromium
//   node bench/run-glb-pipelines-gpu.mjs
//
// Measures, per fixture per pipeline: decode, instantiate (image decode +
// material/texture upload), first frame (incl. GPU buffer upload), steady-state
// frame, GPU time, FPS, draw calls, total load-to-first-render. Classifies the
// workload (CPU- / GPU- / upload- / startup-bound). Not a black-box FPS claim.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { chromium } from "playwright";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");
const MIME = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".glb": "model/gltf-binary" };

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(req.url.split("?")[0]);
    const abs = p.startsWith("/fixtures/") ? join(root, "native/tests/fixtures/glb", p.slice(10)) : join(root, "web", p.replace(/^\//, ""));
    const buf = await readFile(abs);
    res.writeHead(200, { "content-type": MIME[extname(p)] || "application/octet-stream", "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" });
    res.end(buf);
  } catch { res.writeHead(404); res.end("404"); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const fxDir = join(root, "native/tests/fixtures/glb");
const fixtures = [
  "tri.glb", "two-boxes.glb",
  ...(existsSync(join(fxDir, "real")) ? readdirSync(join(fxDir, "real")).filter((f) => f.endsWith(".glb") && !f.startsWith("_")).map((f) => "real/" + f) : []),
];

const browser = await chromium.launch({ args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--use-angle=default", "--ignore-gpu-blocklist", "--disable-dawn-features=use_dxc"] });

const PIPES = [
  { tag: "A", query: "geom=wasm&tangents=1" },
  { tag: "B", query: "parser=native&tangents=1" },
];

// warm the browser: module instantiate + WARP shader compile + image codec all
// pay a big one-off on the first page — do it on a throwaway before measuring.
{
  const w = await browser.newPage({ viewport: { width: 900, height: 600 } });
  try {
    await w.goto(`http://localhost:${port}/harness/glb-viewer.html?url=/fixtures/real/BoxTextured.glb&geom=wasm&spin=0`);
    await w.waitForFunction("window.__ready === true", { timeout: 60000 });
    await w.evaluate(async () => { for (let i = 0; i < 10; i++) window.__viewer.engine.renderOnce(); });
  } catch {}
  await w.close();
}

const rows = [];
for (const fx of fixtures) {
  const rec = { fx, A: null, B: null };
  for (const pipe of PIPES) {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
    try {
      const nav0 = Date.now();
      await page.goto(`http://localhost:${port}/harness/glb-viewer.html?url=/fixtures/${fx}&${pipe.query}&spin=0`);
      await page.waitForFunction("window.__ready === true", { timeout: 60000 });
      const m = await page.evaluate(async () => {
        const v = window.__viewer, e = v.engine;
        const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] ?? 0; };
        // first frame (includes lazy GPU vertex/index upload)
        const f0 = performance.now();
        e.renderOnce();
        await e.renderer.device.queue.onSubmittedWorkDone();
        const firstFrameMs = performance.now() - f0;
        // steady state
        const cpu = [], gpu = [];
        for (let i = 0; i < 80; i++) {
          const st = e.renderOnce();
          if (i >= 20) { cpu.push(st.cpuFrameMs); if (st.gpuMs) gpu.push(st.gpuMs); }
        }
        await e.renderer.device.queue.onSubmittedWorkDone();
        // in-page STEADY decode for both pipelines (module + codec already warm)
        const bytes = v.bytes;
        const decodeBoth = async (o) => {
          for (let i = 0; i < 4; i++) await window.__decodeGLB(bytes, o);      // warm
          const s = [];
          for (let i = 0; i < 8; i++) { const t = performance.now(); await window.__decodeGLB(bytes, o); s.push(performance.now() - t); }
          return med(s);
        };
        const decJs = await decodeBoth({ geometry: "js" });
        const decAuto = await decodeBoth({ geometry: "auto" });
        const decNative = await decodeBoth({ parser: "native" });
        const t = v.result.timing;
        return {
          geometryPath: v.asset.stats.geometryPath,
          crossings: v.asset.stats.wasmCrossings,
          verts: v.asset.stats.vertices, prims: v.asset.stats.primitives, textures: v.asset.stats.textures,
          fetchMs: t.fetchMs, decodeMs: t.decodeMs,
          instantiateMs: t.instantiateMs ?? 0, imageDecodeMs: t.imageDecodeMs ?? 0, materialUploadMs: t.materialUploadMs ?? 0,
          steadyDecodeJsMs: decJs, steadyDecodeAutoMs: decAuto, steadyDecodeNativeMs: decNative,
          firstFrameMs, steadyCpuMs: med(cpu), steadyGpuMs: med(gpu), fps: Math.round(1000 / Math.max(0.001, med(cpu))),
          drawCalls: e.renderer.drawCalls,
          nativeStats: v.asset.nativeStats ?? null,
        };
      });
      m.navToReadyMs = Date.now() - nav0;
      m.loadToRenderMs = m.fetchMs + m.decodeMs + m.instantiateMs + m.firstFrameMs;
      // classify
      m.bound = m.firstFrameMs > 4 * m.steadyCpuMs ? "upload-bound"
        : m.steadyGpuMs > m.steadyCpuMs * 1.3 ? "GPU-bound"
        : m.steadyCpuMs > m.steadyGpuMs * 1.3 ? "CPU-bound" : "balanced";
      m.errs = errs;
      rec[pipe.tag] = m;
    } catch (e) { rec[pipe.tag] = { error: e.message, errs }; }
    await page.close();
  }
  rows.push(rec);

  const f = (x, d = 2) => (x == null ? "—" : x.toFixed(d));
  console.log(`\n${fx}`);
  for (const tag of ["A", "B"]) {
    const m = rec[tag];
    if (!m || m.error) { console.log(`  ${tag}: FAIL ${m?.error ?? ""}`); continue; }
    console.log(`  ${tag} [${m.geometryPath}]  steady-decode: js ${f(m.steadyDecodeJsMs)} · auto ${f(m.steadyDecodeAutoMs)} · native ${f(m.steadyDecodeNativeMs)}   ` +
      `instantiate ${f(m.instantiateMs)} (img ${f(m.imageDecodeMs)} + mat ${f(m.materialUploadMs)})`);
    console.log(`       first-frame ${f(m.firstFrameMs)}  steady cpu ${f(m.steadyCpuMs, 3)} gpu ${f(m.steadyGpuMs, 2)}  fps ${m.fps}  draws ${m.drawCalls}  -> ${m.bound}`);
  }
  const A = rec.A, B = rec.B;
  if (A && B && !A.error && !B.error) {
    console.log(`  A/B: same draws ${A.drawCalls === B.drawCalls}, same verts ${A.verts === B.verts}, ` +
      `load-to-render ${f(A.loadToRenderMs)} vs ${f(B.loadToRenderMs)} ms  (B/A ${f(B.loadToRenderMs / A.loadToRenderMs)}x)`);
  }
}

await browser.close();
server.close();
writeFileSync(join(__dir, "results", "glb-pipelines-gpu.json"), JSON.stringify({ kind: "glb-pipelines-gpu", rows }, null, 2));
console.log(`\nwrote bench/results/glb-pipelines-gpu.json`);
