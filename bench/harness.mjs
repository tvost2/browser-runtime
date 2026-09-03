// Generic benchmark harness: warmup + N timed runs of a per-frame callback,
// with memory + GC sampling. Backend-agnostic.

import { performance, PerformanceObserver, constants as PERF } from "node:perf_hooks";
import { summarize } from "./stats.mjs";

const hasGc = typeof globalThis.gc === "function";

// --- process-wide GC instrumentation ---
const gcTotals = { count: 0, totalMs: 0, byKind: Object.create(null) };
let gcObserverStarted = false;
export function enableGcObserver() {
  if (gcObserverStarted) return;
  gcObserverStarted = true;
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      gcTotals.count++;
      gcTotals.totalMs += e.duration;
      const k = gcKindName(e.detail?.kind ?? e.kind);
      gcTotals.byKind[k] = (gcTotals.byKind[k] || 0) + 1;
    }
  });
  obs.observe({ entryTypes: ["gc"] });
}
function gcKindName(kind) {
  switch (kind) {
    case PERF.NODE_PERFORMANCE_GC_MAJOR: return "major";
    case PERF.NODE_PERFORMANCE_GC_MINOR: return "minor";
    case PERF.NODE_PERFORMANCE_GC_INCREMENTAL: return "incremental";
    case PERF.NODE_PERFORMANCE_GC_WEAKCB: return "weakcb";
    default: return "other";
  }
}
function snapshotGc() {
  return { count: gcTotals.count, totalMs: gcTotals.totalMs, byKind: { ...gcTotals.byKind } };
}
function diffGc(a, b) {
  const byKind = {};
  for (const k of new Set([...Object.keys(a.byKind), ...Object.keys(b.byKind)])) {
    byKind[k] = (b.byKind[k] || 0) - (a.byKind[k] || 0);
  }
  return { count: b.count - a.count, totalMs: b.totalMs - a.totalMs, byKind };
}

function mem() {
  const m = process.memoryUsage();
  return { rss: m.rss, heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers };
}
function median(arr) {
  const s = [...arr].sort((x, y) => x - y);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
}

/**
 * @param {object} opts
 * @param {string}                       opts.name
 * @param {() => (any|Promise<any>)}      opts.setup
 * @param {(ctx:any) => void}             opts.frame
 * @param {(ctx:any) => void}            [opts.teardown]
 * @param {number} [opts.warmupFrames=120]
 * @param {number} [opts.measureFrames=600]
 * @param {number} [opts.repeats=5]
 */
export async function runBenchmark(opts) {
  const {
    name, setup, frame, teardown,
    warmupFrames = 120, measureFrames = 600, repeats = 5,
  } = opts;

  enableGcObserver();
  const cycles = [];

  for (let r = 0; r < repeats; r++) {
    const ctx = await setup();
    for (let i = 0; i < warmupFrames; i++) frame(ctx);

    if (hasGc) { globalThis.gc(); globalThis.gc(); }
    await new Promise((res) => setTimeout(res, 0)); // flush GC observer
    const memBefore = mem();
    const gcBefore = snapshotGc();

    const samples = new Float64Array(measureFrames);
    const tStart = performance.now();
    for (let i = 0; i < measureFrames; i++) {
      const a = performance.now();
      frame(ctx);
      samples[i] = performance.now() - a;
    }
    const wall = performance.now() - tStart;

    await new Promise((res) => setTimeout(res, 0));
    const memAfter = mem();
    const gcAfter = snapshotGc();

    if (teardown) teardown(ctx);
    if (hasGc) { globalThis.gc(); globalThis.gc(); }

    const fs = summarize(Array.from(samples));
    cycles.push({
      frameStats: fs,
      fps: 1000 / fs.median,
      wallMs: wall,
      heapGrowthBytes: memAfter.heapUsed - memBefore.heapUsed,
      externalGrowthBytes: memAfter.external - memBefore.external,
      gc: diffGc(gcBefore, gcAfter),
    });
  }

  const agg = summarize(cycles.map((c) => c.frameStats.median));
  return {
    name, warmupFrames, measureFrames, repeats,
    perCycle: cycles,
    frameTimeMs: agg,
    fps: 1000 / agg.median,
    heapGrowthBytes: median(cycles.map((c) => c.heapGrowthBytes)),
    externalGrowthBytes: median(cycles.map((c) => c.externalGrowthBytes)),
    gc: diffGc(
      { count: 0, totalMs: 0, byKind: {} },
      cycles.reduce(
        (acc, c) => ({
          count: acc.count + c.gc.count,
          totalMs: acc.totalMs + c.gc.totalMs,
          byKind: mergeAdd(acc.byKind, c.gc.byKind),
        }),
        { count: 0, totalMs: 0, byKind: {} },
      ),
    ),
    gcAvailable: hasGc,
  };
}

function mergeAdd(a, b) {
  const o = { ...a };
  for (const k of Object.keys(b)) o[k] = (o[k] || 0) + b[k];
  return o;
}
