// Runs the native (non-WASM) kernel to establish the CPU ceiling: what the
// fused pipeline costs with zero JS/WASM boundary, native SIMD, no GC.
// This is NOT the WASM number — it is the theoretical best the WASM build
// chases. Requires native/bench_world.exe (built via CMake or g++).
//
//   node bench/native-ceiling.mjs

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const exe = join(__dir, "..", "native", process.platform === "win32" ? "bench_world.exe" : "bench_world");
if (!existsSync(exe)) {
  console.error(`missing ${exe} — build it:\n  cd native && g++ -std=c++20 -O3 -march=native -static -Iinclude tests/bench_world.cpp -o bench_world.exe`);
  process.exit(1);
}

const sizes = [800, 2500, 4000, 5000, 6000, 7000, 20000];
const results = [];
for (const n of sizes) {
  const out = execFileSync(exe, [String(n), "3000", "--json"], { encoding: "utf8" }).trim();
  const r = JSON.parse(out);
  results.push(r);
  console.log(`n=${r.nodes}\tmedian=${r.medianMs.toFixed(4)}ms\tvisible=${r.visible}`);
}

writeFileSync(join(__dir, "results", "native.json"), JSON.stringify({ kind: "native-ceiling", results }, null, 2));
console.log("wrote bench/results/native.json");
