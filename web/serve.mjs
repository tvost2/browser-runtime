// Tiny static server for local dev / browser tests. Serves web/ with the
// COOP/COEP headers needed for SharedArrayBuffer (pthreads builds).
//   node web/serve.mjs [port]

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";

const webDir = dirname(fileURLToPath(import.meta.url));
const root = join(webDir, "..");
const MIME = {
  ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript",
  ".wasm": "application/wasm", ".json": "application/json", ".css": "text/css", ".map": "application/json",
};

export function serve(port = 0) {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split("?")[0]);
      if (p === "/") p = "/harness/engine-demo.html";
      const abs = normalize(join(p.startsWith("/node_modules/") ? root : webDir,
        p.startsWith("/node_modules/") ? p : p.replace(/^\//, "")));
      const buf = await readFile(abs);
      res.writeHead(200, {
        "content-type": MIME[extname(p)] || "application/octet-stream",
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": "require-corp",
        "cache-control": "no-store",
      });
      res.end(buf);
    } catch { res.writeHead(404); res.end("404 " + req.url); }
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, port: server.address().port })));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("serve.mjs")) {
  const { port } = await serve(Number(process.argv[2]) || 8080);
  console.log(`serving web/ on http://localhost:${port}/  (engine-demo.html)`);
}
