// Shared loader for engine.wasm. One module instance (one linear memory) is
// reused by WasmCore (per-frame scene eval) and the asset processor (load-time
// geometry), so we pay the ~100 ms instantiate + 64 MB reserve once.

export interface EngineModule {
  HEAPF32: Float32Array; HEAPU32: Uint32Array; HEAP32: Int32Array; HEAPU8: Uint8Array;
  World: new () => any;
  GltfBatch: new () => any;
}

let cached: Promise<EngineModule> | null = null;
let cachedUrl = "";
export let engineInitMs = 0;

export function loadEngineModule(wasmUrl?: string): Promise<EngineModule> {
  const url = wasmUrl ?? new URL("./engine.mjs", import.meta.url).href;
  if (cached && (cachedUrl === url || !wasmUrl)) return cached;
  cachedUrl = url;
  const t0 = performance.now();
  cached = import(/* @vite-ignore */ /* webpackIgnore: true */ url)
    .then((m: any) => m.default())
    .then((mod: EngineModule) => { engineInitMs = performance.now() - t0; return mod; });
  return cached;
}

/** test / teardown helper */
export function resetEngineModule() { cached = null; cachedUrl = ""; }
