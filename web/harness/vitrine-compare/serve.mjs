// Serves the side-by-side comparison harness.
//   node web/harness/vitrine-compare/serve.mjs [port] [glbDir]
//
//   /                → vitrine-compare.html
//   /dist/*          → web/dist/*   (Browser Runtime bundle + wasm)
//   /babylon.js      → bundled Babylon (esbuild, on first request)
//   /models          → JSON list of *.glb in the vitrine dir
//   /models/<name>   → the GLB bytes

import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const web = join(root, "web");

const PORT = Number(process.argv[2] || 8899);
const GLB_DIR = process.argv[3]
  || process.env.GLB_VITRINE_DIR
  || "E:/Nova pasta (2)/vitrine-glb/assets/models";

const MIME = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript",
  ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json", ".glb": "model/gltf-binary" };

let babylonBundle = null;
async function getBabylon() {
  if (babylonBundle) return babylonBundle;
  const r = await build({
    entryPoints: [join(here, "babylon-entry.mjs")],
    bundle: true, format: "esm", write: false, minify: true,
    platform: "browser", target: "es2022", logLevel: "silent",
  });
  babylonBundle = r.outputFiles[0].text;
  return babylonBundle;
}

const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split("?")[0]);
    const send = (body, type, code = 200) => { res.writeHead(code, { "content-type": type, "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" }); res.end(body); };

    if (url === "/" || url === "/index.html") return send(await readFile(join(here, "vitrine-compare.html")), "text/html");
    if (url === "/vitrine-compare.mjs") return send(await readFile(join(here, "vitrine-compare.mjs")), "text/javascript");
    if (url === "/babylon.js") return send(await getBabylon(), "text/javascript");

    if (url === "/models") {
      if (!existsSync(GLB_DIR)) return send(JSON.stringify({ dir: GLB_DIR, files: [], error: "dir not found" }), "application/json");
      const all = (await readdir(GLB_DIR)).filter((f) => f.toLowerCase().endsWith(".glb"));
      const files = [];
      for (const f of all) { const s = await stat(join(GLB_DIR, f)); files.push({ name: f, mb: +(s.size / 1048576).toFixed(1) }); }
      files.sort((a, b) => a.name.localeCompare(b.name));
      return send(JSON.stringify({ dir: GLB_DIR, files }), "application/json");
    }
    if (url.startsWith("/models/")) {
      const p = join(GLB_DIR, url.slice("/models/".length));
      return send(await readFile(p), "model/gltf-binary");
    }
    if (url.startsWith("/dist/")) {
      const p = join(web, "dist", url.slice("/dist/".length));
      return send(await readFile(p), MIME[extname(p)] || "application/octet-stream");
    }
    send("404 " + url, "text/plain", 404);
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});

server.listen(PORT, () => {
  console.log(`\n  side-by-side comparison:  http://localhost:${PORT}/`);
  console.log(`  models from:              ${GLB_DIR}  ${existsSync(GLB_DIR) ? "" : "(NOT FOUND — set GLB_VITRINE_DIR or pass a dir)"}\n`);
});
