// Public API surface. `npm install <engine>` → `import { Engine } from "<engine>"`.
export { Engine } from "./Engine.js";
export type { EngineStats, FrameInfo, FrameHook } from "./Engine.js";
export { Scene } from "./Scene.js";
export type { MeshData } from "./Scene.js";
export { Entity, Transform } from "./Entity.js";
export { Camera } from "./Camera.js";
export { Vec3, Quat, viewProjLH } from "./math.js";
export { box, sphere, subdivSphere } from "./meshes.js";
export { CullStrategy, FLAG, STRIDE } from "../../shared/layout.js";
export type { FrameResult, RenderBatch, EvalStats } from "../../shared/layout.js";
export { WasmCore } from "../bindings/WasmCore.js";

// asset pipeline (glTF / GLB) — Phase 1
export { AssetManager, parseContainer, decodeGLB, isGLB, AlphaMode } from "../asset/index.js";
export { decodeGLBNative, NativePipelineUnsupported, NATIVE_TIMING_LABELS, NATIVE_COUNTER_LABELS, loadEngineModule } from "../asset/index.js";
export { mergeMeshes, groupByCell } from "../asset/index.js";
export type { MergeSource, MergedMesh } from "../asset/index.js";
export type { Asset, AssetNode, AssetMesh, AssetPrimitive, AssetMaterial, LoadResult, NativeDecodeStats } from "../asset/index.js";
