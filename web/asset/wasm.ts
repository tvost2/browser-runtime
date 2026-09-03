// wasm.ts — batch glTF geometry processing in C++/WASM (bcpp::gltf::Batch).
//
// The real runtime path: JS parses the glTF JSON and builds a compact
// per-primitive descriptor table, uploads the binary buffer ONCE, calls
// process() ONCE, and reads the GPU-ready geometry back as typed-array views.
// Crossings per asset ≈ 4 (reserveBin, setPrimCount, process, ptr reads) —
// never per primitive, never per vertex.

import { loadEngineModule } from "../bindings/module.js";
import type { GltfContainer } from "./glb.js";

// PrimDesc layout — 24 × 4 bytes (mirror native/include/bcpp/gltf.hpp)
const PRIMDESC_I32 = 24;
// PrimOut layout — 16 × 4 bytes
const PRIMOUT_I32 = 16;

export const enum GeomFlags { GenNormals = 1, GenTangents = 2 }

/** which accessors of one primitive to process */
export interface PrimSpec {
  position: number;
  normal?: number;
  uv0?: number;
  indices?: number;
}

export interface WasmPrimitiveGeometry {
  positions: Float32Array;         // view [vc*3]
  normals: Float32Array;           // view [vc*3] — generated flat if source had none
  uv0: Float32Array | null;        // view [vc*2] or null if the source primitive had no UV0
  tangents: Float32Array | null;   // view [vc*4] when GenTangents
  indices: Uint32Array;            // view [ic], always u32
  aabbMin: [number, number, number];
  aabbMax: [number, number, number];
  generatedNormals: boolean;
  generatedTangents: boolean;
  vertexCount: number;
  indexCount: number;
}

export interface WasmProcessResult {
  geometries: WasmPrimitiveGeometry[];
  crossings: number;      // JS→WASM calls made
  bytesUploaded: number;  // BIN bytes copied into WASM memory
}

const TYPE_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
function compSize(ct: number) { return ct === 5120 || ct === 5121 ? 1 : ct === 5122 || ct === 5123 ? 2 : 4; }

/** true if every primitive in `specs` can go through the WASM path */
export function canProcessWasm(c: GltfContainer, specs: PrimSpec[]): boolean {
  const g = c.json;
  for (const s of specs) {
    for (const ai of [s.position, s.normal, s.uv0, s.indices]) {
      if (ai == null) continue;
      const acc = g.accessors[ai];
      if (acc.sparse) return false;                 // sparse → JS reference path
      if (acc.componentType === 5126 ? false : acc.type !== "SCALAR" && acc.normalized === undefined) { /* ok */ }
    }
  }
  return true;
}

