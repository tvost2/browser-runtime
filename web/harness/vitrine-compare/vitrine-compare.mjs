// Side-by-side: the same vitrine GLB loaded and rendered by the Browser Runtime
// (left, C++/WASM + WebGPU) and by Babylon.js (right, WebGL). Both orbit the
// same framing so you can eyeball geometry, shading and cost.

import { Engine as RtEngine } from "/dist/engine.js";
const NO_BABYLON = new URLSearchParams(location.search).has("nobabylon");
const BJS = NO_BABYLON ? {} : await import("/babylon.js");

const $ = (id) => document.getElementById(id);
const errBox = $("err");
const showErr = (m) => { errBox.textContent = m; errBox.style.display = "block"; };

const sel = $("model");
const dpr = Math.min(devicePixelRatio, 2);
// size both canvases ONCE, before any engine is created (a WebGPU context /
// depth buffer is bound to the size at configure time)
function sizeCanvas(c) {
  const r = c.parentElement.getBoundingClientRect();
  c.width = Math.max(64, Math.round(r.width * dpr));
  c.height = Math.max(64, Math.round(r.height * dpr));
}

// ---------- model list ----------
let models = [];
try {
  const r = await fetch("/models").then((x) => x.json());
  models = r.files || [];
  $("dir").textContent = r.dir + (r.error ? "  — " + r.error : `  (${models.length} files)`);
  for (const m of models) {
    const o = document.createElement("option");
    o.value = m.name; o.textContent = `${m.name}   ${m.mb} MB`;
    sel.appendChild(o);
  }
} catch (e) { showErr("could not list models: " + e.message); }

const fmt = (x, d = 1) => (x == null || Number.isNaN(x) ? "—" : x.toFixed(d));

const cL = $("cL"), cR = $("cR");
// let the layout settle (the <select> just got its options) before we bind
// WebGPU/WebGL contexts to the canvas sizes
await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
sizeCanvas(cL); sizeCanvas(cR);

// ================= LEFT — Browser Runtime =================
const rt = { engine: null, scene: null };
async function loadRuntime(url) {
  if (!navigator.gpu) throw new Error("WebGPU not available — needs Chrome/Edge 113+");
  if (!(await navigator.gpu.requestAdapter().catch(() => null)) && !(await navigator.gpu.requestAdapter({ forceFallbackAdapter: true }).catch(() => null))) {
    const flag = location.href.includes("edge") || navigator.userAgent.includes("Edg") ? "edge://flags/#enable-unsafe-webgpu" : "chrome://flags/#enable-unsafe-webgpu";
    throw new Error(`no WebGPU adapter on this machine (GPU too old / blocklisted). Fix: paste  ${flag}  in a new tab → set "Unsafe WebGPU Support" to Enabled → restart the browser → reload this page.  OR run  npm run compare  (opens a pre-flagged browser).`);
  }
  $("sL").textContent = "loading…";
  if (rt.engine) { rt.engine.dispose(); rt.engine = null; }
  // canvas sized once at module load; the runtime engine binds its depth buffer to it
  const t0 = performance.now();
  rt.engine = await RtEngine.create(cL);
  rt.scene = rt.engine.createScene();
  const { result } = await rt.scene.loadAsset(url, { parser: "native", generateTangents: false });
  const loadMs = performance.now() - t0;
  const a = result.asset;

  // frame the world-space AABB of the mesh-bearing nodes only (skip
  // transform-only parents — AssetManager marks those invisible)
  rt.engine.core.markHierarchyDirty();
  rt.scene.evaluate(cL.width / cL.height);
  const wm = rt.engine.core.worldMatrices();
  const C = rt.engine.core.components;
  let mn = [1e30, 1e30, 1e30], mx = [-1e30, -1e30, -1e30];
  for (let i = 0; i < rt.engine.core.count; i++) {
    if (!(C.flags[i] & 0b010)) continue;                 // F_VISIBLE — real render nodes
    const b = rt.scene._meshBounds.get(C.meshId[i]);
    if (!b) continue;
    const m = wm.subarray(i * 16, i * 16 + 16);
    for (let c = 0; c < 8; c++) {
      const lx = (c & 1) ? b.max[0] : b.min[0], ly = (c & 2) ? b.max[1] : b.min[1], lz = (c & 4) ? b.max[2] : b.min[2];
      const w = 1 / (lx * m[3] + ly * m[7] + lz * m[11] + m[15]);
      mn = [Math.min(mn[0], (lx * m[0] + ly * m[4] + lz * m[8] + m[12]) * w),
            Math.min(mn[1], (lx * m[1] + ly * m[5] + lz * m[9] + m[13]) * w),
            Math.min(mn[2], (lx * m[2] + ly * m[6] + lz * m[10] + m[14]) * w)];
      mx = [Math.max(mx[0], (lx * m[0] + ly * m[4] + lz * m[8] + m[12]) * w),
            Math.max(mx[1], (lx * m[1] + ly * m[5] + lz * m[9] + m[13]) * w),
            Math.max(mx[2], (lx * m[2] + ly * m[6] + lz * m[10] + m[14]) * w)];
    }
  }
  if (mn[0] > mx[0]) { mn = [-1, -1, -1]; mx = [1, 1, 1]; }
  const ctr = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
  const rad = Math.max(1e-3, Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2);
  rt.center = ctr; rt.radius = rad;
  rt.scene.camera.target = ctr;
  rt.scene.camera.fovY = 0.8;
  // the camera orbits at ~2.6·r; keep far/near small (~40) so hyperbolic depth
  // stays precise — a ratio of thousands z-fights the near/far walls of a solid
  // mesh and you see straight through it (F-009).
  rt.scene.camera.near = rad * 0.6;
  rt.scene.camera.far = rad * 24;

  // the vitrine models are photogrammetry scans with imperfect triangle winding
  // — back-face culling punches holes in the near wall. Render every material
  // double-sided so they read as solid (Babylon does the same for these).
  for (let i = 0; i < Math.max(1, a.materials.length); i++) {
    const m = a.materials[i];
    rt.engine.renderer.registerMaterial(i, {
      baseColorFactor: m ? m.baseColorFactor : [0.82, 0.82, 0.86, 1],
      doubleSided: true,
    });
  }

  rt.stats = { loadMs, decodeMs: result.timing.decodeMs, path: a.stats.geometryPath,
    crossings: a.stats.wasmCrossings, verts: a.stats.vertices, tris: (a.stats.indices / 3) | 0,
    normalsGen: a.ignored.some((s) => /normals generated/.test(s)) };

  $("advL").innerHTML = `<b>decode + geometry in C++/WASM</b><br>` +
    `${rt.stats.normalsGen ? "area-weighted normals generated in C++ · " : ""}` +
    `${rt.stats.crossings} JS↔WASM crossings · SoA · WebGPU instanced draw`;
}

