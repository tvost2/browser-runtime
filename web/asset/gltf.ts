// glTF 2.0 → Asset (the subset defined in docs/investigations/glb.md).
// Pure data: no renderer, no WASM. Anything unsupported is recorded in
// `asset.ignored` — never silently dropped.

import { parseContainer, base64ToBytes, type GltfContainer } from "./glb.js";
import {
  AlphaMode,
  type Asset, type AssetNode, type AssetMesh, type AssetPrimitive,
  type AssetMaterial, type AssetTexture, type AssetImage,
} from "./Asset.js";

const COMPONENT = {
  5120: { size: 1, get: (dv: DataView, o: number) => dv.getInt8(o) },
  5121: { size: 1, get: (dv: DataView, o: number) => dv.getUint8(o) },
  5122: { size: 2, get: (dv: DataView, o: number) => dv.getInt16(o, true) },
  5123: { size: 2, get: (dv: DataView, o: number) => dv.getUint16(o, true) },
  5125: { size: 4, get: (dv: DataView, o: number) => dv.getUint32(o, true) },
  5126: { size: 4, get: (dv: DataView, o: number) => dv.getFloat32(o, true) },
} as const;
const TYPE_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

export interface DecodeOptions {
  /** resolve an external `buffers[].uri` / `images[].uri`. Return null to skip. */
  resolveUri?: (uri: string) => Promise<Uint8Array | null>;
}

export async function decodeGLB(bytes: Uint8Array, opts: DecodeOptions = {}): Promise<Asset> {
  return decodeContainer(parseContainer(bytes), opts);
}

