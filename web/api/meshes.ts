// Procedural primitives → MeshData (positions, indices, normals). Enough to
// build real benchmark/demo scenes without an asset pipeline.

import type { MeshData } from "./Scene.js";

export function box(size = 1): MeshData {
  const h = size / 2;
  // 24 verts (per-face normals), 36 indices
  const faces = [
    { n: [0, 0, 1], v: [[-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]] },
    { n: [0, 0, -1], v: [[h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h]] },
    { n: [0, 1, 0], v: [[-h, h, h], [h, h, h], [h, h, -h], [-h, h, -h]] },
    { n: [0, -1, 0], v: [[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]] },
    { n: [1, 0, 0], v: [[h, -h, h], [h, -h, -h], [h, h, -h], [h, h, h]] },
    { n: [-1, 0, 0], v: [[-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h]] },
  ];
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  faces.forEach((f, fi) => {
    f.v.forEach((p) => { positions.push(...p); normals.push(...f.n); });
    const b = fi * 4;
    indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), indices: Uint32Array.from(indices) };
}

export function sphere(diameter = 1, segments = 16): MeshData {
  const r = diameter / 2;
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  for (let y = 0; y <= segments; y++) {
    const v = y / segments, phi = v * Math.PI;
    for (let x = 0; x <= segments; x++) {
      const u = x / segments, theta = u * Math.PI * 2;
      const nx = Math.sin(phi) * Math.cos(theta), ny = Math.cos(phi), nz = Math.sin(phi) * Math.sin(theta);
      positions.push(nx * r, ny * r, nz * r);
      normals.push(nx, ny, nz);
    }
  }
  const row = segments + 1;
  for (let y = 0; y < segments; y++)
    for (let x = 0; x < segments; x++) {
      const a = y * row + x, b = a + row;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), indices: Uint32Array.from(indices) };
}

/** heavy mesh for the geometry-bound workload */
export function subdivSphere(diameter = 1, segments = 96): MeshData {
  return sphere(diameter, segments);
}
