import { describe, it, expect, vi } from 'vitest';
import {
  trailDetector,
  FWHM_HARD_REJECT_PX,
  MIN_LENGTH_FRACTION_OF_DIAGONAL,
  FILL_FRACTION_MIN,
  CONTIGUOUS_RUN_FRACTION_OF_DIAGONAL,
  GAP_TOLERANCE_FRACTION_OF_DIAGONAL,
  LINEARITY_MAX_WIDTH_PX,
  LONG_COMPONENT_FRACTION,
  MIN_TRAIL_ANGULAR_DEG,
  MIN_BIN_COVERAGE,
  MAX_MASK_COVERAGE,
  STAR_PAD_MIN_PX,
  STAR_PAD_MAX_PX,
} from '../../server/lib/trailDetector';

// This file's synthetic-image tests run the full detector pipeline against
// frames up to 6248x6248px, which is genuinely heavy numeric work. Locally
// (10-core Apple Silicon) the slowest of them takes ~1.7s, comfortably under
// Vitest's 5000ms default — but CI (GitHub's shared 2-core ubuntu-latest
// runner, plus `--coverage` instrumentation on top) is slow enough to push
// several of them past that ceiling, failing tests whose logic is unchanged.
// 20s is a wide margin over any observed local time while still catching a
// genuine hang or infinite loop.
vi.setConfig({ testTimeout: 20_000 });

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
    // Throw rather than `expect(...).toBe(true)`: the result is a discriminated
    // union, so this both fails the test and narrows `result` to the detected
    // variant, making the measurement fields below non-optional.
    if (!result.trailDetected) throw new Error('expected a trail to be detected');
    // FWHM hard-reject threshold from docs/trail-detection.md: must be ≤ 12 px.
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

// ─── Scale-dependence regressions ────────────────────────────────────
//
// Everything below covers a way the detector's behaviour used to depend on
// which telescope took the picture rather than on what was in it. Each block
// names the failure it locks out.

/**
 * Gaussian-profile scene generator, used in place of the single-pixel
 * `stampLine` above: the bugs in this section are all about a trail's WIDTH
 * and a star field's DENSITY, neither of which a 1 px line can express.
 */
function makeScene(
  w: number,
  h: number,
  opts: {
    nStars?: number;
    starPeak?: number;
    trailAmp?: number;
    trailFraction?: number;
    trailFwhm?: number;
    trailAngleDeg?: number;
    noise?: number;
  } = {},
): Float64Array {
  const {
    nStars = 0, starPeak = 400, trailAmp = 300, trailFraction = 1,
    trailFwhm = 3, trailAngleDeg = 20, noise = 30,
  } = opts;

  // Deterministic LCG — same seed every run so a failure is reproducible.
  let s = 12345 >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s & 0xffffff) / 0xffffff; };

  const arr = new Float64Array(w * h);
  for (let i = 0; i < arr.length; i++) arr[i] = 1000 + (rnd() - 0.5) * 2 * noise;

  const starSigma = 1.2;
  for (let n = 0; n < nStars; n++) {
    const cx = Math.round(rnd() * w), cy = Math.round(rnd() * h);
    // A spread of brightnesses, weighted faint, like a real field.
    const peak = starPeak * (0.2 + rnd() * rnd() * 3);
    for (let dy = -5; dy <= 5; dy++) {
      for (let dx = -5; dx <= 5; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || x >= w || y < 0 || y >= h) continue;
        arr[y * w + x] += peak * Math.exp(-(dx * dx + dy * dy) / (2 * starSigma * starSigma));
      }
    }
  }

  const diag = Math.sqrt(w * w + h * h);
  const len = trailFraction * diag;
  const th = trailAngleDeg * Math.PI / 180;
  const dx = Math.cos(th), dy = Math.sin(th);
  const sigma = trailFwhm / 2.3548;
  const half = Math.ceil(sigma * 3);
  const steps = Math.ceil(len * 3);
  for (let t = 0; t <= steps; t++) {
    const u = (t / steps - 0.5) * len;
    const px = w / 2 + u * dx, py = h / 2 + u * dy;
    for (let o = -half; o <= half; o++) {
      const x = Math.round(px - o * dy), y = Math.round(py + o * dx);
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      // /3 because neighbouring steps overlap; keeps the peak near trailAmp.
      arr[y * w + x] += (trailAmp * Math.exp(-(o * o) / (2 * sigma * sigma))) / 3;
    }
  }
  return arr;
}

