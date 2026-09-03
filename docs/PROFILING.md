# Profiling — data-driven hot-path identification

_Generated 2026-09-03T00:01:59.931Z by `bench/report.mjs`. Do not edit by hand._

## Environment

```
{
  "node": "v22.19.0",
  "platform": "win32",
  "arch": "x64",
  "cpus": "Intel(R) Xeon(R) CPU E5-2620 v3 @ 2.40GHz",
  "date": "2026-09-02T21:14:40.531Z",
  "gc": true
}
```

## Baseline per-frame cost (real Babylon.js, NullEngine)

| scene          | meshes | frame median (ms) | p95    | fps   | cv     | heapΔ MB/400f | GC count | GC ms  | sceneCreate ms |
| -------------- | ------ | ----------------- | ------ | ----- | ------ | ------------- | -------- | ------ | -------------- |
| small          | 50     | 0.236             | 0.446  | 4237  | 0.387  | 2.733         | 3        | 58.542 | 253.511        |
| medium         | 800    | 1.065             | 1.099  | 938.7 | 0.0833 | 11.945        | 0        | 0      | 472.673        |
| manyObjects    | 7000   | 14.229            | 14.561 | 70.3  | 0.0342 | 11.177        | 3        | 17.117 | 1063           |
| heavyGeometry  | 60     | 0.436             | 0.464  | 2294  | 0.132  | 2.351         | 0        | 0      | 4617           |
| manyAnimations | 2500   | 5.872             | 5.961  | 170.3 | 0.0644 | -0.0541       | 6        | 8.131  | 1067           |
| manyVisible    | 6000   | 18.827            | 20.330 | 53.1  | 0.0702 | 1.081         | 48       | 70.843 | 1156           |
| heavyCulling   | 7000   | 12.639            | 16.817 | 79.1  | 0.176  | 8.031         | 0        | 0      | 1407           |
| gpuBound       | 200    | 0.595             | 0.662  | 1681  | 0.0696 | 7.512         | 0        | 0      | 972.723        |
| cpuBound       | 5000   | 10.769            | 11.484 | 92.9  | 0.0389 | -0.369        | 6        | 10.773 | 1354           |

## Per-phase breakdown

Instrumentation overhead (nested `performance.now()` pairs around every `computeWorldMatrix` / `isInFrustum` call) is estimated per scene and shown; the phase numbers are **not** overhead-corrected — treat sub-millisecond phase values in the huge-mesh scenes as upper bounds.

| scene          | meshes | total ms | preEval(anim+skel) | activeMeshesEval | └ worldMatrix | └ frustumCull | renderRest | wm calls | cull calls | instr est ms |
| -------------- | ------ | -------- | ------------------ | ---------------- | ------------- | ------------- | ---------- | -------- | ---------- | ------------ |
| small          | 50     | 0.287    | 0.0326             | 0.230            | 0.0395        | 0.0234        | 0.0189     | 50       | 50         | 0.0521       |
| medium         | 800    | 1.837    | 0.0390             | 1.774            | 0.287         | 0.363         | 0.0250     | 800      | 800        | 1.123        |
| manyObjects    | 7000   | 25.794   | 0.0792             | 25.653           | 4.028         | 5.663         | 0.0546     | 7000     | 7000       | 11.174       |
| heavyGeometry  | 60     | 0.278    | 0.0301             | 0.228            | 0.0317        | 0.0390        | 0.0183     | 60       | 60         | 0.0692       |
| manyAnimations | 2500   | 10.173   | 0.0716             | 10.041           | 1.544         | 2.156         | 0.0548     | 2500     | 2500       | 1.678        |
| manyVisible    | 6000   | 25.547   | 0.0702             | 25.416           | 3.250         | 4.647         | 0.0565     | 6000     | 6000       | 5.167        |
| heavyCulling   | 7000   | 24.334   | 0.0400             | 24.236           | 3.965         | 5.647         | 0.0523     | 7000     | 7000       | 5.375        |
| gpuBound       | 200    | 0.475    | 0.0106             | 0.450            | 0.0603        | 0.0805        | 0.0139     | 200      | 200        | 0.176        |
| cpuBound       | 5000   | 16.671   | 0.0240             | 16.612           | 2.878         | 3.792         | 0.0343     | 5000     | 5000       | 7.086        |

## Reading of the data

