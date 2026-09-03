// VALIDATE — GLB decode correctness.
//   npm run test:glb   (needs: npm run build && npm run glb:fixtures)
//
//  1. WASM path (the real runtime path) vs exact known values for the
//     hand-authored fixtures.
//  2. WASM path vs the JS reference decoder, per fixture, with explicit float
//     tolerances — positions / normals / UVs / indices / AABB / counts /
//     materials / hierarchy. A silent difference fails the test.
//  3. real fixtures cross-checked against @babylonjs/loaders (vertex count).

import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const fx = join(__dir, "..", "native", "tests", "fixtures", "glb");
const { decodeGLB } = await import(pathToFileURL(join(__dir, "..", "web", "dist", "engine.js")).href);

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${got !== undefined ? `  — ${JSON.stringify(got)}` : ""}`); }
};
const near = (a, b, e = 1e-5) => Math.abs(a - b) <= e;
const arrNear = (a, b, e = 1e-5) => a.length === b.length && a.every((v, i) => near(v, b[i], e));

const load = async (name, opts) => decodeGLB(new Uint8Array(await readFile(name)), opts);

/** max abs diff between two flat arrays (with length check) */
function maxDiff(a, b) {
  if (!a && !b) return { d: 0, len: true };
  if (!a || !b || a.length !== b.length) return { d: Infinity, len: false };
  let d = 0; for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  return { d, len: true };
}

// ============================ tri.glb — exact ============================
{
  console.log("\ntri.glb — WASM path vs exact known values");
  const a = await load(join(fx, "tri.glb"), { geometry: "wasm" });
  ok("geometry path = wasm", a.stats.geometryPath === "wasm", a.stats.geometryPath);
  ok("crossings ≤ 12 (batch, not per-vertex)", a.stats.wasmCrossings <= 12, a.stats.wasmCrossings);
  ok("1 node 'tri', root, identity", a.nodes.length === 1 && a.nodes[0].name === "tri" && a.nodes[0].parent === -1
    && arrNear(a.nodes[0].translation, [0, 0, 0]) && arrNear(a.nodes[0].scale, [1, 1, 1]));
  const p = a.meshes[0].primitives[0];
  ok("3 vertices", p.positions.length === 9);
  ok("positions exact", arrNear(Array.from(p.positions), [0, 0, 0, 1, 0, 0, 0, 1, 0], 0));
  ok("normals from source (+Z)", arrNear(Array.from(p.normals), [0, 0, 1, 0, 0, 1, 0, 0, 1], 0));
  ok("indices [0,1,2] u32", p.indices instanceof Uint32Array && arrNear(Array.from(p.indices), [0, 1, 2]));
  ok("AABB from accessor min/max", arrNear(p.aabbMin, [0, 0, 0]) && arrNear(p.aabbMax, [1, 1, 0]));
  ok("no material", p.material === -1 && a.materials.length === 0);
  ok("nothing ignored", a.ignored.length === 0, a.ignored);
}

// ========================== two-boxes.glb — exact ==========================
{
  console.log("\ntwo-boxes.glb — WASM path vs exact known values");
  const a = await load(join(fx, "two-boxes.glb"), { geometry: "wasm" });
  ok("2 nodes, topological parent→child", a.nodes.length === 2 && a.nodes[0].parent === -1 && a.nodes[1].parent === 0);
  ok("child T=[2,0,0] S=[.5,.5,.5]", arrNear(a.nodes[1].translation, [2, 0, 0]) && arrNear(a.nodes[1].scale, [0.5, 0.5, 0.5]));
  ok("1 shared mesh, both nodes → mesh 0", a.meshes.length === 1 && a.nodes[0].mesh === 0 && a.nodes[1].mesh === 0);
  const p = a.meshes[0].primitives[0];
  ok("24 verts / 36 indices", p.positions.length === 72 && p.indices.length === 36);
  ok("UV0 present (24×2)", p.uv0 && p.uv0.length === 48);
  ok("normals present", p.normals && p.normals.length === 72);
  ok("unit-cube AABB", arrNear(p.aabbMin, [-0.5, -0.5, -0.5]) && arrNear(p.aabbMax, [0.5, 0.5, 0.5]));
  ok("material 0 'red' baseColor [.8,.1,.1,1]", p.material === 0 && a.materials[0].name === "red"
    && arrNear(a.materials[0].baseColorFactor, [0.8, 0.1, 0.1, 1]));
  ok("metallic 0 / roughness 0.6", near(a.materials[0].metallicFactor, 0) && near(a.materials[0].roughnessFactor, 0.6));
}

// ================= WASM vs JS reference — every fixture =================
const all = [
  join(fx, "tri.glb"), join(fx, "two-boxes.glb"),
  ...(existsSync(join(fx, "real")) ? readdirSync(join(fx, "real")).filter((f) => f.endsWith(".glb")).map((f) => join(fx, "real", f)) : []),
];
const TOL = { pos: 0, nrm: 3e-4, uv: 0, tan: 3e-4, aabb: 1e-4 }; // pos/uv are FLOAT copies → bit-identical

for (const path of all) {
  const name = path.split(/[\\/]/).pop();
  console.log(`\n${name} — WASM vs JS reference`);
  const w = await load(path, { geometry: "wasm", generateTangents: true });
  const j = await load(path, { geometry: "js" });

  ok("same node count", w.nodes.length === j.nodes.length, [w.nodes.length, j.nodes.length]);
  ok("same hierarchy", w.nodes.every((n, i) => n.parent === j.nodes[i].parent
    && arrNear(n.translation, j.nodes[i].translation) && arrNear(n.rotation, j.nodes[i].rotation) && arrNear(n.scale, j.nodes[i].scale)));
  ok("same mesh/primitive/material counts", w.meshes.length === j.meshes.length
    && w.stats.primitives === j.stats.primitives && w.materials.length === j.materials.length);
  ok("same total vertex/index count", w.stats.vertices === j.stats.vertices && w.stats.indices === j.stats.indices,
    { w: [w.stats.vertices, w.stats.indices], j: [j.stats.vertices, j.stats.indices] });

  let posOk = true, nrmOk = true, uvOk = true, idxOk = true, aabbOk = true, genN = 0;
  for (let mi = 0; mi < w.meshes.length; mi++) {
    for (let pi = 0; pi < w.meshes[mi].primitives.length; pi++) {
      const wp = w.meshes[mi].primitives[pi], jp = j.meshes[mi].primitives[pi];
      posOk &&= maxDiff(wp.positions, jp.positions).d <= TOL.pos;
      idxOk &&= maxDiff(wp.indices, jp.indices).d === 0;
      aabbOk &&= arrNear(wp.aabbMin, jp.aabbMin, TOL.aabb) && arrNear(wp.aabbMax, jp.aabbMax, TOL.aabb);
      if (jp.normals) nrmOk &&= maxDiff(wp.normals, jp.normals).d <= TOL.nrm;
      else genN++; // JS left normals null; WASM generated them — checked separately
      if (jp.uv0) uvOk &&= maxDiff(wp.uv0, jp.uv0).d <= TOL.uv;
    }
  }
  ok("positions identical (FLOAT copy)", posOk);
  ok("indices identical", idxOk);
  ok("AABB within 1e-4", aabbOk);
  ok(`normals within ${TOL.nrm} where source had them`, nrmOk);
  ok("UVs identical where source had them", uvOk);
  if (genN) console.log(`    (${genN} primitive(s): WASM generated normals the JS reference left null)`);

  // generated normals sanity: unit length
  for (const m of w.meshes) for (const prim of m.primitives) {
    if (!prim.normals) continue;
    let unit = true;
    for (let v = 0; v < prim.normals.length; v += 3) {
      const l = Math.hypot(prim.normals[v], prim.normals[v + 1], prim.normals[v + 2]);
      if (l > 1e-4 && Math.abs(l - 1) > 2e-3) { unit = false; break; }
    }
    ok(`${m.name}: normals unit length`, unit);
    break;
  }
}

// ============= "auto" hybrid dispatch — data must not change =============
for (const path of all) {
  const name = path.split(/[\\/]/).pop();
  const au = await load(path, { geometry: "auto" });
  const js = await load(path, { geometry: "js" });
  let same = au.meshes.length === js.meshes.length;
  for (let mi = 0; mi < au.meshes.length && same; mi++)
    for (let pi = 0; pi < au.meshes[mi].primitives.length && same; pi++) {
      const ap = au.meshes[mi].primitives[pi], jp = js.meshes[mi].primitives[pi];
      same &&= maxDiff(ap.positions, jp.positions).d === 0
        && maxDiff(ap.indices, jp.indices).d === 0
        && (!jp.normals || maxDiff(ap.normals, jp.normals).d <= 3e-4)
        && (!jp.uv0 || maxDiff(ap.uv0, jp.uv0).d === 0)
        && arrNear(ap.aabbMin, jp.aabbMin, 1e-4) && arrNear(ap.aabbMax, jp.aabbMax, 1e-4);
    }
  ok(`${name}: auto path (${au.stats.geometryPath}) matches js reference`, same);
}

// =================== Babylon vertex-count cross-check ===================
let babylon = null;
try {
  await import("@babylonjs/core/index.js");
  await import("@babylonjs/loaders/glTF/2.0/index.js");
  babylon = await import("@babylonjs/core/index.js");
} catch { /* optional */ }
if (babylon && existsSync(join(fx, "real"))) {
  for (const f of readdirSync(join(fx, "real")).filter((x) => x.endsWith(".glb"))) {
    const a = await load(join(fx, "real", f));
    try {
      const b64 = Buffer.from(await readFile(join(fx, "real", f))).toString("base64");
      const scene = new babylon.Scene(new babylon.NullEngine());
      await babylon.appendSceneAsync("data:;base64," + b64, scene, { pluginExtension: ".glb" });
      const bVerts = scene.meshes.filter((m) => m.getTotalVertices() > 0).reduce((s, m) => s + m.getTotalVertices(), 0);
      ok(`${f}: vertex count vs Babylon (${bVerts})`, bVerts === a.stats.vertices, a.stats.vertices);
      scene.dispose();
    } catch (e) { console.log(`  (Babylon skip ${f}: ${String(e).split("\n")[0]})`); }
  }
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (!babylon) console.log("(install @babylonjs/loaders for the Babylon cross-check)");
process.exit(fail ? 1 : 0);
