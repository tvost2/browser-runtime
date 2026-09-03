// RENDER REAL — load each GLB fixture through the full runtime pipeline
//   GLB → Asset → C++/WASM → AssetManager.instantiate → Scene → WebGPU
// in Chromium, screenshot it, and run structural checks. Numerical equivalence
// passing is NOT enough (see F-009) — this looks at the pixels.
//
//   npm run build && npx playwright install chromium
//   node bench/run-glb-render.mjs

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
    let p = decodeURIComponent(req.url.split("?")[0]);
    // /fixtures/* → native/tests/fixtures/glb/*   ·   everything else → web/*
    const abs = p.startsWith("/fixtures/")
      ? join(root, "native/tests/fixtures/glb", p.slice("/fixtures/".length))
      : join(root, "web", p.replace(/^\//, ""));
    const buf = await readFile(abs);
    res.writeHead(200, { "content-type": MIME[extname(p)] || "application/octet-stream", "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" });
    res.end(buf);
  } catch { res.writeHead(404); res.end("404 " + req.url); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const fxDir = join(root, "native/tests/fixtures/glb");
const fixtures = [
  "tri.glb", "two-boxes.glb",
  ...(existsSync(join(fxDir, "real")) ? readdirSync(join(fxDir, "real")).filter((f) => f.endsWith(".glb")).map((f) => "real/" + f) : []),
];

const browser = await chromium.launch({
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--use-angle=default",
         "--ignore-gpu-blocklist", "--disable-dawn-features=use_dxc"],
});

// render one fixture with the given query params; returns { r, pngBuf, errs }
async function renderOne(fx, query, shotPath) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await page.goto(`http://localhost:${port}/harness/glb-viewer.html?url=/fixtures/${fx}&${query}`);
  let r;
  try {
    await page.waitForFunction("window.__ready === true", { timeout: 60000 });
    await page.evaluate(async () => { for (let k = 0; k < 20; k++) { await new Promise((res) => requestAnimationFrame(res)); window.__viewer.engine.renderOnce(); } await window.__viewer.engine.renderer.device.queue.onSubmittedWorkDone(); });
    await page.waitForTimeout(300);
    r = await page.evaluate(async () => {
      const v = window.__viewer, e = v.engine, s = v.scene;
      const dev = e.renderer.device;
      dev.pushErrorScope("validation");
      const aspect = e.canvas.width / e.canvas.height;
      // fixed camera pose for A/B comparability (kill the orbit spin)
      s.camera.position = [v.aabb.max[0] + (v.aabb.max[0] - v.aabb.min[0]) + 1, v.aabb.max[1], v.aabb.max[2] + (v.aabb.max[2] - v.aabb.min[2]) + 1];
      const fr = s.evaluate(aspect);
      e.renderer.render(s.camera.viewProj(aspect), fr);
      await dev.queue.onSubmittedWorkDone();
      const gpuErr = await dev.popErrorScope();
      const vp = s.camera.viewProj(aspect); let onScreen = 0; const zs = [];
      for (let k = 0; k < fr.visibleCount; k++) {
        const b = k * 16, x = fr.instanceWorld[b + 12], y = fr.instanceWorld[b + 13], z = fr.instanceWorld[b + 14];
        const w = x * vp[3] + y * vp[7] + z * vp[11] + vp[15];
        const nx = (x * vp[0] + y * vp[4] + z * vp[8] + vp[12]) / w;
        const ny = (x * vp[1] + y * vp[5] + z * vp[9] + vp[13]) / w;
        const nz = (x * vp[2] + y * vp[6] + z * vp[10] + vp[14]) / w;
        if (nx > -1.2 && nx < 1.2 && ny > -1.2 && ny < 1.2 && nz > -0.05 && nz < 1.05) onScreen++;
        if (k % Math.max(1, fr.visibleCount >> 5) === 0) zs.push(nz);
      }
      zs.sort((a, b) => a - b);
      return {
        gpuErr: gpuErr ? gpuErr.message : null,
        stats: e.stats, drawCalls: e.renderer.drawCalls,
        assetStats: v.asset.stats, ignored: v.asset.ignored,
        aabb: v.aabb, near: s.camera.near, far: s.camera.far,
        onScreen, visible: fr.visibleCount, ndcZMedian: zs[zs.length >> 1] ?? 0,
      };
    });
  } catch (e) { r = { error: e.message }; }
  let pngBuf = Buffer.alloc(0);
  for (let k = 0; k < 3 && pngBuf.length < 9000; k++) {
    await page.evaluate(async () => { for (let j = 0; j < 6; j++) { await new Promise((r) => requestAnimationFrame(r)); window.__viewer.engine.renderOnce(); } await window.__viewer.engine.renderer.device.queue.onSubmittedWorkDone(); });
    await page.waitForTimeout(250);
    const b = await page.screenshot({ path: shotPath });
    if (b.length > pngBuf.length) pngBuf = b;
  }
  await page.close();
  return { r, pngBuf, errs };
}

