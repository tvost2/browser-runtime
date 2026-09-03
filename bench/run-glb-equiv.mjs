// VALIDATE step of the GLB investigation. A passing parse is NOT a pass — this
// asserts the decoded Asset against known-exact values for the hand-authored
// fixtures, sanity + (optional) Babylon cross-check for the real ones.
//
//   node bench/make-glb-fixtures.mjs && npm run build:api && node bench/run-glb-equiv.mjs

import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const fx = join(__dir, "..", "native", "tests", "fixtures", "glb");
const { decodeGLB } = await import(pathToFileURL(join(__dir, "..", "web", "dist", "engine.js")).href);

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${got !== undefined ? `  — got ${JSON.stringify(got)}` : ""}`); }
};
const near = (a, b, e = 1e-5) => Math.abs(a - b) <= e;
const arrNear = (a, b, e = 1e-5) => a.length === b.length && a.every((v, i) => near(v, b[i], e));

async function load(name) {
  const { readFile } = await import("node:fs/promises");
  return decodeGLB(new Uint8Array(await readFile(name)));
}

// ============================ tri.glb ============================
{
  console.log("\ntri.glb — 1 node, 1 triangle, no material");
  const a = await load(join(fx, "tri.glb"));
  ok("1 node", a.nodes.length === 1, a.nodes.length);
  ok("node name 'tri'", a.nodes[0].name === "tri");
  ok("node is a root", a.nodes[0].parent === -1 && a.roots[0] === 0);
  ok("identity transform", arrNear(a.nodes[0].translation, [0, 0, 0]) && arrNear(a.nodes[0].rotation, [0, 0, 0, 1]) && arrNear(a.nodes[0].scale, [1, 1, 1]));
  ok("1 mesh, 1 primitive", a.meshes.length === 1 && a.meshes[0].primitives.length === 1);
  const p = a.meshes[0].primitives[0];
  ok("3 vertices", p.positions.length === 9, p.positions.length / 3);
  ok("positions exact", arrNear(Array.from(p.positions), [0, 0, 0, 1, 0, 0, 0, 1, 0]));
  ok("normals present, +Z", p.normals && arrNear(Array.from(p.normals), [0, 0, 1, 0, 0, 1, 0, 0, 1]));
  ok("3 indices [0,1,2]", p.indices.length === 3 && arrNear(Array.from(p.indices), [0, 1, 2]));
  ok("indices widened to Uint32", p.indices instanceof Uint32Array);
  ok("AABB from accessor min/max", arrNear(p.aabbMin, [0, 0, 0]) && arrNear(p.aabbMax, [1, 1, 0]));
  ok("no material", p.material === -1 && a.materials.length === 0);
  ok("positions zero-copy view", p.zeroCopy === true);
  ok("nothing ignored", a.ignored.length === 0, a.ignored);
}

// ========================== two-boxes.glb ==========================
{
  console.log("\ntwo-boxes.glb — parent→child, shared mesh, 1 material, UVs");
  const a = await load(join(fx, "two-boxes.glb"));
  ok("2 nodes", a.nodes.length === 2, a.nodes.length);
  ok("node 0 = root 'root'", a.nodes[0].name === "root" && a.nodes[0].parent === -1);
  ok("node 1 = child 'child' of node 0", a.nodes[1].name === "child" && a.nodes[1].parent === 0);
  ok("topological order (parent before child)", a.nodes[0].parent < 0 && a.nodes[1].parent === 0);
  ok("child translation [2,0,0]", arrNear(a.nodes[1].translation, [2, 0, 0]));
  ok("child scale [0.5,0.5,0.5]", arrNear(a.nodes[1].scale, [0.5, 0.5, 0.5]));
  ok("both reference mesh 0", a.nodes[0].mesh === 0 && a.nodes[1].mesh === 0);
  ok("1 mesh (shared, not duplicated)", a.meshes.length === 1);
  const p = a.meshes[0].primitives[0];
  ok("24 vertices", p.positions.length === 72, p.positions.length / 3);
  ok("36 indices", p.indices.length === 36);
  ok("UV0 present, 24×2", p.uv0 && p.uv0.length === 48);
  ok("normals present", p.normals && p.normals.length === 72);
  ok("unit-cube AABB", arrNear(p.aabbMin, [-0.5, -0.5, -0.5]) && arrNear(p.aabbMax, [0.5, 0.5, 0.5]));
  ok("primitive → material 0", p.material === 0);
  ok("1 material 'red'", a.materials.length === 1 && a.materials[0].name === "red");
  ok("baseColorFactor [0.8,0.1,0.1,1]", arrNear(a.materials[0].baseColorFactor, [0.8, 0.1, 0.1, 1]));
  ok("metallic 0, roughness 0.6", near(a.materials[0].metallicFactor, 0) && near(a.materials[0].roughnessFactor, 0.6));
  ok("no textures", a.textures.length === 0 && a.materials[0].baseColorTexture === -1);
}

// ====================== real-world sanity + Babylon cross-check ======================
let babylon = null;
try {
  await import("@babylonjs/core/index.js");
  await import("@babylonjs/loaders/glTF/2.0/index.js");
  babylon = await import("@babylonjs/core/index.js");
} catch { /* optional */ }

const realDir = join(fx, "real");
if (existsSync(realDir)) {
  for (const name of readdirSync(realDir).filter((f) => f.endsWith(".glb"))) {
    console.log(`\nreal/${name}`);
    const a = await load(join(realDir, name));
    ok("has ≥1 node", a.nodes.length >= 1, a.stats);
    ok("has ≥1 primitive", a.stats.primitives >= 1);
    ok("all nodes topological", a.nodes.every((n, i) => n.parent < i));
    ok("every primitive has positions & indices", a.meshes.every((m) => m.primitives.every((p) => p.positions.length > 0 && p.indices.length > 0)));
    ok("every index in range", a.meshes.every((m) => m.primitives.every((p) => {
      const nv = p.positions.length / 3; for (const ix of p.indices) if (ix >= nv) return false; return true;
    })));
    ok("AABB sane (min ≤ max)", a.meshes.every((m) => m.primitives.every((p) => p.aabbMin.every((v, k) => v <= p.aabbMax[k]))));
    console.log(`    stats: ${JSON.stringify(a.stats)}`);
    if (a.ignored.length) console.log(`    ignored: ${a.ignored.join(" · ")}`);

    if (babylon) {
      try {
        const { readFile } = await import("node:fs/promises");
        const b64 = Buffer.from(await readFile(join(realDir, name))).toString("base64");
        const scene = new babylon.Scene(new babylon.NullEngine());
        await babylon.appendSceneAsync("data:;base64," + b64, scene, { pluginExtension: ".glb" });
        const bMeshes = scene.meshes.filter((m) => m.getTotalVertices() > 0);
        const bVerts = bMeshes.reduce((s, m) => s + m.getTotalVertices(), 0);
        ok(`vertex count vs Babylon (${bVerts})`, Math.abs(bVerts - a.stats.vertices) <= bVerts * 0.02 || bVerts === a.stats.vertices, a.stats.vertices);
        scene.dispose();
      } catch (e) { console.log(`    (Babylon cross-check skipped: ${String(e).split("\n")[0]})`); }
    }
  }
} else {
  console.log("\n(no real/ fixtures — run bench/make-glb-fixtures.mjs online)");
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (!babylon) console.log("(install @babylonjs/loaders for the Babylon vertex-count cross-check)");
process.exit(fail ? 1 : 0);
