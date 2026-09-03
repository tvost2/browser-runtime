// GLB viewer — loads a .glb through the REAL runtime pipeline and renders it.
//   glb-viewer.html?url=<glb>&spin=1
//
//   GLB → Asset → C++/WASM geometry → AssetManager.instantiate → Scene → WebGPU

import { Engine } from "../dist/engine.js";

const qs = new URLSearchParams(location.search);
const url = qs.get("url");
const spin = qs.get("spin") !== "0";
const geometry = qs.get("geom") || "auto";           // auto | wasm | js
const parser = qs.get("parser") || "js";             // js | native
const generateTangents = qs.get("tangents") === "1";
const hud = document.getElementById("hud");
const canvas = document.getElementById("c");
const dpr = Math.min(devicePixelRatio, 2);
canvas.width = Math.min(1600, innerWidth * dpr);
canvas.height = Math.min(1000, innerHeight * dpr);

const engine = await Engine.create(canvas);
const scene = engine.createScene();

const t0 = performance.now();
const { entities, result } = await scene.loadAsset(url, { geometry, parser, generateTangents });
const loadMs = performance.now() - t0;
const asset = result.asset;

// combined world-space AABB from the WASM-computed world matrices + local AABBs
engine.core.markHierarchyDirty();
const fr0 = scene.evaluate(canvas.width / canvas.height);
let mn = [1e30, 1e30, 1e30], mx = [-1e30, -1e30, -1e30];
const wm = engine.core.worldMatrices();
let anyMesh = false;
for (let i = 0; i < engine.core.count; i++) {
  const C = engine.core.components;
  const mid = C.meshId[i];
  const b = scene._meshBounds.get(mid);
  if (!b) continue;
  anyMesh = true;
  const m = wm.subarray(i * 16, i * 16 + 16);
  for (let c = 0; c < 8; c++) {
    const lx = (c & 1) ? b.max[0] : b.min[0], ly = (c & 2) ? b.max[1] : b.min[1], lz = (c & 4) ? b.max[2] : b.min[2];
    const rw = 1 / (lx * m[3] + ly * m[7] + lz * m[11] + m[15]);
    const x = (lx * m[0] + ly * m[4] + lz * m[8] + m[12]) * rw;
    const y = (lx * m[1] + ly * m[5] + lz * m[9] + m[13]) * rw;
    const z = (lx * m[2] + ly * m[6] + lz * m[10] + m[14]) * rw;
    mn = [Math.min(mn[0], x), Math.min(mn[1], y), Math.min(mn[2], z)];
    mx = [Math.max(mx[0], x), Math.max(mx[1], y), Math.max(mx[2], z)];
  }
}
if (!anyMesh) { mn = [-1, -1, -1]; mx = [1, 1, 1]; }
const center = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
const radius = Math.max(1e-3, Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2);

scene.camera.target = center;
scene.camera.fovY = 0.8;
scene.camera.fit(radius);

let t = 0;
engine.onBeforeRender(({ dtMs }) => {
  if (spin) t += Math.min(dtMs, 50) / 1000;
  const dist = radius / Math.tan(scene.camera.fovY / 2) * 1.3;
  scene.camera.position = [
    center[0] + Math.cos(t * 0.5) * dist,
    center[1] + radius * 0.5,
    center[2] + Math.sin(t * 0.5) * dist,
  ];
});

const fmt = (x, d = 2) => (x == null ? "—" : x.toFixed(d));
let acc = 0, accN = 0;
function frame() {
  const st = engine.renderOnce();
  acc += st.evalMs; accN++;
  if (accN >= 15) {
    hud.innerHTML =
      `<b>${url.split("/").pop()}</b>\n` +
      `load          ${fmt(loadMs, 1)} ms  (fetch ${fmt(result.timing.fetchMs, 1)} · decode ${fmt(result.timing.decodeMs, 1)})\n` +
      `geometry path ${asset.stats.geometryPath}  ·  ${asset.stats.wasmCrossings} JS↔WASM crossings\n` +
      `nodes ${asset.stats.nodes} · meshes ${asset.stats.meshes} · prims ${asset.stats.primitives}\n` +
      `verts ${asset.stats.vertices.toLocaleString()} · indices ${asset.stats.indices.toLocaleString()} · textures ${asset.stats.textures}\n` +
      `eval (WASM)   <b>${fmt(acc / accN, 3)} ms</b>\n` +
      `cpu frame     ${fmt(st.cpuFrameMs, 3)} ms  ·  gpu ${fmt(st.gpuMs, 3)} ms\n` +
      `fps ${fmt(st.fps, 0)} · visible ${st.visible}/${st.entities} · draw calls ${engine.renderer.drawCalls}\n` +
      (asset.ignored.length ? `ignored: ${asset.ignored.join(" · ")}` : "");
    acc = 0; accN = 0;
  }
  requestAnimationFrame(frame);
}
frame();

window.__viewer = { engine, scene, asset, result, aabb: { min: mn, max: mx }, entities };
window.__ready = true;