export async function decodeContainer(c: GltfContainer, opts: DecodeOptions = {}): Promise<Asset> {
  const g = c.json;
  const ignored: string[] = [];
  const note = (s: string) => { if (!ignored.includes(s)) ignored.push(s); };

  for (const ext of g.extensionsRequired ?? []) note(`extensionsRequired: ${ext} (not supported)`);
  for (const ext of g.extensionsUsed ?? []) note(`extensionsUsed: ${ext} (ignored)`);
  if (g.animations?.length) note(`${g.animations.length} animation(s) (Phase 8)`);
  if (g.skins?.length) note(`${g.skins.length} skin(s) (Phase 9)`);
  if (g.cameras?.length) note(`${g.cameras.length} camera(s) (Phase 3 owns cameras)`);

  // ---- buffers ----
  const buffers: (Uint8Array | null)[] = [];
  for (let i = 0; i < (g.buffers?.length ?? 0); i++) {
    const b = g.buffers[i];
    if (b.uri == null) { buffers[i] = c.bin; if (!c.bin) note(`buffer ${i}: no uri and no BIN chunk`); }
    else if (/^data:/.test(b.uri)) buffers[i] = dataUri(b.uri);
    else if (opts.resolveUri) buffers[i] = await opts.resolveUri(b.uri);
    else { buffers[i] = null; note(`buffer ${i}: external uri "${b.uri}" (no resolver)`); }
  }

  // ---- accessor decode (zero-copy when the layout allows) ----
  let zeroCopy = 0, copied = 0;
  function readAccessor(idx: number): { data: Float32Array | Uint32Array; view: boolean } {
    const acc = g.accessors[idx];
    const comps = TYPE_COMPONENTS[acc.type];
    const comp = (COMPONENT as any)[acc.componentType];
    if (!comp) throw new GltfError(`accessor ${idx}: componentType ${acc.componentType}`);
    const bv = g.bufferViews[acc.bufferView ?? 0];
    const buf = buffers[bv.buffer];
    if (!buf) throw new GltfError(`accessor ${idx}: buffer ${bv.buffer} unavailable`);
    const stride: number = bv.byteStride ?? comps * comp.size;
    const base = (buf.byteOffset) + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const packed = stride === comps * comp.size;

    if (acc.sparse) { note(`accessor ${idx}: sparse (densified via copy)`); }

    // fast path: FLOAT, packed, aligned → view
    if (acc.componentType === 5126 && packed && !acc.normalized && !acc.sparse && base % 4 === 0) {
      zeroCopy++;
      return { data: new Float32Array(buf.buffer, base, acc.count * comps), view: true };
    }
    // fast path: UNSIGNED_INT indices, packed, aligned → view
    if (acc.componentType === 5125 && packed && !acc.sparse && base % 4 === 0) {
      zeroCopy++;
      return { data: new Uint32Array(buf.buffer, base, acc.count * comps), view: true };
    }
    // slow path: copy + widen/convert
    copied++;
    const isIndexLike = acc.type === "SCALAR" && acc.componentType !== 5126;
    const out = isIndexLike ? new Uint32Array(acc.count * comps) : new Float32Array(acc.count * comps);
    const dv = new DataView(buf.buffer, buf.byteOffset + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0));
    for (let i = 0; i < acc.count; i++)
      for (let k = 0; k < comps; k++) {
        let v = comp.get(dv, i * stride + k * comp.size);
        if (acc.normalized) v = normalize(v, acc.componentType);
        (out as any)[i * comps + k] = v;
      }
    if (acc.sparse) applySparse(out as Float32Array | Uint32Array, acc.sparse, g, buffers, comps);
    return { data: out, view: false };
  }

  // ---- meshes / primitives ----
  const meshes: AssetMesh[] = (g.meshes ?? []).map((m: any, mi: number) => ({
    name: m.name ?? `mesh${mi}`,
    primitives: (m.primitives ?? []).map((p: any, pi: number): AssetPrimitive => {
      if ((p.mode ?? 4) !== 4) note(`mesh ${mi} primitive ${pi}: mode ${p.mode} (only TRIANGLES=4)`);
      const a = p.attributes ?? {};
      if (a.POSITION == null) throw new GltfError(`mesh ${mi} primitive ${pi}: no POSITION`);
      const posAcc = readAccessor(a.POSITION);
      const pos = posAcc.data as Float32Array;
      const nrm = a.NORMAL != null ? readAccessor(a.NORMAL).data as Float32Array : null;
      const uv0 = a.TEXCOORD_0 != null ? readAccessor(a.TEXCOORD_0).data as Float32Array : null;
      const col0 = a.COLOR_0 != null ? readAccessor(a.COLOR_0).data as Float32Array : null;
      for (const k of Object.keys(a)) if (!["POSITION", "NORMAL", "TEXCOORD_0", "COLOR_0", "TANGENT"].includes(k)) note(`attribute ${k} (ignored)`);
      if (a.TANGENT != null) note("TANGENT (ignored — Phase 7)");

      let idx: Uint32Array;
      if (p.indices != null) idx = toU32(readAccessor(p.indices).data);
      else { idx = new Uint32Array(pos.length / 3); for (let i = 0; i < idx.length; i++) idx[i] = i; }

      const accPos = g.accessors[a.POSITION];
      let mn: [number, number, number], mx: [number, number, number];
      if (accPos.min && accPos.max) { mn = accPos.min.slice(0, 3); mx = accPos.max.slice(0, 3); }
      else { [mn, mx] = aabbOf(pos); }

      return {
        positions: pos, normals: nrm, uv0, color0: col0, indices: idx,
        material: p.material ?? -1, aabbMin: mn, aabbMax: mx,
        zeroCopy: posAcc.view,
      };
    }),
  }));

  // ---- materials ----
  const materials: AssetMaterial[] = (g.materials ?? []).map((m: any, i: number): AssetMaterial => {
    const pbr = m.pbrMetallicRoughness ?? {};
    if (m.normalTexture) note(`material ${i}: normalTexture (Phase 5)`);
    if (m.occlusionTexture) note(`material ${i}: occlusionTexture (Phase 5)`);
    if (pbr.metallicRoughnessTexture) note(`material ${i}: metallicRoughnessTexture (Phase 5)`);
    return {
      name: m.name ?? `material${i}`,
      baseColorFactor: (pbr.baseColorFactor ?? [1, 1, 1, 1]).slice(0, 4) as [number, number, number, number],
      baseColorTexture: pbr.baseColorTexture?.index ?? -1,
      metallicFactor: pbr.metallicFactor ?? 1,
      roughnessFactor: pbr.roughnessFactor ?? 1,
      emissiveFactor: (m.emissiveFactor ?? [0, 0, 0]).slice(0, 3) as [number, number, number],
      alphaMode: m.alphaMode === "MASK" ? AlphaMode.Mask : m.alphaMode === "BLEND" ? AlphaMode.Blend : AlphaMode.Opaque,
      alphaCutoff: m.alphaCutoff ?? 0.5,
      doubleSided: !!m.doubleSided,
    };
  });

  // ---- textures / images ----
  const images: AssetImage[] = [];
  for (let i = 0; i < (g.images?.length ?? 0); i++) {
    const im = g.images[i];
    let bytes: Uint8Array | null = null, mime = im.mimeType ?? "image/png";
    if (im.bufferView != null) {
      const bv = g.bufferViews[im.bufferView], buf = buffers[bv.buffer];
      if (buf) bytes = buf.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
    } else if (im.uri && /^data:/.test(im.uri)) {
      bytes = dataUri(im.uri); mime = /^data:(.*?);/.exec(im.uri)?.[1] ?? mime;
    } else if (im.uri && opts.resolveUri) {
      bytes = await opts.resolveUri(im.uri);
      mime = im.uri.endsWith(".jpg") || im.uri.endsWith(".jpeg") ? "image/jpeg" : "image/png";
    } else if (im.uri) note(`image ${i}: external uri "${im.uri}" (no resolver)`);
    images.push({ mimeType: mime, bytes: bytes ?? new Uint8Array() });
  }
  const textures: AssetTexture[] = (g.textures ?? []).map((t: any): AssetTexture => {
    const s = g.samplers?.[t.sampler] ?? {};
    return { image: t.source ?? 0, wrapS: s.wrapS ?? 10497, wrapT: s.wrapT ?? 10497, magFilter: s.magFilter ?? 9729, minFilter: s.minFilter ?? 9987 };
  });

  // ---- nodes: topological order, resolve matrix→TRS, compute parent index ----
  const srcNodes = g.nodes ?? [];
  const parentOf = new Int32Array(srcNodes.length).fill(-1);
  for (let i = 0; i < srcNodes.length; i++)
    for (const c of srcNodes[i].children ?? []) parentOf[c] = i;

  const sceneRoots: number[] = (g.scenes?.[g.scene ?? 0]?.nodes) ?? srcNodes.map((_: any, i: number) => i).filter((i: number) => parentOf[i] === -1);

  const order: number[] = [];
  const seen = new Uint8Array(srcNodes.length);
  const walk = (i: number) => { if (seen[i]) return; seen[i] = 1; order.push(i); for (const c of srcNodes[i].children ?? []) walk(c); };
  for (const r of sceneRoots) walk(r);
  for (let i = 0; i < srcNodes.length; i++) walk(i); // any detached nodes

  const remap = new Int32Array(srcNodes.length).fill(-1);
  order.forEach((oldIdx, newIdx) => { remap[oldIdx] = newIdx; });

  const nodes: AssetNode[] = order.map((oldIdx): AssetNode => {
    const n = srcNodes[oldIdx];
    let t: [number, number, number] = n.translation ?? [0, 0, 0];
    let r: [number, number, number, number] = n.rotation ?? [0, 0, 0, 1];
    let s: [number, number, number] = n.scale ?? [1, 1, 1];
    if (n.matrix) [t, r, s] = decomposeColumnMajor(n.matrix);
    return {
      name: n.name ?? `node${oldIdx}`,
      parent: parentOf[oldIdx] >= 0 ? remap[parentOf[oldIdx]] : -1,
      translation: t, rotation: r, scale: s,
      mesh: n.mesh ?? -1,
    };
  });

  const primCount = meshes.reduce((s, m) => s + m.primitives.length, 0);
  const vtxCount = meshes.reduce((s, m) => s + m.primitives.reduce((p, pr) => p + pr.positions.length / 3, 0), 0);
  const idxCount = meshes.reduce((s, m) => s + m.primitives.reduce((p, pr) => p + pr.indices.length, 0), 0);

  return {
    nodes, meshes, materials, textures, images,
    roots: sceneRoots.map((i: number) => remap[i]),
    ignored,
    stats: {
      nodes: nodes.length, meshes: meshes.length, primitives: primCount,
      vertices: vtxCount, indices: idxCount, textures: textures.length,
      zeroCopyAccessors: zeroCopy, copiedAccessors: copied,
    },
  };
}

