// One-time: fetch + activate the Emscripten SDK into tools/emsdk so
// `npm run build:wasm` works. ~2 GB download (LLVM/wasm toolchain). Needs git
// and Python 3 on PATH.
//
//   node native/setup-emsdk.mjs            # install pinned version
//   node native/setup-emsdk.mjs latest     # install latest

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const emsdk = join(root, "tools", "emsdk");
const version = process.argv[2] || "6.0.9"; // pinned (what v0.1.0 was built with) — see docs/WASM_ARCHITECTURE.md

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

// locate a real Python 3 (Windows ships a Store stub as `python3`)
function findPython() {
  for (const c of ["python", "python3", "py"]) {
    try {
      const v = execFileSync(c, ["--version"], { encoding: "utf8" }).trim();
      if (/Python 3\.\d+/.test(v)) return c;
    } catch { /* keep looking */ }
  }
  console.error("Python 3 not found on PATH — install it and retry.");
  process.exit(1);
}

if (!existsSync(join(emsdk, "emsdk.py"))) {
  run("git", ["clone", "--depth", "1", "https://github.com/emscripten-core/emsdk.git", emsdk]);
}

const py = findPython();
process.env.EMSDK_PYTHON = process.env.EMSDK_PYTHON || (() => {
  try { return execFileSync(py, ["-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim(); }
  catch { return ""; }
})();

run(py, ["emsdk.py", "install", version], { cwd: emsdk });
run(py, ["emsdk.py", "activate", version], { cwd: emsdk });

console.log(`\nEmscripten ${version} ready at tools/emsdk. Next: npm run build`);
