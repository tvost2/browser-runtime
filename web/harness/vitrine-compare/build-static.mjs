// Build a fully static, deployable copy of the side-by-side viewer into ./dist/.
// No node server at runtime — serve dist/ with any static host (Caddy file_server).
//
//   npm run build            # first, so web/dist/engine.* exist
//   node web/harness/vitrine-compare/build-static.mjs [glbDir]
//   → web/harness/vitrine-compare/dist/   (upload this to the VM)

import { readFile, writeFile, mkdir, rm, cp, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const web = join(root, "web");
const out = join(here, "dist");
const models = join(out, "models");

const GLB_DIR = process.argv[2] || process.env.GLB_VITRINE_DIR || "E:/Nova pasta (2)/vitrine-glb/assets/models";
const fixtures = join(root, "native", "tests", "fixtures", "glb", "real");

// which GLBs to ship (small first so the page loads fast, then a couple of heavy scans)
const PICK = [
  { from: fixtures, name: "BoxTextured.glb" },
  { from: fixtures, name: "Duck.glb" },
  { from: fixtures, name: "DamagedHelmet.glb" },
  { from: GLB_DIR, name: "0.glb" },
  { from: GLB_DIR, name: "shivas.glb" },
  { from: GLB_DIR, name: "gaia.glb" },
];

await rm(out, { recursive: true, force: true });
await mkdir(models, { recursive: true });

// 1. engine bundle
for (const f of ["engine.js", "engine.mjs", "engine.wasm"]) {
  const src = join(web, "dist", f);
  if (!existsSync(src)) { console.error(`missing ${src} — run: npm run build`); process.exit(1); }
  await cp(src, join(out, f));
}

// 2. bundled Babylon
const bjs = await build({
  entryPoints: [join(here, "babylon-entry.mjs")],
  bundle: true, format: "esm", write: false, minify: true, platform: "browser", target: "es2022", logLevel: "silent",
});
await writeFile(join(out, "babylon.js"), bjs.outputFiles[0].text);

// 3. the page — rewrite the two absolute imports + the /models fetches to relative
let mjs = await readFile(join(here, "vitrine-compare.mjs"), "utf8");
mjs = mjs
  .replace('from "/dist/engine.js"', 'from "./engine.js"')
  .replace('import("/babylon.js")', 'import("./babylon.js")')
  .replace('fetch("/models")', 'fetch("./models.json")')
  .replace(/"\/models\/" \+ encodeURIComponent\(name\)/g, '"./models/" + encodeURIComponent(name)');
await writeFile(join(out, "vitrine-compare.mjs"), mjs);
await cp(join(here, "vitrine-compare.html"), join(out, "index.html"));

// 4. the GLBs + a static manifest
const manifest = { dir: "(static bundle)", files: [] };
for (const p of PICK) {
  const src = join(p.from, p.name);
  if (!existsSync(src)) { console.warn(`  skip (not found): ${src}`); continue; }
  await cp(src, join(models, p.name));
  const s = await stat(src);
  manifest.files.push({ name: p.name, mb: +(s.size / 1048576).toFixed(1) });
}
await writeFile(join(out, "models.json"), JSON.stringify(manifest, null, 2));

// 5. a Caddyfile snippet for the operator — written NEXT TO dist/, never inside
// it, so the token is not served publicly if dist/ is uploaded as-is.
await writeFile(join(here, "Caddyfile.snippet"), `# add to the VM Caddyfile, then: caddy reload
3dviewer.mytheria.com.br {
	root * /opt/sitefactory/deploy/3dviewer
	file_server
	encode zstd gzip
	header /*.wasm Content-Type application/wasm
	header Cache-Control "public, max-age=3600"
	tls {
		dns cloudflare {env.CLOUDFLARE_API_TOKEN}
	}
}
`);

console.log(`\n  built  ${out}`);
console.log(`  models ${manifest.files.map((f) => `${f.name} (${f.mb}MB)`).join(", ")}`);
console.log(`\n  deploy (DNS + Caddy already set up — just push files):`);
console.log(`    cd "${out}" && tar czf - . | ssh mytheria@192.168.100.127 'tar xzf - -C /opt/sitefactory/deploy/3dviewer'`);
console.log(`  live: https://3dviewer.mytheria.com.br   (see DEPLOY.md)\n`);
