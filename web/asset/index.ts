// Asset pipeline — glTF / GLB loading. Pure-data loader (glb + gltf + Asset)
// with zero renderer / WASM coupling; AssetManager is the bridge to the runtime.

export { parseContainer, isGLB, GlbError } from "./glb.js";
export type { GltfContainer } from "./glb.js";
export { decodeGLB, decodeContainer, decomposeColumnMajor, GltfError } from "./gltf.js";
export type { DecodeOptions } from "./gltf.js";
export { decodeGLBNative, NativePipelineUnsupported, NATIVE_TIMING_LABELS, NATIVE_COUNTER_LABELS } from "./native.js";
export type { NativeDecodeStats } from "./native.js";
export { loadEngineModule, resetEngineModule, engineInitMs } from "../bindings/module.js";
export { mergeMeshes, groupByCell } from "./merge.js";
export type { MergeSource, MergedMesh } from "./merge.js";
export { AssetManager, primitiveToMeshData } from "./AssetManager.js";
export type { LoadResult } from "./AssetManager.js";
export { AlphaMode } from "./Asset.js";
export type {
  Asset, AssetNode, AssetMesh, AssetPrimitive,
  AssetMaterial, AssetTexture, AssetImage,
} from "./Asset.js";
