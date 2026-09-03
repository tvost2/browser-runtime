// RuntimeRendererAdapter — paints the same city the Babylon scene is
// showing, but through the Browser Runtime engine (C++/WASM scene core
// + WebGPU instanced draws), so the two renderers can be compared on
// the exact same real Uberlândia data (298k buildings + 34k streets,
// camera-streamed).
//
// It does NOT touch the Babylon scene or digitalTwinDemoMain's build
// path. While the engine toggle is on it does two things per relevant
// frame:
//   1. mirrors every visible Babylon mesh's world-space geometry into a
//      parallel Browser Runtime scene (diffed — only changed/new meshes
//      are rebuilt; the sliding window's add/remove falls out for free)
//   2. copies the ArcRotateCamera pose and renders one runtime frame
//      onto an opaque canvas stacked over the Babylon one
//
// Mirroring at the mesh level (not the DigitalTwinObject level) means it
// automatically covers the near tier, the merged far tier, the ground,
// everything Babylon actually draws — one integration point, no
// coupling to the demo's internal functions.

import { Engine as RtEngine, CullStrategy } from '../../vendor/browser-runtime/engine.js';

// the emscripten glue module — it locates engine.wasm next to itself
const WASM_URL = new URL('../../vendor/browser-runtime/engine.mjs', import.meta.url).href;
const SKIP_NAME = /^(sky|gps|__|ground-|nav|route-|gpsAccuracy)/i;

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
    // flat entities, thousands of them, camera always moving → the GPU-driven
    // cull path: compute-shader frustum cull + compaction, zero per-frame
    // matrix upload, CPU builds no render list.
    scene.cullStrategy = CullStrategy.Gpu;
    RT = {
      engine, scene, canvas,
      adapter,
      software: isSoftwareAdapter(adapter),
      entities: new Map(),  // meshKey -> Entity (pooled; v0.1 has no per-entity delete, hidden ones stay)
      meshData: new Map(),  // meshKey -> {positions,indices} (stable ref → registerMesh dedups)
      sig: new Map(),       // meshKey -> geometry signature (change detector)
      materials: new Map(),
      nextMat: 0,
      live: new Set(),
      mirrorMs: 0, mirrorVerts: 0, mirrorTris: 0, mirrorMeshes: 0,
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
    pooledEntities: RT.entities.size,
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
  const key = rgb.map((v) => Math.round(v * 255)).join('-');
  let idx = RT.materials.get(key);
  if (idx === undefined) {
    idx = RT.nextMat++;
    RT.materials.set(key, idx);
    RT.engine.renderer.registerMaterial(idx, { baseColorFactor: [rgb[0], rgb[1], rgb[2], 1], doubleSided: true });
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

/** Diff the Babylon scene's meshes into the runtime scene. Cheap when
 *  nothing changed (signature match → just flip visible back on). */
export function runtimeMirrorScene(babylonScene, BABYLON) {
  if (!RT) return;
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
    // uniqueId + vertex/index counts: the streaming window creates and
    // destroys whole meshes, it never resizes one in place, so this is a
    // reliable change detector and needs no bounding-info recompute.
    const sig = nv + '/' + ni;
    verts += nv; tris += ni / 3;

    if (RT.sig.get(key) === sig) { // unchanged geometry — just flip it back on, no readback
      const e = RT.entities.get(key);
      if (e) { e.visible = true; RT.live.add(key); }
      continue;
    }

    const idx = mesh.getIndices();
    const pos = mesh.getVerticesData(Pos);
    if (!pos || !idx || idx.length === 0) { seen.delete(key); continue; }
    rebuilt++;

    // Almost every twin mesh has an identity world matrix (footprints
    // carry absolute coords, mesh.position = 0, matrix frozen) — then a
    // plain memcpy replaces 1.5M per-vertex transforms.
    const wm = mesh.computeWorldMatrix(true);
    let wpos;
    if (wm.isIdentity()) {
      wpos = pos instanceof Float32Array ? pos.slice() : Float32Array.from(pos);
    } else {
      wpos = new Float32Array(pos.length);
      for (let i = 0; i < pos.length; i += 3) {
        BABYLON.Vector3.TransformCoordinatesFromFloatsToRef(pos[i], pos[i + 1], pos[i + 2], wm, v);
        wpos[i] = v.x; wpos[i + 1] = v.y; wpos[i + 2] = v.z;
      }
    }
    const md = { positions: wpos, indices: idx instanceof Uint32Array ? idx : new Uint32Array(idx) };
    RT.meshData.set(key, md);
    RT.sig.set(key, sig);

    let e = RT.entities.get(key);
    if (!e) { e = RT.scene.createEntity(); RT.entities.set(key, e); }
    const meshId = RT.scene.registerMesh(md);
    // the renderer resolves material PER MESH (meshMaterial map), not per
    // entity — entity.setMaterial alone leaves it on the default (white,
    // back-face-culled) material, which culls the whole city to black.
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
  return rebuilt;
}

// Babylon ArcRotateCamera → Browser Runtime camera. Same handedness
// (both left-handed), vertical FOV in radians — pose copies straight.
export function runtimeSyncCamera(babylonCamera) {
  if (!RT) return;
  // ArcRotateCamera computes .position from alpha/beta/radius only inside
  // getViewMatrix(); without a scene.render() this frame, .position is
  // stale. Force the recompute before reading it.
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

export function runtimeHideAll() {
  if (!RT) return;
  for (const e of RT.entities.values()) e.visible = false;
  RT.live.clear();
}

export function runtimeDebug() {
  if (!RT) return null;
  const cam = RT.scene.camera;
  let wb = null;
  try { const b = RT.scene._core.worldBounds(); wb = { min: [...b.min.slice(0, 3)], max: [...b.max.slice(0, 3)] }; } catch (e) { wb = 'err:' + e.message; }
  // sample a mirrored mesh's first vertex
  let sample = null;
  for (const md of RT.meshData.values()) { sample = [md.positions[0], md.positions[1], md.positions[2], 'nverts', md.positions.length / 3]; break; }
  const st = RT.lastStats;
  // per-entity world AABBs (a few) + which materials meshes use
  let entAabbs = 'err';
  try {
    const b = RT.scene._core.worldBounds();
    const n = RT.scene._core.count;
    const rows = [];
    for (let i = 0; i < n && rows.length < 6; i += Math.max(1, (n / 6) | 0)) {
      rows.push([i, [b.min[i*3].toFixed(0), b.min[i*3+1].toFixed(1), b.min[i*3+2].toFixed(0)], [b.max[i*3].toFixed(0), b.max[i*3+1].toFixed(1), b.max[i*3+2].toFixed(0)]]);
    }
    entAabbs = rows;
  } catch (e) { entAabbs = 'err:' + e.message; }
  return {
    camPos: cam.position, camTarget: cam.target, camNear: cam.near, camFar: cam.far, camFov: cam.fovY,
    worldBounds: wb, sampleVert: sample, entAabbs,
    canvasWH: [RT.canvas.width, RT.canvas.height, RT.canvas.clientWidth, RT.canvas.clientHeight],
    entities: RT.entities.size, live: RT.live.size, materials: RT.materials.size,
    stats: st && { visible: st.visible, draws: st.drawCalls, batches: st.batches, entities: st.entities, wasmHeapMB: st.wasmHeapMB },
    lastErr: RT.engine.renderer.lastError || null,
  };
}
