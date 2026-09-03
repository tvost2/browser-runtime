// AssetManager — the ONLY bridge between a decoded `Asset` (pure data) and the
// runtime (Scene entities + WebGPU geometry). The loader (glb.ts / gltf.ts /
// Asset) never imports this file or anything below it.

import { decodeGLB, type DecodeOptions } from "./gltf.js";
import type { Asset, AssetPrimitive } from "./Asset.js";
import type { Scene, MeshData } from "../api/Scene.js";
import type { Entity } from "../api/Entity.js";

export interface LoadResult {
  asset: Asset;
  timing: { fetchMs: number; decodeMs: number };
}

export class AssetManager {
  private cache = new Map<string, Asset>();

  /** fetch + decode a .glb / .gltf. Works in the browser and in Node. */
  async load(url: string, opts: DecodeOptions = {}): Promise<LoadResult> {
    const t0 = now();
    const bytes = await fetchBytes(url);
    const t1 = now();
    const asset = await decodeGLB(bytes, {
      resolveUri: opts.resolveUri ?? ((uri) => fetchBytes(new URL(uri, url).href).catch(() => null)),
    });
    const t2 = now();
    this.cache.set(url, asset);
    return { asset, timing: { fetchMs: t1 - t0, decodeMs: t2 - t1 } };
  }

  /** Turn an `Asset` into live entities in `scene`. Returns the created entities
   *  (roots first). Geometry reaches the GPU here — never before. */
  instantiate(asset: Asset, scene: Scene): Entity[] {
    // register each primitive's geometry once; a primitive shared by N nodes
    // (glTF shares meshes) is registered once and reused.
    const meshIds = asset.meshes.map((m) =>
      m.primitives.map((p) => scene.registerMesh(primitiveToMeshData(p))),
    );

    const entities: Entity[] = new Array(asset.nodes.length);
    for (let i = 0; i < asset.nodes.length; i++) {
      const n = asset.nodes[i];
      const e = scene.createEntity();
      entities[i] = e;
      e.transform.position.set(n.translation[0], n.translation[1], n.translation[2]);
      e.transform.setRotationQuaternion(n.rotation[0], n.rotation[1], n.rotation[2], n.rotation[3]);
      e.transform.scaling.set(n.scale[0], n.scale[1], n.scale[2]);
      if (n.parent >= 0) e.setParent(entities[n.parent]);

      if (n.mesh >= 0) {
        const prims = asset.meshes[n.mesh].primitives;
        if (prims.length === 1) {
          e.setMesh(meshIds[n.mesh][0]);
          if (prims[0].material >= 0) e.setMaterial(prims[0].material);
        } else {
          // multi-primitive mesh → one child entity per primitive
          for (let pi = 0; pi < prims.length; pi++) {
            const c = scene.createEntity();
            c.setParent(e).setMesh(meshIds[n.mesh][pi]);
            if (prims[pi].material >= 0) c.setMaterial(prims[pi].material);
          }
        }
      }
    }
    return asset.roots.map((r) => entities[r]).concat(entities);
  }

  /** convenience: load + instantiate in one call */
  async loadInto(url: string, scene: Scene): Promise<{ entities: Entity[]; result: LoadResult }> {
    const result = await this.load(url);
    return { entities: this.instantiate(result.asset, scene), result };
  }
}

// --- helpers ---

/** AssetPrimitive → the engine's MeshData. Positions/indices pass through;
 *  normals are kept if present (the renderer flat-shades when absent). */
export function primitiveToMeshData(p: AssetPrimitive): MeshData {
  return {
    positions: p.positions,
    indices: p.indices,
    normals: p.normals ?? undefined,
  };
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  if (typeof fetch === "function" && (url.startsWith("http") || url.startsWith("blob:") || url.startsWith("data:"))) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  // Node / file path (tests). Loose type — this branch never runs in the browser.
  const fs: any = await import(/* @vite-ignore */ ("node:fs/promises"));
  const p = url.startsWith("file:") ? new URL(url) : url;
  return new Uint8Array(await fs.readFile(p));
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