// ================= RIGHT — Babylon.js =================
// (cR + cL declared above)
const bb = { engine: null, scene: null };
async function loadBabylon(url) {
  $("sR").textContent = "loading…";
  if (bb.engine) { bb.engine.dispose(); bb.engine = null; }

  const t0 = performance.now();
  bb.engine = new BJS.Engine(cR, true, { antialias: true, preserveDrawingBuffer: false });
  bb.scene = new BJS.Scene(bb.engine);
  bb.scene.clearColor = new BJS.Color4(0.04, 0.05, 0.07, 1);
  const cam = new BJS.ArcRotateCamera("c", 1.0, 1.1, 10, BJS.Vector3.Zero(), bb.scene);
  cam.attachControl(cR, true);
  new BJS.HemisphericLight("h", new BJS.Vector3(0.4, 1, 0.3), bb.scene).intensity = 0.9;
  const dl = new BJS.DirectionalLight("d", new BJS.Vector3(-0.5, -0.9, -0.4), bb.scene); dl.intensity = 0.6;

  const tDecode0 = performance.now();
  await BJS.appendSceneAsync(url, bb.scene);
  const decodeMs = performance.now() - tDecode0;

  // frame it
  bb.scene.createOrUpdateSelectionOctree?.();
  let min = new BJS.Vector3(1e30, 1e30, 1e30), max = new BJS.Vector3(-1e30, -1e30, -1e30);
  let tris = 0, verts = 0, meshes = 0;
  for (const m of bb.scene.meshes) {
    if (!m.getTotalVertices || m.getTotalVertices() === 0) continue;
    meshes++; verts += m.getTotalVertices(); tris += (m.getTotalIndices() / 3) | 0;
    m.computeWorldMatrix(true);
    const bi = m.getBoundingInfo().boundingBox;
    min = BJS.Vector3.Minimize(min, bi.minimumWorld); max = BJS.Vector3.Maximize(max, bi.maximumWorld);
    if (m.getVerticesData && !m.isVerticesDataPresent("normal")) { m.createNormals(true); }  // Babylon: normals in JS
  }
  const ctr = BJS.Vector3.Center(min, max);
  const rad = Math.max(0.001, max.subtract(min).length() / 2);
  cam.target = ctr; cam.radius = rad * 2.4; cam.lowerRadiusLimit = rad * 0.3; cam.upperRadiusLimit = rad * 20;
  cam.minZ = rad * 0.02; cam.maxZ = rad * 40;
  bb.center = ctr; bb.radius = rad;

  const loadMs = performance.now() - t0;
  bb.stats = { loadMs, decodeMs, verts, tris, meshes };
  $("advR").innerHTML = `<b>decode + geometry in JavaScript</b><br>` +
    `class-per-mesh scene graph · normals computed in JS · WebGL draw`;
}