describe('trail width independence (star mask must not swallow thick trails)', () => {
  // `linearity` is pixelCount / bboxDiagonal, which for a line reads out as its
  // WIDTH. The old cutoff of 2.5 therefore declared every trail wider than
  // 2.5 working px a "compact source" and masked its bounding box — the whole
  // frame, for a full-frame diagonal. Bright passes (ISS, flares) and small
  // sensors at long focal length were hit hardest, because they downsample
  // least and so have the widest trails in working pixels.
  const widths = [2, 3, 4, 6, 8, 12, 20, 32];

  it.each(widths)('detects a %i px wide trail on a 2048x2048 frame', (fwhm) => {
    const pixels = makeScene(2048, 2048, { nStars: 200, trailFwhm: fwhm });
    const result = trailDetector.detect(buildFitsBuffer(2048, 2048, pixels));
    expect(result.trailDetected).toBe(true);
  });

  it.each(widths.slice(0, 7))('detects a %i px wide trail on a 1080x1920 SeeStar frame', (fwhm) => {
    const pixels = makeScene(1080, 1920, { nStars: 100, trailFwhm: fwhm });
    const result = trailDetector.detect(buildFitsBuffer(1080, 1920, pixels));
    expect(result.trailDetected).toBe(true);
  });

  it('keeps the width cutoff above any plausible trail width', () => {
    // Guards the constant itself: 2.5 was below the width of a routine bright
    // trail, which is what made the bug possible.
    expect(LINEARITY_MAX_WIDTH_PX).toBeGreaterThanOrEqual(8);
  });

  it('never masks a component already long enough to be a trail', () => {
    // The escape hatch that makes the width cutoff safe: half the minimum trail
    // length, so a trail split in two by a star crossing still protects both
    // halves.
    expect(LONG_COMPONENT_FRACTION).toBeCloseTo(MIN_LENGTH_FRACTION_OF_DIAGONAL / 2, 10);
  });
});

describe('sensor resolution independence (star-mask padding)', () => {
  // Padding used to be `maxIntensity / sigma`, a ratio that grows with the
  // downsample factor because box-filtering suppresses noise faster than star
  // peaks. On a 61 MP frame every star saturated the 12 px cap and claimed a
  // ~25x25 working block: the same 300-star sky masked 0.4% of a 1 MP frame
  // and 26% of a 39 MP one, and a rich field masked 99% and detected nothing.
  const sensors: Array<[number, number]> = [[1024, 1024], [3008, 3008], [6248, 6248]];

  for (const [w, h] of sensors) {
    for (const nStars of [300, 1500, 6000]) {
      it(`detects a full-frame trail on ${w}x${h} under ${nStars} stars`, () => {
        const pixels = makeScene(w, h, { nStars });
        const result = trailDetector.detect(buildFitsBuffer(w, h, pixels));
        expect(result.trailDetected).toBe(true);
      });
    }
  }

  it('bounds the padding so it cannot scale with the downsample factor', () => {
    expect(STAR_PAD_MIN_PX).toBeGreaterThanOrEqual(1);
    expect(STAR_PAD_MAX_PX).toBeLessThanOrEqual(8);
    expect(STAR_PAD_MAX_PX).toBeGreaterThan(STAR_PAD_MIN_PX);
  });

  it('declares a mask-coverage ceiling that leaves sky to search', () => {
    expect(MAX_MASK_COVERAGE).toBeGreaterThan(0);
    expect(MAX_MASK_COVERAGE).toBeLessThan(0.6);
  });
});

describe('square sensors have no 45/135 degree dead band', () => {
  // On a SQUARE frame the projection axis at exactly 45/135 lands on the image
  // diagonal, the end bins degenerate to a single corner pixel, and the count
  // normalization amplified that corner into a peak that outranked the trail.
  // Rectangular frames were unaffected (no integer angle hits their diagonal),
  // which is why this went unnoticed. 3008x3008 is the ASI533, a common camera.
  it.each([44.5, 45, 45.5, 134.5, 135, 135.5])(
    'detects a trail at %s degrees on a 3008x3008 frame',
    (angle) => {
      const pixels = makeScene(3008, 3008, { nStars: 200, trailAngleDeg: angle });
      const result = trailDetector.detect(buildFitsBuffer(3008, 3008, pixels));
      expect(result.trailDetected).toBe(true);
    },
  );

  it('discards projection bins too sparse to measure', () => {
    expect(MIN_BIN_COVERAGE).toBeGreaterThan(0);
    expect(MIN_BIN_COVERAGE).toBeLessThan(1);
  });
});

