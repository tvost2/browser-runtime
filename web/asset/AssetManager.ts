// AssetManager — the ONLY bridge between a decoded `Asset` (pure data) and the
// runtime (Scene entities + WebGPU geometry). The loader (glb.ts / gltf.ts /
// Asset) never imports this file or anything below it.

import { decodeGLB, type DecodeOptions } from "./gltf.js";
import { AlphaMode, type Asset, type AssetPrimitive } from "./Asset.js";
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
      ...opts,
      resolveUri: opts.resolveUri ?? ((uri) => fetchBytes(new URL(uri, url).href).catch(() => null)),
    });
    const t2 = now();
    this.cache.set(url, asset);
    return { asset, timing: { fetchMs: t1 - t0, decodeMs: t2 - t1 } };
  }

  /** Turn an `Asset` into live entities in `scene`. Returns the created entities
   *  (roots first). Geometry + textures reach the GPU here — never before. */
  async instantiate(asset: Asset, scene: Scene): Promise<Entity[]> {
    const renderer = scene._renderer;

    // --- materials + textures (browser only; Node tests skip this) ---
    if (renderer) {
      // decode each image to raw RGBA8 (via OffscreenCanvas — reliable on software
      // WebGPU, unlike copyExternalImageToTexture)
      const rgba = await Promise.all(asset.images.map((im) => decodeImage(im.bytes, im.mimeType)));
      asset.materials.forEach((m, i) => {
        const tex = m.baseColorTexture >= 0 ? asset.textures[m.baseColorTexture] : null;
        renderer.registerMaterial(i, {
          baseColorFactor: m.baseColorFactor,
          baseColorTexture: tex ? rgba[tex.image] : null,
          alphaCutoff: m.alphaMode === AlphaMode.Mask ? m.alphaCutoff : 0,
          doubleSided: m.doubleSided,
        });
      });
    }

    // register each primitive's geometry once; a mesh shared by N nodes is reused.
    const meshIds = asset.meshes.map((m) =>
      m.primitives.map((p) => {
        const id = scene.registerMesh(primitiveToMeshData(p));
        if (renderer && p.material >= 0) renderer.setMeshMaterial(id, p.material);
        return id;
      }),
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

      // transform-only nodes (no mesh) still propagate to children but must not
      // render — otherwise they'd draw mesh 0 (the SoA default meshId).
      if (n.mesh < 0) e.visible = false;

      if (n.mesh >= 0) {
        const prims = asset.meshes[n.mesh].primitives;
        if (prims.length === 1) {
          e.setMesh(meshIds[n.mesh][0]);
          if (prims[0].material >= 0) e.setMaterial(prims[0].material);
        } else {
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
  async loadInto(url: string, scene: Scene, opts: DecodeOptions = {}): Promise<{ entities: Entity[]; result: LoadResult }> {
    const result = await this.load(url, opts);
    return { entities: await this.instantiate(result.asset, scene), result };
  }
}

// --- helpers ---

/** AssetPrimitive → the engine's MeshData (pos / index / normal / uv0). */
export function primitiveToMeshData(p: AssetPrimitive): MeshData {
  return {
    positions: p.positions,
    indices: p.indices,
    normals: p.normals ?? undefined,
    uv0: p.uv0,
  };
}

const IS_BROWSER = typeof window !== "undefined" || typeof (globalThis as any).importScripts === "function";

/** PNG/JPEG bytes → RGBA8 { data, width, height } via createImageBitmap +
 *  OffscreenCanvas. Returns null on failure or outside the browser. */
async function decodeImage(bytes: Uint8Array, mime: string): Promise<import("../renderer/Renderer.js").RGBA8 | null> {
  if (!bytes.length || typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return null;
  try {
    const bmp = await createImageBitmap(new Blob([bytes.slice().buffer], { type: mime }), { colorSpaceConversion: "none" });
    const w = bmp.width, h = bmp.height; // read BEFORE close() — a closed ImageBitmap reports 0×0
    const oc = new OffscreenCanvas(w, h);
    const ctx = oc.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    const id = ctx.getImageData(0, 0, w, h);
    bmp.close?.();
    if (!w || !h) return null;
    return { data: new Uint8Array(id.data.buffer.slice(0)), width: w, height: h };
  } catch { return null; }
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  // browser: everything (incl. relative paths) goes through fetch
  if (IS_BROWSER || /^(https?|blob|data):/.test(url)) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  // Node / local file path (tests). Loose type — this branch never runs in a page.
  const fs: any = await import(/* @vite-ignore */ ("node:fs/promises"));
  const p = url.startsWith("file:") ? new URL(url) : url;
  return new Uint8Array(await fs.readFile(p));
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
