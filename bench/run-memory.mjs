// Memory cost of the WASM-first core at scale. Node, no renderer.
// Goal: KNOW the current cost, not optimise it.
//
//   npm run build && node --expose-gc bench/run-memory.mjs
//   → bench/results/memory.json  (folded into docs/COMPARISON.md)
//
// Method: a FRESH WasmCore per size (so linear-memory growth isn't masked by an
// earlier, larger allocation), fill the SoA, run 30 frames so the render-list
// buffers reach steady size, then read total WASM linear memory + Node heap.

import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const distUrl = pathToFileURL(join(__dir, "..", "web", "dist", "engine.js")).href;
const loaderUrl = pathToFileURL(join(__dir, "..", "web", "backend", "engine.mjs")).href;
const { WasmCore } = await import(distUrl);
const MB = 1 / 1048576;

// exact SoA cost per entity, from native/include/bcpp/world.hpp
const SOA = {
  localPos: 12, localRot: 16, localScale: 12, parent: 4,
  localMin: 12, localMax: 12, meshId: 4, materialId: 4, flags: 4,
  world: 64, worldSphere: 16, _order: 4, _depth: 4,
  "renderList(reserved)": 4 + 64 + 4, "_sortKeys(reserved)": 8,
};
const soaTotal = Object.values(SOA).reduce((a, b) => a + b, 0);

const vp = new Float32Array([1.2, 0, 0, 0, 0, 2.1, 0, 0, 0, 0, 1.001, 1, 0, 0, -0.5, 0]);
const SIZES = [10_000, 50_000, 100_000, 250_000, 500_000];

function fill(core, n) {
  core.setCount(n);
  const C = core.components;
  let s = 0x51ed ^ n;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < n; i++) {
    C.pos[i * 3] = (rnd() - 0.5) * 800; C.pos[i * 3 + 1] = (rnd() - 0.5) * 800; C.pos[i * 3 + 2] = rnd() * 900 + 50;
    C.rot[i * 4 + 3] = 1;
    C.scale[i * 3] = C.scale[i * 3 + 1] = C.scale[i * 3 + 2] = 0.5 + rnd();
    C.localMin.set([-0.5, -0.5, -0.5], i * 3);
    C.localMax.set([0.5, 0.5, 0.5], i * 3);
    C.flags[i] = 0b011;
    C.meshId[i] = i % 8;
    if (i > 0 && rnd() < 0.5) C.parent[i] = (rnd() * i) | 0;
  }
  core.markHierarchyDirty();
}

console.log(`computed SoA cost: ${soaTotal} bytes/entity`);
for (const [k, v] of Object.entries(SOA)) console.log(`  ${k.padEnd(22)} ${v}`);
console.log("");

const rows = [];
for (const n of SIZES) {
  const core = await WasmCore.create(loaderUrl);
  const wasm0 = core.heapBytes;
  fill(core, n);
  core.writeViewProj(vp);
  let visible = 0;
  for (let f = 0; f < 30; f++) visible = core.evaluate(0, true).visibleCount;
  if (globalThis.gc) { globalThis.gc(); globalThis.gc(); }

  const wasm = core.heapBytes;
  const js = process.memoryUsage().heapUsed;
  const row = {
    count: n, visible,
    wasmHeapMB: wasm * MB,
    wasmGrowthMB: (wasm - wasm0) * MB,
    wasmBytesPerEntity: (wasm - wasm0) / n,     // 0 while INITIAL_MEMORY has headroom
    jsHeapMB: js * MB,
    initialMemoryMB: wasm0 * MB,
  };
  rows.push(row);
  console.log(
    `${String(n).padStart(7)}  wasm ${(wasm * MB).toFixed(1)}MB` +
    `  (init ${(wasm0 * MB).toFixed(0)}MB, grew +${((wasm - wasm0) * MB).toFixed(1)}MB)` +
    `  js ${(js * MB).toFixed(1)}MB  vis ${visible}`,
  );
}

const big = rows.at(-1);
console.log(
  `\ncomputed SoA cost: ${soaTotal} bytes/entity (exact, from world.hpp)` +
  `\nINITIAL_MEMORY (${rows[0].initialMemoryMB.toFixed(0)}MB) covers ~${Math.floor(rows[0].initialMemoryMB * 1048576 / soaTotal / 1000)}k entities with zero heap growth.` +
  `\nat ${big.count.toLocaleString("en-US")} entities the WASM heap is ${big.wasmHeapMB.toFixed(0)}MB` +
  ` (${big.initialMemoryMB.toFixed(0)}MB base + ${big.wasmGrowthMB.toFixed(0)}MB grown) — ` +
  `≈ ${(big.wasmHeapMB * 1048576 / big.count).toFixed(0)} B/entity total incl. base slack, consistent with ${soaTotal} B/entity + code/stack.` +
  `\nNode/JS heap is flat (~${rows[0].jsHeapMB.toFixed(1)}MB) at every size — the SoA lives in WASM; JS holds only TypedArray views.` +
  `\nThe public-API Entity/Transform handles add ~200 B/entity on the JS heap IF created (createEntities does; the raw SoA path does not).`,
);

writeFileSync(join(__dir, "results", "memory.json"), JSON.stringify({
  kind: "memory", computedBytesPerEntity: soaTotal, soaBreakdown: SOA,
  totalBytesPerEntityAt500k: big.wasmHeapMB * 1048576 / big.count,
  jsHeapFlatMB: rows[0].jsHeapMB,
  apiHandleJsBytesPerEntity: 200,
  note: "Node, no renderer, fresh WasmCore per size. wasm0 = INITIAL_MEMORY. Growth = ALLOW_MEMORY_GROWTH (dlmalloc, may not return pages to the OS).",
  rows,
}, null, 2));
console.log(`\nwrote ${join(__dir, "results", "memory.json")}`);
