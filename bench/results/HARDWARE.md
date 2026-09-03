# Benchmark host — v0.1.0 reference numbers

Every `*.json` in this directory was produced on this machine. **Absolute
milliseconds are specific to it; only the ratios transfer.**

| | |
|---|---|
| CPU | Intel Xeon E5-2620 v3 @ 2.40 GHz (2014, Haswell-EP, 6C/12T) |
| RAM | (dev workstation) |
| GPU | **none discrete** — WebGPU runs on the Microsoft WARP software rasteriser |
| OS | Windows 10 Pro 19045 |
| Node | v22.19.0 |
| Emscripten | 6.0.9 (clang 21) |
| C++ (native tests/ceiling) | g++ 16.1.0 (MinGW-w64 UCRT) |
| Browser | Chromium via Playwright 1.62, flags: `--enable-unsafe-webgpu --enable-features=Vulkan,WebGPU --use-angle=default --ignore-gpu-blocklist --disable-dawn-features=use_dxc` |
| Bench scale | `BCPP_SCALE=0.5` for `bench:browser` (halves the workload counts); `1` elsewhere |

## Consequences

- A modern laptop (2020+) runs the CPU kernels **~3× faster** in absolute terms.
- WebGPU numbers here are **software-rasteriser** numbers — `gpu ms` is inflated
  10–50×, so every large browser scene reads CPU-bound. On real GPU hardware the
  point where the GPU becomes the bottleneck (and C++/WASM stops helping FPS)
  moves to a much larger entity count. Re-run `npm run bench:browser` with
  `BCPP_GPU=hw` on a real GPU to place that crossover for your hardware.
- `timestamp-query` support varies; `gpuMs` is `null` when unavailable.
- Run-to-run CV on the CPU kernels is ~0.2–0.35 (an old, noisy, shared box).
  Medians over 3000 frames are stable to ~±10%.

## Regenerate everything

```bash
npm run build
npm run test:equivalence && npm run test:visual
npm run bench:compare && npm run bench:scale && npm run bench:memory
npm run build:wasm:nosimd && npm run bench:wasm -- --profile engine-o3
npm run bench:native
npm run bench:browser
npm run setup:reference && npm run bench:baseline && npm run analyze
npm run report
```
