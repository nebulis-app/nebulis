/** The editor's three Adjust sliders, each -100…+100 (0 = unchanged). */
export interface AutoAdjustment {
  brightness: number;
  contrast: number;
  saturation: number;
}

/** Where the sky background and the brightest real signal should land after the adjustment (0-1). */
const TARGET_BLACK = 0.04;
const TARGET_WHITE = 0.97;
/** Average colourfulness of the mid-tones we aim for (HSV saturation, 0-1). */
const TARGET_SATURATION = 0.3;
/** Never push contrast past this slider value; a harder stretch clips the galaxy core. */
const MAX_CONTRAST = 60;
const MIN_CONTRAST = -30;
const MAX_SATURATION = 60;
const MIN_SATURATION = -20;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Value at the given fraction (0-1) of a 256-bin histogram holding `total` samples. */
function percentile(hist: Uint32Array, total: number, fraction: number): number {
  const goal = total * fraction;
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    seen += hist[i];
    if (seen >= goal) return i / 255;
  }
  return 1;
}

/**
 * Works out slider values for a picture from its RGBA pixels, matching the maths in
 * the editor's `applyPixelAdjustments` (brightness added, then saturation, then
 * contrast about 0.5).
 *
 * Contrast and brightness stretch the range between the sky background (0.5th
 * percentile of brightness) and the bright end (99.8th, past the star tips) onto
 * 0.04…0.97, so a dull, grey-looking stack gains depth while the sky stays dark.
 * Saturation nudges the mid-tones toward a typical colourfulness. Returns zeros for a
 * picture with nothing to measure (blank, or a single flat colour).
 */
export function computeAutoAdjust(data: Uint8ClampedArray): AutoAdjustment {
  const lumHist = new Uint32Array(256);
  let samples = 0;
  let satSum = 0;
  let satCount = 0;

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    lumHist[lum]++;
    samples++;
    // Mid-tones only: sky noise and clipped star cores have meaningless colour.
    if (lum > 30 && lum < 220) {
      const max = Math.max(r, g, b);
      satSum += (max - Math.min(r, g, b)) / max;
      satCount++;
    }
  }
  if (samples === 0) return { brightness: 0, contrast: 0, saturation: 0 };

  const lo = percentile(lumHist, samples, 0.005);
  const hi = percentile(lumHist, samples, 0.998);
  let brightness = 0;
  let contrast = 0;
  if (hi - lo > 0.05) {
    const scale = clamp((TARGET_WHITE - TARGET_BLACK) / (hi - lo), 1 + MIN_CONTRAST / 100, 1 + MAX_CONTRAST / 100);
    // out = scale * (in + br - 0.5) + 0.5, so moving `lo` onto TARGET_BLACK fixes br.
    const br = (TARGET_BLACK - 0.5) / scale + 0.5 - lo;
    contrast = Math.round((scale - 1) * 100);
    brightness = Math.round(clamp(br, -0.5, 0.5) * 100);
  }

  let saturation = 0;
  if (satCount > samples * 0.02) {
    const factor = TARGET_SATURATION / Math.max(satSum / satCount, 0.01);
    saturation = Math.round(clamp((factor - 1) * 100, MIN_SATURATION, MAX_SATURATION));
  }

  return { brightness, contrast, saturation };
}
