// RuntimeRendererAdapter — paints the same city the Babylon scene is
// showing, but through the Browser Runtime engine (C++/WASM scene core
// + WebGPU), so the two renderers can be compared on the exact same real
// Uberlândia data (298k buildings + 34k streets, camera-streamed).
//
// It does NOT touch the Babylon scene or digitalTwinDemoMain's build
// path. While the engine toggle is on it does two things per relevant
// frame:
//   1. mirrors every visible Babylon mesh's world-space geometry into a
//      parallel Browser Runtime scene
//   2. copies the ArcRotateCamera pose and renders one runtime frame
//      onto an opaque canvas stacked over the Babylon one
//
// Two mirror modes:
//   · per-mesh   — one runtime entity per Babylon mesh (1:1, simplest)
//   · CELL MERGE — the many small building footprints in a grid cell are
//     baked into ONE mesh by the C++ `mergeMeshes` kernel, so the frame
//     goes from ~3.7k draws to ~dozens. Each merged vertex keeps its
//     source mesh's uniqueId, so `runtimePick()` still resolves the
//     individual building (pixel-accurate id buffer). Default ON.

import { Engine as RtEngine, CullStrategy, mergeMeshes } from '../../vendor/browser-runtime/engine.js';

// the emscripten glue module — it locates engine.wasm next to itself
const WASM_URL = new URL('../../vendor/browser-runtime/engine.mjs', import.meta.url).href;
const SKIP_NAME = /^(sky|gps|__|ground-|nav|route-|gpsAccuracy)/i;

// cell merge tuning (overridable from the console)
const DEFAULT_CELL = 1500;     // world units per grid cell (Uberlândia metric coords)
const BIG_MESH_VERTS = 12000;  // at/above this a mesh is mirrored 1:1 (ground, far-tier merges, ribbons)
const COLOR_LEVELS = 5;        // colour quantisation before grouping — fewer buckets, near-invisible on a city

let RT = null;
let bootPromise = null;

export async function initRuntimeRenderer(canvas) {
  if (RT) return { ok: true };
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    if (!navigator.gpu) return { ok: false, reason: 'WebGPU indisponível (precisa Chrome/Edge 113+ ou Safari 18+)' };
    const adapter = (await navigator.gpu.requestAdapter().catch(() => null))
      ?? (await navigator.gpu.requestAdapter({ forceFallbackAdapter: true }).catch(() => null));
    if (!adapter) return { ok: false, reason: 'nenhum adaptador WebGPU disponível (GPU antiga / bloqueada)' };
    let engine;
    try { engine = await RtEngine.create(canvas, { wasmUrl: WASM_URL }); }
    catch (e) { return { ok: false, reason: 'RtEngine.create: ' + (e?.message || e) }; }
    const scene = engine.createScene();
    scene.camera.up = [0, 1, 0];
    const merge = window.__twinMerge !== false;
    // cell merge → ~dozens of entities → the incremental Standard/Auto cull
    // wins (and pickAt needs the CPU render path). per-mesh → thousands of
    // flat entities, camera always moving → the GPU-driven cull path.
    scene.cullStrategy = merge ? CullStrategy.Auto : CullStrategy.Gpu;
    RT = {
      engine, scene, canvas, adapter,
      software: isSoftwareAdapter(adapter),
      merge,
      cell: Number(window.__twinCell) || DEFAULT_CELL,
      // per-mesh mode
      entities: new Map(),  // meshKey -> Entity (pooled; v0.1 has no per-entity delete)
      meshData: new Map(),  // meshKey -> {positions,indices}
      sig: new Map(),       // meshKey -> geometry signature
      // cell-merge mode
      groupEnt: new Map(),  // groupKey -> Entity
      groupSig: new Map(),  // groupKey -> membership signature (skip re-merge when unchanged)
      bigEnt: new Map(),    // meshKey -> Entity  (big meshes bypass the grid)
      bigSig: new Map(),
      idToMesh: new Map(),  // pick id (meshUniqueId) -> Babylon mesh
      materials: new Map(),
      nextMat: 0,
      live: new Set(),
      mirrorMs: 0, mirrorVerts: 0, mirrorTris: 0, mirrorMeshes: 0, mergedGroups: 0, remerged: 0,
      lastStats: null,
    };
    return { ok: true };
  })();
  return bootPromise;
}

function isSoftwareAdapter(a) {
  if (a?.isFallbackAdapter) return true;
  const i = a?.info || {};
  return /warp|swiftshader|llvmpipe|basic render|microsoft basic|software|lavapipe/i
    .test(`${i.vendor || ''} ${i.architecture || ''} ${i.description || ''}`);
}

