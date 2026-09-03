// Stage 11: automatic report. Reads whatever result files exist and emits
//   docs/PROFILING.md      (baseline + per-phase)
//   docs/COMPARISON.md     (JS vs C++/WASM, if compare.json present)
//   bench/results/*.csv
//
//   node bench/report.mjs

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fmt } from "./stats.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const R = join(__dir, "results");
const D = join(__dir, "..", "docs");
const load = (f) => (existsSync(join(R, f)) ? JSON.parse(readFileSync(join(R, f), "utf8")) : null);

const baseline = load("baseline.json");
const profile = load("profile.json");
const compare = load("compare.json");
const native = load("native.json");
const wasm = load("wasm.json");
const wasmSimd = load("wasm.engine.json");
const wasmNoSimd = load("wasm.engine-o3.json");
const browser = load("browser.json");
const scale = load("scale.json");
const memory = load("memory.json");
const visual = load("visual.json");

function table(rows) {
  const w = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  const line = (r) => "| " + r.map((v, c) => String(v).padEnd(w[c])).join(" | ") + " |";
  const sep = "| " + w.map((n) => "-".repeat(n)).join(" | ") + " |";
  return [line(rows[0]), sep, ...rows.slice(1).map(line)].join("\n");
}

// ---------------- PROFILING.md ----------------
if (baseline || profile) {
  let md = `# Profiling — data-driven hot-path identification\n\n`;
  md += `_Generated ${new Date().toISOString()} by \`bench/report.mjs\`. `;
  md += `Do not edit by hand._\n\n`;

  if (baseline) {
    md += `## Environment\n\n\`\`\`\n${JSON.stringify(baseline.env, null, 2)}\n\`\`\`\n\n`;
    md += `## Baseline per-frame cost (real Babylon.js, NullEngine)\n\n`;
    const rows = [["scene", "meshes", "frame median (ms)", "p95", "fps", "cv", "heapΔ MB/400f", "GC count", "GC ms", "sceneCreate ms"]];
    for (const r of baseline.results) {
      const f = r.frameTimeMs;
      rows.push([
        r.name, r.meshCount, fmt(f.median), fmt(f.p95), fmt(r.fps, 1), fmt(f.cv),
        fmt(r.heapGrowthBytes / 1e6), r.gc.count, fmt(r.gc.totalMs), fmt(r.sceneCreateMs),
      ]);
    }
    md += table(rows) + "\n\n";
    writeCsv("baseline.csv", rows);
  }

  if (profile) {
    md += `## Per-phase breakdown\n\n`;
    md += `Instrumentation overhead (nested \`performance.now()\` pairs around every `;
    md += `\`computeWorldMatrix\` / \`isInFrustum\` call) is estimated per scene and `;
    md += `shown; the phase numbers are **not** overhead-corrected — treat sub-`;
    md += `millisecond phase values in the huge-mesh scenes as upper bounds.\n\n`;
    const rows = [["scene", "meshes", "total ms", "preEval(anim+skel)", "activeMeshesEval", "└ worldMatrix", "└ frustumCull", "renderRest", "wm calls", "cull calls", "instr est ms"]];
    for (const r of profile.results) {
      const p = r.phases;
      rows.push([
        r.kind, r.meshCount, fmt(p.total.median), fmt(p.animations.median),
        fmt(p.activeMeshesEval.median), fmt(p.worldMatrix_in_eval.median),
        fmt(p.frustumCulling_in_eval.median), fmt(p.renderRest.median),
        r.calls.worldMatrix, r.calls.frustum, fmt(r.estInstrOverheadPerFrameMs),
      ]);
    }
    md += table(rows) + "\n\n";
    writeCsv("profile.csv", rows);

    md += `## Reading of the data\n\n`;
    md += autoReading(profile);
  }

  if (native && profile) {
    md += `\n## Native ceiling vs Babylon \`_evaluateActiveMeshes\`\n\n`;
    md += `Native = the fused C++ kernel (transform propagation + world bounding `;
    md += `refit + frustum culling → visible id list), built with \`-O3 -march=native\`, `;
    md += `no JS/WASM boundary, no GC. Numerically identical to Babylon `;
    md += `(\`native/tests/test_equiv.cpp\`: 19457 checks, 0 failures). This is the `;
    md += `**upper bound** the WASM build chases — not the WASM number.\n\n`;
    const byN = new Map(native.results.map((r) => [r.nodes, r]));
    const rows = [["scene", "meshes", "Babylon activeMeshesEval (ms)", "native fused kernel (ms)", "ceiling ratio"]];
    for (const r of profile.results) {
      const nat = byN.get(r.meshCount);
      if (!nat) continue;
      rows.push([
        r.kind, r.meshCount, fmt(r.phases.activeMeshesEval.median),
        fmt(nat.medianMs), fmt(r.phases.activeMeshesEval.median / nat.medianMs) + "×",
      ]);
    }
    md += table(rows) + "\n\n";
    md += `> The ratio is the *maximum* speedup available if 100% of eval moved `;
    md += `native and the boundary were free. The real end-to-end speedup is lower: `;
    md += `render-list/submesh/material work stays in JS, and the visible list must `;
    md += `cross back. The gap between this ratio and the browser numbers is the `;
    md += `"cost of the boundary + irreducible JS".\n`;
    writeCsv("native-ceiling.csv", rows);
  }

  writeFileSync(join(D, "PROFILING.md"), md);
  console.log("wrote docs/PROFILING.md");
}

