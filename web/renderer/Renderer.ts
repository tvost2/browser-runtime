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

// pos / normal / uv arrive as three separate vertex buffers (SoA) — the
// C++ decode already stores geometry that way, so upload is a straight
// memcpy per attribute with no interleave pass.
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

// --- GPU-driven path (CullStrategy.Gpu) ---------------------------------------
// One compute dispatch culls every entity against the frustum and atomically
// compacts the survivors into per-mesh runs of a `visibleIds` buffer; a second
// tiny dispatch fills a DrawIndexedIndirect args buffer. The render pass then
// issues one drawIndexedIndirect per bucket — the CPU builds no render list and
// uploads only the frustum planes + any world matrices that changed.
const CULL_WGSL = /* wgsl */ `
struct CullU {
  count      : u32,
  numBuckets : u32,
  _p0 : u32, _p1 : u32,
  planes : array<vec4<f32>, 6>,   // frustum: normal.xyz, d  (normalised, Babylon convention)
};
@group(0) @binding(0) var<uniform> u : CullU;
@group(0) @binding(1) var<storage, read>        sphere       : array<vec4<f32>>;  // per entity: center.xyz, radius
@group(0) @binding(2) var<storage, read>        entityBucket : array<u32>;        // per entity → bucket, 0xffffffff = skip
@group(0) @binding(3) var<storage, read>        bucketOffset : array<u32>;        // numBuckets+1
@group(0) @binding(4) var<storage, read>        flags        : array<u32>;        // per entity
@group(0) @binding(5) var<storage, read_write>  visibleIds   : array<u32>;
@group(0) @binding(6) var<storage, read_write>  bucketCount  : array<atomic<u32>>;
@group(0) @binding(7) var<storage, read>        meshInfo     : array<vec4<u32>>;  // per bucket: indexCount, firstIndex, baseVertex, _
@group(0) @binding(8) var<storage, read_write>  drawArgs     : array<u32>;        // 5 u32 per bucket

const F_ON : u32 = 3u;  // F_ENABLED | F_VISIBLE

@compute @workgroup_size(64)
fn cull(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= u.count) { return; }
  let b = entityBucket[i];
  if (b == 0xffffffffu) { return; }
  if ((flags[i] & F_ON) != F_ON) { return; }
  let s = sphere[i];
  for (var p = 0u; p < 6u; p = p + 1u) {
    if (dot(u.planes[p].xyz, s.xyz) + u.planes[p].w <= -s.w) { return; }
  }
  let slot = atomicAdd(&bucketCount[b], 1u);
  visibleIds[bucketOffset[b] + slot] = i;
}

@compute @workgroup_size(64)
fn args(@builtin(global_invocation_id) gid : vec3<u32>) {
  let b = gid.x;
  if (b >= u.numBuckets) { return; }
  let mi = meshInfo[b];
  let o = b * 5u;
  drawArgs[o + 0u] = mi.x;                         // indexCount
  drawArgs[o + 1u] = atomicLoad(&bucketCount[b]);  // instanceCount
  drawArgs[o + 2u] = mi.y;                         // firstIndex
  drawArgs[o + 3u] = mi.z;                         // baseVertex
  drawArgs[o + 4u] = bucketOffset[b];              // firstInstance
}`;

// render pipeline for GPU mode: world matrices are entity-indexed, the instance
// index goes through visibleIds first.
const GPU_WGSL = /* wgsl */ `
struct Camera { viewProj : mat4x4<f32> };
@group(0) @binding(0) var<uniform> camera : Camera;
@group(0) @binding(1) var<storage, read> worldMats  : array<mat4x4<f32>>;  // entity-indexed
@group(0) @binding(2) var<storage, read> visibleIds : array<u32>;

struct Material { baseColor : vec4<f32>, flags : vec4<f32> };
@group(1) @binding(0) var<uniform> mat : Material;
@group(1) @binding(1) var baseColorTex : texture_2d<f32>;
@group(1) @binding(2) var baseColorSampler : sampler;

struct VSOut { @builtin(position) clip : vec4<f32>, @location(0) n : vec3<f32>, @location(1) uv : vec2<f32> };

@vertex fn vs(@location(0) p : vec3<f32>, @location(1) nrm : vec3<f32>,
              @location(2) uv : vec2<f32>, @builtin(instance_index) ii : u32) -> VSOut {
  let world = worldMats[visibleIds[ii]];
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
  return vec4<f32>(base.rgb * (0.30 + 0.85 * key + fill), base.a);
}`;

