// WebGPU renderer. Consumes the WASM render list (batch-sorted instance world
// matrices) and issues one indexed-instanced draw per (mesh, material) batch.
// All meshes share one vertex/index buffer; per-instance world matrices live in
// one storage buffer written once per frame; each material is one small uniform
// + optional texture.
//
// Thin consumer at the end of:  C++/WASM prepares data → WebGPU draws.

import type { MeshData } from "../api/Scene.js";
import type { FrameResult } from "../../shared/layout.js";

const WGSL = /* wgsl */ `
struct Camera { viewProj : mat4x4<f32> };
@group(0) @binding(0) var<uniform> camera : Camera;
@group(0) @binding(1) var<storage, read> models : array<mat4x4<f32>>;

struct Material {
  baseColor : vec4<f32>,
  flags     : vec4<f32>,   // x = hasBaseColorTexture, y = alphaCutoff (>0 → mask)
};
@group(1) @binding(0) var<uniform> mat : Material;
@group(1) @binding(1) var baseColorTex : texture_2d<f32>;
@group(1) @binding(2) var baseColorSampler : sampler;

struct VSOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) n : vec3<f32>,
  @location(1) uv : vec2<f32>,
};

@vertex fn vs(@location(0) p : vec3<f32>, @location(1) nrm : vec3<f32>,
              @location(2) uv : vec2<f32>, @builtin(instance_index) i : u32) -> VSOut {
  let world = models[i];
  var o : VSOut;
  o.clip = camera.viewProj * (world * vec4<f32>(p, 1.0));
  o.n = normalize((world * vec4<f32>(nrm, 0.0)).xyz);
  o.uv = uv;
  return o;
}

@fragment fn fs(in : VSOut) -> @location(0) vec4<f32> {
  var base = mat.baseColor;
  if (mat.flags.x > 0.5) {
    let t = textureSample(baseColorTex, baseColorSampler, in.uv);
    base = vec4<f32>(base.rgb * t.rgb, base.a * t.a);
  }
  if (mat.flags.y > 0.0 && base.a < mat.flags.y) { discard; }
  let n = normalize(in.n);
  let key  = max(dot(n, normalize(vec3<f32>(0.5, 0.9, 0.4))), 0.0);
  let fill = max(dot(n, normalize(vec3<f32>(-0.4, 0.2, -0.7))), 0.0) * 0.35;
  let lit = 0.30 + 0.85 * key + fill;
  return vec4<f32>(base.rgb * lit, base.a);
}`;

interface MeshSlot { firstIndex: number; indexCount: number; baseVertex: number; }

/** a decoded RGBA8 image ready for the GPU */
export interface RGBA8 { data: Uint8Array; width: number; height: number; }

/** what the renderer needs to know about one material (from an Asset) */
export interface MaterialSpec {
  baseColorFactor: [number, number, number, number];
  baseColorTexture?: RGBA8 | null;
  alphaCutoff?: number; // >0 → alpha-mask
  doubleSided?: boolean;
}

const VSTRIDE = 32; // pos3 + normal3 + uv2

export class Renderer {
  device!: GPUDevice;
  adapter!: GPUAdapter;
  canTimestamp = false;
  gpuMs = 0;

  private ctx!: GPUCanvasContext;
  private canvas!: HTMLCanvasElement;
  private depthW = 0;
  private depthH = 0;
  private format!: GPUTextureFormat;
  private pipeline!: GPURenderPipeline;
  private pipelineNoCull!: GPURenderPipeline;
  private g0Layout!: GPUBindGroupLayout;
  private g1Layout!: GPUBindGroupLayout;
  private vbuf!: GPUBuffer;
  private ibuf!: GPUBuffer;
  private camBuf!: GPUBuffer;
  private modelBuf!: GPUBuffer;
  private modelCapacity = 0;
  private g0!: GPUBindGroup;
  private depth!: GPUTexture;
  private sampler!: GPUSampler;
  private slots = new Map<number, MeshSlot>();
  private meshMaterial = new Map<number, number>();
  private materials = new Map<number, { g1: GPUBindGroup; doubleSided: boolean; tex?: GPUTexture; buf: GPUBuffer }>();
  private defaultTex!: GPUTexture;
  private qset?: GPUQuerySet;
  private qResolve?: GPUBuffer;
  private qRead?: GPUBuffer;