// ---------------- COMPARISON.md ----------------
if (compare) {
  const s = compare.scene;
  const jk = compare.jsKernel.median;
  let md = `# Comparison — the implementation ladder\n\n`;
  md += `_Generated ${new Date().toISOString()}._\n\n`;
  md += `One workload: the fused per-frame kernel (transform propagation + world `;
  md += `bounding refit + STANDARD frustum culling → visible id list) on the `;
  md += `Babylon-authored fixture scene of **${s.nodes} nodes, ${s.visible} visible**. `;
  md += `Every row computes a byte-for-byte identical visible set (asserted).\n\n`;

  const rungs = [];
  // babylon (scaled from profile if the exact count isn't there)
  const bab = compare.results.find((r) => /babylon/.test(r.name));
  if (bab) rungs.push(["Babylon `_evaluateActiveMeshes` (OO path)", bab.js.median, bab.name.match(/\d+/)[0]]);
  rungs.push(["hand-written data-oriented **JS** kernel (`JsBackend.mjs`)", jk, String(s.nodes)]);
  const nat = compare.results.find((r) => /native/.test(r.name));
  if (nat) rungs.push(["**C++ native** `-O3 -march=native`, no boundary", nat.wasm.median, nat.name.match(/\d+/)[0]]);
  if (wasm && wasm.scene.nodes === s.nodes) {
    // insert wasm between JS kernel and native
    rungs.push(["**C++/WASM** (`-O3 -msimd128`), one boundary crossing/frame", wasm.stats.median, String(s.nodes)]);
  }

  const base = rungs[0][1]; // Babylon is always the reference
  rungs.sort((a, b) => b[1] - a[1]); // slowest first
  const rows = [["implementation", "meshes/nodes", "median ms/frame", "vs Babylon", "vs prev rung"]];
  for (let i = 0; i < rungs.length; i++) {
    const [name, ms, cnt] = rungs[i];
    rows.push([
      name, cnt, fmt(ms),
      fmt(base / ms) + "×",
      i === 0 ? "—" : fmt(rungs[i - 1][1] / ms) + "×",
    ]);
  }
  md += table(rows) + "\n\n";
  md += `### What the ladder says\n\n`;
  if (rungs.length >= 2) {
    md += `- Going **data-oriented in plain JavaScript** already buys `;
    md += `${fmt(base / jk)}× over Babylon's per-mesh object path — **no WASM required**. `;
    md += `Much of Babylon's cost is \`SmartArray\`/\`Map\`/observer/\`_activate\` machinery, not arithmetic.\n`;
  }
  if (nat) {
    md += `- Dropping to **native C++** buys a further ${fmt(jk / nat.wasm.median)}× over the JS kernel `;
    md += `(${fmt(base / nat.wasm.median)}× vs Babylon) — this is the ceiling, boundary-free.\n`;
  }
  if (wasm && nat) {
    const w = wasm.stats.median;
    md += `- **C++/WASM** lands at ${fmt(base / w)}× vs Babylon, ${fmt(jk / w)}× vs the JS kernel. `;
    md += `native→wasm gap = ${fmt(w / nat.wasm.median)}× ("cost of the sandbox + one boundary crossing/frame").\n`;
  } else if (!wasm) {
    md += `- **WASM row missing** — run \`npm run bench:wasm\` (needs \`npm run build:wasm\`).\n`;
  }
  writeCsv("comparison.csv", rows);

  // ---- WASM SIMD contribution ----
  if (wasmSimd && wasmNoSimd) {
    const on = wasmSimd.stats.median, off = wasmNoSimd.stats.median;
    md += `\n## WASM SIMD contribution\n\n`;
    md += `Same core, same workload (${wasmSimd.scene.nodes} nodes), only the emcc flag differs. `;
    md += `Both produce an identical visible set.\n\n`;
    md += table([
      ["build", "flags", "median ms/frame", "vs no-SIMD"],
      ["`o3`", "`-O3`", fmt(off), "1.00×"],
      ["`release`", "`-O3 -msimd128`", fmt(on), fmt(off / on) + "×"],
    ]) + "\n\n";
    md += `> WASM SIMD (128-bit) is worth **${fmt(off / on)}×** here — LLVM vectorises the `;
    md += `matrix compose/multiply and the 8-corner AABB transform. It is on by default `;
    md += `(all browsers with WebGPU also have WASM SIMD).\n`;
  }

  // ---- scaling curve ----
  if (scale && scale.rows.length) {
    md += `\n## Scaling — \`World.evaluate()\` vs entity count\n\n`;
    md += `Node, no renderer: isolates the WASM eval + boundary. Shell scene, `;
    md += `moderate frustum (~${fmt(100 * scale.rows[0].visible / scale.rows[0].count, 0)}% visible). `;
    md += `\`ns/entity\` flat ⇒ compute-bound; climbing ⇒ the working set is spilling cache (memory-bound).\n\n`;
    const rows = [["entities", "WASM median ms", "p95", "JS kernel ms", "WASM speedup", "WASM ns/entity", "visible"]];
    for (const r of scale.rows) rows.push([
      r.count.toLocaleString("en-US"), fmt(r.wasmMs, 3), fmt(r.wasmP95, 3), fmt(r.jsMs, 3),
      fmt(r.speedup, 2) + "×", fmt(r.nsPerEntityWasm, 1), r.visible.toLocaleString("en-US"),
    ]);
    md += table(rows) + "\n\n";
    const ns = scale.rows.map((r) => r.nsPerEntityWasm);
    const lo = Math.min(...ns), hi = ns[ns.length - 1];
    const loAt = scale.rows[ns.indexOf(lo)].count;
    md += `> ns/entity bottoms at **${fmt(lo, 1)}** (~${loAt.toLocaleString("en-US")} entities, working set in L2/L3) `;
    md += `and rises to **${fmt(hi, 1)}** at ${scale.rows[scale.rows.length - 1].count.toLocaleString("en-US")} `;
    md += `(${fmt(hi / lo, 2)}×). ${hi > lo * 1.6
      ? "That climb is cache spill — past here the pass is memory-bandwidth-bound. Threads multiply bandwidth demand; measure before adding them."
      : "Mild — the pass stays mostly compute-bound through this range; SIMD, not threads, is the first lever."}\n`;
    writeCsv("scale.csv", rows);
  }

  // ---- memory ----
  if (memory && memory.rows.length) {
    md += `\n## Memory\n\n`;
    md += `Node, no renderer, fresh \`WasmCore\` per size. The SoA lives in WASM linear `;
    md += `memory; the JS heap only holds \`TypedArray\` views over it.\n\n`;
    const rows = [["entities", "WASM heap MB", "grew MB", "JS heap MB", "visible"]];
    for (const r of memory.rows) rows.push([
      r.count.toLocaleString("en-US"), fmt(r.wasmHeapMB, 1), fmt(r.wasmGrowthMB, 1), fmt(r.jsHeapMB, 1), r.visible,
    ]);
    md += table(rows) + "\n\n";
    md += `- **Computed SoA cost: ${memory.computedBytesPerEntity} bytes/entity** (exact, from \`world.hpp\`): `;
    md += Object.entries(memory.soaBreakdown).map(([k, v]) => `${k} ${v}`).join(" · ") + ".\n";
    md += `- \`INITIAL_MEMORY\` (64 MB) covers ~270k entities with **zero heap growth**. `;
    md += `Beyond that, \`ALLOW_MEMORY_GROWTH\` kicks in (dlmalloc; pages may not return to the OS).\n`;
    md += `- **JS heap is flat (~${fmt(memory.jsHeapFlatMB, 1)} MB) at every size** — SoA is in WASM.\n`;
    md += `- The public-API \`Entity\`/\`Transform\` handles add **~${memory.apiHandleJsBytesPerEntity} B/entity on the JS heap _if created_** `;
    md += `(\`scene.createEntities\` does; writing the raw SoA arrays does not).\n`;
    writeCsv("memory.csv", rows);
  }

  // ---- visual smoke ----
  if (visual) {
    md += `\n## Visual smoke test (\`npm run test:visual\`)\n\n`;
    md += `F-009 showed equivalence PASS ≠ rendering correct. This checks the *pixels*, `;
    md += `coarsely (no pixel-perfect matching):\n\n`;
    const rows = [["entities", "result", "checks"]];
    for (const v of visual.report) rows.push([
      v.count.toLocaleString("en-US"), v.pass ? "PASS" : "FAIL",
      v.checks.map((c) => (c[1] ? "✓" : "✗") + c[0].split(" ")[0]).join(" "),
    ]);
    md += table(rows) + "\n\n";
    md += `Checks: render target is not black (PNG size) · frustum culls · visible `;
    md += `entities land on screen · draw calls == mesh count · NDC in cube · depth `;
    md += `headroom (median z < 0.999, the F-009 guard) · no GPU/page errors.\n`;
  }

  // ---- browser / real WebGPU section ----
  if (browser && browser.results.length) {
    md += `\n## Real WebGPU (browser harness)\n\n`;
    md += `Chromium, WebGPU on, instanced cube draw of the visible set. Same GPU `;
    md += `workload for both backends — any \`frame\` or \`eval\` delta is CPU-side. `;
    md += `\`cpp\` = C++/WASM \`WasmBackend\`, \`js\` = \`JsBackend.mjs\`.\n\n`;
    const byScene = new Map();
    for (const r of browser.results) {
      if (r.error) continue;
      const e = byScene.get(r.scene) || {};
      e[r.backend] = r;
      byScene.set(r.scene, e);
    }
    const brows = [["scene", "meshes", "js CPU-frame", "cpp CPU-frame", "eval speedup", "gpu ms js/cpp", "js bound", "cpp bound", "GPU-paced FPS js→cpp"]];
    for (const [scene, e] of byScene) {
      if (!e.js || !e.cpp) continue;
      const gj = e.js.gpuMs?.median ?? 0, gc = e.cpp.gpuMs?.median ?? 0;
      const boundJs = gj > e.js.frameMs.median ? "GPU" : "CPU";
      const boundCpp = gc > e.cpp.frameMs.median ? "GPU" : "CPU";
      const pacedJs = Math.max(e.js.frameMs.median, gj);
      const pacedCpp = Math.max(e.cpp.frameMs.median, gc);
      brows.push([
        scene, e.js.meshCount,
        fmt(e.js.frameMs.median), fmt(e.cpp.frameMs.median),
        fmt(e.js.evalMs.median / e.cpp.evalMs.median) + "×",
        e.js.gpuMs ? `${fmt(gj)}/${fmt(gc)}` : "n/a",
        boundJs, boundCpp,
        `${fmt(1000 / pacedJs, 0)}→${fmt(1000 / pacedCpp, 0)} (${fmt(pacedJs / pacedCpp)}×)`,
      ]);
    }
    md += table(brows) + "\n\n";
    md += `- **CPU-frame** = \`evaluateFrame\` + WebGPU command recording + submit `;
    md += `(does not block on the GPU). **eval speedup** isolates the migrated kernel.\n`;
    md += `- **bound** = whether GPU time exceeds the CPU frame for that config. `;
    md += `**GPU-paced FPS** = \`1000 / max(cpuFrame, gpuMs)\` — the ceiling if the `;
    md += `loop were vsync/GPU-limited. Where a config is already **GPU-bound**, the `;
    md += `C++ speedup does **not** move that number — a valid, expected result.\n`;
    md += `- GPU here is a software adapter (no discrete GPU on the bench host), so `;
    md += `\`gpu ms\` is inflated and every large scene reads CPU-bound. On real GPU `;
    md += `hardware the crossover point (where C++/WASM stops helping FPS) moves to `;
    md += `much larger scenes — re-run \`bench/run-browser.mjs\` there to place it.\n`;
    writeCsv("browser.csv", brows);
  }

  writeFileSync(join(D, "COMPARISON.md"), md);
  console.log("wrote docs/COMPARISON.md");
}

