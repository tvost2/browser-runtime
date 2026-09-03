// Prerequisite check. `npm run doctor` — tells a fresh machine what it still needs.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rows = [];
const ok = (n, v) => rows.push([true, n, v]);
const missing = (n, how) => rows.push([false, n, how]);

function tryCmd(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n")[0]; }
  catch { return null; }
}

// --- required for build + core tests ---
const node = process.version;
(+node.slice(1).split(".")[0] >= 20) ? ok("Node ≥ 20", node) : missing("Node ≥ 20", `have ${node}`);

existsSync(join(root, "node_modules")) ? ok("npm deps", "installed") : missing("npm deps", "npm install");

const git = tryCmd("git", ["--version"]);
git ? ok("git", git) : missing("git", "install git (needed for setup:emsdk / setup:reference)");

const py = ["python", "python3", "py"].map((c) => tryCmd(c, ["--version"])).find((v) => /Python 3\./.test(v));
py ? ok("Python 3", py) : missing("Python 3", "install (needed by emsdk only)");

const emsdk = existsSync(join(root, "tools", "emsdk", ".emscripten"));
emsdk ? ok("Emscripten SDK", "tools/emsdk activated") : missing("Emscripten SDK", "npm run setup:emsdk  (~2 GB, one-time)");

const wasm = existsSync(join(root, "web", "backend", "engine.wasm"));
wasm ? ok("WASM build", "web/backend/engine.wasm") : missing("WASM build", "npm run build:wasm");

const dist = existsSync(join(root, "web", "dist", "engine.js"));
dist ? ok("API bundle", "web/dist/engine.js") : missing("API bundle", "npm run build:api");

// --- required for specific tasks (optional) ---
const gpp = tryCmd("g++", ["--version"]) || tryCmd("clang++", ["--version"]);
gpp ? ok("C++ compiler (native tests)", gpp) : missing("C++ compiler", "install g++/clang — needed for test:equivalence + bench:native");

const ref = existsSync(join(root, "reference", "packages", "dev", "core", "src"));
ref ? ok("Babylon reference (analyze / baseline)", "reference/") : missing("Babylon reference", "npm run setup:reference — needed for `analyze` and `bench:baseline`");

let chromium = false;
try { const { chromium: c } = await import("playwright"); chromium = !!c && !!c.executablePath && existsSync(c.executablePath()); } catch { /* not installed */ }
chromium ? ok("Chromium (browser benchmarks)", "playwright") : missing("Chromium", "npx playwright install chromium — needed for bench:browser + test:visual");

// --- print ---
const pad = Math.max(...rows.map((r) => r[1].length));
console.log("");
for (const [good, name, note] of rows)
  console.log(`  ${good ? "✓" : "✗"}  ${name.padEnd(pad)}   ${note}`);
const blockers = rows.filter((r) => !r[0] && /^(Node|npm deps|Emscripten|WASM build|API bundle)/.test(r[1]));
console.log(
  blockers.length
    ? `\n${blockers.length} blocker(s) for \`npm run build\`. Fix the ✗ above.`
    : `\nReady for: npm run build · npm run demo · npm run test:equivalence`,
);
process.exit(blockers.length ? 1 : 0);
