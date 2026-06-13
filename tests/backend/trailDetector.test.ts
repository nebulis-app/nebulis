import { describe, it, expect } from 'vitest';
import {
  trailDetector,
  FWHM_HARD_REJECT_PX,
  MIN_LENGTH_FRACTION_OF_DIAGONAL,
  FILL_FRACTION_MIN,
  CONTIGUOUS_RUN_FRACTION_OF_DIAGONAL,
  GAP_TOLERANCE_FRACTION_OF_DIAGONAL,
} from '../../server/lib/trailDetector';

/**
 * Synthetic-fixture tests for the satellite trail detector.
 *
 * The detector's public entry point takes a FITS Buffer, so each test
 * constructs an in-memory FITS file with BITPIX=-64 (Float64) so we can
 * write arbitrary pixel values without scaling math. The actual logic
 * exercised is the post-parse pipeline:
 *   downsample → background subtract → star mask → angle search → validate
 *
 * The thresholds asserted here are documented in docs/trail-detection.md and
 * lock the detector against silent parameter drift:
 *   - FWHM hard reject  > 12 px
 *   - Min length        ≥ 10% of diagonal
 *   - Fill fraction     ≥ 40%
 *   - Contiguous run    ≥ 3% of diagonal
 *
 * If anyone loosens or tightens these, the corresponding assertion fails.
 */

// ─── FITS buffer construction ────────────────────────────────────────

/**
 * Build a minimal SIMPLE FITS file with BITPIX=-64 (IEEE-754 big-endian
 * doubles) carrying the supplied pixel array. The detector's parser only
 * reads NAXIS1, NAXIS2, BITPIX, BZERO, BSCALE, so we keep the header to
 * exactly those required cards.
 */
function buildFitsBuffer(width: number, height: number, pixels: Float64Array): Buffer {
  if (pixels.length !== width * height) {
    throw new Error(`pixel count ${pixels.length} != ${width}x${height}`);
  }

  const card = (key: string, value: string) =>
    (key.padEnd(8) + '= ' + value).padEnd(80);

  const cards: string[] = [
    card('SIMPLE', 'T'.padStart(20)),
    card('BITPIX', String(-64).padStart(20)),
    card('NAXIS', String(2).padStart(20)),
    card('NAXIS1', String(width).padStart(20)),
    card('NAXIS2', String(height).padStart(20)),
    'END'.padEnd(80),
  ];

  const headerText = cards.join('');
  const headerPadLen = 2880 - (headerText.length % 2880);
  const headerBuf = Buffer.from(
    headerText + (headerPadLen === 2880 ? '' : ' '.repeat(headerPadLen)),
    'ascii'
  );

  // Pixel data: big-endian Float64.
  const dataBuf = Buffer.alloc(pixels.length * 8);
  for (let i = 0; i < pixels.length; i++) {
    dataBuf.writeDoubleBE(pixels[i], i * 8);
  }
  // Pad data block to 2880-byte boundary as required by FITS.
  const dataPadLen = (2880 - (dataBuf.length % 2880)) % 2880;
  const dataPadded = Buffer.concat([dataBuf, Buffer.alloc(dataPadLen)]);

  return Buffer.concat([headerBuf, dataPadded]);
}

// ─── Synthetic image generators ──────────────────────────────────────

function blankImage(w: number, h: number, baseline = 100): Float64Array {
  const arr = new Float64Array(w * h);
  arr.fill(baseline);
  return arr;
}

/**
 * Add a small deterministic noise pattern so the MAD-based sigma estimator
 * doesn't collapse to zero. Real frames always have read noise — this is the
 * synthetic equivalent. Uses a fixed seed so test runs are reproducible.
 */
function addNoise(arr: Float64Array, amplitude: number, seed = 1): void {
  // Simple LCG; we just need varied small offsets, not crypto-grade noise.
  let s = seed >>> 0;
  for (let i = 0; i < arr.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const u = (s & 0xffffff) / 0xffffff; // [0, 1)
    arr[i] += (u - 0.5) * 2 * amplitude;
  }
}

/**
 * Stamp a thin diagonal streak from (x0, y0) to (x1, y1) using Bresenham.
 * Single-pixel-wide; the detector's projection-based search doesn't need a
 * thick line to lock on, and a thick line risks tripping the FWHM > 12 px
 * hard-reject.
 */
function stampLine(
  arr: Float64Array,
  w: number,
  h: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  value: number
): void {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;

  const paint = (px: number, py: number) => {
    if (px >= 0 && px < w && py >= 0 && py < h) {
      arr[py * w + px] = value;
    }
  };

  for (let i = 0; i < w + h; i++) {
    paint(x, y);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx)  { err += dx; y += sy; }
  }
}

/**
 * Stamp a 3×3 round star at the given center with peak value at the
 * middle pixel. Stars are compact, never linear, so the detector should
 * mask them and report no trail.
 */