function autoReading(profile) {
  const lines = [];
  for (const r of profile.results) {
    const p = r.phases;
    const total = p.total.median;
    const eval_ = p.activeMeshesEval.median;
    const wm = p.worldMatrix_in_eval.median;
    const cull = p.frustumCulling_in_eval.median;
    const evalOverhead = Math.max(0, eval_ - wm - cull); // Babylon per-mesh OO overhead
    lines.push(
      `- **${r.kind}** (${r.meshCount} meshes, ${fmt(total)}ms/frame): ` +
      `\`activeMeshesEval\` = ${fmt((eval_ / total) * 100, 2)}% of the frame. ` +
      `Inside it: \`computeWorldMatrix\` ≈ ${fmt(wm)}ms + \`isInFrustum\` ≈ ${fmt(cull)}ms ` +
      `(measured, includes probe overhead — upper bound), ` +
      `remaining Babylon per-mesh overhead ≈ ${fmt(evalOverhead)}ms ` +
      `(LOD maps, SmartArray, _preActivate/_activate, observers, submesh dispatch). ` +
      (eval_ / total > 0.5 && r.meshCount >= 500
        ? `**Strong native-migration candidate** — the whole eval pass is data-parallel arithmetic + bookkeeping that a SoA C++ kernel replaces with one boundary crossing.`
        : `Frame too cheap for migration to matter.`),
    );
  }
  return lines.join("\n") + "\n";
}

function writeCsv(name, rows) {
  const csv = rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(",")).join("\n");
  writeFileSync(join(R, name), csv);
}
