// GLB fixtures for the loader investigation.
//   node bench/make-glb-fixtures.mjs
//
//  - hand-authored (vendored, few KB, exact known values → parser unit tests):
//      native/tests/fixtures/glb/tri.glb        1 node, 1 triangle
//      native/tests/fixtures/glb/two-boxes.glb  parent→child nodes, 2 meshes,
//                                               shared geometry, one baseColor
//  - real-world (fetched, git-ignored, for the perf profile + material tests):
//      native/tests/fixtures/glb/real/*.glb     Khronos glTF-Sample-Assets
//
// The GLB writer here is intentionally tiny and readable — it doubles as
// documentation of the container format (docs/investigations/glb.md).

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "native", "tests", "fixtures", "glb");
const realDir = join(dir, "real");
mkdirSync(realDir, { recursive: true });

const GLB_MAGIC = 0x46546c67;   // "glTF"
const CHUNK_JSON = 0x4e4f534a;  // "JSON"
const CHUNK_BIN = 0x004e4942;   // "BIN\0"

/** pack {json, bin} into a GLB. bin is a Uint8Array (already the concatenated buffer). */
function writeGLB(path, json, bin) {
  const jsonBytes = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const jsonChunkLen = jsonBytes.length + jsonPad;
  const binChunkLen = bin.length + binPad;
  const total = 12 + 8 + jsonChunkLen + (bin.length ? 8 + binChunkLen : 0);

  const out = Buffer.alloc(total);
  let o = 0;
  out.writeUInt32LE(GLB_MAGIC, o); o += 4;
  out.writeUInt32LE(2, o); o += 4;                 // version
  out.writeUInt32LE(total, o); o += 4;
  out.writeUInt32LE(jsonChunkLen, o); o += 4;
  out.writeUInt32LE(CHUNK_JSON, o); o += 4;
  jsonBytes.copy(out, o); o += jsonBytes.length;
  out.fill(0x20, o, o + jsonPad); o += jsonPad;    // JSON pad = spaces
  if (bin.length) {
    out.writeUInt32LE(binChunkLen, o); o += 4;
    out.writeUInt32LE(CHUNK_BIN, o); o += 4;
    Buffer.from(bin.buffer, bin.byteOffset, bin.length).copy(out, o); o += bin.length;
    out.fill(0x00, o, o + binPad);
  }
  writeFileSync(path, out);
  return out.length;
}

// --- geometry helpers → { bin, accessors, bufferViews } for a component ---
function f32(arr) { return new Uint8Array(Float32Array.from(arr).buffer.slice()); }
function u16(arr) { return new Uint8Array(Uint16Array.from(arr).buffer.slice()); }
function minMax3(arr) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < arr.length; i += 3) for (let k = 0; k < 3; k++) {
    mn[k] = Math.min(mn[k], arr[i + k]); mx[k] = Math.max(mx[k], arr[i + k]);
  }
  return { min: mn, max: mx };
}

// ============================ tri.glb ============================
{
  const pos = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const nrm = [0, 0, 1, 0, 0, 1, 0, 0, 1];
  const idx = [0, 1, 2];
  const posB = f32(pos), nrmB = f32(nrm), idxB = u16(idx);
  const parts = [posB, nrmB, idxB];
  let off = 0; const views = parts.map((p) => { const v = { byteOffset: off, byteLength: p.length }; off += p.length + ((4 - p.length % 4) % 4); return v; });
  const bin = new Uint8Array(off);
  parts.forEach((p, i) => bin.set(p, views[i].byteOffset));
  const { min, max } = minMax3(pos);
  const json = {
    asset: { version: "2.0", generator: "browser-runtime fixture" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "tri" }],
    meshes: [{ name: "tri", primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, mode: 4 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min, max },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 2, componentType: 5123, count: 3, type: "SCALAR" },
    ],
    bufferViews: views.map((v, i) => ({ buffer: 0, byteOffset: v.byteOffset, byteLength: v.byteLength, target: i === 2 ? 34963 : 34962 })),
    buffers: [{ byteLength: off }],
  };
  const n = writeGLB(join(dir, "tri.glb"), json, bin);
  console.log(`tri.glb           ${n} B  (1 node, 3 verts, 1 tri)`);
}