/** what the GPU-cull path needs each frame (views over WASM memory) */
export interface GpuFrame {
  count: number;
  numBuckets: number;
  bucketMesh: Uint32Array;    // meshId per bucket (draw order)
  bucketOffset: Uint32Array;  // numBuckets + 1
  entityBucket: Uint32Array;  // count
  worldMats: Float32Array;    // count * 16
  worldSphere: Float32Array;  // count * 4
  flags: Uint32Array;         // count
  recomputed: Uint8Array;     // count — matrices that changed this frame
  layoutChanged: boolean;
  frameChanged: boolean;
}

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

const POS_STRIDE = 12; // vec3 f32
const NRM_STRIDE = 12;
const UV_STRIDE = 8;

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
  // append-only geometry arena: three SoA vertex buffers + one index buffer.
  // A new mesh is written at the tail (one partial writeBuffer per attribute);
  // the buffer only grows (doubling, GPU-side copy) when the tail runs out.
  private posBuf!: GPUBuffer;
  private nrmBuf!: GPUBuffer;
  private uvBuf!: GPUBuffer;
  private ibuf!: GPUBuffer;
  private vertHead = 0;   // next free vertex slot
  private idxHead = 0;    // next free index slot
  private vertCap = 0;    // capacity in vertices
  private idxCap = 0;     // capacity in indices
  private _defaultNrm = new Float32Array(0); // (0,1,0) filler for meshes with no normals
  /** running total of geometry bytes pushed to the GPU (all uploads) */
  geomBytesTotal = 0;
  /** geometry bytes pushed on the last uploadMeshes() call */
  lastGeomUploadBytes = 0;
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

  // --- GPU-driven cull path ---
  private computeCull?: GPUComputePipeline;
  private computeArgs?: GPUComputePipeline;
  private cullLayout?: GPUBindGroupLayout;
  private pipelineGpu?: GPURenderPipeline;
  private pipelineGpuNoCull?: GPURenderPipeline;
  private g0GpuLayout?: GPUBindGroupLayout;
  private gWorldMat?: GPUBuffer;   private gWorldMatCap = 0;
  private gSphere?: GPUBuffer;
  private gEntBucket?: GPUBuffer;
  private gBucketOff?: GPUBuffer;
  private gFlags?: GPUBuffer;
  private gVisible?: GPUBuffer;
  private gBucketCnt?: GPUBuffer;
  private gMeshInfo?: GPUBuffer;
  private gDrawArgs?: GPUBuffer;
  private gCullU?: GPUBuffer;
  private gCullBind?: GPUBindGroup;
  private g0Gpu?: GPUBindGroup;
  private gEntCap = 0;
  private gBucketCap = 0;
  private gBucketMesh = new Uint32Array(0);
  private gWorldMatValid = false;
  private _plane = new Float32Array(24);

  drawCalls = 0;

  static async create(canvas: HTMLCanvasElement): Promise<Renderer> {
    if (!navigator.gpu) throw new Error("WebGPU is not available in this browser (need Chrome/Edge 113+, or enable it)");
    const r = new Renderer();
    r.adapter = (await navigator.gpu.requestAdapter({ powerPreference: "high-performance" }))
      ?? (await navigator.gpu.requestAdapter())                        // retry without a preference
      ?? (await navigator.gpu.requestAdapter({ forceFallbackAdapter: true }))!;  // last resort: software
    if (!r.adapter) throw new Error("navigator.gpu.requestAdapter() returned null — no WebGPU adapter available");
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
        buffers: [
          { arrayStride: POS_STRIDE, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" as const }] },
          { arrayStride: NRM_STRIDE, attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" as const }] },
          { arrayStride: UV_STRIDE, attributes: [{ shaderLocation: 2, offset: 0, format: "float32x2" as const }] },
        ],
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
    this.buildComputePipelines();
  }

  private buildComputePipelines() {
    const d = this.device;
    // cull + args share one bind group
    const bufRO = { type: "read-only-storage" as const };
    const bufRW = { type: "storage" as const };
    this.cullLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: bufRO },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: bufRO },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: bufRO },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: bufRO },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: bufRW },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: bufRW },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: bufRO },
        { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: bufRW },
      ],
    });
    const cmod = d.createShaderModule({ code: CULL_WGSL });
    const clayout = d.createPipelineLayout({ bindGroupLayouts: [this.cullLayout] });
    this.computeCull = d.createComputePipeline({ layout: clayout, compute: { module: cmod, entryPoint: "cull" } });
    this.computeArgs = d.createComputePipeline({ layout: clayout, compute: { module: cmod, entryPoint: "args" } });
    this.gCullU = d.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    // GPU-mode render pipeline: g0 = camera + worldMats + visibleIds
    this.g0GpuLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: bufRO },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: bufRO },
      ],
    });
    const gmod = d.createShaderModule({ code: GPU_WGSL });
    const glayout = d.createPipelineLayout({ bindGroupLayouts: [this.g0GpuLayout, this.g1Layout] });
    const gcommon = {
      layout: glayout,
      vertex: {
        module: gmod, entryPoint: "vs",
        buffers: [
          { arrayStride: POS_STRIDE, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" as const }] },
          { arrayStride: NRM_STRIDE, attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" as const }] },
          { arrayStride: UV_STRIDE, attributes: [{ shaderLocation: 2, offset: 0, format: "float32x2" as const }] },
        ],
      },
      fragment: { module: gmod, entryPoint: "fs", targets: [{ format: this.format }] },
      depthStencil: { format: "depth24plus" as const, depthWriteEnabled: true, depthCompare: "less" as const },
    };
    this.pipelineGpu = d.createRenderPipeline({ ...gcommon, primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" } });
    this.pipelineGpuNoCull = d.createRenderPipeline({ ...gcommon, primitive: { topology: "triangle-list", cullMode: "none", frontFace: "ccw" } });
  }

  resize(w: number, h: number) {
    w = Math.max(1, w | 0); h = Math.max(1, h | 0);
    if (w === this.depthW && h === this.depthH && this.depth) return;
    this.depth?.destroy();
    this.depth = this.device.createTexture({ size: [w, h], format: "depth24plus", usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.depthW = w; this.depthH = h;
  }

  dispose() {
    for (const b of [this.posBuf, this.nrmBuf, this.uvBuf, this.ibuf, this.camBuf, this.modelBuf, this.qResolve, this.qRead,
      this.gWorldMat, this.gSphere, this.gEntBucket, this.gBucketOff, this.gFlags, this.gVisible, this.gBucketCnt, this.gMeshInfo, this.gDrawArgs, this.gCullU]) b?.destroy();
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

  /** Append any not-yet-uploaded meshes to the geometry arena. O(new data),
   *  not O(all meshes) — a mesh already in `slots` is skipped. The buffers
   *  grow by doubling (GPU-side copy) only when the tail overflows. */
  uploadMeshes(meshes: Map<number, MeshData>) {
    this.lastGeomUploadBytes = 0;
    // what's new, and how much room it needs
    let newV = 0, newI = 0;
    const fresh: [number, MeshData][] = [];
    for (const [id, m] of meshes) {
      if (this.slots.has(id)) continue;
      fresh.push([id, m]);
      newV += m.positions.length / 3;
      newI += m.indices.length;
    }
    if (fresh.length === 0) return;

    if (this.vertHead + newV > this.vertCap) this.growVerts(this.vertHead + newV);
    if (this.idxHead + newI > this.idxCap) this.growIndices(this.idxHead + newI);

    const d = this.device;
    // reusable (0,1,0) filler for meshes without normals
    let maxN = 0;
    for (const [, m] of fresh) if (!m.normals) maxN = Math.max(maxN, m.positions.length);
    if (maxN > this._defaultNrm.length) {
      this._defaultNrm = new Float32Array(maxN);
      for (let i = 1; i < maxN; i += 3) this._defaultNrm[i] = 1;
    }

    for (const [id, m] of fresh) {
      const n = m.positions.length / 3;
      const uv = (m as MeshData & { uv0?: Float32Array | null }).uv0 ?? null;
      const vByte = this.vertHead * POS_STRIDE;

      d.queue.writeBuffer(this.posBuf, vByte, m.positions.buffer, m.positions.byteOffset, n * 12);
      if (m.normals) d.queue.writeBuffer(this.nrmBuf, vByte, m.normals.buffer, m.normals.byteOffset, n * 12);
      else d.queue.writeBuffer(this.nrmBuf, vByte, this._defaultNrm.buffer, 0, n * 12);
      if (uv && uv.length >= n * 2) d.queue.writeBuffer(this.uvBuf, this.vertHead * UV_STRIDE, uv.buffer, uv.byteOffset, n * 8);
      d.queue.writeBuffer(this.ibuf, this.idxHead * 4, m.indices.buffer, m.indices.byteOffset, m.indices.length * 4);

      this.slots.set(id, { firstIndex: this.idxHead, indexCount: m.indices.length, baseVertex: this.vertHead });
      const b = n * 12 + n * 12 + (uv ? n * 8 : 0) + m.indices.length * 4;
      this.lastGeomUploadBytes += b;
      this.vertHead += n;
      this.idxHead += m.indices.length;
    }
    this.geomBytesTotal += this.lastGeomUploadBytes;
  }

  private growVerts(need: number) {
    const d = this.device;
    const cap = Math.max(need, this.vertCap * 2, 65536);
    const mk = () => d.createBuffer({ size: cap * 12, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    const np = mk(), nn = mk(), nu = d.createBuffer({ size: cap * UV_STRIDE, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    if (this.vertHead > 0) {
      const enc = d.createCommandEncoder();
      enc.copyBufferToBuffer(this.posBuf, 0, np, 0, this.vertHead * 12);
      enc.copyBufferToBuffer(this.nrmBuf, 0, nn, 0, this.vertHead * 12);
      enc.copyBufferToBuffer(this.uvBuf, 0, nu, 0, this.vertHead * UV_STRIDE);
      d.queue.submit([enc.finish()]);
    }
    this.posBuf?.destroy(); this.nrmBuf?.destroy(); this.uvBuf?.destroy();
    this.posBuf = np; this.nrmBuf = nn; this.uvBuf = nu;
    this.vertCap = cap;
  }

  private growIndices(need: number) {
    const d = this.device;
    const cap = Math.max(need, this.idxCap * 2, 131072);
    const ni = d.createBuffer({ size: cap * 4, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    if (this.idxHead > 0) {
      const enc = d.createCommandEncoder();
      enc.copyBufferToBuffer(this.ibuf, 0, ni, 0, this.idxHead * 4);
      d.queue.submit([enc.finish()]);
    }
    this.ibuf?.destroy();
    this.ibuf = ni;
    this.idxCap = cap;
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
    this.drawCalls = 0;
    if (this.posBuf && this.ibuf) {
      pass.setVertexBuffer(0, this.posBuf);
      pass.setVertexBuffer(1, this.nrmBuf);
      pass.setVertexBuffer(2, this.uvBuf);
      pass.setIndexBuffer(this.ibuf, "uint32");
    }
    let curPipe: GPURenderPipeline | null = null;
    for (const b of (this.posBuf ? frame.batches : [])) {
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

  // ---- GPU-driven cull path -------------------------------------------------

  private syncGpuBuffers(gpu: GpuFrame) {
    const d = this.device;
    const S = GPUBufferUsage.STORAGE, C = GPUBufferUsage.COPY_DST, R = GPUBufferUsage.COPY_SRC;
    let rebind = false;

    if (gpu.count > this.gEntCap) {
      const cap = Math.max(gpu.count, this.gEntCap * 2, 4096);
      for (const b of [this.gWorldMat, this.gSphere, this.gEntBucket, this.gFlags, this.gVisible]) b?.destroy();
      this.gWorldMat = d.createBuffer({ size: cap * 64, usage: S | C | R });
      this.gSphere = d.createBuffer({ size: cap * 16, usage: S | C });
      this.gEntBucket = d.createBuffer({ size: cap * 4, usage: S | C });
      this.gFlags = d.createBuffer({ size: cap * 4, usage: S | C });
      this.gVisible = d.createBuffer({ size: cap * 4, usage: S | R });
      this.gEntCap = cap;
      this.gWorldMatCap = cap;
      this.gWorldMatValid = false;
      this._gpuArgsValid = false;
      rebind = true;
    }
    if (gpu.numBuckets > this.gBucketCap) {
      const cap = Math.max(gpu.numBuckets, this.gBucketCap * 2, 64);
      for (const b of [this.gBucketOff, this.gBucketCnt, this.gMeshInfo, this.gDrawArgs]) b?.destroy();
      this.gBucketOff = d.createBuffer({ size: (cap + 1) * 4, usage: S | C });
      this.gBucketCnt = d.createBuffer({ size: cap * 4, usage: S | C });
      this.gMeshInfo = d.createBuffer({ size: cap * 16, usage: S | C });
      this.gDrawArgs = d.createBuffer({ size: cap * 20, usage: GPUBufferUsage.INDIRECT | S | R });
      this.gBucketCap = cap;
      rebind = true;
    }

    if (gpu.layoutChanged || rebind) {
      this.gBucketMesh = gpu.bucketMesh.slice(0, gpu.numBuckets);
      d.queue.writeBuffer(this.gEntBucket!, 0, gpu.entityBucket.buffer, gpu.entityBucket.byteOffset, gpu.count * 4);
      d.queue.writeBuffer(this.gBucketOff!, 0, gpu.bucketOffset.buffer, gpu.bucketOffset.byteOffset, (gpu.numBuckets + 1) * 4);
      d.queue.writeBuffer(this.gFlags!, 0, gpu.flags.buffer, gpu.flags.byteOffset, gpu.count * 4);
      // per-bucket mesh geometry info, from the arena's slot table
      const mi = new Uint32Array(gpu.numBuckets * 4);
      for (let b = 0; b < gpu.numBuckets; b++) {
        const s = this.slots.get(this.gBucketMesh[b]);
        if (s) { mi[b * 4] = s.indexCount; mi[b * 4 + 1] = s.firstIndex; mi[b * 4 + 2] = s.baseVertex; }
      }
      d.queue.writeBuffer(this.gMeshInfo!, 0, mi);

      this.gCullBind = d.createBindGroup({
        layout: this.cullLayout!,
        entries: [
          { binding: 0, resource: { buffer: this.gCullU! } },
          { binding: 1, resource: { buffer: this.gSphere! } },
          { binding: 2, resource: { buffer: this.gEntBucket! } },
          { binding: 3, resource: { buffer: this.gBucketOff! } },
          { binding: 4, resource: { buffer: this.gFlags! } },
          { binding: 5, resource: { buffer: this.gVisible! } },
          { binding: 6, resource: { buffer: this.gBucketCnt! } },
          { binding: 7, resource: { buffer: this.gMeshInfo! } },
          { binding: 8, resource: { buffer: this.gDrawArgs! } },
        ],
      });
      this.g0Gpu = d.createBindGroup({
        layout: this.g0GpuLayout!,
        entries: [
          { binding: 0, resource: { buffer: this.camBuf } },
          { binding: 1, resource: { buffer: this.gWorldMat! } },
          { binding: 2, resource: { buffer: this.gVisible! } },
        ],
      });
    }
  }

  /** frustum planes from viewProj (row-vector, Babylon convention), normalised */
  private writePlanes(m: Float32Array) {
    const P = this._plane;
    const rows = [
      [m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]], // near
      [m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]], // far
      [m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]],  // left
      [m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]],  // right
      [m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]],  // top
      [m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]],  // bottom
    ];
    for (let i = 0; i < 6; i++) {
      const [a, b, c, dd] = rows[i];
      const inv = 1 / (Math.hypot(a, b, c) || 1);
      P[i * 4] = a * inv; P[i * 4 + 1] = b * inv; P[i * 4 + 2] = c * inv; P[i * 4 + 3] = dd * inv;
    }
  }

  /** running total of instance/world-matrix bytes pushed on the last renderGpu() */
  lastGpuUploadBytes = 0;

  private _gpuArgsValid = false;

  renderGpu(viewProj: Float32Array, gpu: GpuFrame) {
    const d = this.device;
    if (this.canvas && (this.canvas.width !== this.depthW || this.canvas.height !== this.depthH))
      this.resize(this.canvas.width, this.canvas.height);
    this.syncGpuBuffers(gpu);
    if (!this.posBuf || gpu.numBuckets === 0) { this.blank(viewProj); return; }
    this.lastGpuUploadBytes = 0;

    // nothing moved and the camera is unchanged → skip the upload + the cull
    // dispatch, re-issue last frame's draw args verbatim.
    const recull = gpu.frameChanged || gpu.layoutChanged || !this._gpuArgsValid;
    const enc = d.createCommandEncoder();

    if (recull) {
      d.queue.writeBuffer(this.camBuf, 0, viewProj);
      const head = new Uint32Array(4); head[0] = gpu.count; head[1] = gpu.numBuckets;
      d.queue.writeBuffer(this.gCullU!, 0, head);
      this.writePlanes(viewProj);
      d.queue.writeBuffer(this.gCullU!, 16, this._plane);

      const wm = gpu.worldMats, sp = gpu.worldSphere, rc = gpu.recomputed;
      if (!this.gWorldMatValid) {
        d.queue.writeBuffer(this.gWorldMat!, 0, wm, 0, gpu.count * 16);
        d.queue.writeBuffer(this.gSphere!, 0, sp, 0, gpu.count * 4);
        this.lastGpuUploadBytes = gpu.count * 80;
        this.gWorldMatValid = true;
      } else if (gpu.frameChanged) {
        let k = 0;
        while (k < gpu.count) {
          if (!rc[k]) { k++; continue; }
          let j = k + 1;
          while (j < gpu.count && rc[j]) j++;
          d.queue.writeBuffer(this.gWorldMat!, k * 64, wm, k * 16, (j - k) * 16);
          d.queue.writeBuffer(this.gSphere!, k * 16, sp, k * 4, (j - k) * 4);
          this.lastGpuUploadBytes += (j - k) * 80;
          k = j;
        }
      }

      enc.clearBuffer(this.gBucketCnt!, 0, this.gBucketCap * 4);
      const cp = enc.beginComputePass();
      cp.setBindGroup(0, this.gCullBind!);
      cp.setPipeline(this.computeCull!);
      cp.dispatchWorkgroups(Math.ceil(gpu.count / 64));
      cp.setPipeline(this.computeArgs!);
      cp.dispatchWorkgroups(Math.ceil(gpu.numBuckets / 64));
      cp.end();
      this._gpuArgsValid = true;
    }

    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), clearValue: { r: 0.04, g: 0.05, b: 0.07, a: 1 }, loadOp: "clear", storeOp: "store" }],
      depthStencilAttachment: { view: this.depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
      ...(this.canTimestamp ? { timestampWrites: { querySet: this.qset!, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {}),
    });
    pass.setBindGroup(0, this.g0Gpu!);
    pass.setVertexBuffer(0, this.posBuf);
    pass.setVertexBuffer(1, this.nrmBuf);
    pass.setVertexBuffer(2, this.uvBuf);
    pass.setIndexBuffer(this.ibuf, "uint32");
    this.drawCalls = 0;
    let curPipe: GPURenderPipeline | null = null;
    for (let b = 0; b < gpu.numBuckets; b++) {
      const matId = this.meshMaterial.get(this.gBucketMesh[b]) ?? 0;
      const m = this.materials.get(matId) ?? this.materials.get(0)!;
      const pipe = m.doubleSided ? this.pipelineGpuNoCull! : this.pipelineGpu!;
      if (pipe !== curPipe) { pass.setPipeline(pipe); curPipe = pipe; }
      pass.setBindGroup(1, m.g1);
      pass.drawIndexedIndirect(this.gDrawArgs!, b * 20);
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

  /** test-only: read back the GPU-computed visible entity ids (stalls the queue). */
  async readbackGpuVisible(): Promise<Uint32Array> {
    const d = this.device;
    if (!this.gDrawArgs || !this.gVisible) return new Uint32Array(0);
    const nb = this.gBucketMesh.length;
    const argN = nb * 5;
    const argRead = d.createBuffer({ size: argN * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    let enc = d.createCommandEncoder();
    enc.copyBufferToBuffer(this.gDrawArgs, 0, argRead, 0, argN * 4);
    d.queue.submit([enc.finish()]);
    await argRead.mapAsync(GPUMapMode.READ);
    const args = new Uint32Array(argRead.getMappedRange().slice(0));
    argRead.unmap(); argRead.destroy();

    const out: number[] = [];
    const visN = this.gEntCap;
    const visRead = d.createBuffer({ size: visN * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc = d.createCommandEncoder();
    enc.copyBufferToBuffer(this.gVisible, 0, visRead, 0, visN * 4);
    d.queue.submit([enc.finish()]);
    await visRead.mapAsync(GPUMapMode.READ);
    const vis = new Uint32Array(visRead.getMappedRange());
    for (let b = 0; b < nb; b++) {
      const first = args[b * 5 + 4], cnt = args[b * 5 + 1];
      for (let k = 0; k < cnt; k++) out.push(vis[first + k]);
    }
    visRead.unmap(); visRead.destroy();
    return Uint32Array.from(out);
  }

  /** clear-only frame (no geometry / no buckets yet) */
  private blank(viewProj: Float32Array) {
    const d = this.device;
    d.queue.writeBuffer(this.camBuf, 0, viewProj);
    const enc = d.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), clearValue: { r: 0.04, g: 0.05, b: 0.07, a: 1 }, loadOp: "clear", storeOp: "store" }],
      depthStencilAttachment: { view: this.depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
    });
    pass.end();
    d.queue.submit([enc.finish()]);
  }
}