  drawCalls = 0;

  static async create(canvas: HTMLCanvasElement): Promise<Renderer> {
    if (!navigator.gpu) throw new Error("WebGPU not available");
    const r = new Renderer();
    r.adapter = (await navigator.gpu.requestAdapter({ powerPreference: "high-performance" }))!;
    if (!r.adapter) throw new Error("no GPU adapter");
    r.canTimestamp = r.adapter.features.has("timestamp-query");
    r.device = await r.adapter.requestDevice({ requiredFeatures: r.canTimestamp ? ["timestamp-query"] : [] });
    r.device.addEventListener("uncapturederror", (e: Event) => {
      // surface the ROOT cause — otherwise later ops report "previous error"
      console.error("WebGPU:", (e as GPUUncapturedErrorEvent).error.message);
      (r as unknown as { lastError?: string }).lastError = (e as GPUUncapturedErrorEvent).error.message;
    });
    r.canvas = canvas;
    r.ctx = canvas.getContext("webgpu")!;
    r.format = navigator.gpu.getPreferredCanvasFormat();
    r.ctx.configure({ device: r.device, format: r.format, alphaMode: "opaque" });
    r.buildPipeline();
    r.resize(canvas.width, canvas.height);
    if (r.canTimestamp) {
      r.qset = r.device.createQuerySet({ type: "timestamp", count: 2 });
      r.qResolve = r.device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      r.qRead = r.device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    }
    return r;
  }

