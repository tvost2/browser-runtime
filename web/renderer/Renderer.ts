// WebGPU renderer. Consumes the WASM render list (batch-sorted instance world
// matrices) and issues one indexed-instanced draw per mesh batch. All meshes
// live in one shared vertex/index buffer; per-instance world matrices live in
// one storage buffer written once per frame.
//
// It does NOT own scene state and does NOT implement a graphics abstraction —
// it is the thin consumer at the end of:  C++/WASM prepares data → WebGPU draws.

import type { MeshData } from "../api/Scene.js";
import type { FrameResult } from "../../shared/layout.js";

const WGSL = /* wgsl */ `
struct Camera { viewProj : mat4x4<f32> };
@group(0) @binding(0) var<uniform> camera : Camera;
@group(0) @binding(1) var<storage, read> models : array<mat4x4<f32>>;

struct VSOut { @builtin(position) clip : vec4<f32>, @location(0) n : vec3<f32>, @location(1) wpos : vec3<f32> };

@vertex fn vs(@location(0) p : vec3<f32>, @location(1) nrm : vec3<f32>,
              @builtin(instance_index) i : u32) -> VSOut {
  let world = models[i];
  let wp = world * vec4<f32>(p, 1.0);
  var o : VSOut;
  o.clip = camera.viewProj * wp;
  o.n = normalize((world * vec4<f32>(nrm, 0.0)).xyz);
  o.wpos = wp.xyz;
  return o;
}

@fragment fn fs(in : VSOut) -> @location(0) vec4<f32> {
  let n = normalize(in.n);
  let key = max(dot(n, normalize(vec3<f32>(0.5, 0.9, 0.4))), 0.0);
  let fill = max(dot(n, normalize(vec3<f32>(-0.4, 0.2, -0.7))), 0.0) * 0.35;
  let base = vec3<f32>(0.62, 0.66, 0.78);
  return vec4<f32>(base * (0.28 + 0.9 * key + fill), 1.0);
}`;

interface MeshSlot { firstIndex: number; indexCount: number; baseVertex: number; }

export class Renderer {
  device!: GPUDevice;
  adapter!: GPUAdapter;
  canTimestamp = false;
  gpuMs = 0;

  private ctx!: GPUCanvasContext;
  private format!: GPUTextureFormat;
  private pipeline!: GPURenderPipeline;
  private vbuf!: GPUBuffer;
  private ibuf!: GPUBuffer;
  private camBuf!: GPUBuffer;
  private modelBuf!: GPUBuffer;
  private modelCapacity = 0;
  private bind!: GPUBindGroup;
  private depth!: GPUTexture;
  private slots = new Map<number, MeshSlot>();
  private qset?: GPUQuerySet;
  private qResolve?: GPUBuffer;
  private qRead?: GPUBuffer;

  static async create(canvas: HTMLCanvasElement): Promise<Renderer> {
    if (!navigator.gpu) throw new Error("WebGPU not available");
    const r = new Renderer();
    r.adapter = (await navigator.gpu.requestAdapter({ powerPreference: "high-performance" }))!;
    if (!r.adapter) throw new Error("no GPU adapter");
    r.canTimestamp = r.adapter.features.has("timestamp-query");
    r.device = await r.adapter.requestDevice({ requiredFeatures: r.canTimestamp ? ["timestamp-query"] : [] });
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
    const mod = this.device.createShaderModule({ code: WGSL });
    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: mod, entryPoint: "vs",
        buffers: [{
          arrayStride: 24,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
          ],
        }],
      },
      fragment: { module: mod, entryPoint: "fs", targets: [{ format: this.format }] },
      primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
    });
    this.camBuf = this.device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  resize(w: number, h: number) {
    this.depth?.destroy();
    this.depth = this.device.createTexture({ size: [w, h], format: "depth24plus", usage: GPUTextureUsage.RENDER_ATTACHMENT });
  }

  /** Release all GPU resources. The Renderer is unusable afterwards. */
  dispose() {
    for (const b of [this.vbuf, this.ibuf, this.camBuf, this.modelBuf, this.qResolve, this.qRead]) b?.destroy();
    this.depth?.destroy();
    this.qset?.destroy();
    this.device.destroy();
  }

  /** Pack every registered mesh into one vertex + one index buffer. Call once. */
  uploadMeshes(meshes: Map<number, MeshData>) {
    let vCount = 0, iCount = 0;
    for (const m of meshes.values()) { vCount += m.positions.length / 3; iCount += m.indices.length; }
    const verts = new Float32Array(vCount * 6);
    const idx = new Uint32Array(iCount);
    let vOff = 0, iOff = 0;
    for (const [id, m] of meshes) {
      const baseVertex = vOff;
      const n = m.positions.length / 3;
      for (let i = 0; i < n; i++) {
        verts[(vOff + i) * 6 + 0] = m.positions[i * 3];
        verts[(vOff + i) * 6 + 1] = m.positions[i * 3 + 1];
        verts[(vOff + i) * 6 + 2] = m.positions[i * 3 + 2];
        verts[(vOff + i) * 6 + 3] = m.normals ? m.normals[i * 3] : 0;
        verts[(vOff + i) * 6 + 4] = m.normals ? m.normals[i * 3 + 1] : 1;
        verts[(vOff + i) * 6 + 5] = m.normals ? m.normals[i * 3 + 2] : 0;
      }
      idx.set(m.indices, iOff);
      this.slots.set(id, { firstIndex: iOff, indexCount: m.indices.length, baseVertex });
      vOff += n; iOff += m.indices.length;
    }
    this.vbuf = this.device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.ibuf = this.device.createBuffer({ size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.vbuf, 0, verts);
    this.device.queue.writeBuffer(this.ibuf, 0, idx);
  }

  private ensureModelBuffer(instances: number) {
    if (instances <= this.modelCapacity && this.modelBuf) return;
    this.modelCapacity = Math.max(instances, Math.ceil(this.modelCapacity * 1.5), 1024);
    this.modelBuf?.destroy();
    this.modelBuf = this.device.createBuffer({ size: this.modelCapacity * 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.bind = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.camBuf } },
        { binding: 1, resource: { buffer: this.modelBuf } },
      ],
    });
  }

  render(viewProj: Float32Array, frame: FrameResult) {
    const d = this.device;
    d.queue.writeBuffer(this.camBuf, 0, viewProj);
    this.ensureModelBuffer(Math.max(1, frame.visibleCount));
    if (frame.visibleCount > 0) {
      d.queue.writeBuffer(this.modelBuf, 0, frame.instanceWorld.buffer, frame.instanceWorld.byteOffset, frame.visibleCount * 64);
    }

    const enc = d.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), clearValue: { r: 0.04, g: 0.05, b: 0.07, a: 1 }, loadOp: "clear", storeOp: "store" }],
      depthStencilAttachment: { view: this.depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
      ...(this.canTimestamp ? { timestampWrites: { querySet: this.qset!, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {}),
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind);
    pass.setVertexBuffer(0, this.vbuf);
    pass.setIndexBuffer(this.ibuf, "uint32");
    for (const b of frame.batches) {
      const s = this.slots.get(b.meshId);
      if (!s) continue;
      pass.drawIndexed(s.indexCount, b.instanceCount, s.firstIndex, s.baseVertex, b.firstInstance);
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