// --- helpers ---
function toU32(a: Float32Array | Uint32Array): Uint32Array {
  if (a instanceof Uint32Array) return a;
  const o = new Uint32Array(a.length); o.set(a); return o;
}
function normalize(v: number, ct: number): number {
  switch (ct) {
    case 5121: return v / 255;
    case 5123: return v / 65535;
    case 5120: return Math.max(v / 127, -1);
    case 5122: return Math.max(v / 32767, -1);
    default: return v;
  }
}
function aabbOf(pos: Float32Array): [[number, number, number], [number, number, number]] {
  const mn: [number, number, number] = [Infinity, Infinity, Infinity];
  const mx: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) {
    if (pos[i + k] < mn[k]) mn[k] = pos[i + k];
    if (pos[i + k] > mx[k]) mx[k] = pos[i + k];
  }
  return [mn, mx];
}
function dataUri(uri: string): Uint8Array {
  return base64ToBytes(/;base64,(.*)$/.exec(uri)?.[1] ?? "");
}
function applySparse(out: Float32Array | Uint32Array, sparse: any, g: any, buffers: (Uint8Array | null)[], comps: number) {
  const idxBV = g.bufferViews[sparse.indices.bufferView];
  const valBV = g.bufferViews[sparse.values.bufferView];
  const idxBuf = buffers[idxBV.buffer]!, valBuf = buffers[valBV.buffer]!;
  const idxComp = (COMPONENT as any)[sparse.indices.componentType];
  const idxDV = new DataView(idxBuf.buffer, idxBuf.byteOffset + (idxBV.byteOffset ?? 0) + (sparse.indices.byteOffset ?? 0));
  const valDV = new DataView(valBuf.buffer, valBuf.byteOffset + (valBV.byteOffset ?? 0) + (sparse.values.byteOffset ?? 0));
  for (let i = 0; i < sparse.count; i++) {
    const target = idxComp.get(idxDV, i * idxComp.size);
    for (let k = 0; k < comps; k++) out[target * comps + k] = valDV.getFloat32((i * comps + k) * 4, true);
  }
}