// ---------- load + render loop ----------
let camAngle = 0;
async function loadBoth(name) {
  const url = "/models/" + encodeURIComponent(name);
  errBox.style.display = "none";
  camAngle = 0;
  await Promise.allSettled([
    loadRuntime(url).catch((e) => { console.error(e); showErr("runtime: " + (e.message || e)); $("sL").textContent = "error: " + (e.message || e); }),
    NO_BABYLON ? null : loadBabylon(url).catch((e) => { console.error(e); showErr("babylon: " + (e.message || e)); $("sR").textContent = "error: " + (e.stack || e.message || e); }),
  ]);
}

let accL = 0, accR = 0, nn = 0;
function tick(ts) {
  const spin = $("spin").checked;
  if (spin) camAngle += 0.005;

  // both cameras: identical spherical pose around the model centre
  //   radius = 2.6·r · polar (beta) 1.15 rad from +Y · same azimuth
  const R = 2.6, BETA = 1.15;
  const sb = Math.sin(BETA), cb = Math.cos(BETA);
  // --- runtime ---
  if (rt.engine && rt.scene && rt.center) {
    const d = rt.radius * R;
    rt.scene.camera.position = [
      rt.center[0] + d * sb * Math.cos(camAngle),
      rt.center[1] + d * cb,
      rt.center[2] + d * sb * Math.sin(camAngle),
    ];
    const st = rt.engine.renderOnce();
    accL += st.cpuFrameMs;
  }
  // --- babylon --- (ArcRotate: alpha around +Y, beta from +Y)
  if (bb.engine && bb.scene && bb.radius) {
    const cam = bb.scene.activeCamera;
    if (cam) { cam.alpha = camAngle + Math.PI; cam.beta = BETA; cam.radius = bb.radius * R; }
    const t = performance.now();
    bb.scene.render();
    accR += performance.now() - t;
  }
  nn++;
  if (nn >= 20) {
    if (rt.engine && rt.stats) {
      const s = rt.engine.stats;
      $("sL").textContent =
        `load        ${fmt(rt.stats.loadMs)} ms   (decode ${fmt(rt.stats.decodeMs)} ms)\n` +
        `geometry    ${rt.stats.path}  ·  ${rt.stats.crossings} crossings  ·  ${rt.stats.normalsGen ? "normals gen (C++)" : "normals from file"}\n` +
        `verts ${rt.stats.verts.toLocaleString()}  ·  tris ${rt.stats.tris.toLocaleString()}\n` +
        `cpu frame   ${fmt(s.cpuFrameMs, 2)} ms   ·   eval ${fmt(s.evalMs, 2)} ms\n` +
        `fps ${fmt(s.fps, 0)}   visible ${s.visible}/${s.entities}   draws ${s.drawCalls}\n` +
        `wasm heap ${fmt(s.wasmHeapMB, 0)} MB`;
    }
    if (bb.engine && bb.stats) {
      const fMs = accR / 20;
      $("sR").textContent =
        `load        ${fmt(bb.stats.loadMs)} ms   (decode ${fmt(bb.stats.decodeMs)} ms)\n` +
        `geometry    javascript  ·  scene-graph objects  ·  normals in JS\n` +
        `verts ${bb.stats.verts.toLocaleString()}  ·  tris ${bb.stats.tris.toLocaleString()}  ·  meshes ${bb.stats.meshes}\n` +
        `render()    ${fmt(fMs, 2)} ms\n` +
        `fps ${fmt(1000 / Math.max(0.01, fMs), 0)}   draws ${fmt(bb.engine._drawCalls?.current ?? bb.engine.drawCalls?.current, 0)}`;
    }
    nn = accL = accR = 0;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

window.__cmp = { rt, bb };
$("reload").onclick = () => sel.value && loadBoth(sel.value);
sel.onchange = () => loadBoth(sel.value);
let _rz; addEventListener("resize", () => { clearTimeout(_rz); _rz = setTimeout(() => { sizeCanvas(cL); sizeCanvas(cR); rt.engine?.renderer.resize(cL.width, cL.height); bb.engine?.resize(); }, 120); });

if (models.length) { sel.value = models[0].name; await loadBoth(models[0].name); }
else showErr("no .glb files found — start the server with a valid vitrine dir");
