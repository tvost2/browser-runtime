// PROFILE step of the GLB investigation (docs/investigations/glb.md).
// Measures the raw cost of the operations a GLB loader must do, BEFORE any
// loader exists — to decide what goes in JS vs WASM vs GPU.
//
//   node bench/make-glb-fixtures.mjs && node --expose-gc bench/run-glb-profile.mjs
//
// For each fixture: file size, JSON-chunk vs BIN-chunk split, JSON.parse time,
// #accessors / #vertices / #indices / #images, and a naive accessor-decode pass
// (bytes → Float32Array copies, the work the loader will actually do).

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

const fx = join(dirname(fileURLToPath(import.meta.url)), "..", "native", "tests", "fixtures", "glb");
const files = [
  ...["tri.glb", "two-boxes.glb"].map((f) => join(fx, f)),
  ...(existsSync(join(fx, "real")) ? readdirSync(join(fx, "real")).filter((f) => f.endsWith(".glb")).map((f) => join(fx, "real", f)) : []),
];

const GLB_MAGIC = 0x46546c67, CHUNK_JSON = 0x4e4f534a, CHUNK_BIN = 0x004e4942;
const COMPONENT_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

/** split a GLB blob into { json, bin } — the one operation that must happen first */
function splitGLB(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error("not a GLB");
  if (dv.getUint32(4, true) !== 2) throw new Error("GLB version != 2");
  let o = 12, jsonBytes = null, bin = null;
  while (o < buf.byteLength) {
    const len = dv.getUint32(o, true), type = dv.getUint32(o + 4, true);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === CHUNK_JSON) jsonBytes = data;
    else if (type === CHUNK_BIN) bin = data;
    o += 8 + len;
  }
  return { jsonBytes, bin };
}

function median(a) { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }
const time = (n, fn) => { const s = new Float64Array(n); for (let i = 0; i < n; i++) { const a = performance.now(); fn(); s[i] = performance.now() - a; } return median(Array.from(s)); };

console.log(`\n${"fixture".padEnd(22)} ${"size".padStart(9)} ${"json".padStart(7)} ${"bin".padStart(9)} ${"parse".padStart(8)} ${"decode".padStart(8)}  contents`);
console.log("-".repeat(110));

const rows = [];
for (const path of files) {
  const buf = readFileSync(path);
  const name = path.split(/[\\/]/).slice(-1)[0];

  const { jsonBytes, bin } = splitGLB(buf);
  const jsonStr = Buffer.from(jsonBytes).toString("utf8");
  const reps = buf.length < 200_000 ? 2000 : 50;

  const parseMs = time(reps, () => JSON.parse(jsonStr));
  const gltf = JSON.parse(jsonStr);

  // naive accessor decode: for every accessor, copy its bytes out to a fresh
  // typed array (deinterleaving via byteStride). This is the CPU work the loader
  // does regardless of where the parser lives.
  const decodeMs = time(reps, () => {
    for (const acc of gltf.accessors ?? []) {
      const comps = TYPE_COUNT[acc.type], csize = COMPONENT_SIZE[acc.componentType];
      const bv = gltf.bufferViews[acc.bufferView ?? 0];
      const stride = bv.byteStride || comps * csize;
      const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
      const out = new Float32Array(acc.count * comps);
      const src = new DataView(bin.buffer, bin.byteOffset + base);
      for (let i = 0; i < acc.count; i++)
        for (let c = 0; c < comps; c++)
          out[i * comps + c] = acc.componentType === 5126
            ? src.getFloat32(i * stride + c * csize, true)
            : src.getUint16(i * stride + c * csize, true);
    }
  });

  const nVerts = (gltf.accessors ?? []).filter((a) => a.type === "VEC3").reduce((m, a) => Math.max(m, a.count), 0);
  const nIdx = (gltf.meshes ?? []).flatMap((m) => m.primitives).map((p) => p.indices).filter((i) => i != null)
    .reduce((s, i) => s + (gltf.accessors[i]?.count ?? 0), 0);
  const nImg = (gltf.images ?? []).length;
  const nPrim = (gltf.meshes ?? []).flatMap((m) => m.primitives).length;

  const row = {
    name, sizeKB: buf.length / 1024, jsonPct: 100 * jsonBytes.length / buf.length, binKB: (bin?.length ?? 0) / 1024,
    parseMs, decodeMs, nodes: (gltf.nodes ?? []).length, meshes: (gltf.meshes ?? []).length, prims: nPrim,
    accessors: (gltf.accessors ?? []).length, verts: nVerts, indices: nIdx, images: nImg, materials: (gltf.materials ?? []).length,
    exts: gltf.extensionsUsed ?? [],
  };
  rows.push(row);
  console.log(
    `${name.padEnd(22)} ${(row.sizeKB).toFixed(0).padStart(7)}KB ${row.jsonPct.toFixed(0).padStart(5)}% ` +
    `${row.binKB.toFixed(0).padStart(7)}KB ${row.parseMs.toFixed(3).padStart(8)} ${row.decodeMs.toFixed(3).padStart(8)}  ` +
    `${row.nodes}n ${row.meshes}m ${row.prims}p ${row.accessors}acc ${row.verts}v ${row.indices}i ${row.images}img ${row.materials}mat` +
    (row.exts.length ? ` ext:[${row.exts.join(",")}]` : ""),
  );
}

console.log("\nreadings:");
for (const r of rows) {
  const other = Math.max(0, (r.sizeKB - r.binKB - r.jsonPct / 100 * r.sizeKB));
  console.log(
    `- ${r.name}: JSON ${r.jsonPct.toFixed(0)}% of file, parse ${r.parseMs.toFixed(3)}ms, naive accessor decode ${r.decodeMs.toFixed(3)}ms` +
    (other > 4 ? `, ${other.toFixed(0)}KB embedded images (PNG/JPEG in the BIN — decode is a browser codec job, not ours)` : "") +
    (r.exts.length ? `. Extensions: ${r.exts.join(", ")}` : "."),
  );
}

import { writeFileSync } from "node:fs";
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "results", "glb-profile.json"),
  JSON.stringify({ kind: "glb-profile", rows }, null, 2));
console.log(`\nwrote bench/results/glb-profile.json`);
