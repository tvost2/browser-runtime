// Smoke test: the real engine (public API → WASM core → WebGPU) runs in
// Chromium, produces frames, and its WASM-computed visible set is sane. Saves a
// screenshot to bench/results/engine-demo.png.
//
//   npm run build:wasm && npm run build:api
//   node bench/test-engine-browser.mjs [scene] [count]

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { serve } from "../web/serve.mjs";
import { chromium } from "playwright";

const __dir = dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] || "field";
const count = process.argv[3] || 6000;

const { server, port } = await serve(0);
const browser = await chromium.launch({
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--use-angle=default",
         "--ignore-gpu-blocklist", "--disable-dawn-features=use_dxc"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(`http://localhost:${port}/harness/engine-demo.html?scene=${mode}&count=${count}`);

let stats;
try {
  await page.waitForFunction("window.__engine && window.__engine.stats.frame > 120", { timeout: 60000 });
  stats = await page.evaluate(() => ({
    ...window.__engine.stats,
    wasmInitMs: window.__engine.wasmInitMs,
    entityCount: window.__engine.core.count,
    adapter: window.__engine.renderer.adapter.info?.description || window.__engine.renderer.adapter.info?.vendor,
  }));
} catch (e) {
  console.error("FAILED:", e.message);
  errors.forEach((x) => console.error("  page:", x));
  await page.screenshot({ path: join(__dir, "results", "engine-demo-FAIL.png") });
  await browser.close(); server.close();
  process.exit(1);
}

await page.screenshot({ path: join(__dir, "results", "engine-demo.png") });
await browser.close();
server.close();

console.log(`\nengine demo · ${mode} · ${count} entities`);
console.log(`  wasm init      ${stats.wasmInitMs.toFixed(1)} ms`);
console.log(`  eval (WASM)    ${stats.evalMs.toFixed(3)} ms/frame`);
console.log(`  cpu frame      ${stats.cpuFrameMs.toFixed(3)} ms`);
console.log(`  gpu            ${stats.gpuMs != null ? stats.gpuMs.toFixed(3) + " ms" : "n/a"}`);
console.log(`  fps            ${stats.fps.toFixed(0)}`);
console.log(`  visible        ${stats.visible} / ${stats.entityCount}`);
console.log(`  draw calls     ${stats.drawCalls}`);
console.log(`  adapter        ${stats.adapter}`);

const ok = stats.visible > 0 && stats.visible <= stats.entityCount && stats.frame > 120 && errors.length === 0;
writeFileSync(join(__dir, "results", "engine-demo.json"), JSON.stringify({ mode, count, stats, errors }, null, 2));
if (!ok) { console.error("\nSANITY FAIL", { errors }); process.exit(1); }
console.log("\nOK — screenshot: bench/results/engine-demo.png");
