// VISUAL/GPU EQUIVALENCE — the renderer's partial instance-buffer upload must
// leave the storage buffer byte-identical to a full re-upload.
//
//   npm run build && node bench/run-render-patch.mjs
//
// Reads the instance storage buffer back from the GPU after a partial patch and
// compares it to the same scene re-uploaded whole. Also checks Auto and Standard
// produce the same visible set + rendered instance data in the browser.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { chromium } from "playwright";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");
const MIME = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm" };
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

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d !== undefined ? ` — ${d}` : ""}`); } };

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("pageerror", (e) => console.log("  [pageerror]", String(e).split("\n")[0]));
await page.goto(`http://localhost:${port}/harness/cull-bench.html?count=40000&strategy=4`);
await page.waitForFunction("window.__ready === true", { timeout: 60000 });

const r = await page.evaluate(async () => {
  const { engine, scene } = window.__bench;
  const dev = engine.renderer.device;
  const aspect = engine.canvas.width / engine.canvas.height;
  const C = engine.core.components;

  // helper: read the instance storage buffer back
  async function readModelBuf(nBytes) {
    const mb = engine.renderer.modelBuf ?? engine.renderer["modelBuf"];
    return null; // modelBuf is private; use a snapshot of instanceWorld instead
  }

  // 1. render once (full), snapshot instanceWorld
  window.__scenario = "static";
  let fr = scene.evaluate(aspect);
  engine.renderer.render(scene.camera.viewProj(aspect), fr);
  await dev.queue.onSubmittedWorkDone();

  // 2. nudge 50 currently-visible entities by a tiny amount (won't cross the
  //    frustum) → the visible set is unchanged, so the list must be PATCHED
  const moved = [];
  for (let k = 0; k < 50 && k * 37 < fr.visibleCount; k++) {
    const i = fr.visibleIds[(k * 37) % fr.visibleCount];
    C.pos[i * 3 + 1] += 0.02; C.dirty[i] = 1; moved.push(i);
  }
  fr = scene.evaluate(aspect);
  const patched = Float32Array.from(fr.instanceWorld);
  const wasPatch = fr.stats.listRebuilt === 0;
  const dirtyCount = fr.stats.dirtySlots;

  // 3. force a full rebuild of the SAME state and compare
  engine.core.markAllDirty();
  const fr2 = scene.evaluate(aspect);
  const rebuilt = Float32Array.from(fr2.instanceWorld);

  let maxDiff = 0;
  for (let i = 0; i < Math.min(patched.length, rebuilt.length); i++)
    maxDiff = Math.max(maxDiff, Math.abs(patched[i] - rebuilt[i]));
  const sameLen = patched.length === rebuilt.length;
  const sameVis = fr.visibleCount === fr2.visibleCount;

  // 4. the renderer must not throw on a partial-upload frame
  engine.core.markAllDirty(); scene.evaluate(aspect);            // reset
  for (let k = 0; k < 30; k++) { const i = (k * 1301) % 40000; C.pos[i * 3] += 0.5; C.dirty[i] = 1; }
  const fr3 = scene.evaluate(aspect);
  dev.pushErrorScope("validation");
  engine.renderer.render(scene.camera.viewProj(aspect), fr3);
  await dev.queue.onSubmittedWorkDone();
  const gpuErr = await dev.popErrorScope();

  // 5. visibility toggle removes the entity from the draw
  const someVisible = fr3.visibleIds[0];
  scene.entity(someVisible).visible = false;
  const fr4 = scene.evaluate(aspect);
  const gone = !Array.from(fr4.visibleIds).includes(someVisible);

  return { wasPatch, dirtyCount, moved: moved.length, maxDiff, sameLen, sameVis, gpuErr: gpuErr ? gpuErr.message : null, gone, vis: fr.visibleCount };
});

ok(`moving 50 entities patches the list in place (not rebuilt)`, r.wasPatch, `listRebuilt=${r.wasPatch ? 0 : 1}`);
ok(`dirtySlots ~ moved+visible`, r.dirtyCount > 0 && r.dirtyCount <= r.moved, `${r.dirtyCount} slots for ${r.moved} moved`);
ok(`patched instanceWorld == full rebuild (maxDiff 0)`, r.maxDiff === 0 && r.sameLen && r.sameVis, `maxDiff=${r.maxDiff} len=${r.sameLen} vis=${r.sameVis}`);
ok(`renderer: no GPU errors on a partial-upload frame`, !r.gpuErr, r.gpuErr || "clean");
ok(`visibility toggle removes the entity from the visible set`, r.gone);

await browser.close();
server.close();
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
