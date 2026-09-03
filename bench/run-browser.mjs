// Stage 8: real WebGPU comparison. Serves web/ and drives Chromium (WebGPU on)
// through the harness for {js, cpp} × scenes, reads window.__result, aggregates.
//
//   npx playwright install chromium      # one-time
//   npm run build:wasm                   # so the cpp backend exists
//   node bench/run-browser.mjs [scene ...]
//
// Writes bench/results/browser.json → folded into docs/COMPARISON.md by report.mjs.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(__dir, "..", "web");
const nodeRoot = join(__dir, "..", "node_modules");

let chromium;
try { ({ chromium } = await import("playwright")); }
catch { console.error("playwright not installed: npm i -D playwright && npx playwright install chromium"); process.exit(1); }
for (const f of ["backend/engine.mjs", "backend/engine.wasm", "dist/engine.js"]) {
  if (!existsSync(join(webRoot, f))) {
    console.error(`!! web/${f} missing — run:  npm run build`);
    process.exit(1);
  }
}

const MIME = { ".mjs": "text/javascript", ".js": "text/javascript", ".html": "text/html", ".wasm": "application/wasm", ".json": "application/json" };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/harness/index.html";
    const base = p.startsWith("/node_modules/") ? nodeRoot : webRoot;
    const rel = p.startsWith("/node_modules/") ? p.slice("/node_modules/".length) : p;
    const buf = await readFile(join(base, rel));
    res.writeHead(200, { "content-type": MIME[extname(p)] || "application/octet-stream", "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" });
    res.end(buf);
  } catch { res.writeHead(404); res.end("404"); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `http://localhost:${port}/harness/index.html`;

const scenes = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const kinds = scenes.length ? scenes : ["medium", "manyObjects", "manyVisible", "heavyCulling", "cpuBound"];
const scale = process.env.BCPP_SCALE || 1;

// GPU path selection. BCPP_GPU=hw tries the real adapter (D3D12/Vulkan);
// default falls back to SwiftShader so headless / server boxes still run
// (every scene then reads CPU-bound — noted in the report).
const gpuMode = process.env.BCPP_GPU || "hw";
const gpuArgs = gpuMode === "sw"
  ? ["--enable-unsafe-webgpu", "--enable-unsafe-swiftshader",
     "--use-webgpu-adapter=swiftshader", "--use-angle=swiftshader", "--disable-gpu-sandbox"]
  : ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU",
     "--use-angle=default", "--ignore-gpu-blocklist", "--disable-dawn-features=use_dxc"];
const browser = await chromium.launch({ headless: true, args: gpuArgs });
console.log(`GPU mode: ${gpuMode} (set BCPP_GPU=sw for SwiftShader)`);
// NOTE: needs a host with working WebGPU. On a headless GPU-less box both
// paths may report "no WebGPU" / device-creation failure — that blocks the
// real-frame numbers only; the Node ladder (bench:wasm / bench:compare) is
// unaffected.
const results = [];
for (const scene of kinds) {
  for (const backend of ["js", "cpp"]) {
    const page = await browser.newPage();
    page.on("console", (m) => { if (m.type() === "error") console.log(`  [page:${scene}:${backend}]`, m.text()); });
    const url = `${base}?backend=${backend}&scene=${scene}&scale=${scale}&frames=${process.env.BCPP_FRAMES || 600}&warmup=${process.env.BCPP_WARMUP || 120}`;
    await page.goto(url);
    try {
      await page.waitForFunction("window.__done === true", { timeout: 300000 });
      const r = await page.evaluate("window.__result");
      results.push(r);
      if (r.error) console.log(`✗ ${scene}/${backend}: ${r.error.split("\n")[0]}`);
      else console.log(`✓ ${scene}/${backend}: frame median ${r.frameMs.median.toFixed(3)}ms · eval ${r.evalMs.median.toFixed(3)}ms · fps ${r.fps.toFixed(0)} · gpu ${r.gpuMs ? r.gpuMs.median.toFixed(3) + "ms" : "n/a"}`);
    } catch (e) {
      console.log(`✗ ${scene}/${backend}: timeout/${e.message}`);
      results.push({ scene, backend, error: "timeout" });
    }
    await page.close();
  }
}
await browser.close();
server.close();

writeFileSync(join(__dir, "results", "browser.json"), JSON.stringify({ kind: "browser", scale, results }, null, 2));
console.log(`\nwrote ${join(__dir, "results", "browser.json")}`);
