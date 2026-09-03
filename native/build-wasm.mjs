// Build the C++ engine core to WASM (direct em++). Emits into web/backend/:
//   engine.mjs + engine.wasm   (default: the WASM-first runtime core)
//
//   node native/build-wasm.mjs [--profile <name>] [--out <basename>]
//
// Profiles — each is a measurable build variant (see docs/BENCHMARK_METHODOLOGY.md):
//   release   -O3 -msimd128                (default, ships)
//   debug     -O0 -g3 -sASSERTIONS=2 -sSAFE_HEAP=1
//   o3        -O3                          (no SIMD — isolates the SIMD win)
//   simdlto   -O3 -msimd128 -flto
//   threads   -O3 -msimd128 -pthread -sPTHREAD_POOL_SIZE=4  (needs COOP/COEP headers)

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const nativeDir = dirname(fileURLToPath(import.meta.url));
const root = join(nativeDir, "..");
const emsdk = join(root, "tools", "emsdk");
const outDir = join(root, "web", "backend");

const emConfig = join(emsdk, ".emscripten");
if (!existsSync(emConfig)) {
  console.error("Emscripten not set up. Run once:\n  npm run setup:emsdk\n(needs git + Python 3; ~2 GB download)");
  process.exit(1);
}
const emDir = join(emsdk, "upstream", "emscripten");
const empp = ["em++.exe", "em++.bat", "em++"].map((f) => join(emDir, f)).find(existsSync);

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : def; };
const profile = arg("--profile", "release");
const outBase = arg("--out", "engine");

const PROFILES = {
  release: ["-O3", "-msimd128"],
  debug:   ["-O0", "-g3", "-sASSERTIONS=2"],
  o3:      ["-O3"],
  simdlto: ["-O3", "-msimd128", "-flto"],
  threads: ["-O3", "-msimd128", "-pthread", "-sPTHREAD_POOL_SIZE=4", "-sPROXY_TO_PTHREAD=0"],
};
const opt = PROFILES[profile];
if (!opt) { console.error(`unknown profile '${profile}'. one of: ${Object.keys(PROFILES).join(", ")}`); process.exit(1); }

mkdirSync(outDir, { recursive: true });
const env = { ...process.env, EM_CONFIG: emConfig };

const args = [
  "-std=c++20", ...opt,
  "-Wno-unused-command-line-argument",
  "-I", join(nativeDir, "include"),
  "-I", join(nativeDir, "vendor"),
  // vendored JSON parser for PIPELINE B (read-only; MIT — native/vendor/LICENSE-yyjson)
  "-DYYJSON_DISABLE_WRITER=1", "-DYYJSON_DISABLE_UTF8_VALIDATION=0",
  join(nativeDir, "vendor", "yyjson.c"),
  join(nativeDir, "bindings", "engine.cpp"),
  join(nativeDir, "bindings", "asset.cpp"),
  "--bind",
  "-sMODULARIZE=1", "-sEXPORT_ES6=1", `-sEXPORT_NAME=createEngine`,
  "-sALLOW_MEMORY_GROWTH=1", "-sINITIAL_MEMORY=67108864", "-sMAXIMUM_MEMORY=1073741824",
  "-sSTACK_SIZE=2097152",
  "-sENVIRONMENT=web,worker,node",
  "-sEXPORTED_RUNTIME_METHODS=HEAPF32,HEAPU32,HEAP32,HEAPU8",
  "-o", join(outDir, `${outBase}.mjs`),
];

console.log(`em++ profile '${profile}': ${opt.join(" ")}  →  web/backend/${outBase}.mjs`);
const t0 = Date.now();
execFileSync(empp, args, { env, stdio: "inherit", shell: empp.endsWith(".bat") });
writeFileSync(join(outDir, `${outBase}.build.json`), JSON.stringify({
  profile, flags: opt, out: outBase, builtAt: new Date().toISOString(), buildMs: Date.now() - t0,
}, null, 2));
console.log(`OK in ${((Date.now() - t0) / 1000).toFixed(1)}s → web/backend/${outBase}.{mjs,wasm}`);