export function isRuntimeReady() { return !!RT; }
export function runtimeStats() { return RT?.lastStats ?? null; }
export function runtimeInfo() {
  if (!RT) return null;
  const i = RT.adapter?.info || {};
  return {
    software: RT.software,
    adapter: i.description || i.vendor || (RT.software ? 'software' : 'GPU'),
    merge: RT.merge,
    cell: RT.cell,
    mergedGroups: RT.mergedGroups,
    remergedLast: RT.remerged,
    pooledEntities: RT.merge ? (RT.groupEnt.size + RT.bigEnt.size) : RT.entities.size,
    liveMeshes: RT.live.size,
    mirrorMs: RT.mirrorMs,
    mirrorVerts: RT.mirrorVerts,
    mirrorTris: RT.mirrorTris,
    geomUploadKB: (RT.engine.renderer.lastGeomUploadBytes || 0) / 1024,
    geomTotalMB: (RT.engine.renderer.geomBytesTotal || 0) / 1048576,
    gpuUploadKB: (RT.engine.renderer.lastGpuUploadBytes || 0) / 1024,
  };
}

function matIndexForColor(rgb) {
  // quantise so 51 near-identical building tints collapse to a handful of
  // materials → far fewer (cell, colour) merge groups. In merge mode this is
  // coarse (COLOR_LEVELS); the eye can't tell on a city block.
  const q = RT.merge ? COLOR_LEVELS : 255;
  const r = Math.round(rgb[0] * q) / q, g = Math.round(rgb[1] * q) / q, b = Math.round(rgb[2] * q) / q;
  const key = r + '-' + g + '-' + b;
  let idx = RT.materials.get(key);
  if (idx === undefined) {
    idx = RT.nextMat++;
    RT.materials.set(key, idx);
    RT.engine.renderer.registerMaterial(idx, { baseColorFactor: [r, g, b, 1], doubleSided: true });
  }
  return idx;
}

function colorOfMesh(mesh) {
  const m = mesh.material;
  if (m) {
    const c = m.emissiveColor && (m.emissiveColor.r + m.emissiveColor.g + m.emissiveColor.b) > 0.01
      ? m.emissiveColor
      : (m.diffuseColor || m.albedoColor);
    if (c) return [c.r, c.g, c.b];
  }
  return [0.55, 0.6, 0.68];
}

// world-space positions for a Babylon mesh (memcpy when the world matrix is
// identity — which almost every twin footprint is).
function worldPositions(mesh, pos, BABYLON, v) {
  const wm = mesh.computeWorldMatrix(true);
  if (wm.isIdentity()) return pos instanceof Float32Array ? pos.slice() : Float32Array.from(pos);
  const wpos = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    BABYLON.Vector3.TransformCoordinatesFromFloatsToRef(pos[i], pos[i + 1], pos[i + 2], wm, v);
    wpos[i] = v.x; wpos[i + 1] = v.y; wpos[i + 2] = v.z;
  }
  return wpos;
}

/** Diff the Babylon scene's meshes into the runtime scene. In cell-merge mode
 *  this is async (the C++ merge); callers may fire-and-forget — a re-entrant
 *  call while one is in flight is skipped. */
export function runtimeMirrorScene(babylonScene, BABYLON) {
  if (!RT) return;
  if (!RT.merge) return mirrorPerMesh(babylonScene, BABYLON);
  if (RT._mirroring) return RT._mirroring;
  RT._mirroring = mirrorMerged(babylonScene, BABYLON)
    .catch((e) => { console.warn('mirrorMerged', e); })
    .finally(() => { RT._mirroring = null; });
  return RT._mirroring;
}

/** Switch mirror strategy at runtime (console / a UI toggle). */
export function runtimeSetMerge(on) {
  if (!RT) { window.__twinMerge = on; return; }
  if (RT.merge === !!on) return;
  runtimeHideAll();
  RT.merge = !!on;
  RT.scene.cullStrategy = on ? CullStrategy.Auto : CullStrategy.Gpu;
  RT.groupSig.clear(); RT.bigSig.clear(); RT.sig.clear();
}

