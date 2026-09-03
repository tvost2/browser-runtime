// native.ts — PIPELINE B: the whole GLB/glTF decode in C++/WASM.
//
//   GLB bytes ──▶ WASM (bcpp::gltf::Pipeline)
//        container split · JSON parse (yyjson) · glTF metadata ·
//        accessor decode · geometry processing (bcpp::gltf::Batch)
//   ──▶ one TOC int32 array ──▶ this file assembles the Asset.
//
// JS does: hand over the blob, call loadGLB + process, read the TOC, slice
// typed-array VIEWS out of WASM memory. No per-element crossing. ~5 crossings.
//
// web/asset/gltf.ts (PIPELINE A) stays the functional reference; the equivalence
// tests compare the two.

import { loadEngineModule } from "../bindings/module.js";
import { parseContainer } from "./glb.js";
import {
  AlphaMode,
  type Asset, type AssetNode, type AssetMesh, type AssetPrimitive,
  type AssetMaterial, type AssetTexture, type AssetImage,
} from "./Asset.js";

// TOC layout — mirror of enum in native/include/bcpp/gltf_pipeline.hpp
const enum T {
  VERSION, OK, ZEROCOPY_BIN,
  BUFVIEWS_PTR, BUFVIEWS_N, ACCESSORS_PTR, ACCESSORS_N,
  PRIMS_PTR, PRIMS_N, MESHES_PTR, MESHES_N, NODES_PTR, NODES_N,
  ROOTS_PTR, ROOTS_N, MATS_PTR, MATS_N, TEX_PTR, TEX_N, SAMP_PTR, SAMP_N,
  IMG_PTR, IMG_N, STRINGS_PTR, STRINGS_N, IGNORED_PTR, IGNORED_N,
  BIN_PTR, BIN_N, AUXBIN_PTR, AUXBIN_N,
  POS_PTR, NRM_PTR, UV_PTR, TAN_PTR, IDX_PTR,
  OUTMETA_PTR, TOTAL_VERTS, TOTAL_IDX,
  SLOTMAP_PTR, SLOTMAP_N, TIMINGS_PTR, TIMINGS_N, COUNTERS_PTR, COUNTERS_N,
  BIN_BLOB_OFFSET,
  COUNT,
}
// timings[] — T_* in the header
export const NATIVE_TIMING_LABELS = ["loadTotal", "container", "jsonParse", "metadata", "primDesc", "geometry", "processTotal"] as const;
// counters[] — C_* in the header
export const NATIVE_COUNTER_LABELS = ["blobBytes", "binCopyBytes", "auxbinBytes", "geomOutBytes", "stringsBytes", "metaBytes", "primCount", "slotCount", "binZeroCopy", "jsonBytes"] as const;

export interface NativeDecodeStats {
  timings: Record<string, number>;
  counters: Record<string, number>;
  crossings: number;
  binZeroCopy: boolean;
}

export class NativePipelineUnsupported extends Error {}

const GEN_NORMALS = 1, GEN_TANGENTS = 2;
const DNODE = 15, DMESH = 4, DPRIM = 8, DMAT = 15, DTEX = 2, DSAMP = 4, DIMG = 6, DBV = 4, DACC = 14, DOUT = 16;

// one GltfPipeline per module instance (matches acquireBatch in wasm.ts) — its
// C++ vectors grow and stay, so steady-state decoding does no WASM-heap alloc.
const pipelineCache = new WeakMap<object, any>();

/** Decode a GLB entirely in C++/WASM. Throws NativePipelineUnsupported for
 *  primitives the batch core can't do (sparse accessors, COLOR_0). */