// ========================== two-boxes.glb ==========================
// unit cube, 24 verts (per-face normals) + 36 indices. Two nodes: a root box and
// a child box (translated+scaled), both referencing mesh 0 → shared geometry.
{
  const h = 0.5;
  const faces = [
    { n: [0, 0, 1], v: [[-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]] },
    { n: [0, 0, -1], v: [[h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h]] },
    { n: [0, 1, 0], v: [[-h, h, h], [h, h, h], [h, h, -h], [-h, h, -h]] },
    { n: [0, -1, 0], v: [[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]] },
    { n: [1, 0, 0], v: [[h, -h, h], [h, -h, -h], [h, h, -h], [h, h, h]] },
    { n: [-1, 0, 0], v: [[-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h]] },
  ];
  const pos = [], nrm = [], uv = [], idx = [];
  faces.forEach((f, fi) => {
    f.v.forEach((p, vi) => { pos.push(...p); nrm.push(...f.n); uv.push(vi === 1 || vi === 2 ? 1 : 0, vi >= 2 ? 1 : 0); });
    const b = fi * 4; idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  const posB = f32(pos), nrmB = f32(nrm), uvB = f32(uv), idxB = u16(idx);
  const parts = [posB, nrmB, uvB, idxB];
  let off = 0; const views = parts.map((p) => { const v = { byteOffset: off, byteLength: p.length }; off += p.length + ((4 - p.length % 4) % 4); return v; });
  const bin = new Uint8Array(off);
  parts.forEach((p, i) => bin.set(p, views[i].byteOffset));
  const { min, max } = minMax3(pos);
  const json = {
    asset: { version: "2.0", generator: "browser-runtime fixture" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: "root", mesh: 0, translation: [0, 0, 0], children: [1] },
      { name: "child", mesh: 0, translation: [2, 0, 0], scale: [0.5, 0.5, 0.5], rotation: [0, 0, 0, 1] },
    ],
    meshes: [{ name: "box", primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0, mode: 4 }] }],
    materials: [{ name: "red", pbrMetallicRoughness: { baseColorFactor: [0.8, 0.1, 0.1, 1], metallicFactor: 0, roughnessFactor: 0.6 } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: "VEC3", min, max },
      { bufferView: 1, componentType: 5126, count: 24, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: 24, type: "VEC2" },
      { bufferView: 3, componentType: 5123, count: 36, type: "SCALAR" },
    ],
    bufferViews: views.map((v, i) => ({ buffer: 0, byteOffset: v.byteOffset, byteLength: v.byteLength, target: i === 3 ? 34963 : 34962 })),
    buffers: [{ byteLength: off }],
  };
  const n = writeGLB(join(dir, "two-boxes.glb"), json, bin);
  console.log(`two-boxes.glb     ${n} B  (2 nodes parent→child, shared mesh 0, 1 material, UVs)`);
}

// ====================== real-world (fetched) ======================
const REAL = {
  // name: [Khronos sample path, expected approx size class]
  "Box.glb": "Models/Box/glTF-Binary/Box.glb",
  "BoxTextured.glb": "Models/BoxTextured/glTF-Binary/BoxTextured.glb",
  "Duck.glb": "Models/Duck/glTF-Binary/Duck.glb",
  "DamagedHelmet.glb": "Models/DamagedHelmet/glTF-Binary/DamagedHelmet.glb",
};
const BASE = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/";
let fetched = 0;
for (const [name, path] of Object.entries(REAL)) {
  const dest = join(realDir, name);
  if (existsSync(dest)) { console.log(`real/${name.padEnd(20)} (cached)`); continue; }
  try {
    const res = await fetch(BASE + path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(dest, buf);
    console.log(`real/${name.padEnd(20)} ${(buf.length / 1024).toFixed(0)} KB  (fetched)`);
    fetched++;
  } catch (e) {
    console.warn(`real/${name.padEnd(20)} SKIP — ${e.message}`);
  }
}
console.log(`\nvendored: native/tests/fixtures/glb/{tri,two-boxes}.glb`);
console.log(`fetched:  native/tests/fixtures/glb/real/  (git-ignored${fetched ? "" : " — offline?"})`);
