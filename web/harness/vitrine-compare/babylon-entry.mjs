// Bundled Babylon.js entry for the side-by-side comparison harness.
// Same @babylonjs/core version the benchmarks use (deps in package.json).
export { Engine } from "@babylonjs/core/Engines/engine.js";
export { Scene } from "@babylonjs/core/scene.js";
export { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera.js";
export { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
export { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
export { Vector3, Color3, Color4 } from "@babylonjs/core/Maths/math.js";
export { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
export { appendSceneAsync } from "@babylonjs/core/Loading/sceneLoader.js";
import "@babylonjs/core/Materials/standardMaterial.js";
import "@babylonjs/core/Loading/loadingScreen.js";     // side-effect: Engine.loadingScreen
import "@babylonjs/core/Rendering/depthRendererSceneComponent.js";
import "@babylonjs/loaders/glTF/2.0/index.js";
