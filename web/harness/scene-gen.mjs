// Browser-safe SoA scene generator. Produces the backend `upload()` scene shape
// directly (no Babylon dependency), deterministic per seed. Mirrors the intent
// of bench/scenes.mjs so browser numbers are comparable to the Node profiling.

export function rng(seed = 0x9e3779b9) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quatFromEuler(px, py, pz) {
  const hr = pz * 0.5, hp = px * 0.5, hy = py * 0.5;
  const sr = Math.sin(hr), cr = Math.cos(hr), sp = Math.sin(hp), cp = Math.cos(hp), sy = Math.sin(hy), cy = Math.cos(hy);
  return [cy * sp * cr + sy * cp * sr, sy * cp * cr - cy * sp * sr, cy * cp * sr - sy * sp * cr, cy * cp * cr + sy * sp * sr];
}

const PRESETS = {
  small: { n: 50, spread: 40, seed: 11 },
  medium: { n: 800, spread: 120, seed: 22 },
  manyObjects: { n: 20000, spread: 600, seed: 33 },
  manyAnimations: { n: 8000, spread: 200, seed: 55, animate: true },
  manyVisible: { n: 15000, spread: 300, seed: 66, inFront: true },
  heavyCulling: { n: 20000, spread: 600, seed: 77, shell: true },
  cpuBound: { n: 12000, spread: 400, seed: 91, parented: true, animate: true },
};

export function buildScene(kind, scale = 1) {
  const cfg = PRESETS[kind] || PRESETS.medium;
  const n = Math.max(1, Math.round(cfg.n * scale));
  const r = rng(cfg.seed);

  const parents = new Int32Array(n).fill(-1);
  const trs = new Float32Array(n * 10);
  const extents = new Float32Array(n * 6);
  const flags = new Uint32Array(n);
  let lastRoot = -1;

  for (let i = 0; i < n; i++) {
    let x, y, z;
    if (cfg.shell) {
      const th = r() * 6.283, ph = Math.acos(2 * r() - 1), rad = 200 + r() * 400;
      x = rad * Math.sin(ph) * Math.cos(th); y = rad * Math.sin(ph) * Math.sin(th); z = rad * Math.cos(ph);
    } else if (cfg.inFront) {
      x = (r() - 0.5) * cfg.spread; y = (r() - 0.5) * cfg.spread * 0.66; z = r() * cfg.spread;
    } else {
      x = (r() - 0.5) * cfg.spread; y = (r() - 0.5) * cfg.spread; z = (r() - 0.5) * cfg.spread;
    }
    const q = quatFromEuler(r() * 6.28, r() * 6.28, r() * 6.28);
    const s = 0.5 + r() * 1.5;
    const b = i * 10;
    trs[b] = x; trs[b + 1] = y; trs[b + 2] = z;
    trs[b + 3] = q[0]; trs[b + 4] = q[1]; trs[b + 5] = q[2]; trs[b + 6] = q[3];
    trs[b + 7] = s; trs[b + 8] = s; trs[b + 9] = s;
    extents.set([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5], i * 6);
    flags[i] = 0b011;
    if (cfg.parented && lastRoot >= 0 && i % 4 !== 0) parents[i] = lastRoot;
    else lastRoot = i;
  }

  const camera = cfg.inFront ? { pos: [0, 0, -cfg.spread], fov: 1.2 }
    : cfg.shell ? { pos: [0, 0, -20], fov: 0.4 }
    : { pos: [0, 0, -Math.max(50, cfg.spread * 0.6)], fov: 0.9 };

  return { kind, scale, scene: { count: n, parents, trs, extents, flags }, camera, animate: !!cfg.animate };
}

export const SCENE_KINDS = Object.keys(PRESETS);

// Babylon LookAtLH + PerspectiveFovLH, row-major, so it matches native/frustum.
export function makeViewProj(camPos, target, aspect, fov, near = 2, far = 3000) {
  const z = norm(sub(target, camPos));
  const x = norm(cross([0, 1, 0], z));
  const y = cross(z, x);
  const view = [
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, camPos), -dot(y, camPos), -dot(z, camPos), 1,
  ];
  const f = 1 / Math.tan(fov / 2);
  const proj = [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far / (far - near), 1,
    0, 0, -(near * far) / (far - near), 0,
  ];
  return mul4(view, proj);
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
function mul4(a, b) {
  const o = new Float32Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
    o[r * 4 + c] = s;
  }
  return o;
}