describe('minimum trail length is angular when the plate scale is known', () => {
  // 10% of the diagonal is scale-free, but a trail's length is not: it is
  // (angular rate x exposure) degrees whatever optics took the frame. On a
  // ~63 deg camera-lens field that floor demanded a 6.3 deg streak, which no
  // single sub produces, so real trails were discarded as "too short".
  const w = 4000, h = 2100;
  const wideFieldDegPerPixel = 63 / Math.sqrt(w * w + h * h);

  it('rejects a short streak on a wide field when no plate scale is supplied', () => {
    const pixels = makeScene(w, h, { nStars: 400, trailFraction: 0.02 });
    expect(trailDetector.detect(buildFitsBuffer(w, h, pixels)).trailDetected).toBe(false);
  });

  it('accepts the same streak once the plate scale shows it is a real angle', () => {
    const pixels = makeScene(w, h, { nStars: 400, trailFraction: 0.02 });
    // 2% of a 63 deg diagonal is 1.26 deg on the sky: about 1.5 s of LEO motion.
    const result = trailDetector.detect(buildFitsBuffer(w, h, pixels), {
      degreesPerPixel: wideFieldDegPerPixel,
    });
    expect(result.trailDetected).toBe(true);
  });

  it('does not loosen the floor on a narrow field', () => {
    // A plate scale must only ever make the detector MORE sensitive on wide
    // fields, never looser on the narrow ones the 10% rule was tuned for.
    const sw = 256, sh = 256;
    const narrowDegPerPixel = 0.73 / Math.sqrt(sw * sw + sh * sh);
    const pixels = blankImage(sw, sh, 100);
    addNoise(pixels, 5);
    const diag = Math.sqrt(sw * sw + sh * sh);
    const targetLen = diag * 0.09; // below the 10% floor, as in the test above
    const dx = Math.round((targetLen / 2) * Math.SQRT1_2);
    const dy = Math.round((targetLen / 2) * Math.SQRT1_2);
    stampLine(pixels, sw, sh, sw / 2 - dx, sh / 2 - dy, sw / 2 + dx, sh / 2 + dy, 5000);
    const buf = buildFitsBuffer(sw, sh, pixels);
    expect(trailDetector.detect(buf).trailDetected).toBe(false);
    expect(trailDetector.detect(buf, { degreesPerPixel: narrowDegPerPixel }).trailDetected).toBe(false);
  });

  it('ignores a nonsensical plate scale rather than trusting it', () => {
    const pixels = makeScene(w, h, { nStars: 400, trailFraction: 0.02 });
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = trailDetector.detect(buildFitsBuffer(w, h, pixels), { degreesPerPixel: bad });
      expect(result.trailDetected).toBe(false);
    }
  });

  it('declares an angular floor short enough that no real pass is excluded', () => {
    // A satellite covers 0.3-1.2 deg/s, so this is well under one second of motion.
    expect(MIN_TRAIL_ANGULAR_DEG).toBeGreaterThan(0);
    expect(MIN_TRAIL_ANGULAR_DEG).toBeLessThanOrEqual(0.5);
  });
});

describe('reported angle is the trail direction, not its normal', () => {
  // The projection search parameterises a trail by its NORMAL, and that number
  // was returned verbatim — so the API field and the UI's "N deg angle" were
  // both 90 deg off from the streak on screen (a horizontal trail read 90).
  it.each([0, 20, 45, 90, 135, 160])('reports %i degrees for a trail drawn at that angle', (angle) => {
    const pixels = makeScene(1024, 1536, { nStars: 100, trailAngleDeg: angle });
    const result = trailDetector.detect(buildFitsBuffer(1024, 1536, pixels));
    if (!result.trailDetected) throw new Error(`expected a trail at ${angle} degrees`);
    // The 1-degree angle search grid is the only tolerance needed here.
    expect(Math.abs(result.angleDegrees - angle)).toBeLessThanOrEqual(1);
  });

  it('reports an orientation in [0, 180)', () => {
    const pixels = makeScene(1024, 1536, { nStars: 100, trailAngleDeg: 170 });
    const result = trailDetector.detect(buildFitsBuffer(1024, 1536, pixels));
    if (!result.trailDetected) throw new Error('expected a trail');
    expect(result.angleDegrees).toBeGreaterThanOrEqual(0);
    expect(result.angleDegrees).toBeLessThan(180);
  });
});