export async function decodeGLBNative(
  bytes: Uint8Array,
  opts: { generateTangents?: boolean; wasmUrl?: string; reuse?: boolean } = {},
): Promise<Asset & { nativeStats: NativeDecodeStats }> {
  const mod = await loadEngineModule(opts.wasmUrl);
  let pipe = opts.reuse !== false ? pipelineCache.get(mod) : null;
  if (!pipe) { pipe = new mod.GltfPipeline(); if (opts.reuse !== false) pipelineCache.set(mod, pipe); }

  let crossings = 0;

  pipe.reserveInput(bytes.length); crossings++;
  const inPtr = pipe.inputPtr(); crossings++;
  new Uint8Array(mod.HEAPU8.buffer, inPtr, bytes.length).set(bytes); // memcpy in, not a crossing
  const okLoad = pipe.loadGLB(bytes.length); crossings++;
  if (!okLoad) {
    const ep = pipe.errorPtr(), el = pipe.errorLen();
    const msg = new TextDecoder().decode(new Uint8Array(mod.HEAPU8.buffer, ep, el));
    throw new Error(`native pipeline: ${msg || "load failed"}`);
  }

  let flags = GEN_NORMALS;
  if (opts.generateTangents) flags |= GEN_TANGENTS;
  pipe.process(flags); crossings++;

  const toc = new Int32Array(mod.HEAP32.buffer, pipe.tocPtr(), T.COUNT).slice(); crossings++;

  const i32 = (ptr: number, n: number) => new Int32Array(mod.HEAP32.buffer, ptr, n);
  const u32 = (ptr: number, n: number) => new Uint32Array(mod.HEAPU32.buffer, ptr, n);
  const f32 = (ptr: number, n: number) => new Float32Array(mod.HEAPF32.buffer, ptr, n);
  const bytesAt = (ptr: number, n: number) => new Uint8Array(mod.HEAPU8.buffer, ptr, n);

  const strBytes = bytesAt(toc[T.STRINGS_PTR], toc[T.STRINGS_N]);
  const dec = new TextDecoder();
  const str = (off: number, len: number) => (len ? dec.decode(strBytes.subarray(off, off + len)) : "");

  const ignored = toc[T.IGNORED_N]
    ? dec.decode(bytesAt(toc[T.IGNORED_PTR], toc[T.IGNORED_N])).split("\n").filter(Boolean)
    : [];

  // ---- geometry: per slot, slice PrimOut + SoA views, copy out ----
  const slotmap = i32(toc[T.SLOTMAP_PTR], toc[T.SLOTMAP_N]);
  const outMeta = u32(toc[T.OUTMETA_PTR], toc[T.SLOTMAP_N] * DOUT);
  const outMetaF = f32(toc[T.OUTMETA_PTR], toc[T.SLOTMAP_N] * DOUT);
  const tv = toc[T.TOTAL_VERTS];
  const posAll = f32(toc[T.POS_PTR], tv * 3);
  const nrmAll = f32(toc[T.NRM_PTR], tv * 3);
  const uvAll = f32(toc[T.UV_PTR], tv * 2);
  const tanAll = (flags & GEN_TANGENTS) ? f32(toc[T.TAN_PTR], tv * 4) : null;
  const idxAll = u32(toc[T.IDX_PTR], toc[T.TOTAL_IDX]);

  const prims = i32(toc[T.PRIMS_PTR], toc[T.PRIMS_N] * DPRIM);
  const primHasUV = (pi: number) => prims[pi * DPRIM + 2] >= 0;

  const geomBySlot = new Map<number, AssetPrimitive>();
  for (let s = 0; s < slotmap.length; s++) {
    const m = s * DOUT;
    const vb = outMeta[m + 0], vc = outMeta[m + 1], ib = outMeta[m + 2], ic = outMeta[m + 3];
    const f = outMeta[m + 10];
    const pi = slotmap[s];
    geomBySlot.set(pi, {
      positions: posAll.subarray(vb * 3, (vb + vc) * 3).slice(),
      normals: nrmAll.subarray(vb * 3, (vb + vc) * 3).slice(),
      uv0: primHasUV(pi) ? uvAll.subarray(vb * 2, (vb + vc) * 2).slice() : null,
      color0: null,
      tangents: tanAll ? tanAll.subarray(vb * 4, (vb + vc) * 4).slice() : null,
      indices: idxAll.subarray(ib, ib + ic).slice(),
      material: prims[pi * DPRIM + 6],
      aabbMin: [outMetaF[m + 4], outMetaF[m + 5], outMetaF[m + 6]],
      aabbMax: [outMetaF[m + 7], outMetaF[m + 8], outMetaF[m + 9]],
      zeroCopy: false,
    });
    void f;
  }

  // ---- meshes ----
  const meshesRaw = u32(toc[T.MESHES_PTR], toc[T.MESHES_N] * DMESH);
  const meshes: AssetMesh[] = [];
  for (let mi = 0; mi < toc[T.MESHES_N]; mi++) {
    const first = meshesRaw[mi * DMESH + 0], count = meshesRaw[mi * DMESH + 1];
    const nameOff = meshesRaw[mi * DMESH + 2], nameLen = meshesRaw[mi * DMESH + 3];
    const primitives: AssetPrimitive[] = [];
    for (let p = 0; p < count; p++) {
      const pi = first + p;
      const g = geomBySlot.get(pi);
      if (!g) throw new NativePipelineUnsupported(`mesh ${mi} primitive ${p}: sparse/COLOR_0 not in native path`);
      primitives.push(g);
    }
    meshes.push({ name: nameLen ? str(nameOff, nameLen) : `mesh${mi}`, primitives });
  }

  // ---- materials ----
  const matRaw = i32(toc[T.MATS_PTR], toc[T.MATS_N] * DMAT);
  const matRawF = f32(toc[T.MATS_PTR], toc[T.MATS_N] * DMAT);
  const matRawU = u32(toc[T.MATS_PTR], toc[T.MATS_N] * DMAT);
  const materials: AssetMaterial[] = [];
  for (let i = 0; i < toc[T.MATS_N]; i++) {
    const b = i * DMAT;
    const nameOff = matRawU[b + 13], nameLen = matRawU[b + 14];
    materials.push({
      name: nameLen ? str(nameOff, nameLen) : `material${i}`,
      baseColorFactor: [matRawF[b + 0], matRawF[b + 1], matRawF[b + 2], matRawF[b + 3]],
      baseColorTexture: matRaw[b + 4],
      metallicFactor: matRawF[b + 5],
      roughnessFactor: matRawF[b + 6],
      emissiveFactor: [matRawF[b + 7], matRawF[b + 8], matRawF[b + 9]],
      alphaMode: matRaw[b + 10] === 1 ? AlphaMode.Mask : matRaw[b + 10] === 2 ? AlphaMode.Blend : AlphaMode.Opaque,
      alphaCutoff: matRawF[b + 11],
      doubleSided: !!matRawU[b + 12],
    });
  }

  // ---- textures + samplers + images ----
  const texRaw = i32(toc[T.TEX_PTR], toc[T.TEX_N] * DTEX);
  const sampRaw = i32(toc[T.SAMP_PTR], toc[T.SAMP_N] * DSAMP);
  const textures: AssetTexture[] = [];
  for (let i = 0; i < toc[T.TEX_N]; i++) {
    const source = texRaw[i * DTEX + 0], sampler = texRaw[i * DTEX + 1];
    const sb = sampler >= 0 && sampler < toc[T.SAMP_N] ? sampler * DSAMP : -1;
    textures.push({
      image: source,
      magFilter: sb >= 0 ? sampRaw[sb + 0] : 9729,
      minFilter: sb >= 0 ? sampRaw[sb + 1] : 9987,
      wrapS: sb >= 0 ? sampRaw[sb + 2] : 10497,
      wrapT: sb >= 0 ? sampRaw[sb + 3] : 10497,
    });
  }
  // image bytes: for BIN-embedded images, take a VIEW straight over the caller's
  // original ArrayBuffer — the native pipeline never copies texture bytes into
  // WASM. (data-URI images were base64-decoded in C++, so those come from auxbin.)
  const binBlobOff = toc[T.BIN_BLOB_OFFSET];
  const auxPtr = toc[T.AUXBIN_PTR];
  const imgRaw = i32(toc[T.IMG_PTR], toc[T.IMG_N] * DIMG);
  const imgRawU = u32(toc[T.IMG_PTR], toc[T.IMG_N] * DIMG);
  const images: AssetImage[] = [];
  for (let i = 0; i < toc[T.IMG_N]; i++) {
    const b = i * DIMG;
    const uriKind = imgRaw[b + 1], dOff = imgRawU[b + 2], dLen = imgRawU[b + 3];
    const mimeOff = imgRawU[b + 4], mimeLen = imgRawU[b + 5];
    let bytesOut: Uint8Array = new Uint8Array();
    if (uriKind === 0) bytesOut = bytes.subarray(binBlobOff + dOff, binBlobOff + dOff + dLen);      // view, no copy
    else if (uriKind === 1 && auxPtr) bytesOut = new Uint8Array(bytesAt(auxPtr + dOff, dLen));      // data-URI: one copy out of auxbin
    images.push({ mimeType: mimeLen ? str(mimeOff, mimeLen) : "image/png", bytes: bytesOut });
  }

  // ---- nodes ----
  const nodeI = i32(toc[T.NODES_PTR], toc[T.NODES_N] * DNODE);
  const nodeF = f32(toc[T.NODES_PTR], toc[T.NODES_N] * DNODE);
  const nodeU = u32(toc[T.NODES_PTR], toc[T.NODES_N] * DNODE);
  const nodes: AssetNode[] = [];
  for (let i = 0; i < toc[T.NODES_N]; i++) {
    const b = i * DNODE;
    const srcIndex = nodeI[b + 12], nameOff = nodeU[b + 13], nameLen = nodeU[b + 14];
    nodes.push({
      name: nameLen ? str(nameOff, nameLen) : `node${srcIndex}`,
      parent: nodeI[b + 11],
      translation: [nodeF[b + 0], nodeF[b + 1], nodeF[b + 2]],
      rotation: [nodeF[b + 3], nodeF[b + 4], nodeF[b + 5], nodeF[b + 6]],
      scale: [nodeF[b + 7], nodeF[b + 8], nodeF[b + 9]],
      mesh: nodeI[b + 10],
    });
  }
  const roots = Array.from(i32(toc[T.ROOTS_PTR], toc[T.ROOTS_N]));

  // ---- stats ----
  const timingsF = new Float64Array(mod.HEAPU8.buffer, toc[T.TIMINGS_PTR], toc[T.TIMINGS_N]);
  const countersF = new Float64Array(mod.HEAPU8.buffer, toc[T.COUNTERS_PTR], toc[T.COUNTERS_N]);
  const timings: Record<string, number> = {};
  NATIVE_TIMING_LABELS.forEach((k, i) => (timings[k] = timingsF[i] ?? 0));
  const counters: Record<string, number> = {};
  NATIVE_COUNTER_LABELS.forEach((k, i) => (counters[k] = countersF[i] ?? 0));

  const primCount = meshes.reduce((s, m) => s + m.primitives.length, 0);
  const vtxCount = meshes.reduce((s, m) => s + m.primitives.reduce((p, pr) => p + pr.positions.length / 3, 0), 0);
  const idxCount = meshes.reduce((s, m) => s + m.primitives.reduce((p, pr) => p + pr.indices.length, 0), 0);

  return {
    nodes, meshes, materials, textures, images, roots, ignored,
    stats: {
      nodes: nodes.length, meshes: meshes.length, primitives: primCount,
      vertices: vtxCount, indices: idxCount, textures: textures.length,
      zeroCopyAccessors: 0, copiedAccessors: 0,
      geometryPath: "native",
      wasmCrossings: crossings,
      bytesUploadedToWasm: bytes.length,
    },
    nativeStats: { timings, counters, crossings, binZeroCopy: !!toc[T.ZEROCOPY_BIN] },
  };
}

/** parseContainer for a plain .gltf still needs a JSON string round-trip in JS;
 *  the native path only takes the raw blob. Re-exported for callers that branch. */
export { parseContainer };