/** column-major 4x4 (glTF) → TRS. Assumes no shear. */
export function decomposeColumnMajor(m: number[]): [[number, number, number], [number, number, number, number], [number, number, number]] {
  const t: [number, number, number] = [m[12], m[13], m[14]];
  const sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  let sz = Math.hypot(m[8], m[9], m[10]);
  // handle negative scale via determinant
  const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (det < 0) sz = -sz;
  const r = [
    m[0] / sx, m[1] / sx, m[2] / sx,
    m[4] / sy, m[5] / sy, m[6] / sy,
    m[8] / sz, m[9] / sz, m[10] / sz,
  ];
  // rotation matrix → quaternion (row-major 3x3 in r)
  const trace = r[0] + r[4] + r[8];
  let qx: number, qy: number, qz: number, qw: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    qw = s / 4; qx = (r[7] - r[5]) / s; qy = (r[2] - r[6]) / s; qz = (r[3] - r[1]) / s;
  } else if (r[0] > r[4] && r[0] > r[8]) {
    const s = Math.sqrt(1 + r[0] - r[4] - r[8]) * 2;
    qw = (r[7] - r[5]) / s; qx = s / 4; qy = (r[1] + r[3]) / s; qz = (r[2] + r[6]) / s;
  } else if (r[4] > r[8]) {
    const s = Math.sqrt(1 + r[4] - r[0] - r[8]) * 2;
    qw = (r[2] - r[6]) / s; qx = (r[1] + r[3]) / s; qy = s / 4; qz = (r[5] + r[7]) / s;
  } else {
    const s = Math.sqrt(1 + r[8] - r[0] - r[4]) * 2;
    qw = (r[3] - r[1]) / s; qx = (r[2] + r[6]) / s; qy = (r[5] + r[7]) / s; qz = s / 4;
  }
  return [t, [qx, qy, qz, qw], [sx, sy, sz]];
}

export class GltfError extends Error {
  constructor(msg: string) { super(`glTF: ${msg}`); this.name = "GltfError"; }
}
