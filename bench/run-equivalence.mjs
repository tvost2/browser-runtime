// Aggregate equivalence gate: every implementation must produce Babylon's
// output. Fails loudly on any silent divergence.
//
//   npm run build:wasm && npm run build:api && node native/tests/gen_fixtures.mjs
//   node bench/run-equivalence.mjs
//
// Checks:
//   1. C++ math + scene kernel (native test_equiv)         vs Babylon fixtures
//   2. C++ World core         (native test_world_equiv)     vs Babylon fixtures
//   3. JS data-oriented kernel (JsBackend)                  vs Babylon fixtures
//   4. C++/WASM core          (WasmBackend)                 vs Babylon fixtures

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { WasmBackend } from "../web/backend/WasmBackend.mjs";
import { JsBackend } from "../web/backend/JsBackend.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const nativeDir = join(__dir, "..", "native");
const fx = join(nativeDir, "tests", "fixtures");
const rd = (n) => { const b = readFileSync(join(fx, n)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

if (!existsSync(join(fx, "kernel_visible.bin"))) {
  console.log("fixtures missing — generating from @babylonjs/core …");
  execFileSync(process.execPath, [join(nativeDir, "tests", "gen_fixtures.mjs")], { stdio: "inherit" });
}

const results = [];
const record = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

// ---- native tests (need g++; skip gracefully if absent) ----
let gpp = true;
try { execFileSync("g++", ["--version"], { stdio: "ignore" }); } catch { gpp = false; }
if (gpp) {
  for (const [src, exe] of [
    ["tests/test_equiv.cpp", "test_equiv.exe"],           // math + scene.hpp kernel (19457 checks)
    ["tests/test_world_equiv.cpp", "test_world_equiv.exe"], // bcpp::World core
  ]) {
    try {
      execFileSync("g++", ["-std=c++20", "-O2", "-static", "-Iinclude", src, "-o", exe],
        { cwd: nativeDir, stdio: "pipe" });
      const out = execFileSync(join(nativeDir, exe), [join(nativeDir, "tests", "fixtures")], { encoding: "utf8" });
      const ok = !/FAIL|MISMATCH|failures\.\s*[1-9]/.test(out) && /0 failures|OK/.test(out);
      record(`native ${exe}`, ok, out.trim().split("\n").pop());
    } catch (e) { record(`native ${exe}`, false, (e.stdout || e.message || "").toString().slice(-200)); }
  }
} else {
  console.log("SKIP  native C++ tests (no g++)");
}

// ---- JS + WASM against the fixture ----
const parent = new Int32Array(rd("kernel_parent.bin"));
const trs = new Float32Array(rd("kernel_trs.bin"));
const ext = new Float32Array(rd("kernel_ext.bin"));
const flags = new Uint32Array(new Int32Array(rd("kernel_flags.bin")));
const vp = new Float32Array(rd("kernel_vp.bin"));
const expVisible = new Int32Array(rd("kernel_visible.bin"));
const n = parent.length;
const scene = { count: n, parents: parent, trs, extents: ext, flags };
const exp = new Set(expVisible);
const sameSet = (ids) => { if (ids.length !== exp.size) return false; for (const v of ids) if (!exp.has(v)) return false; return true; };

const jb = new JsBackend(); await jb.init(); jb.upload(scene);
record("JS data-oriented kernel", sameSet(jb.evaluateFrame(vp, 0).visibleIds),
  `${jb.evaluateFrame(vp, 0).visibleCount}/${expVisible.length} visible`);

const engineMjs = join(__dir, "..", "web", "backend", "engine.mjs");
if (existsSync(engineMjs)) {
  const wb = new WasmBackend(); await wb.init(pathToFileURL(engineMjs).href); wb.upload(scene);
  const r = wb.evaluateFrame(vp, 0, false);
  record("C++/WASM World core", sameSet(r.visibleIds), `${r.visibleCount}/${expVisible.length} visible`);
} else {
  console.log("SKIP  C++/WASM (run: npm run build:wasm && npm run build:api)");
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
