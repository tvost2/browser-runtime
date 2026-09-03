// WasmBackend — adapter over the WASM-first core (WasmCore/World) for the
// benchmark harness. Compares against JsBackend + the Babylon baseline on
// identical workloads. Same core the public Engine API drives. See ./README.md.
//
// Loads the bundled API lazily so importing this module never fails on a
// machine that hasn't run `npm run build` yet.
const CullStrategy = { Standard: 0, BoundingSphereOnly: 1, None: 2 };

export class WasmBackend {
  name = "cpp";
  #core = null;

  async init(wasmUrl) {
    let WasmCore;
    try {
      ({ WasmCore } = await import("../dist/engine.js"));
    } catch {
      throw new Error("web/dist/engine.js not found — run `npm run build` first");
    }
    this.#core = await WasmCore.create(wasmUrl);
  }

  /** scene: { count, parents:Int32, trs:Float32[count*10], extents:Float32[count*6], flags:Uint32 } */
  upload(scene) {
    const n = scene.count;
    this.#core.setCount(n);
    const C = this.#core.components;
    C.parent.set(scene.parents.subarray(0, n));
    C.flags.set(scene.flags.subarray(0, n));
    for (let i = 0; i < n; i++) {
      const s = i * 10;
      C.pos[i * 3] = scene.trs[s]; C.pos[i * 3 + 1] = scene.trs[s + 1]; C.pos[i * 3 + 2] = scene.trs[s + 2];
      C.rot[i * 4] = scene.trs[s + 3]; C.rot[i * 4 + 1] = scene.trs[s + 4]; C.rot[i * 4 + 2] = scene.trs[s + 5]; C.rot[i * 4 + 3] = scene.trs[s + 6];
      C.scale[i * 3] = scene.trs[s + 7]; C.scale[i * 3 + 1] = scene.trs[s + 8]; C.scale[i * 3 + 2] = scene.trs[s + 9];
      C.localMin[i * 3] = scene.extents[i * 6]; C.localMin[i * 3 + 1] = scene.extents[i * 6 + 1]; C.localMin[i * 3 + 2] = scene.extents[i * 6 + 2];
      C.localMax[i * 3] = scene.extents[i * 6 + 3]; C.localMax[i * 3 + 1] = scene.extents[i * 6 + 4]; C.localMax[i * 3 + 2] = scene.extents[i * 6 + 5];
      C.meshId[i] = 0;
    }
    this.#core.markHierarchyDirty();
  }

  updateTransforms(indices, trs) {
    const C = this.#core.components;
    const each = indices || { length: this.#core.count };
    for (let k = 0; k < each.length; k++) {
      const i = indices ? indices[k] : k;
      const s = i * 10;
      C.pos[i * 3] = trs[s]; C.pos[i * 3 + 1] = trs[s + 1]; C.pos[i * 3 + 2] = trs[s + 2];
      C.rot[i * 4] = trs[s + 3]; C.rot[i * 4 + 1] = trs[s + 4]; C.rot[i * 4 + 2] = trs[s + 5]; C.rot[i * 4 + 3] = trs[s + 6];
      C.scale[i * 3] = trs[s + 7]; C.scale[i * 3 + 1] = trs[s + 8]; C.scale[i * 3 + 2] = trs[s + 9];
      C.dirty[i] = 1;
    }
  }

  get components() { return this.#core.components; }
  markMeshLayoutDirty() { this.#core.markMeshLayoutDirty(); }

  /** flag a subset of entities dirty (transform changed) without rewriting data */
  markDirty(indices) { const D = this.#core.components.dirty; for (let k = 0; k < indices.length; k++) D[indices[k]] = 1; }
  markAllDirty() { this.#core.markAllDirty(); }
  nudge(indices, dz = 0.001) {
    const P = this.#core.components.pos, D = this.#core.components.dirty;
    for (let k = 0; k < indices.length; k++) { P[indices[k] * 3 + 2] += dz; D[indices[k]] = 1; }
  }

  evaluateFrame(viewProj, strategy = CullStrategy.Standard, sortByMesh = false) {
    this.#core.writeViewProj(viewProj);
    const r = this.#core.evaluate(strategy, sortByMesh);
    return {
      visibleCount: r.visibleCount,
      visibleIds: r.visibleIds,
      visibleWorld: r.instanceWorld,
      dirtySlots: r.dirtySlots,
      stats: {
        tested: r.stats.traversed, culledByFlags: r.stats.culledDisabled, culledByFrustum: r.stats.culledFrustum,
        transformsRecomputed: r.stats.transformsRecomputed, frameChanged: r.stats.frameChanged,
        bvhBuilds: r.stats.bvhBuilds, bvhNodes: r.stats.bvhNodes,
        transformUs: r.stats.transformUs, cullUs: r.stats.cullUs, listUs: r.stats.listUs,
        listRebuilt: r.stats.listRebuilt, dirtySlots: r.stats.dirtySlots,
      },
    };
  }

  dispose() {}
}
