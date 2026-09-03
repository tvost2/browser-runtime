// Bundle the TypeScript API → web/dist/  (the shippable package payload).
//   node web/build-api.mjs [--watch]
//
// Output:
//   web/dist/engine.js     bundled ESM (the import target)
//   web/dist/engine.d.ts   ambient types (tsc)
//   web/dist/engine.mjs    emscripten loader   (copied)
//   web/dist/engine.wasm   the C++ core        (copied)
//
// The C++ toolchain is NEVER needed by consumers — they get JS + WASM only.

import { build, context } from "esbuild";
import { copyFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const webDir = dirname(fileURLToPath(import.meta.url));
const root = join(webDir, "..");
const dist = join(webDir, "dist");
mkdirSync(dist, { recursive: true });
// clear stale d.ts trees (tsc emits fresh under dist/types/)
for (const d of ["api", "bindings", "renderer", "types"])
  rmSync(join(dist, d), { recursive: true, force: true });

for (const f of ["engine.mjs", "engine.wasm"]) {
  const src = join(webDir, "backend", f);
  if (!existsSync(src)) { console.error(`missing ${src} — run: npm run build:wasm`); process.exit(1); }
  copyFileSync(src, join(dist, f));
}

const opts = {
  entryPoints: [join(webDir, "api", "index.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: join(dist, "engine.js"),
  // emscripten loader stays a sibling file; node: builtins are for the Node-only
  // asset-loading branch (tests) and are never reached in the browser.
  external: ["./engine.mjs", "node:*"],
  banner: { js: "// bcpp engine — generated bundle, do not edit\n" },
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(opts);
  await ctx.watch();
  console.log("watching web/api → web/dist/engine.js");
} else {
  await build(opts);
  try {
    execFileSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"),
      "--project", join(webDir, "tsconfig.json")], { stdio: "inherit" });
  } catch { console.warn("tsc .d.ts emit failed (non-fatal for runtime)"); }
  console.log("built web/dist/engine.js");
}