// ---- per-mesh mirror (1:1) -------------------------------------------------
function mirrorPerMesh(babylonScene, BABYLON) {
  const t0 = performance.now();
  const Pos = BABYLON.VertexBuffer.PositionKind;
  const v = new BABYLON.Vector3();
  const seen = new Set();
  let verts = 0, tris = 0, rebuilt = 0;

  for (const mesh of babylonScene.meshes) {
    const nv = mesh.getTotalVertices();
    if (nv === 0 || !mesh.isEnabled(false) || SKIP_NAME.test(mesh.name)) continue;
    const ni = mesh.getTotalIndices();
    if (ni === 0) continue;

    const key = 'm' + mesh.uniqueId;
    seen.add(key);
    const sig = nv + '/' + ni;
    verts += nv; tris += ni / 3;

    if (RT.sig.get(key) === sig) {
      const e = RT.entities.get(key);
      if (e) { e.visible = true; RT.live.add(key); }
      continue;
    }
    const idx = mesh.getIndices();
    const pos = mesh.getVerticesData(Pos);
    if (!pos || !idx || idx.length === 0) { seen.delete(key); continue; }
    rebuilt++;

    const md = { positions: worldPositions(mesh, pos, BABYLON, v), indices: idx instanceof Uint32Array ? idx : new Uint32Array(idx) };
    RT.meshData.set(key, md);
    RT.sig.set(key, sig);

    let e = RT.entities.get(key);
    if (!e) { e = RT.scene.createEntity(); RT.entities.set(key, e); }
    const meshId = RT.scene.registerMesh(md);
    RT.engine.renderer.setMeshMaterial(meshId, matIndexForColor(colorOfMesh(mesh)));
    e.setMesh(meshId);
    e.transform.position.set(0, 0, 0);
    e.visible = true;
    RT.live.add(key);
  }

  for (const key of RT.live) {
    if (seen.has(key)) continue;
    const e = RT.entities.get(key);
    if (e) e.visible = false;
  }
  RT.live = seen;
  RT.mirrorMs = performance.now() - t0;
  RT.mirrorVerts = verts | 0; RT.mirrorTris = tris | 0; RT.mirrorMeshes = seen.size;
  RT.mergedGroups = 0; RT.remerged = 0;
  return rebuilt;
}

// ---- cell-merge mirror ----------------------------------------------------
// Small footprints grouped by (grid cell, colour) → one baked mesh per group
// via the C++ merge kernel. A group is re-merged only when its membership
// changes (the streaming window adds/removes whole meshes). Big meshes go
// through 1:1. Async — mergeMeshes awaits the (cached) WASM module.
async function mirrorMerged(babylonScene, BABYLON) {
  const t0 = performance.now();
  const Pos = BABYLON.VertexBuffer.PositionKind;
  const v = new BABYLON.Vector3();
  const inv = 1 / RT.cell;
  let verts = 0, tris = 0, remerged = 0;

  // 1. bucket this frame's meshes
  const groups = new Map();  // groupKey -> { mat, items:[{id,positions,indices}], sigParts:[] }
  const seenBig = new Set();
  RT.idToMesh.clear();

  for (const mesh of babylonScene.meshes) {
    const nv = mesh.getTotalVertices();
    if (nv === 0 || !mesh.isEnabled(false) || SKIP_NAME.test(mesh.name)) continue;
    const ni = mesh.getTotalIndices();
    if (ni === 0) continue;
    verts += nv; tris += ni / 3;
    RT.idToMesh.set(mesh.uniqueId, mesh);

    const mat = matIndexForColor(colorOfMesh(mesh));

    if (nv >= BIG_MESH_VERTS) {
      // 1:1 — bypass the grid
      const key = 'b' + mesh.uniqueId;
      seenBig.add(key);
      const sig = nv + '/' + ni + '/' + mat;
      if (RT.bigSig.get(key) === sig) { const e = RT.bigEnt.get(key); if (e) e.visible = true; continue; }
      const idx = mesh.getIndices(); const pos = mesh.getVerticesData(Pos);
      if (!pos || !idx) { seenBig.delete(key); continue; }
      const md = { positions: worldPositions(mesh, pos, BABYLON, v), indices: idx instanceof Uint32Array ? idx : new Uint32Array(idx) };
      let e = RT.bigEnt.get(key);
      if (!e) { e = RT.scene.createEntity(); RT.bigEnt.set(key, e); }
      const meshId = RT.scene.registerMesh(md);
      RT.engine.renderer.setMeshMaterial(meshId, mat);
      e.setMesh(meshId); e.transform.position.set(0, 0, 0); e.visible = true;
      RT.bigSig.set(key, sig);
      continue;
    }

    // small footprint → grid cell
    const bb = mesh.getBoundingInfo().boundingBox;
    const cx = Math.floor(bb.centerWorld.x * inv);
    const cz = Math.floor(bb.centerWorld.z * inv);
    const gk = cx + ',' + cz + ':' + mat;
    let g = groups.get(gk);
    if (!g) groups.set(gk, (g = { mat, items: [], sigParts: [] }));
    const idx = mesh.getIndices(); const pos = mesh.getVerticesData(Pos);
    if (!pos || !idx) continue;
    g.items.push({ id: mesh.uniqueId, positions: worldPositions(mesh, pos, BABYLON, v), indices: idx instanceof Uint32Array ? idx : new Uint32Array(idx) });
    g.sigParts.push(mesh.uniqueId + '.' + nv);
  }

  // 2. (re)merge changed groups
  for (const [gk, g] of groups) {
    const sig = g.sigParts.sort().join('|');
    if (RT.groupSig.get(gk) === sig) { const e = RT.groupEnt.get(gk); if (e) e.visible = true; continue; }
    let m;
    try { m = await mergeMeshes(g.items); }
    catch (e) { console.warn('mergeMeshes falhou', gk, e); continue; }
    remerged++;
    let e = RT.groupEnt.get(gk);
    if (!e) { e = RT.scene.createEntity(); RT.groupEnt.set(gk, e); }
    const meshId = RT.scene.registerMesh(m.mesh);
    RT.engine.renderer.setMeshMaterial(meshId, g.mat);
    e.setMesh(meshId); e.transform.position.set(0, 0, 0); e.visible = true;
    RT.groupSig.set(gk, sig);
  }

  // 3. hide vanished groups / big meshes
  for (const [gk, e] of RT.groupEnt) if (!groups.has(gk)) { e.visible = false; RT.groupSig.delete(gk); }
  for (const [key, e] of RT.bigEnt) if (!seenBig.has(key)) { e.visible = false; RT.bigSig.delete(key); }

  RT.mirrorMs = performance.now() - t0;
  RT.mirrorVerts = verts | 0; RT.mirrorTris = tris | 0;
  RT.mirrorMeshes = RT.idToMesh.size;
  RT.mergedGroups = groups.size;
  RT.remerged = remerged;
  RT.live = new Set([...groups.keys()]);
  return remerged;
}

