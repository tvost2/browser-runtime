// Asset — the immutable, GPU-free, WASM-free CPU representation of one decoded
// glTF/GLB. Produced by web/asset/gltf.ts; consumed by AssetManager to build
// runtime entities + GPU resources. Nothing here imports the renderer or WasmCore.

/** A glTF node → one runtime entity. `parent` is an index into `Asset.nodes`
 *  (−1 = root); nodes are emitted parents-first (topological) so the runtime
 *  can build the hierarchy in one linear pass. */
export interface AssetNode {
  name: string;
  parent: number;
  /** local transform, already resolved to TRS (a glTF `matrix` is decomposed) */
  translation: [number, number, number];
  rotation: [number, number, number, number]; // quaternion x,y,z,w
  scale: [number, number, number];
  /** index into `Asset.meshes`, or −1 */
  mesh: number;
}

export interface AssetPrimitive {
  /** interleaved? no — separate tight arrays, ready for one VBO each (or packed) */
  positions: Float32Array;       // [n*3]
  normals: Float32Array | null;  // [n*3] — generated flat by the WASM path if the glTF omitted them
  uv0: Float32Array | null;      // [n*2]
  color0: Float32Array | null;   // [n*4]
  tangents: Float32Array | null; // [n*4] — only when decoded with generateTangents
  indices: Uint32Array;          // always 32-bit here (u8/u16 widened on decode)
  /** index into `Asset.materials`, or −1 */
  material: number;
  /** local-space AABB (from accessor min/max when present, else recomputed) */
  aabbMin: [number, number, number];
  aabbMax: [number, number, number];
  /** whether `positions` etc. are views over the source buffer (true) or copies */
  zeroCopy: boolean;
}

export interface AssetMesh {
  name: string;
  primitives: AssetPrimitive[];
}

export const enum AlphaMode { Opaque = 0, Mask = 1, Blend = 2 }

export interface AssetMaterial {
  name: string;
  baseColorFactor: [number, number, number, number];
  baseColorTexture: number;  // index into Asset.textures, or −1
  metallicFactor: number;
  roughnessFactor: number;
  emissiveFactor: [number, number, number];
  alphaMode: AlphaMode;
  alphaCutoff: number;
  doubleSided: boolean;
}

export interface AssetTexture {
  image: number;             // index into Asset.images
  wrapS: number; wrapT: number; // glTF sampler wrap enums (10497 repeat, …)
  magFilter: number; minFilter: number;
}

export interface AssetImage {
  mimeType: string;          // "image/png" | "image/jpeg"
  bytes: Uint8Array;         // raw file bytes — decode deferred to the renderer
}

export interface Asset {
  nodes: AssetNode[];        // topological, parents first
  meshes: AssetMesh[];
  materials: AssetMaterial[];
  textures: AssetTexture[];
  images: AssetImage[];
  /** roots of the default scene, indices into `nodes` */
  roots: number[];
  /** what was skipped, so callers/tests see gaps instead of silent wrong output */
  ignored: string[];
  stats: {
    nodes: number; meshes: number; primitives: number;
    vertices: number; indices: number; textures: number;
    zeroCopyAccessors: number; copiedAccessors: number;
    /** which geometry decoder ran */
    geometryPath: "wasm" | "js" | "mixed";
    /** JS→WASM calls made for geometry (0 for the js path) */
    wasmCrossings: number;
    /** binary bytes copied into WASM linear memory */
    bytesUploadedToWasm: number;
  };
}
