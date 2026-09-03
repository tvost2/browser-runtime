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

let allPass = true;
const report = [];
for (const fx of fixtures) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });

  // force the C++/WASM geometry path + tangent generation so the render test
  // exercises the native core end-to-end, all the way to the pixels (F-009).
  const url = `http://localhost:${port}/harness/glb-viewer.html?url=/fixtures/${fx}&geom=wasm&tangents=1`;
  await page.goto(url);

  let r;
  try {
    await page.waitForFunction("window.__ready === true", { timeout: 45000 });
    await page.evaluate(async () => { for (let k = 0; k < 20; k++) { await new Promise((res) => requestAnimationFrame(res)); window.__viewer.engine.renderOnce(); } await window.__viewer.engine.renderer.device.queue.onSubmittedWorkDone(); });
    await page.waitForTimeout(300);
    r = await page.evaluate(async () => {
      const v = window.__viewer, e = v.engine, s = v.scene;
      const dev = e.renderer.device;
      dev.pushErrorScope("validation");
      const aspect = e.canvas.width / e.canvas.height;
      const fr = s.evaluate(aspect);
      e.renderer.render(s.camera.viewProj(aspect), fr);
      await dev.queue.onSubmittedWorkDone();
      const gpuErr = await dev.popErrorScope();
      // NDC of visible instances
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
  } catch (e) {
    r = { error: e.message };
  }

  const shot = join(__dir, "results", `glb-${fx.replace(/[\\/]/g, "_").replace(".glb", "")}.png`);
  // best of a few — the compositor can race a heavy software-rendered frame
  let pngBytes = 0;
  for (let k = 0; k < 3 && pngBytes < 9000; k++) {
    await page.evaluate(async () => { for (let j = 0; j < 6; j++) { await new Promise((r) => requestAnimationFrame(r)); window.__viewer.engine.renderOnce(); } await window.__viewer.engine.renderer.device.queue.onSubmittedWorkDone(); });
    await page.waitForTimeout(250);
    pngBytes = Math.max(pngBytes, (await page.screenshot({ path: shot })).length);
  }
  await page.close();

  if (r.error) {
    console.log(`\n${fx}  FAIL — ${r.error}`);
    errs.slice(0, 3).forEach((x) => console.log("  " + x));
    allPass = false; report.push({ fx, pass: false, error: r.error, errs });
    continue;
  }

  const checks = [
    ["geometry path = wasm", r.assetStats.geometryPath === "wasm", r.assetStats.geometryPath],
    ["visible > 0", r.visible > 0, r.visible],
    ["most instances on screen", r.onScreen >= Math.max(1, r.visible * 0.5), `${r.onScreen}/${r.visible}`],
    ["draw calls ≥ 1, ≤ primitives", r.drawCalls >= 1 && r.drawCalls <= Math.max(1, r.assetStats.primitives), `${r.drawCalls} calls / ${r.assetStats.primitives} prims`],
    ["depth headroom (median z < 0.9997)", r.ndcZMedian < 0.9997, `z=${r.ndcZMedian.toFixed(4)} near=${r.near.toFixed(2)} far=${r.far.toFixed(0)}`],
    ["not a black screen (frame PNG > 9 KB; black ≈ 4 KB)", pngBytes > 9000, `${(pngBytes / 1024).toFixed(0)} KB`],
    ["no GPU validation errors", !r.gpuErr, r.gpuErr || "clean"],
    ["no page errors", errs.length === 0, errs[0] || "clean"],
  ];
  const pass = checks.every((c) => c[1]);
  allPass &&= pass;
  report.push({ fx, pass, checks, stats: r });

  console.log(`\n${fx}  ${pass ? "PASS" : "FAIL"}   ` +
    `[${r.assetStats.geometryPath}] verts=${r.assetStats.vertices} prims=${r.assetStats.primitives} tex=${r.assetStats.textures} ` +
    `draws=${r.drawCalls} eval=${r.stats.evalMs.toFixed(2)}ms gpu=${(r.stats.gpuMs ?? 0).toFixed(1)}ms`);
  for (const [n, good, d] of checks) console.log(`  ${good ? "✓" : "✗"} ${n} — ${d}`);
  if (r.ignored.length) console.log(`  · ignored: ${r.ignored.join(" · ")}`);
}

await browser.close();
server.close();
writeFileSync(join(__dir, "results", "glb-render.json"), JSON.stringify({ kind: "glb-render", allPass, report }, null, 2));
console.log(`\n${allPass ? "GLB RENDER: PASS" : "GLB RENDER: FAIL"}  (screenshots: bench/results/glb-*.png)`);
process.exit(allPass ? 0 : 1);
