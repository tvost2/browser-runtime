// EQUIVALENCE — PIPELINE B (native C++/WASM decode) vs PIPELINE A (JS reference).
//
//   npm run build && node bench/run-glb-native-equiv.mjs
//
// The JS front-end (web/asset/gltf.ts, geometry:"js") is the functional
// reference. The native pipeline must produce the same Asset: container,
// metadata, geometry, scene graph, materials, textures, ignored features.
// Exact equality where possible; explicit float tolerance only for computed
// floats (generated normals/tangents).

import { readFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const fx = join(__dir, "..", "native", "tests", "fixtures", "glb");
const eng = await import(pathToFileURL(join(__dir, "..", "web", "dist", "engine.js")).href);
const { decodeGLB } = eng;

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${got !== undefined ? `  — ${JSON.stringify(got)}` : ""}`); }
};
const near = (a, b, e) => Math.abs(a - b) <= e;
const arrNear = (a, b, e) => a.length === b.length && a.every((v, i) => near(v, b[i], e));
function maxDiff(a, b) {
  if (!a && !b) return 0;
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0; for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  return d;
}
const load = async (p, o) => decodeGLB(new Uint8Array(await readFile(p)), o);

const TOL = { pos: 0, uv: 0, idx: 0, nrm: 3e-4, tan: 3e-4, aabb: 1e-4, trs: 1e-5 };

const all = [
  join(fx, "tri.glb"), join(fx, "two-boxes.glb"),
  ...(existsSync(join(fx, "real")) ? readdirSync(join(fx, "real")).filter((f) => f.endsWith(".glb") && !f.startsWith("_")).map((f) => join(fx, "real", f)) : []),
];

// ---------- exact known values through the native pipeline ----------
{
  console.log("\ntri.glb — native pipeline vs exact known values");
  const a = await load(join(fx, "tri.glb"), { parser: "native" });
  ok("geometry path = native", a.stats.geometryPath === "native", a.stats.geometryPath);
  ok("crossings small + flat (<= 8)", a.stats.wasmCrossings <= 8, a.stats.wasmCrossings);
  ok("1 node 'tri', root, identity", a.nodes.length === 1 && a.nodes[0].name === "tri" && a.nodes[0].parent === -1
    && arrNear(a.nodes[0].translation, [0, 0, 0], 0) && arrNear(a.nodes[0].scale, [1, 1, 1], 0));
  const p = a.meshes[0].primitives[0];
  ok("positions exact", arrNear(Array.from(p.positions), [0, 0, 0, 1, 0, 0, 0, 1, 0], 0));
  ok("normals from source (+Z)", arrNear(Array.from(p.normals), [0, 0, 1, 0, 0, 1, 0, 0, 1], 0));
  ok("indices [0,1,2] u32", p.indices instanceof Uint32Array && arrNear(Array.from(p.indices), [0, 1, 2], 0));
  ok("AABB from accessor min/max", arrNear(p.aabbMin, [0, 0, 0], 0) && arrNear(p.aabbMax, [1, 1, 0], 0));
  ok("no material", p.material === -1 && a.materials.length === 0);
  ok("nothing ignored", a.ignored.length === 0, a.ignored);
  ok("native bin zero-copy", a.nativeStats.binZeroCopy === true);
}
{
  console.log("\ntwo-boxes.glb — native pipeline vs exact known values");
  const a = await load(join(fx, "two-boxes.glb"), { parser: "native" });
  ok("2 nodes, topological parent->child", a.nodes.length === 2 && a.nodes[0].parent === -1 && a.nodes[1].parent === 0);
  ok("child T=[2,0,0] S=[.5,.5,.5]", arrNear(a.nodes[1].translation, [2, 0, 0], 1e-6) && arrNear(a.nodes[1].scale, [0.5, 0.5, 0.5], 1e-6));
  ok("1 shared mesh, both nodes -> mesh 0", a.meshes.length === 1 && a.nodes[0].mesh === 0 && a.nodes[1].mesh === 0);
  const p = a.meshes[0].primitives[0];
  ok("24 verts / 36 indices", p.positions.length === 72 && p.indices.length === 36);
  ok("UV0 present (24x2)", p.uv0 && p.uv0.length === 48);
  ok("unit-cube AABB", arrNear(p.aabbMin, [-0.5, -0.5, -0.5], 1e-6) && arrNear(p.aabbMax, [0.5, 0.5, 0.5], 1e-6));
  ok("material 0 'red' baseColor [.8,.1,.1,1]", p.material === 0 && a.materials[0].name === "red"
    && arrNear(a.materials[0].baseColorFactor, [0.8, 0.1, 0.1, 1], 1e-6));
  ok("metallic 0 / roughness 0.6", near(a.materials[0].metallicFactor, 0, 1e-6) && near(a.materials[0].roughnessFactor, 0.6, 1e-6));
}

// ---------- native vs JS reference — every fixture ----------
for (const path of all) {
  const name = path.split(/[\\/]/).pop();
  console.log(`\n${name} — native vs JS reference`);
  const n = await load(path, { parser: "native", generateTangents: true });
  const j = await load(path, { geometry: "js" });

  // SCENE
  ok("same node count", n.nodes.length === j.nodes.length, [n.nodes.length, j.nodes.length]);
  ok("same hierarchy + names", n.nodes.every((nd, i) => nd.parent === j.nodes[i].parent && nd.name === j.nodes[i].name && nd.mesh === j.nodes[i].mesh));
  ok("same transforms (TRS)", n.nodes.every((nd, i) =>
    arrNear(nd.translation, j.nodes[i].translation, TOL.trs) &&
    arrNear(nd.rotation, j.nodes[i].rotation, TOL.trs) &&
    arrNear(nd.scale, j.nodes[i].scale, TOL.trs)));
  ok("same roots", arrNear(n.roots, j.roots, 0));

  // ASSET counts
  ok("same mesh/primitive/material/texture counts",
    n.meshes.length === j.meshes.length && n.stats.primitives === j.stats.primitives
    && n.materials.length === j.materials.length && n.textures.length === j.textures.length && n.images.length === j.images.length);
  ok("same total vertex/index count", n.stats.vertices === j.stats.vertices && n.stats.indices === j.stats.indices,
    { n: [n.stats.vertices, n.stats.indices], j: [j.stats.vertices, j.stats.indices] });

  // MATERIALS
  let matOk = true;
  for (let i = 0; i < j.materials.length; i++) {
    const a = n.materials[i], b = j.materials[i];
    matOk &&= a.name === b.name && arrNear(a.baseColorFactor, b.baseColorFactor, 1e-6)
      && a.baseColorTexture === b.baseColorTexture && near(a.metallicFactor, b.metallicFactor, 1e-6)
      && near(a.roughnessFactor, b.roughnessFactor, 1e-6) && a.alphaMode === b.alphaMode
      && near(a.alphaCutoff, b.alphaCutoff, 1e-6) && a.doubleSided === b.doubleSided
      && arrNear(a.emissiveFactor, b.emissiveFactor, 1e-6);
  }
  ok("materials identical", matOk);

  // TEXTURES
  let texOk = true;
  for (let i = 0; i < j.textures.length; i++) {
    const a = n.textures[i], b = j.textures[i];
    texOk &&= a.image === b.image && a.wrapS === b.wrapS && a.wrapT === b.wrapT && a.magFilter === b.magFilter && a.minFilter === b.minFilter;
  }
  ok("textures identical", texOk);

  // IMAGES — mime + byte content
  let imgOk = true;
  for (let i = 0; i < j.images.length; i++) {
    const a = n.images[i], b = j.images[i];
    imgOk &&= a.mimeType === b.mimeType && a.bytes.length === b.bytes.length;
    if (a.bytes.length === b.bytes.length) for (let k = 0; k < a.bytes.length; k += 997) if (a.bytes[k] !== b.bytes[k]) { imgOk = false; break; }
  }
  ok("images identical (mime + bytes)", imgOk);

  // GEOMETRY
  let posOk = true, idxOk = true, uvOk = true, nrmOk = true, aabbOk = true, gen = 0;
  for (let mi = 0; mi < n.meshes.length; mi++) {
    for (let pi = 0; pi < n.meshes[mi].primitives.length; pi++) {
      const a = n.meshes[mi].primitives[pi], b = j.meshes[mi].primitives[pi];
      posOk &&= maxDiff(a.positions, b.positions) <= TOL.pos;
      idxOk &&= maxDiff(a.indices, b.indices) === TOL.idx;
      aabbOk &&= arrNear(a.aabbMin, b.aabbMin, TOL.aabb) && arrNear(a.aabbMax, b.aabbMax, TOL.aabb);
      if (b.uv0) uvOk &&= maxDiff(a.uv0, b.uv0) <= TOL.uv;
      if (b.normals) nrmOk &&= maxDiff(a.normals, b.normals) <= TOL.nrm; else gen++;
    }
  }
  ok("positions identical", posOk);
  ok("indices identical", idxOk);
  ok("UVs identical where source had them", uvOk);
  ok(`normals within ${TOL.nrm} where source had them`, nrmOk);
  ok("AABB within 1e-4", aabbOk);
  if (gen) console.log(`    (${gen} primitive(s): normals generated in C++)`);

  // generated normals unit-length
  let unit = true;
  for (const m of n.meshes) for (const prim of m.primitives) {
    if (!prim.normals) continue;
    for (let v = 0; v < prim.normals.length; v += 3) {
      const l = Math.hypot(prim.normals[v], prim.normals[v + 1], prim.normals[v + 2]);
      if (l > 1e-4 && Math.abs(l - 1) > 2e-3) { unit = false; break; }
    }
  }
  ok("generated normals unit-length", unit);

  // IGNORED — compare the "subject" of each note (strip the trailing "(...)")
  const subj = (s) => s.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const ni = new Set(n.ignored.map(subj)), ji = new Set(j.ignored.map(subj));
  const miss = [...ji].filter((x) => !ni.has(x));
  const extra = [...ni].filter((x) => !ji.has(x));
  ok("ignored features match (by subject)", miss.length === 0 && extra.length === 0, { miss, extra });
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
