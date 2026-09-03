// merge.ts — bake many transformed meshes into one, in C++/WASM.
//
// The renderer issues one draw per (mesh, material) bucket. A scene of N unique
// static meshes (building footprints in a digital twin, props in a level) is N
// draws + N cull entries. Grouping them spatially and merging each group into
// one mesh collapses that to a handful of draws. The per-vertex heavy work —
// world-baking positions, inverse-transpose for normals, index rebasing — is
// the C++ `bcpp::mergeMeshes` kernel; JS only packs the inputs and reads views.
//
// Every output vertex keeps a `id` (u32) from its source item, so a pick pass
// can still resolve the individual object under the cursor.

import { loadEngineModule, type EngineModule } from "../bindings/module.js";
import type { MeshData } from "../api/Scene.js";

export interface MergeSource {
  positions: Float32Array;          // xyz
  indices: Uint32Array;
  normals?: Float32Array | null;    // xyz
  uv0?: Float32Array | null;        // uv
  /** 16, row-major (Babylon). Omit / identity → positions used as-is. */
  world?: Float32Array | null;
  /** per-vertex tag carried into the merged mesh (building id, entity id, …) */
  id: number;
}

export interface MergedMesh {
  mesh: MeshData;              // positions (+ normals / uv0) baked to world, indices rebased
  vertexId: Uint32Array;       // one u32 per merged vertex — the source item id
  vertexCount: number;
  indexCount: number;
  sourceCount: number;
}

const DESC_I32 = 7; // vBase, vCount, iBase, iCount, flags, id, _pad  (mirror asset.cpp)

const mergerCache = new WeakMap<EngineModule, any>();
function merger(mod: EngineModule) {
  let m = mergerCache.get(mod);
  if (!m) { m = new mod.MeshMerger(); mergerCache.set(mod, m); }
  return m;
}

const IDENTITY16 = new Float32Array(16); // all-zero → C++ treats as identity (fast path)

/** Merge `sources` into a single mesh (in C++/WASM). Positions are baked to
 *  world space; a source with no `world` is taken as-is. */
export async function mergeMeshes(sources: MergeSource[], wasmUrl?: string): Promise<MergedMesh> {
  const mod = await loadEngineModule(wasmUrl);
  const M = merger(mod);

  let totalV = 0, totalI = 0;
  for (const s of sources) { totalV += s.positions.length / 3; totalI += s.indices.length; }
  const anyNrm = sources.some((s) => s.normals && s.normals.length > 0);
  const anyUv = sources.some((s) => s.uv0 && s.uv0.length > 0);

  M.reserveInput(totalV, totalI, sources.length);
  // views are taken AFTER the (large) reserve alloc — it may have grown the heap
  const inPos = new Float32Array(mod.HEAPF32.buffer, M.inPosPtr(), totalV * 3);
  const inNrm = new Float32Array(mod.HEAPF32.buffer, M.inNrmPtr(), totalV * 3);
  const inUv = new Float32Array(mod.HEAPF32.buffer, M.inUvPtr(), totalV * 2);
  const inIdx = new Uint32Array(mod.HEAPU32.buffer, M.inIdxPtr(), totalI);
  const desc = new Int32Array(mod.HEAP32.buffer, M.descPtr(), sources.length * DESC_I32);
  const world = new Float32Array(mod.HEAPF32.buffer, M.worldPtr(), sources.length * 16);

  let vBase = 0, iBase = 0;
  for (let k = 0; k < sources.length; k++) {
    const s = sources[k];
    const vc = s.positions.length / 3;
    inPos.set(s.positions, vBase * 3);
    let flags = 0;
    if (s.normals && s.normals.length >= vc * 3) { inNrm.set(s.normals.subarray(0, vc * 3), vBase * 3); flags |= 1; }
    if (s.uv0 && s.uv0.length >= vc * 2) { inUv.set(s.uv0.subarray(0, vc * 2), vBase * 2); flags |= 2; }
    inIdx.set(s.indices, iBase);
    const d = k * DESC_I32;
    desc[d] = vBase; desc[d + 1] = vc; desc[d + 2] = iBase; desc[d + 3] = s.indices.length;
    desc[d + 4] = flags; desc[d + 5] = s.id >>> 0; desc[d + 6] = 0;
    world.set(s.world && s.world.length === 16 ? s.world : IDENTITY16, k * 16);
    vBase += vc; iBase += s.indices.length;
  }

  M.merge(sources.length);

  const vCount = M.outVertexCount() as number;
  const iCount = M.outIndexCount() as number;
  // views taken after merge() (its output vectors may have grown the heap); copy out
  const positions = new Float32Array(mod.HEAPF32.buffer, M.outPosPtr(), vCount * 3).slice();
  const indices = new Uint32Array(mod.HEAPU32.buffer, M.outIdxPtr(), iCount).slice();
  const normals = anyNrm && M.outHasNrm() ? new Float32Array(mod.HEAPF32.buffer, M.outNrmPtr(), vCount * 3).slice() : undefined;
  const uv0 = anyUv && M.outHasUv() ? new Float32Array(mod.HEAPF32.buffer, M.outUvPtr(), vCount * 2).slice() : undefined;
  const vertexId = new Uint32Array(mod.HEAPU32.buffer, M.outIdPtr(), vCount).slice();

  return {
    mesh: { positions, indices, normals, uv0 },
    vertexId,
    vertexCount: vCount,
    indexCount: iCount,
    sourceCount: sources.length,
  };
}

/** Group indices by a uniform spatial grid over `centers` (xyz per item).
 *  Returns one array of source-indices per non-empty cell — feed each to
 *  `mergeMeshes`. `cellSize` is in world units. */
export function groupByCell(centers: Float32Array, cellSize: number): number[][] {
  const inv = 1 / cellSize;
  const cells = new Map<string, number[]>();
  const n = centers.length / 3;
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(centers[i * 3] * inv);
    const cy = Math.floor(centers[i * 3 + 1] * inv);
    const cz = Math.floor(centers[i * 3 + 2] * inv);
    const key = cx + "," + cy + "," + cz;
    let arr = cells.get(key);
    if (!arr) cells.set(key, (arr = []));
    arr.push(i);
  }
  return [...cells.values()];
}
