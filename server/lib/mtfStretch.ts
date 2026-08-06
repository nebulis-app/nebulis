// Midtone-transfer-function (MTF) autostretch, shared by the FITS and TIFF
// server-side thumbnail renderers (both decode to a linear Float32Array of
// scene values and need the same screen stretch). Mirrors the stretch in
// src/lib/fits.ts, which runs the same algorithm client-side in the browser.

export interface StretchParams { lo: number; hi: number; m: number }

const TARGET_BG = 0.25; // Siril autostretch default

function mtf(x: number, m: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return ((m - 1) * x) / ((2 * m - 1) * x - m);
}

export function computeAutoStretch(data: Float32Array, sampleRate = 8): StretchParams {
  const sampled: number[] = [];
  for (let i = 0; i < data.length; i += sampleRate) {
    const v = data[i];
    if (Number.isFinite(v)) sampled.push(v);
  }
  sampled.sort((a, b) => a - b);
  const n = sampled.length;
  if (n === 0) return { lo: 0, hi: 1, m: 0.5 };

  const min = sampled[0];
  const hi = sampled[Math.min(n - 1, Math.floor(n * 0.999))];
  const range = hi - min;
  if (range <= 0) return { lo: min, hi: min + 1, m: 0.5 };

  const median = sampled[Math.floor(n / 2)];
  const deviations = new Float64Array(n);
  for (let i = 0; i < n; i++) deviations[i] = Math.abs(sampled[i] - median);
  deviations.sort();
  const madn = 1.4826 * deviations[Math.floor(n / 2)];

  const medNorm = (median - min) / range;
  const madnNorm = madn / range;
  const c = madnNorm > 0 ? Math.max(0, medNorm - 2.8 * madnNorm) : 0;
  const xm = Math.min(1, Math.max(1e-6, (medNorm - c) / (1 - c)));

  const solveM = (x: number, target: number): number => {
    const denom = 2 * target * x - target - x;
    if (Math.abs(denom) < 1e-9) return 0.5;
    return Math.min(1 - 1e-6, Math.max(1e-6, (x * (target - 1)) / denom));
  };

  let m = solveM(xm, TARGET_BG);

  // Highlight guard: keep bright subjects like the Moon from blowing out — if
  // the 95th-percentile pixel would land above 0.85, relax the midtone so it
  // lands at 0.85 instead.
  const q95 = sampled[Math.floor(n * 0.95)];
  const brightNorm = ((q95 - min) / range - c) / (1 - c);
  if (brightNorm > 0 && brightNorm < 1 && mtf(brightNorm, m) > 0.85) {
    m = Math.max(m, solveM(brightNorm, 0.85));
  }

  return { lo: min + c * range, hi, m };
}

export function applyStretch(v: number, p: StretchParams): number {
  return mtf((v - p.lo) / (p.hi - p.lo), p.m);
}