export async function processPrimitivesWasm(
  c: GltfContainer,
  specs: PrimSpec[],
  opts: { generateNormals?: boolean; generateTangents?: boolean; wasmUrl?: string } = {},
): Promise<WasmProcessResult> {
  const g = c.json;
  const mod = await loadEngineModule(opts.wasmUrl);
  const batch = acquireBatch(mod);   // one reused instance — its buffers grow and stay
  let crossings = 0;

  // ---- upload ONLY the byte ranges the geometry accessors actually touch ----
  // A GLB BIN chunk holds geometry AND image bytes; copying the whole buffer
  // would push megabytes of texture data into WASM for nothing. Compute the
  // referenced [min,max) window per buffer and copy just that.
  const winMin: number[] = [];
  const winMax: number[] = [];
  const touch = (ai: number | undefined) => {
    if (ai == null) return;
    const acc = g.accessors[ai];
    const bv = g.bufferViews[acc.bufferView ?? 0];
    const bi = bv.buffer ?? 0;
    const comps = TYPE_COMPONENTS[acc.type] ?? 1;
    const cs = compSize(acc.componentType);
    const stride = bv.byteStride ?? comps * cs;
    const start = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const end = start + Math.max(0, acc.count - 1) * stride + comps * cs;
    winMin[bi] = winMin[bi] == null ? start : Math.min(winMin[bi], start);
    winMax[bi] = winMax[bi] == null ? end : Math.max(winMax[bi], end);
  };
  for (const s of specs) { touch(s.position); touch(s.normal); touch(s.uv0); touch(s.indices); }

  const bufBase: number[] = [];
  const parts: { src: Uint8Array; at: number; from: number; len: number }[] = [];
  let total = 0;
  for (let i = 0; i < (g.buffers?.length ?? 1); i++) {
    const decl = g.buffers?.[i];
    let b: Uint8Array | null = null;
    if (!decl || decl.uri == null) b = c.bin;
    else if (/^data:/.test(decl.uri)) b = dataUri(decl.uri);
    if (b == null || winMin[i] == null) { bufBase[i] = total; continue; }
    const lo = Math.max(0, winMin[i]);
    const hi = Math.min(winMax[i], b.length);
    bufBase[i] = total - lo;                 // keeps accInfo() offsets valid after the shift
    parts.push({ src: b, at: total, from: lo, len: Math.max(0, hi - lo) });
    total += align4(Math.max(0, hi - lo));
  }
  const mega = new Uint8Array(total);
  for (const p of parts) mega.set(p.src.subarray(p.from, p.from + p.len), p.at);

  batch.reserveBin(mega.length); crossings++;
  new Uint8Array(mod.HEAPU8.buffer, batch.binPtr(), mega.length).set(mega); // copy in (no crossing)

  // ---- write the PrimDesc table ----
  batch.setPrimCount(specs.length); crossings++;
  const desc = new Int32Array(mod.HEAP32.buffer, batch.descPtr(), specs.length * PRIMDESC_I32);
  const descF = new Float32Array(mod.HEAPF32.buffer, batch.descPtr(), specs.length * PRIMDESC_I32);
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i], d = i * PRIMDESC_I32;
    const pos = accInfo(g, s.position, bufBase);
    desc[d + 0] = pos.offset; desc[d + 1] = pos.stride; desc[d + 2] = pos.componentType; desc[d + 3] = pos.count;
    if (s.normal != null) { const n = accInfo(g, s.normal, bufBase); desc[d + 4] = n.offset; desc[d + 5] = n.stride; desc[d + 6] = n.componentType; desc[d + 7] = n.normalized; }
    else desc[d + 4] = -1;
    if (s.uv0 != null) { const u = accInfo(g, s.uv0, bufBase); desc[d + 8] = u.offset; desc[d + 9] = u.stride; desc[d + 10] = u.componentType; desc[d + 11] = u.normalized; }
    else desc[d + 8] = -1;
    if (s.indices != null) { const ix = accInfo(g, s.indices, bufBase); desc[d + 12] = ix.offset; desc[d + 13] = ix.componentType; desc[d + 14] = ix.count; }
    else desc[d + 12] = -1;
    const accPos = g.accessors[s.position];
    if (accPos.min && accPos.max) {
      desc[d + 15] = 1;
      descF[d + 16] = accPos.min[0]; descF[d + 17] = accPos.min[1]; descF[d + 18] = accPos.min[2];
      descF[d + 19] = accPos.max[0]; descF[d + 20] = accPos.max[1]; descF[d + 21] = accPos.max[2];
    } else desc[d + 15] = 0;
    desc[d + 22] = accPos.normalized ? 1 : 0;
  }

  // ---- one call does everything ----
  let flags = 0;
  if (opts.generateNormals !== false) flags |= GeomFlags.GenNormals; // default: generate missing normals
  if (opts.generateTangents) flags |= GeomFlags.GenTangents;
  batch.process(flags); crossings++;

  // ---- read outputs as views ----
  const tv = batch.totalVertices(), ti = batch.totalIndices();
  const posAll = new Float32Array(mod.HEAPF32.buffer, batch.posPtr(), tv * 3);
  const nrmAll = new Float32Array(mod.HEAPF32.buffer, batch.nrmPtr(), tv * 3);
  const uvAll = new Float32Array(mod.HEAPF32.buffer, batch.uvPtr(), tv * 2);
  const tanAll = (flags & GeomFlags.GenTangents) ? new Float32Array(mod.HEAPF32.buffer, batch.tanPtr(), tv * 4) : null;
  const idxAll = new Uint32Array(mod.HEAPU32.buffer, batch.idxPtr(), ti);
  const meta = new Uint32Array(mod.HEAPU32.buffer, batch.outMetaPtr(), specs.length * PRIMOUT_I32);
  const metaF = new Float32Array(mod.HEAPF32.buffer, batch.outMetaPtr(), specs.length * PRIMOUT_I32);
  crossings += 6; // ptr getters

  const geometries: WasmPrimitiveGeometry[] = specs.map((s, i) => {
    const m = i * PRIMOUT_I32;
    const vb = meta[m + 0], vc = meta[m + 1], ib = meta[m + 2], ic = meta[m + 3];
    const f = meta[m + 10];
    return {
      positions: posAll.subarray(vb * 3, (vb + vc) * 3),
      normals: nrmAll.subarray(vb * 3, (vb + vc) * 3),
      uv0: s.uv0 != null ? uvAll.subarray(vb * 2, (vb + vc) * 2) : null,
      tangents: tanAll ? tanAll.subarray(vb * 4, (vb + vc) * 4) : null,
      indices: idxAll.subarray(ib, ib + ic),
      aabbMin: [metaF[m + 4], metaF[m + 5], metaF[m + 6]],
      aabbMax: [metaF[m + 7], metaF[m + 8], metaF[m + 9]],
      generatedNormals: !!(f & 1),
      generatedTangents: !!(f & 2),
      vertexCount: vc,
      indexCount: ic,
    };
  });

  return { geometries, crossings, bytesUploaded: mega.length };
}

// --- helpers ---

// One GltfBatch per module instance, reused across every decode. The C++ side
// keeps its bin/output vectors allocated and only grows them, so steady-state
// decoding does zero WASM heap allocation. (embind objects must be freed
// explicitly; a per-call `new` would leak.)
const batchCache = new WeakMap<object, any>();
function acquireBatch(mod: any) {
  let b = batchCache.get(mod);
  if (!b) { b = new mod.GltfBatch(); batchCache.set(mod, b); }
  return b;
}

function accInfo(g: any, idx: number, bufBase: number[]) {
  const acc = g.accessors[idx];
  const comps = TYPE_COMPONENTS[acc.type] ?? 1;
  const bv = g.bufferViews[acc.bufferView ?? 0];
  const cs = compSize(acc.componentType);
  return {
    offset: bufBase[bv.buffer ?? 0] + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0),
    stride: bv.byteStride ?? comps * cs,
    componentType: acc.componentType,
    count: acc.count,
    normalized: acc.normalized ? 1 : 0,
  };
}
function align4(n: number) { return (n + 3) & ~3; }
function dataUri(uri: string): Uint8Array {
  const b64 = /;base64,(.*)$/.exec(uri)?.[1] ?? "";
  const s = atob(b64); const o = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i);
  return o;
}
