// BROWSER GPU BENCHMARK — incremental renderer. Real Chromium WebGPU (WARP on the
// bench host). Per scenario per strategy: CPU frame, GPU frame, FPS, instance
// storage-buffer upload (median + max bytes/frame), visible count, draw calls,
// WASM/JS heap.
//
//   npm run build && npx playwright install chromium
//   node bench/run-renderer-gpu.mjs [count]

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { chromium } from "playwright";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");
const COUNT = Number(process.argv[2] || 120_000);
const MIME = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(req.url.split("?")[0]);
    const buf = await readFile(join(root, "web", p.replace(/^\//, "")));
    res.writeHead(200, { "content-type": MIME[extname(p)] || "application/octet-stream", "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" });
    res.end(buf);
  } catch { res.writeHead(404); res.end("404"); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({ args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--use-angle=default", "--ignore-gpu-blocklist", "--disable-dawn-features=use_dxc"] });

const SCENARIOS = [
  { name: "static", scenario: "static", mover: 0 },
  { name: "transform 0.1%", scenario: "transform", mover: 0.001 },
  { name: "transform 1%", scenario: "transform", mover: 0.01 },
  { name: "camera orbit", scenario: "camera", mover: 0 },
  { name: "camera + 1%", scenario: "camera+move", mover: 0.01 },
  { name: "churn 100%", scenario: "churn", mover: 1 },
];
const STRATS = [{ tag: "Standard", n: 0 }, { tag: "Bvh", n: 3 }, { tag: "Auto", n: 4 }];

const out = { kind: "renderer-gpu", count: COUNT, rows: [] };
console.log(`\nincremental renderer — browser WebGPU (WARP), ${COUNT.toLocaleString()} entities\n`);

for (const strat of STRATS) {
  const page = await browser.newPage({ viewport: { width: 1300, height: 760 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  await page.goto(`http://localhost:${port}/harness/cull-bench.html?count=${COUNT}&strategy=${strat.n}`);
  try {
    await page.waitForFunction("window.__ready === true", { timeout: 60000 });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 500))); // warm
    for (const sc of SCENARIOS) {
      await page.evaluate(({ s, m }) => { window.__scenario = s; window.__moverRatio = m; }, { s: sc.scenario, m: sc.mover });
      await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));   // settle
      await page.evaluate(() => window.__bench.reset());
      await page.evaluate(() => new Promise((r) => setTimeout(r, 900)));   // collect ~50 frames
      const res = await page.evaluate(() => window.__bench.result());
      res.evalMs = (res.transformUs + res.cullUs + res.listUs) / 1000;   // clean CPU (steady_clock in C++)
      out.rows.push({ strategy: strat.tag, scenario: sc.name, ...res });
      console.log(
        `  ${strat.tag.padEnd(9)} ${sc.name.padEnd(16)} eval ${res.evalMs.toFixed(2)}ms (tf ${(res.transformUs / 1000).toFixed(2)} cull ${(res.cullUs / 1000).toFixed(2)} list ${(res.listUs / 1000).toFixed(2)})  ` +
        `upload ${(res.uploadBytesMed / 1024).toFixed(0)} KB  vis ${res.visible.toLocaleString()}  rebuilt ${(res.listRebuiltFrac * 100).toFixed(0)}%  ` +
        `gpu(WARP) ${res.gpuMs.toFixed(0)}ms`,
      );
    }
  } catch (e) { console.log(`  ${strat.tag}: FAIL ${e.message}`); errs.slice(0, 2).forEach((x) => console.log("   " + x)); }
  await page.close();
}

await browser.close();
server.close();
writeFileSync(join(__dir, "results", "renderer-gpu.json"), JSON.stringify(out, null, 2));
console.log(`\nwrote bench/results/renderer-gpu.json`);