// Babylon ArcRotateCamera → Browser Runtime camera.
export function runtimeSyncCamera(babylonCamera) {
  if (!RT) return;
  babylonCamera.getViewMatrix(true);
  const p = babylonCamera.position, t = babylonCamera.target;
  const cam = RT.scene.camera;
  cam.position = [p.x, p.y, p.z];
  cam.target = [t.x, t.y, t.z];
  cam.fovY = babylonCamera.fov ?? 0.8;
  const dist = Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z) || 100;
  cam.near = Math.max(1.5, dist * 0.04);
  cam.far = Math.max(dist * 4, 4500);
}

export function runtimeRenderFrame(babylonCamera) {
  if (!RT) return null;
  runtimeSyncCamera(babylonCamera);
  const c = RT.canvas, dpr = Math.min(devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; RT.engine.renderer.resize?.(w, h); }
  RT.lastStats = RT.engine.renderOnce();
  return RT.lastStats;
}

/** Pixel-accurate pick through the runtime's id buffer. `clientX/clientY` are
 *  DOM coords (e.g. from a pointer event). Returns the Babylon mesh under the
 *  cursor (resolved from the per-vertex source id the merge kept), or null.
 *  Merge mode only — the per-mesh path has no pick ids. */
export async function runtimePick(clientX, clientY) {
  if (!RT || !RT.merge) return null;
  const r = RT.canvas.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const x = (clientX - r.left) * dpr;
  const y = (clientY - r.top) * dpr;
  let id;
  try { id = await RT.engine.pickAt(x, y); } catch { return null; }
  if (id < 0) return null;
  return RT.idToMesh.get(id) || null;
}

export function runtimeHideAll() {
  if (!RT) return;
  for (const e of RT.entities.values()) e.visible = false;
  for (const e of RT.groupEnt.values()) e.visible = false;
  for (const e of RT.bigEnt.values()) e.visible = false;
  RT.live.clear();
}

export function runtimeDebug() {
  if (!RT) return null;
  const cam = RT.scene.camera;
  const st = RT.lastStats;
  return {
    merge: RT.merge, cell: RT.cell,
    camPos: cam.position, camTarget: cam.target, camNear: cam.near, camFar: cam.far,
    mergedGroups: RT.mergedGroups, remergedLast: RT.remerged,
    bigMeshes: RT.bigEnt.size, idMapSize: RT.idToMesh.size,
    canvasWH: [RT.canvas.width, RT.canvas.height, RT.canvas.clientWidth, RT.canvas.clientHeight],
    materials: RT.materials.size,
    stats: st && { visible: st.visible, draws: st.drawCalls, batches: st.batches, entities: st.entities, wasmHeapMB: st.wasmHeapMB },
    lastErr: RT.engine.renderer.lastError || null,
  };
}
