// CullStrategy.Gpu vs Standard: the per-frame CPU→GPU cost while the camera
// orbits a large static scene. Standard re-culls on the CPU, rebuilds the
// render list and re-uploads visible*64 B of matrices; Gpu uploads only the
// 96-byte frustum and lets a compute shader cull + compact + emit draw args.
//
//   node bench/run-gpu-cull.mjs
//
// bench host has no GPU → WARP. Compute time is not representative; the CPU
// frame and the upload bytes are.

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm" };
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

const STRAT = { Standard: 0, Gpu: 5 };
const COUNTS = [50000, 150000];
const SCEN = ["static", "camera"];

// --- equivalence: GPU visible set vs CPU Standard on the same frame ---
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`http://localhost:${port}/web/harness/cull-bench.html?count=60000&strategy=5&scenario=camera`);
  await page.waitForFunction(() => window.__ready, { timeout: 30000 });
  await page.waitForTimeout(2500);
  const eq = await page.evaluate(() => window.__equiv());
  await page.close();
  const frac = eq.extra / Math.max(1, eq.cpu);
  const ok = eq.missing === 0 && frac < 0.002;
  console.log(`\n  equivalence (60k, moving camera): CPU ${eq.cpu} visible · GPU misses ${eq.missing} · GPU extra ${eq.extra} (${(frac * 100).toFixed(3)}%, boundary float noise, always over-draws)  ${ok ? "OK" : "FAIL"}`);
  if (!ok) process.exitCode = 1;

  // many-bucket sanity: 2000 distinct meshes → 2000 draw buckets. Regression
  // guard for the WARP firstInstance bug (fixed with a per-bucket dynamic uniform).
  const mb = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  await mb.goto(`http://localhost:${port}/web/harness/cull-bench.html?count=20000&meshes=2000&strategy=5&scenario=camera`);
  await mb.waitForFunction(() => window.__ready, { timeout: 30000 });
  await mb.waitForTimeout(3500);
  const nvis = await mb.evaluate(() => window.__bench.engine.renderer.readbackGpuVisible().then((r) => r.length));
  await mb.close();
  console.log(`  many-bucket (20k entities, 2000 meshes): GPU visible ${nvis}  ${nvis > 5000 ? "OK" : "FAIL"}`);
  if (nvis <= 5000) process.exitCode = 1;
}

const results = [];
for (const count of COUNTS) {
  for (const scenario of SCEN) {
    for (const [name, s] of Object.entries(STRAT)) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      const errs = [];
      page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
      page.on("console", (m) => { if (/webgpu:|error/i.test(m.text())) errs.push(m.text().slice(0, 140)); });
      await page.goto(`http://localhost:${port}/web/harness/cull-bench.html?count=${count}&strategy=${s}&scenario=${scenario}`);
      await page.waitForFunction(() => window.__ready, { timeout: 30000 });
      await page.evaluate(() => window.__bench.reset());
      await page.waitForTimeout(4000);
      const r = await page.evaluate(() => window.__bench.result());
      results.push({ count, scenario, strat: name, ...r, errs: errs.slice(0, 2) });
      await page.close();
    }
  }
}
await browser.close();
server.close();

console.log("\n  count    scenario   strat      cpuFrame   gpu(WARP)   upload/frame   visible");
for (const r of results) {
  console.log(
    `  ${String(r.count).padStart(7)}  ${r.scenario.padEnd(9)}  ${r.strat.padEnd(9)}  ${(r.cpuFrameMs).toFixed(3).padStart(7)} ms  ${(r.gpuMs).toFixed(1).padStart(7)} ms  ${(r.uploadBytesMed / 1024).toFixed(0).padStart(8)} KB    ${String(r.visible).padStart(8)}` +
    (r.errs.length ? `  ⚠ ${r.errs.join(" | ")}` : ""),
  );
}

// headline: camera scenario, big count
const pairs = {};
for (const r of results) (pairs[`${r.count}/${r.scenario}`] ??= {})[r.strat] = r;
console.log("\n  camera-orbit, per-frame CPU→GPU upload:");
for (const k of Object.keys(pairs)) {
  const { Standard: a, Gpu: b } = pairs[k];
  if (!a || !b || a.scenario !== "camera") continue;
  console.log(`    ${k}:  Standard ${(a.uploadBytesMed / 1024).toFixed(0)} KB/frame  →  Gpu ${(b.uploadBytesMed / 1024).toFixed(1)} KB/frame   (cpu ${a.cpuFrameMs.toFixed(2)} → ${b.cpuFrameMs.toFixed(2)} ms)`);
}
