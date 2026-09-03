// The 9 required workloads, built on Babylon's NullEngine so the per-frame CPU
// pipeline (animation -> world matrix -> bounding -> culling -> render list)
// runs exactly as in production, without a GPU.
//
// Every scene is deterministic (seeded RNG) so JS and WASM backends get an
// identical workload.
//
// Object counts scale with BCPP_SCALE (env, default 1). Use BCPP_SCALE=3 for
// the full "thousands / stress" counts once you have a fast machine; the
// default is tuned so the whole suite runs in a couple of minutes.

import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { CreateBoxVertexData } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import { CreateSphereVertexData } from "@babylonjs/core/Meshes/Builders/sphereBuilder.js";
import { Animation } from "@babylonjs/core/Animations/animation.js";
import "@babylonjs/core/Animations/animatable.js";

// ---- deterministic RNG (mulberry32) ----
export function rng(seed = 0x9e3779b9) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function baseScene() {
  const engine = new NullEngine({
    renderWidth: 1920,
    renderHeight: 1080,
    textureSize: 512,
    deterministicLockstep: true,
    lockstepMaxSteps: 1,
  });
  const scene = new Scene(engine);
  scene.autoClear = false;
  scene.skipPointerMovePicking = true;
  const camera = new FreeCamera("cam", new Vector3(0, 0, -50), scene);
  camera.setTarget(Vector3.Zero());
  camera.maxZ = 2000;
  scene.activeCamera = camera;
  return { engine, scene, camera };
}

// A single shared geometry with `subdivisions` controlling vertex count.
function boxVD(size, subs = 1) {
  if (subs <= 1) return CreateBoxVertexData({ size });
  // build a subdivided grid-ish heavy mesh via sphere segments
  return CreateSphereVertexData({ diameter: size, segments: subs });
}

function scatter(scene, count, spread, geoFactory, { seed = 1, parented = false } = {}) {
  const r = rng(seed);
  const meshes = [];
  let parent = null;
  for (let i = 0; i < count; i++) {
    const m = new Mesh("m" + i, scene);
    geoFactory(i).applyToMesh(m);
    m.position.set((r() - 0.5) * spread, (r() - 0.5) * spread, (r() - 0.5) * spread);
    m.rotation.set(r() * 6.28, r() * 6.28, r() * 6.28);
    const s = 0.5 + r() * 1.5;
    m.scaling.set(s, s, s);
    if (parented && parent && i % 4 !== 0) m.parent = parent;
    else parent = m;
    m.alwaysSelectAsActiveMesh = false;
    meshes.push(m);
  }
  return meshes;
}

// ---------------------------------------------------------------------------
const SCALE = Number(process.env.BCPP_SCALE || 1);
const N = (base) => Math.max(1, Math.round(base * SCALE));

export const SCENES = {
  // 1. small
  small() {
    const c = baseScene();
    const shared = boxVD(2, 1);
    scatter(c.scene, N(50), 40, () => shared, { seed: 11 });
    return c;
  },

  // 2. medium
  medium() {
    const c = baseScene();
    const shared = boxVD(2, 1);
    scatter(c.scene, N(800), 120, () => shared, { seed: 22 });
    return c;
  },

  // 3. thousands of objects
  manyObjects() {
    const c = baseScene();
    const shared = boxVD(1, 1);
    scatter(c.scene, N(7000), 600, () => shared, { seed: 33 });
    return c;
  },

  // 4. heavy geometry (few meshes, huge vertex buffers)
  heavyGeometry() {
    const c = baseScene();
    scatter(c.scene, N(60), 80, () => boxVD(6, 96), { seed: 44 });
    return c;
  },

  // 5. many animations
  manyAnimations() {
    const c = baseScene();
    const shared = boxVD(2, 1);
    const meshes = scatter(c.scene, N(2500), 200, () => shared, { seed: 55 });
    const r = rng(999);
    for (const m of meshes) {
      const anim = new Animation("a", "position.y", 60, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
      const y0 = m.position.y;
      anim.setKeys([
        { frame: 0, value: y0 },
        { frame: 30, value: y0 + 10 * r() },
        { frame: 60, value: y0 },
      ]);
      m.animations = [anim];
      c.scene.beginAnimation(m, 0, 60, true, 0.5 + r());
    }
    return c;
  },

  // 6. many visible objects (all inside frustum -> culling keeps everything)
  manyVisible() {
    const c = baseScene();
    c.camera.position.set(0, 0, -400);
    c.camera.fov = 1.4;
    const shared = boxVD(1, 1);
    // pack in a slab directly in front of the camera
    const r = rng(66);
    for (let i = 0; i < N(6000); i++) {
      const m = new Mesh("v" + i, c.scene);
      shared.applyToMesh(m);
      m.position.set((r() - 0.5) * 300, (r() - 0.5) * 200, r() * 300);
      m.scaling.setAll(0.5 + r());
    }
    return c;
  },

  // 7. heavy culling (most objects behind camera / far outside frustum)
  heavyCulling() {
    const c = baseScene();
    c.camera.position.set(0, 0, -20);
    c.camera.fov = 0.4;
    const shared = boxVD(1, 1);
    const r = rng(77);
    for (let i = 0; i < N(7000); i++) {
      const m = new Mesh("c" + i, c.scene);
      shared.applyToMesh(m);
      // sphere shell around origin -> ~95% outside a narrow frustum
      const theta = r() * 6.283, phi = Math.acos(2 * r() - 1), rad = 200 + r() * 400;
      m.position.set(rad * Math.sin(phi) * Math.cos(theta), rad * Math.sin(phi) * Math.sin(theta), rad * Math.cos(phi));
      m.scaling.setAll(1 + r());
    }
    return c;
  },

  // 8. GPU-bound proxy: few meshes, but we mark the workload GPU-bound.
  //    On NullEngine there is no GPU; this exists so the harness/report can
  //    show "no CPU headroom to reclaim" honestly. Real GPU-bound runs happen
  //    in the browser harness (web/).
  gpuBound() {
    const c = baseScene();
    scatter(c.scene, N(200), 60, () => boxVD(3, 24), { seed: 88 });
    c.__note = "GPU-bound is only meaningful in the browser harness (web/).";
    return c;
  },

  // 9. CPU-bound: deep parented hierarchy + animations + culling churn
  cpuBound() {
    const c = baseScene();
    const shared = boxVD(1.5, 1);
    const meshes = scatter(c.scene, N(5000), 400, () => shared, { seed: 91, parented: true });
    const r = rng(1234);
    for (let i = 0; i < meshes.length; i += 3) {
      const m = meshes[i];
      const anim = new Animation("a", "rotation.y", 60, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
      anim.setKeys([{ frame: 0, value: 0 }, { frame: 60, value: 6.283 * (1 + r()) }]);
      m.animations = [anim];
      c.scene.beginAnimation(m, 0, 60, true, 0.5 + r());
    }
    return c;
  },
};

export const SCENE_KINDS = Object.keys(SCENES);

export function frameOf(ctx) {
  // one production frame; NullEngine makes GPU calls no-ops
  return () => ctx.scene.render();
}
