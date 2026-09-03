// Engine — the public entry point.
//
//   const engine = await Engine.create(canvas);
//   const scene  = engine.createScene();
//   const box    = scene.registerMesh(boxMesh());
//   const e      = scene.createEntity(); e.setMesh(box); e.transform.position.set(0, 1, 0);
//   engine.start();
//
// Per frame:  JS updates SoA arrays (cheap) → scene.evaluate() [1 WASM call]
//             → renderer.render(list)  → WebGPU → GPU.

import { WasmCore } from "../bindings/WasmCore.js";
import { Renderer } from "../renderer/Renderer.js";
import { Scene } from "./Scene.js";
import { CullStrategy, type FrameResult } from "../../shared/layout.js";

export interface FrameInfo {
  frame: number;
  dtMs: number;
  time: number;
  result: FrameResult;
}
export type FrameHook = (info: FrameInfo) => void;

export interface EngineStats {
  frame: number;
  cpuFrameMs: number;   // updateHooks + evaluate + render-record + submit
  evalMs: number;       // just scene.evaluate() (the WASM crossing)
  gpuMs: number | null; // timestamp-query, when available
  fps: number;
  visible: number;
  entities: number;
  batches: number;
  drawCalls: number;
  wasmHeapMB: number;   // total WASM linear memory
  jsHeapMB: number | null; // performance.memory, Chromium only
}

export class Engine {
  readonly core: WasmCore;
  readonly renderer: Renderer;
  readonly canvas: HTMLCanvasElement;

  private scenes: Scene[] = [];
  private running = false;
  private _frame = 0;
  private _last = 0;
  private _beforeRender: FrameHook[] = [];
  private _emaCpu = 0;
  private _emaEval = 0;
  stats: EngineStats = {
    frame: 0, cpuFrameMs: 0, evalMs: 0, gpuMs: null, fps: 0,
    visible: 0, entities: 0, batches: 0, drawCalls: 0, wasmHeapMB: 0, jsHeapMB: null,
  };

  private constructor(core: WasmCore, renderer: Renderer, canvas: HTMLCanvasElement) {
    this.core = core; this.renderer = renderer; this.canvas = canvas;
  }

  static async create(canvas: HTMLCanvasElement, opts: { wasmUrl?: string } = {}): Promise<Engine> {
    const [core, renderer] = await Promise.all([
      WasmCore.create(opts.wasmUrl),
      Renderer.create(canvas),
    ]);
    return new Engine(core, renderer, canvas);
  }

  /** ms spent loading + instantiating the WASM module */
  get wasmInitMs() { return this.core.initMs; }

  createScene(): Scene {
    const s = new Scene(this.core);
    s._renderer = this.renderer;
    this.scenes.push(s);
    return s;
  }

  /** Optional — meshes upload lazily on the first frame otherwise. Call
   *  explicitly if you want the GPU cost paid before `start()`. */
  uploadMeshes(scene: Scene) {
    this.renderer.uploadMeshes(scene._meshData);
    scene._meshesDirty = false;
  }

  onBeforeRender(hook: FrameHook) { this._beforeRender.push(hook); }

  renderOnce(): EngineStats {
    const scene = this.scenes[0];
    if (scene._meshesDirty) this.uploadMeshes(scene);
    const t0 = performance.now();
    const dt = this._last ? t0 - this._last : 16.7;
    this._last = t0;

    const aspect = this.canvas.width / this.canvas.height;
    const info: FrameInfo = { frame: this._frame, dtMs: dt, time: t0, result: null as unknown as FrameResult };
    for (const h of this._beforeRender) h(info);

    const tEval = performance.now();
    const result = scene.evaluate(aspect);
    const evalMs = performance.now() - tEval;

    const vp = scene.camera.viewProj(aspect);
    let gpuVisible = result.visibleCount;
    let gpuDraws = result.batches.length;
    if (scene.cullStrategy === CullStrategy.Gpu) {
      const g = this.core.gpuState();
      this.renderer.renderGpu(vp, g);
      gpuDraws = this.renderer.drawCalls; // non-empty buckets actually issued
      gpuVisible = -1; // the GPU knows; reading it back would stall
    } else {
      this.renderer.render(vp, result);
    }
    const cpuMs = performance.now() - t0;

    this._emaCpu = this._emaCpu ? this._emaCpu * 0.9 + cpuMs * 0.1 : cpuMs;
    this._emaEval = this._emaEval ? this._emaEval * 0.9 + evalMs * 0.1 : evalMs;
    const perfMem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    this.stats = {
      frame: this._frame, cpuFrameMs: this._emaCpu, evalMs: this._emaEval,
      gpuMs: this.renderer.canTimestamp ? this.renderer.gpuMs : null,
      fps: 1000 / this._emaCpu,
      visible: gpuVisible, entities: this.core.count,
      batches: gpuDraws, drawCalls: gpuDraws,
      wasmHeapMB: this.core.heapBytes / 1048576,
      jsHeapMB: perfMem ? perfMem.usedJSHeapSize / 1048576 : null,
    };
    this._frame++;
    return this.stats;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => { if (!this.running) return; this.renderOnce(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
  stop() { this.running = false; }

  /** Stop the loop and release the WASM World + all GPU resources. The engine,
   *  its scenes, and any component views are unusable afterwards. */
  dispose() {
    this.stop();
    this.renderer.dispose();
    this.core.dispose();
    this.scenes.length = 0;
  }
}
