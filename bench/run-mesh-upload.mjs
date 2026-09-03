// Measures the geometry-upload path: add meshes in batches (the digital-twin
// streaming pattern) and time uploadMeshes() per batch. With the append arena
// each batch should cost O(new data); a full-rebuild path costs O(all meshes)
// and the per-batch time climbs.
//
//   node bench/run-mesh-upload.mjs

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".map": "application/json" };
const server = createServer(async (req, res) => {
  try {
    const p = join(root, decodeURIComponent(req.url.split("?")[0]));
    res.writeHead(200, { "content-type": MIME[extname(p)] || "application/octet-stream" });
    res.end(await readFile(p));
  } catch { res.writeHead(404); res.end("404"); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--use-angle=default", "--ignore-gpu-blocklist", "--disable-dawn-features=use_dxc"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).split("\n")[0]));
page.on("console", (m) => { if (/webgpu:|error/i.test(m.text())) console.log("[console]", m.text().slice(0, 200)); });
await page.goto(`http://localhost:${port}/web/harness/mesh-upload-bench.html`);
await page.waitForFunction(() => window.__ready, { timeout: 30000 });

const BATCH = 150;
const BATCHES = 24;
const rows = [];
for (let i = 0; i < BATCHES; i++) {
  // a few frames to let the GPU settle between measurements
  const r = await page.evaluate((n) => window.addBatch(n), BATCH);
  rows.push(r);
  await page.waitForTimeout(60);
}

console.log(`\n  batch = ${BATCH} unique meshes (~40 verts each), ${BATCHES} batches\n`);
console.log("  meshes   build   upload   render   geomKB   (uploadMs is the arena append)");
for (const r of rows) {
  console.log(
    `  ${String(r.total).padStart(6)}  ${String(r.buildMs).padStart(6)}  ${String(r.uploadMs).padStart(7)}  ${String(r.renderMs).padStart(6)}  ${String(r.geomKB).padStart(7)}`,
  );
}
const first5 = rows.slice(0, 5).reduce((a, r) => a + r.uploadMs, 0) / 5;
const last5 = rows.slice(-5).reduce((a, r) => a + r.uploadMs, 0) / 5;
console.log(`\n  uploadMs first 5 batches avg: ${first5.toFixed(3)} ms`);
console.log(`  uploadMs last  5 batches avg: ${last5.toFixed(3)} ms   (flat ⇒ O(new); climbing ⇒ O(all))`);
console.log(`  total geometry uploaded: ${rows.at(-1).geomTotalMB} MB for ${rows.at(-1).total} meshes`);

await browser.close();
server.close();