- **small** (50 meshes, 0.287ms/frame): `activeMeshesEval` = 79.95% of the frame. Inside it: `computeWorldMatrix` ≈ 0.0395ms + `isInFrustum` ≈ 0.0234ms (measured, includes probe overhead — upper bound), remaining Babylon per-mesh overhead ≈ 0.167ms (LOD maps, SmartArray, _preActivate/_activate, observers, submesh dispatch). Frame too cheap for migration to matter.
- **medium** (800 meshes, 1.837ms/frame): `activeMeshesEval` = 96.57% of the frame. Inside it: `computeWorldMatrix` ≈ 0.287ms + `isInFrustum` ≈ 0.363ms (measured, includes probe overhead — upper bound), remaining Babylon per-mesh overhead ≈ 1.124ms (LOD maps, SmartArray, _preActivate/_activate, observers, submesh dispatch). **Strong native-migration candidate** — the whole eval pass is data-parallel arithmetic + bookkeeping that a SoA C++ kernel replaces with one boundary crossing.
- **manyObjects** (7000 meshes, 25.794ms/frame): `activeMeshesEval` = 99.45% of the frame. Inside it: `computeWorldMatrix` ≈ 4.028ms + `isInFrustum` ≈ 5.663ms (measured, includes probe overhead — upper bound), remaining Babylon per-mesh overhead ≈ 15.962ms (LOD maps, SmartArray, _preActivate/_activate, observers, submesh dispatch). **Strong native-migration candidate** — the whole eval pass is data-parallel arithmetic + bookkeeping that a SoA C++ kernel replaces with one boundary crossing.
- **heavyGeometry** (60 meshes, 0.278ms/frame): `activeMeshesEval` = 81.88% of the frame. Inside it: `computeWorldMatrix` ≈ 0.0317ms + `isInFrustum` ≈ 0.0390ms (measured, includes probe overhead — upper bound), remaining Babylon per-mesh overhead ≈ 0.157ms (LOD maps, SmartArray, _preActivate/_activate, observers, submesh dispatch). Frame too cheap for migration to matter.
- **manyAnimations** (2500 meshes, 10.173ms/frame): `activeMeshesEval` = 98.70% of the frame. Inside it: `computeWorldMatrix` ≈ 1.544ms + `isInFrustum` ≈ 2.156ms (measured, includes probe overhead — upper bound), remaining Babylon per-mesh overhead ≈ 6.341ms (LOD maps, SmartArray, _preActivate/_activate, observers, submesh dispatch). **Strong native-migration candidate** — the whole eval pass is data-parallel arithmetic + bookkeeping that a SoA C++ kernel replaces with one boundary crossing.
- **manyVisible** (6000 meshes, 25.547ms/frame): `activeMeshesEval` = 99.49% of the frame. Inside it: `computeWorldMatrix` ≈ 3.250ms + `isInFrustum` ≈ 4.647ms (measured, includes probe overhead — upper bound), remaining Babylon per-mesh overhead ≈ 17.519ms (LOD maps, SmartArray, _preActivate/_activate, observers, submesh dispatch). **Strong native-migration candidate** — the whole eval pass is data-parallel arithmetic + bookkeeping that a SoA C++ kernel replaces with one boundary crossing.
- **heavyCulling** (7000 meshes, 24.334ms/frame): `activeMeshesEval` = 99.60% of the frame. Inside it: `computeWorldMatrix` ≈ 3.965ms + `isInFrustum` ≈ 5.647ms (measured, includes probe overhead — upper bound), remaining Babylon per-mesh overhead ≈ 14.623ms (LOD maps, SmartArray, _preActivate/_activate, observers, submesh dispatch). **Strong native-migration candidate** — the whole eval pass is data-parallel arithmetic + bookkeeping that a SoA C++ kernel replaces with one boundary crossing.
- **gpuBound** (200 meshes, 0.475ms/frame): `activeMeshesEval` = 94.86% of the frame. Inside it: `computeWorldMatrix` ≈ 0.0603ms + `isInFrustum` ≈ 0.0805ms (measured, includes probe overhead — upper bound), remaining Babylon per-mesh overhead ≈ 0.309ms (LOD maps, SmartArray, _preActivate/_activate, observers, submesh dispatch). Frame too cheap for migration to matter.
- **cpuBound** (5000 meshes, 16.671ms/frame): `activeMeshesEval` = 99.65% of the frame. Inside it: `computeWorldMatrix` ≈ 2.878ms + `isInFrustum` ≈ 3.792ms (measured, includes probe overhead — upper bound), remaining Babylon per-mesh overhead ≈ 9.941ms (LOD maps, SmartArray, _preActivate/_activate, observers, submesh dispatch). **Strong native-migration candidate** — the whole eval pass is data-parallel arithmetic + bookkeeping that a SoA C++ kernel replaces with one boundary crossing.

## Native ceiling vs Babylon `_evaluateActiveMeshes`

Native = the fused C++ kernel (transform propagation + world bounding refit + frustum culling → visible id list), built with `-O3 -march=native`, no JS/WASM boundary, no GC. Numerically identical to Babylon (`native/tests/test_equiv.cpp`: 19457 checks, 0 failures). This is the **upper bound** the WASM build chases — not the WASM number.

| scene          | meshes | Babylon activeMeshesEval (ms) | native fused kernel (ms) | ceiling ratio |
| -------------- | ------ | ----------------------------- | ------------------------ | ------------- |
| medium         | 800    | 1.774                         | 0.305                    | 5.809×        |
| manyObjects    | 7000   | 25.653                        | 2.275                    | 11.274×       |
| manyAnimations | 2500   | 10.041                        | 1.004                    | 9.997×        |
| manyVisible    | 6000   | 25.416                        | 1.835                    | 13.850×       |
| heavyCulling   | 7000   | 24.236                        | 2.275                    | 10.651×       |
| cpuBound       | 5000   | 16.612                        | 1.535                    | 10.821×       |

> The ratio is the *maximum* speedup available if 100% of eval moved native and the boundary were free. The real end-to-end speedup is lower: render-list/submesh/material work stays in JS, and the visible list must cross back. The gap between this ratio and the browser numbers is the "cost of the boundary + irreducible JS".
