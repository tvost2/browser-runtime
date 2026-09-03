// chunk-merge: N unique static meshes as N draw buckets vs grouped-and-merged.
// The C++ kernel (bcpp::mergeMeshes) world-bakes each spatial cell into one
// mesh; per-vertex source ids are kept so picking still works.
//
//   node bench/run-chunk-merge.mjs
//
// bench host has no GPU → WARP. The draw-bucket count and merge time are the
// real result; GPU/fps numbers are WARP and only directional.

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

async function run(params) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  page.on("console", (m) => { if (/webgpu:|error/i.test(m.text())) errs.push(m.text().slice(0, 160)); });
  const q = new URLSearchParams(params).toString();
  await page.goto(`http://localhost:${port}/web/harness/chunk-merge.html?${q}`);
  await page.waitForFunction(() => window.__ready, { timeout: 40000 });
  const check = await page.evaluate(() => window.__bench.check());
  await page.waitForTimeout(500); // one settled frame for the pick pass to read
  const pick = await page.evaluate(() => window.__bench.pick());
  await page.evaluate(() => { window.__bench.reset(); window.__scenario = "camera"; });
  await page.waitForTimeout(4000);
  const r = await page.evaluate(() => window.__bench.result());
  await page.close();
  return { ...r, check, pick, errs: errs.slice(0, 2) };
}

const COUNT = 4000;
const CELL = 140;

const noMerge = await run({ count: COUNT, merge: 0, strategy: 0 });
const merged = await run({ count: COUNT, merge: 1, cell: CELL, strategy: 0 });
const mergedGpu = await run({ count: COUNT, merge: 1, cell: CELL, strategy: 5 });

await browser.close();
server.close();

const row = (label, r) =>
  `  ${label.padEnd(20)}  buckets ${String(r.drawBuckets).padStart(5)}   entities ${String(r.entities).padStart(5)}   cpu ${r.cpuFrameMs.toFixed(2).padStart(7)} ms   fps ${String(Math.round(r.fps)).padStart(4)}   heap ${r.wasmHeapMB.toFixed(0)} MB` +
  (r.errs.length ? `  ⚠ ${r.errs.join(" | ")}` : "");

console.log(`\n  ${COUNT} unique meshes · cell ${CELL} world units\n`);
console.log(row("no merge", noMerge));
console.log(row("merge (Standard)", merged));
console.log(row("merge (Gpu cull)", mergedGpu));

console.log(`\n  merge kernel: ${merged.mergeMs.toFixed(1)} ms  ·  ${merged.buckets} cells  ·  ` +
  `verts ${merged.srcVerts}→${merged.mrgVerts}  ·  tris ${merged.srcTris}→${merged.mrgTris}`);

const c = merged.check;
const cok = c.ok && merged.check.aabbOk;
console.log(`\n  geometry: vertices ${c.vSum}/${c.srcVerts}  indices ${c.iSum}/${c.srcI}  ` +
  `ids in [${c.idMin}..${c.idMax}] of ${COUNT}  world-AABB match ${c.aabbOk}  →  ${cok ? "OK" : "FAIL"}`);

const p = merged.pick;
console.log(`  pick buffer: ${p.hit}/${p.tried} centroids resolved to a building, ${p.exact} exact  →  ${p.ok ? "OK" : "FAIL"}`);

const collapse = noMerge.drawBuckets / Math.max(1, merged.drawBuckets);
console.log(`\n  draw buckets ${noMerge.drawBuckets} → ${merged.drawBuckets}  (${collapse.toFixed(0)}× fewer)`);

const anyErr = [noMerge, merged, mergedGpu].some((r) => r.errs.length);
if (!cok || !p.ok || anyErr) process.exitCode = 1;
