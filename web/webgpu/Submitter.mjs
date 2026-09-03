// Minimal WebGPU renderer that consumes a backend's FrameResult and draws the
// visible set as instanced unit cubes. Identical GPU workload regardless of
// which backend (js / cpp) produced the visible list — that is the point:
// the GPU sees the same thing, so any frame-time delta is CPU-side.
//
// Per-instance world matrix comes straight from result.visibleWorld (a view
// over the backend's memory) written into one storage buffer each frame.

const WGSL = /* wgsl */ `
struct Camera { viewProj : mat4x4<f32> };
@group(0) @binding(0) var<uniform> camera : Camera;
@group(0) @binding(1) var<storage, read> models : array<mat4x4<f32>>;

struct VSOut { @builtin(position) pos : vec4<f32>, @location(0) n : vec3<f32> };

@vertex
fn vs(@location(0) p : vec3<f32>, @builtin(instance_index) i : u32) -> VSOut {
  var o : VSOut;
  let world = models[i];
  o.pos = camera.viewProj * (world * vec4<f32>(p, 1.0));
  o.n = normalize((world * vec4<f32>(p, 0.0)).xyz);
  return o;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  let l = max(dot(normalize(in.n), normalize(vec3<f32>(0.4, 0.8, 0.3))), 0.0);
  return vec4<f32>(vec3<f32>(0.15) + vec3<f32>(0.8, 0.85, 0.9) * l, 1.0);
}`;

const CUBE = new Float32Array([
  // 36 verts, unit cube centered at origin (matches [-0.5,0.5] extents)
  -0.5,-0.5,-0.5, 0.5,-0.5,-0.5, 0.5,0.5,-0.5, -0.5,-0.5,-0.5, 0.5,0.5,-0.5, -0.5,0.5,-0.5,
  -0.5,-0.5,0.5, 0.5,0.5,0.5, 0.5,-0.5,0.5, -0.5,-0.5,0.5, -0.5,0.5,0.5, 0.5,0.5,0.5,
  -0.5,0.5,-0.5, 0.5,0.5,-0.5, 0.5,0.5,0.5, -0.5,0.5,-0.5, 0.5,0.5,0.5, -0.5,0.5,0.5,
  -0.5,-0.5,-0.5, 0.5,-0.5,0.5, 0.5,-0.5,-0.5, -0.5,-0.5,-0.5, -0.5,-0.5,0.5, 0.5,-0.5,0.5,
  0.5,-0.5,-0.5, 0.5,-0.5,0.5, 0.5,0.5,0.5, 0.5,-0.5,-0.5, 0.5,0.5,0.5, 0.5,0.5,-0.5,
  -0.5,-0.5,-0.5, -0.5,0.5,0.5, -0.5,-0.5,0.5, -0.5,-0.5,-0.5, -0.5,0.5,-0.5, -0.5,0.5,0.5,
]);

export class Submitter {
  async init(canvas, maxInstances) {
    this.adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    const canTimestamp = this.adapter.features.has("timestamp-query");
    this.device = await this.adapter.requestDevice({
      requiredFeatures: canTimestamp ? ["timestamp-query"] : [],
    });
    this.canTimestamp = canTimestamp;
    this.ctx = canvas.getContext("webgpu");
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device: this.device, format: this.format, alphaMode: "opaque" });

    const d = this.device;
    this.vbuf = d.createBuffer({ size: CUBE.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(this.vbuf, 0, CUBE);

    this.camBuf = d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.modelBuf = d.createBuffer({ size: maxInstances * 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });

    const mod = d.createShaderModule({ code: WGSL });
    this.pipeline = d.createRenderPipeline({
      layout: "auto",
      vertex: { module: mod, entryPoint: "vs", buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] },
      fragment: { module: mod, entryPoint: "fs", targets: [{ format: this.format }] },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
    });
    this.bind = d.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.camBuf } },
        { binding: 1, resource: { buffer: this.modelBuf } },
      ],
    });
    this._resize(canvas);

    if (canTimestamp) {
      this.qset = d.createQuerySet({ type: "timestamp", count: 2 });
      this.qbuf = d.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      this.qread = d.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    }
    this.gpuMs = 0;
  }

  _resize(canvas) {
    this.depth?.destroy?.();
    this.depth = this.device.createTexture({
      size: [canvas.width, canvas.height], format: "depth24plus", usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  render(viewProj, result) {
    const d = this.device;
    d.queue.writeBuffer(this.camBuf, 0, viewProj);
    if (result.visibleCount > 0) {
      d.queue.writeBuffer(this.modelBuf, 0, result.visibleWorld.buffer, result.visibleWorld.byteOffset, result.visibleCount * 64);
    }
    const enc = d.createCommandEncoder();
    const rp = enc.beginRenderPass({
      colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), clearValue: { r: 0.05, g: 0.06, b: 0.08, a: 1 }, loadOp: "clear", storeOp: "store" }],
      depthStencilAttachment: { view: this.depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
      ...(this.canTimestamp ? { timestampWrites: { querySet: this.qset, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {}),
    });
    rp.setPipeline(this.pipeline);
    rp.setBindGroup(0, this.bind);
    rp.setVertexBuffer(0, this.vbuf);
    rp.draw(36, result.visibleCount);
    rp.end();
    if (this.canTimestamp && this.qread.mapState === "unmapped") {
      enc.resolveQuerySet(this.qset, 0, 2, this.qbuf, 0);
      enc.copyBufferToBuffer(this.qbuf, 0, this.qread, 0, 16);
    }
    d.queue.submit([enc.finish()]);
    if (this.canTimestamp && this.qread.mapState === "unmapped") {
      this.qread.mapAsync(GPUMapMode.READ).then(() => {
        const t = new BigInt64Array(this.qread.getMappedRange());
        this.gpuMs = Number(t[1] - t[0]) / 1e6;
        this.qread.unmap();
      }).catch(() => {});
    }
  }
}