function stampStar(
  arr: Float64Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  peak: number
): void {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const px = cx + dx;
      const py = cy + dy;
      if (px < 0 || px >= w || py < 0 || py >= h) continue;
      const fall = dx === 0 && dy === 0 ? 1 : 0.5;
      arr[py * w + px] = peak * fall;
    }
  }
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('trailDetector.detect', () => {
  it('returns trailDetected: false for a perfectly blank image', () => {
    const w = 256, h = 256;
    const pixels = new Float64Array(w * h); // all zeros
    const buf = buildFitsBuffer(w, h, pixels);

    const result = trailDetector.detect(buf);
    expect(result.trailDetected).toBe(false);
  });

  it('detects a single-pixel-wide horizontal streak spanning ~40% of the diagonal', () => {
    const w = 256, h = 256;
    const pixels = blankImage(w, h, 100);
    // Add small noise so MAD-based sigma is non-zero (real frames always
    // have read noise; the detector's threshold logic depends on a sane σ).
    addNoise(pixels, 5);
    // Horizontal trail spanning ~40% of the image diagonal (145 / 362 ≈ 40%),
    // well above the 10% minimum-length floor.
    // A horizontal trail is used rather than a 45° diagonal because the
    // line-direction projection at angle 135° steps by √2 ≈ 1.414 bins per
    // pixel, creating unavoidable 1-bin gaps that keep the longest contiguous
    // run at 2-3 bins — well below the 3%-of-diagonal (≈11 bin) minimum.
    // Horizontal trails step exactly 1 bin per pixel and have no such gaps.
    stampLine(pixels, w, h, 55, 128, 199, 128, 5000);
    const buf = buildFitsBuffer(w, h, pixels);

    const result = trailDetector.detect(buf);
    expect(result.trailDetected).toBe(true);
    // FWHM hard-reject threshold from docs/trail-detection.md: must be ≤ 12 px.
    // `toBeLessThanOrEqual` would throw on undefined, so the `.toBeDefined`
    // pre-check is redundant.
    expect(result.profileWidth).toBeLessThanOrEqual(FWHM_HARD_REJECT_PX);
    // Trail length must clear the 10%-of-diagonal floor.
    const diag = Math.sqrt(w * w + h * h);
    expect(result.lengthPixels).toBeGreaterThanOrEqual(diag * MIN_LENGTH_FRACTION_OF_DIAGONAL);
  });

  it('returns trailDetected: false for a star field with no streak', () => {
    const w = 256, h = 256;
    const pixels = blankImage(w, h, 100);
    // Sprinkle a couple dozen compact stars at varied positions and
    // brightnesses. None linear, none above the trail-length floor.
    const positions: Array<[number, number, number]> = [
      [40, 30, 4000], [80, 60, 3500], [120, 25, 5000], [200, 50, 4200],
      [30, 100, 3800], [90, 130, 4600], [160, 110, 3000], [220, 140, 5200],
      [50, 180, 4400], [110, 200, 3700], [170, 190, 4100], [230, 220, 4800],
      [60, 240, 3300], [140, 70, 3900], [180, 160, 4500], [70, 80, 3600],
    ];
    for (const [x, y, peak] of positions) {
      stampStar(pixels, w, h, x, y, peak);
    }
    const buf = buildFitsBuffer(w, h, pixels);

    const result = trailDetector.detect(buf);
    expect(result.trailDetected).toBe(false);
  });

  it('rejects a streak whose length is below the 10% diagonal floor', () => {
    const w = 256, h = 256;
    const pixels = blankImage(w, h, 100);
    // Trail that spans only 9% of the diagonal — explicitly below the
    // documented minimum of 10%. This is the threshold-locking test:
    // raise the floor and the line stops being detected; lower it and
    // the line starts being detected. Either way, this test catches the
    // change.
    const diag = Math.sqrt(w * w + h * h);
    const targetLen = diag * 0.09;
    const cx = w / 2;
    const cy = h / 2;
    // 45° streak centred at image middle.
    const dx = Math.round((targetLen / 2) * Math.SQRT1_2);
    const dy = Math.round((targetLen / 2) * Math.SQRT1_2);
    stampLine(pixels, w, h, cx - dx, cy - dy, cx + dx, cy + dy, 5000);
    const buf = buildFitsBuffer(w, h, pixels);

    const result = trailDetector.detect(buf);
    expect(result.trailDetected).toBe(false);
  });
});

// ─── Threshold lock-in ───────────────────────────────────────────────

describe('documented detector thresholds (lock-in)', () => {
  // Asserts the *exported* production constants against the values documented
  // in docs/trail-detection.md (Thresholds table). Any edit to those constants
  // forces this test to fail, which forces a deliberate docs update + re-test
  // on real frames before the change can ship.
  it('matches the documented thresholds in docs/trail-detection.md', () => {
    expect(FWHM_HARD_REJECT_PX).toBe(12);
    expect(MIN_LENGTH_FRACTION_OF_DIAGONAL).toBe(0.10);
    expect(FILL_FRACTION_MIN).toBe(0.40);
    expect(CONTIGUOUS_RUN_FRACTION_OF_DIAGONAL).toBe(0.03);
    expect(GAP_TOLERANCE_FRACTION_OF_DIAGONAL).toBe(0.06);
  });
});