  private buildPipeline() {
    const d = this.device;
    const mod = d.createShaderModule({ code: WGSL });
    this.g0Layout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    });
    this.g1Layout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    const layout = d.createPipelineLayout({ bindGroupLayouts: [this.g0Layout, this.g1Layout] });
    const common = {
      layout,
      vertex: {
        module: mod, entryPoint: "vs",
        buffers: [{
          arrayStride: VSTRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" as const },
            { shaderLocation: 1, offset: 12, format: "float32x3" as const },
            { shaderLocation: 2, offset: 24, format: "float32x2" as const },
          ],
        }],
      },
      fragment: { module: mod, entryPoint: "fs", targets: [{ format: this.format }] },
      depthStencil: { format: "depth24plus" as const, depthWriteEnabled: true, depthCompare: "less" as const },
    };
    this.pipeline = d.createRenderPipeline({ ...common, primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" } });
    this.pipelineNoCull = d.createRenderPipeline({ ...common, primitive: { topology: "triangle-list", cullMode: "none", frontFace: "ccw" } });

    this.camBuf = d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sampler = d.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "repeat", addressModeV: "repeat" });
    this.defaultTex = d.createTexture({ size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    d.queue.writeTexture({ texture: this.defaultTex }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4, rowsPerImage: 1 }, [1, 1]);
    this.registerMaterial(0, { baseColorFactor: [1, 1, 1, 1] }); // default
  }

  resize(w: number, h: number) {
    w = Math.max(1, w | 0); h = Math.max(1, h | 0);
    if (w === this.depthW && h === this.depthH && this.depth) return;
    this.depth?.destroy();
    this.depth = this.device.createTexture({ size: [w, h], format: "depth24plus", usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.depthW = w; this.depthH = h;
  }

  dispose() {
    for (const b of [this.vbuf, this.ibuf, this.camBuf, this.modelBuf, this.qResolve, this.qRead]) b?.destroy();
    for (const m of this.materials.values()) { m.buf.destroy(); m.tex?.destroy(); }
    this.depth?.destroy(); this.defaultTex?.destroy(); this.qset?.destroy();
    this.device.destroy();
  }

  /** Register/replace a material. `id` 0 is the default white material. */
  registerMaterial(id: number, spec: MaterialSpec) {
    const d = this.device;
    const buf = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const u = new Float32Array(8);
    u.set(spec.baseColorFactor, 0);
    u[4] = spec.baseColorTexture ? 1 : 0;
    u[5] = spec.alphaCutoff ?? 0;
    d.queue.writeBuffer(buf, 0, u);

    let tex: GPUTexture | undefined;
    let view: GPUTextureView;
    const img = spec.baseColorTexture;
    if (img && img.width > 0 && img.height > 0 && img.data.length >= img.width * img.height * 4) {
      tex = d.createTexture({
        size: [img.width, img.height], format: "rgba8unorm-srgb",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      d.queue.writeTexture({ texture: tex }, img.data, { bytesPerRow: img.width * 4, rowsPerImage: img.height }, [img.width, img.height]);
      view = tex.createView();
    } else {
      view = this.defaultTex.createView();
    }
    const g1 = d.createBindGroup({
      layout: this.g1Layout,
      entries: [
        { binding: 0, resource: { buffer: buf } },
        { binding: 1, resource: view },
        { binding: 2, resource: this.sampler },
      ],
    });
    this.materials.get(id)?.buf.destroy();
    this.materials.get(id)?.tex?.destroy();
    this.materials.set(id, { g1, doubleSided: !!spec.doubleSided, tex, buf });
  }

  /** which material a mesh (primitive) draws with */
  setMeshMaterial(meshId: number, materialId: number) { this.meshMaterial.set(meshId, materialId); }

  /** Pack every registered mesh into one vertex + one index buffer. Call once
   *  (or whenever the mesh set changes). */
  uploadMeshes(meshes: Map<number, MeshData>) {
    let vCount = 0, iCount = 0;
    for (const m of meshes.values()) { vCount += m.positions.length / 3; iCount += m.indices.length; }
    const verts = new Float32Array(Math.max(1, vCount) * 8);
    const idx = new Uint32Array(Math.max(1, iCount));
    let vOff = 0, iOff = 0;
    for (const [id, m] of meshes) {
      const baseVertex = vOff;
      const n = m.positions.length / 3;
      const uv = (m as MeshData & { uv0?: Float32Array | null }).uv0 ?? null;
      for (let i = 0; i < n; i++) {
        const o = (vOff + i) * 8;
        verts[o + 0] = m.positions[i * 3]; verts[o + 1] = m.positions[i * 3 + 1]; verts[o + 2] = m.positions[i * 3 + 2];
        verts[o + 3] = m.normals ? m.normals[i * 3] : 0;
        verts[o + 4] = m.normals ? m.normals[i * 3 + 1] : 1;
        verts[o + 5] = m.normals ? m.normals[i * 3 + 2] : 0;
        verts[o + 6] = uv ? uv[i * 2] : 0; verts[o + 7] = uv ? uv[i * 2 + 1] : 0;
      }
      idx.set(m.indices, iOff);
      this.slots.set(id, { firstIndex: iOff, indexCount: m.indices.length, baseVertex });
      vOff += n; iOff += m.indices.length;
    }
    this.vbuf?.destroy(); this.ibuf?.destroy();
    this.vbuf = this.device.createBuffer({ size: Math.max(32, verts.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.ibuf = this.device.createBuffer({ size: Math.max(4, idx.byteLength), usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.vbuf, 0, verts);
    this.device.queue.writeBuffer(this.ibuf, 0, idx);
  }

  private modelBufValid = false;    // false → the instance buffer holds no valid data yet (force a full upload)
  private lastUploadedVisible = -1;

  private ensureModelBuffer(instances: number) {
    if (instances <= this.modelCapacity && this.modelBuf) return;
    this.modelCapacity = Math.max(instances, Math.ceil(this.modelCapacity * 1.5), 1024);
    this.modelBuf?.destroy();
    this.modelBufValid = false;
    this.modelBuf = this.device.createBuffer({ size: this.modelCapacity * 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.g0 = this.device.createBindGroup({
      layout: this.g0Layout,
      entries: [
        { binding: 0, resource: { buffer: this.camBuf } },
        { binding: 1, resource: { buffer: this.modelBuf } },
      ],
    });
  }

  /** bytes uploaded to the instance storage buffer on the last render() */
  lastUploadBytes = 0;

  render(viewProj: Float32Array, frame: FrameResult) {
    const d = this.device;
    // the canvas colour texture auto-tracks canvas.width/height; keep the depth
    // texture in lock-step or beginRenderPass rejects the size mismatch and the
    // frame is silently dropped (black screen).
    if (this.canvas && (this.canvas.width !== this.depthW || this.canvas.height !== this.depthH))
      this.resize(this.canvas.width, this.canvas.height);
    d.queue.writeBuffer(this.camBuf, 0, viewProj);
    this.ensureModelBuffer(Math.max(1, frame.visibleCount));
    this.lastUploadBytes = 0;

    // Instance storage buffer sync:
    //  · frameChanged === 0        → nothing changed, buffer is already correct.
    //  · listRebuilt === 1         → the whole list moved, one full upload.
    //  · listRebuilt === 0 + dirty → the visible set + batch layout are identical
    //    to last frame; only the matrix rows in `dirtySlots` changed → coalesce
    //    them into runs and patch (a partial upload).
    const iw = frame.instanceWorld;
    const dirty = frame.dirtySlots;
    // trust the incremental patch only when the buffer already holds a valid
    // full copy of THIS visible set — a fresh buffer, or a standalone evaluate()
    // (query / camera framing) not paired with a render, desyncs it.
    const canPatch = this.modelBufValid && frame.visibleCount === this.lastUploadedVisible;
    if (frame.visibleCount === 0 || (frame.stats.frameChanged === 0 && canPatch)) {
      // nothing to upload
    } else if (frame.stats.listRebuilt === 0 && canPatch) {
      // the buffer is already correct except for the changed matrix rows
      if (dirty && dirty.length > 0) {
        if (dirty.length * 3 >= frame.visibleCount) {
          d.queue.writeBuffer(this.modelBuf, 0, iw.buffer, iw.byteOffset, frame.visibleCount * 64);
          this.lastUploadBytes = frame.visibleCount * 64;
        } else {
          const slots = dirty.length > 1 ? Uint32Array.from(dirty).sort() : dirty;
          let runStart = slots[0], prev = slots[0];
          const flush = (end: number) => {
            const bytes = (end - runStart + 1) * 64;
            d.queue.writeBuffer(this.modelBuf, runStart * 64, iw.buffer, iw.byteOffset + runStart * 64, bytes);
            this.lastUploadBytes += bytes;
          };
          for (let k = 1; k < slots.length; k++) {
            if (slots[k] === prev + 1) { prev = slots[k]; continue; }
            flush(prev); runStart = prev = slots[k];
          }
          flush(prev);
        }
      }
    } else if (frame.visibleCount > 0) {
      d.queue.writeBuffer(this.modelBuf, 0, iw.buffer, iw.byteOffset, frame.visibleCount * 64);
      this.lastUploadBytes = frame.visibleCount * 64;
      this.modelBufValid = true;
      this.lastUploadedVisible = frame.visibleCount;
    }

    const enc = d.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), clearValue: { r: 0.04, g: 0.05, b: 0.07, a: 1 }, loadOp: "clear", storeOp: "store" }],
      depthStencilAttachment: { view: this.depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
      ...(this.canTimestamp ? { timestampWrites: { querySet: this.qset!, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {}),
    });
    pass.setBindGroup(0, this.g0);
    pass.setVertexBuffer(0, this.vbuf);
    pass.setIndexBuffer(this.ibuf, "uint32");
    this.drawCalls = 0;
    let curPipe: GPURenderPipeline | null = null;
    for (const b of frame.batches) {
      const s = this.slots.get(b.meshId);
      if (!s) continue;
      const matId = this.meshMaterial.get(b.meshId) ?? 0;
      const m = this.materials.get(matId) ?? this.materials.get(0)!;
      const pipe = m.doubleSided ? this.pipelineNoCull : this.pipeline;
      if (pipe !== curPipe) { pass.setPipeline(pipe); curPipe = pipe; }
      pass.setBindGroup(1, m.g1);
      pass.drawIndexed(s.indexCount, b.instanceCount, s.firstIndex, s.baseVertex, b.firstInstance);
      this.drawCalls++;
    }
    pass.end();

    const wantTs = this.canTimestamp && this.qRead!.mapState === "unmapped";
    if (wantTs) {
      enc.resolveQuerySet(this.qset!, 0, 2, this.qResolve!, 0);
      enc.copyBufferToBuffer(this.qResolve!, 0, this.qRead!, 0, 16);
    }
    d.queue.submit([enc.finish()]);
    if (wantTs) {
      this.qRead!.mapAsync(GPUMapMode.READ).then(() => {
        const t = new BigInt64Array(this.qRead!.getMappedRange());
        this.gpuMs = Number(t[1] - t[0]) / 1e6;
        this.qRead!.unmap();
      }).catch(() => {});
    }
  }
}
