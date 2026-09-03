// Summary statistics for benchmark samples. No dependencies.

export function summarize(samplesMs) {
  const s = [...samplesMs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return { n: 0 };
  const sum = s.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const q = (p) => {
    const idx = (n - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return s[lo] + (s[hi] - s[lo]) * (idx - lo);
  };
  return {
    n,
    min: s[0],
    max: s[n - 1],
    mean,
    median: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    stddev: Math.sqrt(variance),
    cv: Math.sqrt(variance) / mean, // coefficient of variation
  };
}

export function speedup(jsSummary, wasmSummary) {
  // >1 means wasm is faster
  return jsSummary.median / wasmSummary.median;
}

export function fmt(x, digits = 3) {
  if (x == null || Number.isNaN(x)) return "-";
  if (x === 0) return "0";
  const abs = Math.abs(x);
  if (abs >= 1000) return x.toFixed(0);
  if (abs >= 1) return x.toFixed(digits);
  return x.toPrecision(digits);
}