// crude PNG similarity: decode both to raw pixels via a headless canvas page and
// compare. (playwright screenshots are PNG; do a byte-histogram + size proxy.)
async function pixelDelta(aBuf, bBuf) {
  const page = await browser.newPage();
  const toRGBA = async (b64) => page.evaluate(async (u) => {
    const img = new Image(); img.src = u;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height); const x = c.getContext("2d");
    x.drawImage(img, 0, 0); const d = x.getImageData(0, 0, img.width, img.height).data;
    return Array.from(d.filter((_, i) => i % 40 === 0)); // sample
  }, "data:image/png;base64," + b64);
  const a = await toRGBA(aBuf.toString("base64"));
  const b = await toRGBA(bBuf.toString("base64"));
  await page.close();
  if (a.length !== b.length || !a.length) return 1;
  let sum = 0; for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length / 255; // mean abs channel diff, 0..1
}

const PIPES = [
  { tag: "A-wasm", query: "geom=wasm&tangents=1", label: "pipeline A (JS front-end + WASM geometry)" },
  { tag: "B-native", query: "parser=native&tangents=1", label: "pipeline B (full native decode)" },
];

let allPass = true;
const report = [];
for (const fx of fixtures) {
  const base = fx.replace(/[\\/]/g, "_").replace(".glb", "");
  const runs = {};
  for (const pipe of PIPES) {
    const shot = join(__dir, "results", `glb-${base}__${pipe.tag}.png`);
    runs[pipe.tag] = { ...(await renderOne(fx, pipe.query, shot)), shot, pipe };
  }
  // also keep the legacy single screenshot name (pipeline B) for the docs
  const legacyShot = join(__dir, "results", `glb-${base}.png`);
  try { writeFileSync(legacyShot, runs["B-native"].pngBuf); } catch {}

  const delta = (runs["A-wasm"].pngBuf.length && runs["B-native"].pngBuf.length)
    ? await pixelDelta(runs["A-wasm"].pngBuf, runs["B-native"].pngBuf) : 1;

  const fxChecks = [];
  for (const pipe of PIPES) {
    const { r, pngBuf, errs } = runs[pipe.tag];
    if (r.error) { fxChecks.push([`${pipe.tag}: loaded`, false, r.error]); continue; }
    const wantPath = pipe.tag === "B-native" ? "native" : "wasm";
    fxChecks.push([`${pipe.tag}: geometry path = ${wantPath}`, r.assetStats.geometryPath === wantPath, r.assetStats.geometryPath]);
    fxChecks.push([`${pipe.tag}: visible > 0`, r.visible > 0, r.visible]);
    fxChecks.push([`${pipe.tag}: most instances on screen`, r.onScreen >= Math.max(1, r.visible * 0.5), `${r.onScreen}/${r.visible}`]);
    fxChecks.push([`${pipe.tag}: draw calls 1..prims`, r.drawCalls >= 1 && r.drawCalls <= Math.max(1, r.assetStats.primitives), `${r.drawCalls}/${r.assetStats.primitives}`]);
    fxChecks.push([`${pipe.tag}: depth headroom`, r.ndcZMedian < 0.9997, `z=${r.ndcZMedian.toFixed(4)}`]);
    fxChecks.push([`${pipe.tag}: not black (PNG > 9 KB)`, pngBuf.length > 9000, `${(pngBuf.length / 1024).toFixed(0)} KB`]);
    fxChecks.push([`${pipe.tag}: no GPU errors`, !r.gpuErr, r.gpuErr || "clean"]);
    fxChecks.push([`${pipe.tag}: no page errors`, errs.length === 0, errs[0] || "clean"]);
  }
  // RENDER EQUIVALENCE — the two pipelines must agree
  const a = runs["A-wasm"].r, b = runs["B-native"].r;
  if (!a.error && !b.error) {
    fxChecks.push(["A/B: same vertex count", a.assetStats.vertices === b.assetStats.vertices, `${a.assetStats.vertices} vs ${b.assetStats.vertices}`]);
    fxChecks.push(["A/B: same draw calls", a.drawCalls === b.drawCalls, `${a.drawCalls} vs ${b.drawCalls}`]);
    fxChecks.push(["A/B: same visible count", a.visible === b.visible, `${a.visible} vs ${b.visible}`]);
    fxChecks.push(["A/B: screenshots match (mean channel Δ < 0.03)", delta < 0.03, `Δ=${delta.toFixed(4)}`]);
  }

  const pass = fxChecks.every((c) => c[1]);
  allPass &&= pass;
  report.push({ fx, pass, checks: fxChecks, a, b, pixelDelta: delta });

  console.log(`\n${fx}  ${pass ? "PASS" : "FAIL"}`);
  for (const [n, good, d] of fxChecks) console.log(`  ${good ? "✓" : "✗"} ${n} — ${d}`);
}

await browser.close();
server.close();
writeFileSync(join(__dir, "results", "glb-render.json"), JSON.stringify({ kind: "glb-render", allPass, report }, null, 2));
console.log(`\n${allPass ? "GLB RENDER: PASS" : "GLB RENDER: FAIL"}  (screenshots: bench/results/glb-*__A-wasm.png / __B-native.png)`);
process.exit(allPass ? 0 : 1);
