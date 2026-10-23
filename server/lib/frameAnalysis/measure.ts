/**
 * Per-frame measurement for the sub-frame analyzer: how many stars a raw FITS sub-frame shows, how sharp and how
 * round they are, how bright and noisy the sky is, and whether a straight streak crosses it.
 *
 * Whether those numbers are good is not decided here. It depends on what the rest of the night looked like, so
 * `ranking.ts` judges each frame against its night. This file is a port of the macOS app's `FrameAnalyzer`, and
 * the two are meant to agree on the numbers, so change them together.
 */
import { fitsDataOffset, parseFitsHeader } from '../fitsParser.js';

export interface FrameStreak {
  /** Degrees, 0 to 180, in the analysed picture. */
  angle: number;
  /** How much of the picture's diagonal it covers, 0...1. */
  strength: number;
}

export interface FrameMetrics {
  /** The grid the numbers refer to. A colour-filter-array frame is analysed at half size. */
  width: number;
  height: number;
  starCount: number;
  /** Full width at half maximum of the stars, in pixels of the analysed grid. */
  fwhm: number | null;
  /** Major over minor axis of the stars, 1 for round. */
  elongation: number | null;
  /** Direction the stars are stretched in, degrees. */
  orientation: number | null;
  background: number;
  noise: number;
  /** How much the sky brightness varies across the picture, relative to its level. */
  gradient: number;
  /** Brightest-star signal over noise, median. */
  peakSNR: number | null;
  streak: FrameStreak | null;
  saturatedFraction: number;
  /** Where the telescope pointed, degrees, from the header. A mosaic points somewhere new every frame. */
  ra: number | null;
  dec: number | null;
}

/** Bump when a change here makes the same file measure differently, so stored results are dropped on upgrade. */
export const FRAME_METRICS_VERSION = 3;

const BAYER_PATTERNS = new Set(['RGGB', 'BGGR', 'GRBG', 'GBRG']);
const SUPPORTED_BITPIX = new Set([8, 16, 32, -32, -64]);
/** Above this many pixels a frame is binned 2 by 2 too, which also steadies the star measurements. */
const BIN_ABOVE_PIXELS = 2_400_000;

/**
 * Smaller than this is a stub or a thumbnail, not a sub-frame: there are too few pixels for a star count, background
 * or noise to mean anything, and a verdict built on them would be invented.
 */
const MIN_SIDE = 64;

const CELL = 32;
const DETECTION_SIGMA = 5;
const MAX_MEASURED = 600;

export class FrameDecodeError extends Error {}

interface Grid {
  data: Float32Array;
  width: number;
  height: number;
  /** The largest value a pixel can hold, when the file's format says so. */
  ceiling: number | null;
  ra: number | null;
  dec: number | null;
}

// ─── Decode ───────────────────────────────────────────────────────────────

function headerNumber(values: Record<string, string | number | boolean>, key: string): number | null {
  const v = values[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * One brightness plane to measure, read straight from the file buffer. A colour-filter-array picture is binned
 * 2 by 2 so each value holds one of every colour; very large pictures are binned too. Nothing at full size is
 * held: each output pixel is accumulated from the file, so an 8 MP frame costs about 2 MP of floats.
 */
export function decodeGrid(buf: Buffer): Grid {
  const header = parseFitsHeader(buf);
  const v = header.values;
  const bitpix = headerNumber(v, 'BITPIX') ?? 16;
  const width = headerNumber(v, 'NAXIS1') ?? 0;
  const height = headerNumber(v, 'NAXIS2') ?? 0;
  const depth = Math.max(1, headerNumber(v, 'NAXIS3') ?? 1);
  if (width <= 0 || height <= 0) throw new FrameDecodeError('This file holds no picture (NAXIS1 and NAXIS2 are missing)');
  if (!SUPPORTED_BITPIX.has(bitpix)) throw new FrameDecodeError(`Pixels of type BITPIX ${bitpix} are not supported`);
  const bscale = headerNumber(v, 'BSCALE') ?? 1;
  const bzero = headerNumber(v, 'BZERO') ?? 0;
  const planes = depth >= 3 ? 3 : 1;
  const bytes = Math.abs(bitpix) / 8;
  const pixels = width * height;
  let offset: number;
  try { offset = fitsDataOffset(buf); } catch (err) { throw new FrameDecodeError(err instanceof Error ? err.message : String(err)); }
  if (buf.length < offset + pixels * bytes * planes) {
    throw new FrameDecodeError('The pixel data is shorter than the header says. The file may be incomplete');
  }
  const bayerRaw = typeof v.BAYERPAT === 'string' ? v.BAYERPAT.toUpperCase() : '';
  const hasPattern = BAYER_PATTERNS.has(bayerRaw);
  // A real mosaic is one plane that still has to be debayered; a colour cube that carries the card is not.
  const mosaic = planes === 1 && hasPattern;

  const readAt = ((): ((byteIndex: number) => number) => {
    switch (bitpix) {
      case 8: return i => buf[i];
      case 16: return i => buf.readInt16BE(i);
      case 32: return i => buf.readInt32BE(i);
      case -32: return i => buf.readFloatBE(i);
      default: return i => buf.readDoubleBE(i);
    }
  })();

  if (width < MIN_SIDE || height < MIN_SIDE) {
    throw new FrameDecodeError(`This picture is only ${width} by ${height} pixels, too small to analyze`);
  }
  // Binned like the Mac app: any frame that names a Bayer pattern, and anything over ~2.4 MP.
  const bin = hasPattern || pixels > BIN_ABOVE_PIXELS;
  const ow = bin ? Math.floor(width / 2) : width;
  const oh = bin ? Math.floor(height / 2) : height;
  const out = new Float32Array(ow * oh);

  if (mosaic) {
    // Bilinear debayer, then (R + G + B) / 3, then 2 x 2 average: the Mac app's path, so both read the same numbers.
    // Red and blue sites hold their own colour and interpolate the other two; a green site holds green and
    // interpolates the other two from its row and column. Either way the sum of the three is one of two forms.
    const plane = new Float32Array(pixels);
    const base = offset;
    for (let i = 0; i < pixels; i++) plane[i] = readAt(base + i * bytes) * bscale + bzero;
    const pat = bayerRaw;
    const at = (x: number, y: number): number =>
      plane[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))];
    const lum = (x: number, y: number): number => {
      const value = plane[y * width + x];
      if (pat[(y & 1) * 2 + (x & 1)] === 'G') {
        const h = (at(x - 1, y) + at(x + 1, y)) / 2, vv = (at(x, y - 1) + at(x, y + 1)) / 2;
        return (value + h + vv) / 3;
      }
      const cross = (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) / 4;
      const diag = (at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1)) / 4;
      return (value + cross + diag) / 3;
    };
    for (let y = 0; y < oh; y++) {
      for (let x = 0; x < ow; x++) {
        const x0 = 2 * x, y0 = 2 * y;
        out[y * ow + x] = (lum(x0, y0) + lum(x0 + 1, y0) + lum(x0, y0 + 1) + lum(x0 + 1, y0 + 1)) * 0.25;
      }
    }
  } else {
    const norm = (bin ? 0.25 : 1) / planes;
    for (let p = 0; p < planes; p++) {
      const base = offset + p * pixels * bytes;
      for (let y = 0; y < oh; y++) {
        const row = bin ? 2 * y : y;
        const o = y * ow;
        for (let x = 0; x < ow; x++) {
          const i = base + (row * width + (bin ? 2 * x : x)) * bytes;
          if (bin) {
            const j = i + width * bytes;
            const sum = readAt(i) + readAt(i + bytes) + readAt(j) + readAt(j + bytes);
            out[o + x] += (sum * bscale + 4 * bzero) * norm;
          } else {
            out[o + x] += (readAt(i) * bscale + bzero) * norm;
          }
        }
      }
    }
  }

  const ra = headerNumber(v, 'RA');
  const dec = headerNumber(v, 'DEC');
  const located = ra !== null && dec !== null && ra >= 0 && ra <= 360 && dec >= -90 && dec <= 90;
  return {
    data: out, width: ow, height: oh,
    ceiling: bitpix === 8 ? 255 : bitpix === 16 ? 65535 : null,
    ra: located ? ra : null, dec: located ? dec : null,
  };
}

// ─── Statistics ───────────────────────────────────────────────────────────

export function median(values: ArrayLike<number>): number | null {
  const n = values.length;
  if (n === 0) return null;
  const s = Float64Array.from(values).sort();
  const m = n >> 1;
  return n % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Bilinear read of a coarse per-cell background. */
class BackgroundReader {
  constructor(
    readonly nx: number, readonly ny: number, readonly values: Float32Array,
    readonly width: number, readonly height: number,
  ) {}

  value(x: number, y: number): number {
    const cw = this.width / this.nx, ch = this.height / this.ny;
    const fx = Math.min(Math.max((x + 0.5) / cw - 0.5, 0), this.nx - 1);
    const fy = Math.min(Math.max((y + 0.5) / ch - 0.5, 0), this.ny - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, this.nx - 1), y1 = Math.min(y0 + 1, this.ny - 1);
    const tx = fx - x0, ty = fy - y0;
    const top = this.values[y0 * this.nx + x0] * (1 - tx) + this.values[y0 * this.nx + x1] * tx;
    const bottom = this.values[y1 * this.nx + x0] * (1 - tx) + this.values[y1 * this.nx + x1] * tx;
    return top * (1 - ty) + bottom * ty;
  }
}

/**
 * A coarse background: the median of each `cell`-sized square, read back with bilinear interpolation, plus the noise
 * of what is left over and how much the sky level varies.
 */
class BackgroundMap {
  readonly nx: number;
  readonly ny: number;
  readonly values: Float32Array;
  readonly level: number;
  readonly noise: number;
  readonly gradient: number;
  private readonly reader: BackgroundReader;

  constructor(g: Grid, cell: number) {
    const nx = Math.max(1, Math.floor(g.width / cell));
    const ny = Math.max(1, Math.floor(g.height / cell));
    this.nx = nx; this.ny = ny;
    const vals = new Float32Array(nx * ny);
    const cw = Math.floor(g.width / nx), ch = Math.floor(g.height / ny);
    const scratch = new Float32Array(Math.ceil(cw / 2) * Math.ceil(ch / 2));
    for (let cy = 0; cy < ny; cy++) {
      for (let cx = 0; cx < nx; cx++) {
        let n = 0;
        for (let y = cy * ch; y < (cy + 1) * ch; y += 2) {
          for (let x = cx * cw; x < (cx + 1) * cw; x += 2) scratch[n++] = g.data[y * g.width + x];
        }
        const sorted = scratch.subarray(0, n).sort();
        // Slightly below the median so a cell crowded with stars still reads as sky.
        vals[cy * nx + cx] = n === 0 ? 0 : sorted[Math.floor(n * 0.45)];
      }
    }
    this.values = vals;
    const sortedVals = Float32Array.from(vals).sort();
    this.level = sortedVals[sortedVals.length >> 1];
    this.gradient = this.level > 0
      ? (sortedVals[Math.floor((sortedVals.length - 1) * 0.9)] - sortedVals[Math.floor((sortedVals.length - 1) * 0.1)]) / this.level
      : 0;

    this.reader = new BackgroundReader(nx, ny, vals, g.width, g.height);
    const residuals: number[] = [];
    for (let y = 0; y < g.height; y += 5) {
      for (let x = 0; x < g.width; x += 5) residuals.push(g.data[y * g.width + x] - this.reader.value(x, y));
    }
    const r = Float32Array.from(residuals).sort();
    const mid = r[r.length >> 1];
    const dev = new Float32Array(r.length);
    for (let i = 0; i < r.length; i++) dev[i] = Math.abs(r[i] - mid);
    dev.sort();
    this.noise = Math.max(dev[dev.length >> 1] * 1.4826, 1e-3);
  }

  value(x: number, y: number): number { return this.reader.value(x, y); }
}

// ─── Stars ────────────────────────────────────────────────────────────────

interface Star {
  x: number;
  y: number;
  peak: number;
  fwhm: number;
  elongation: number;
  /** Degrees, 0 to 180. */
  angle: number;
}

/** Size and shape of one star from the pixels connected to its peak that are above a quarter of its height. */
function profile(g: Grid, map: BackgroundMap, x: number, y: number, peak: number): Star | null {
  const r = 9, side = 2 * r + 1;
  const bg = map.value(x, y);
  const top = peak - bg;
  if (!(top > 0)) return null;
  const cut = bg + top * 0.25;
  const inside = new Uint8Array(side * side);
  const stack: number[] = [r * side + r];
  inside[r * side + r] = 1;
  const memberX: number[] = [], memberY: number[] = [], memberW: number[] = [];
  let sumW = 0, sumX = 0, sumY = 0;
  let touchesEdge = false;
  while (stack.length > 0) {
    const cur = stack.pop() as number;
    const cx = cur % side, cy = (cur - cx) / side;
    const weight = g.data[(y + cy - r) * g.width + (x + cx - r)] - bg;
    memberX.push(cx); memberY.push(cy); memberW.push(weight);
    sumW += weight; sumX += weight * cx; sumY += weight * cy;
    if (cx === 0 || cy === 0 || cx === side - 1 || cy === side - 1) touchesEdge = true;
    for (let k = 0; k < 4; k++) {
      const nx = cx + (k === 0 ? 1 : k === 1 ? -1 : 0);
      const ny = cy + (k === 2 ? 1 : k === 3 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= side || ny >= side || inside[ny * side + nx]) continue;
      const ax = x + nx - r, ay = y + ny - r;
      if (ax < 0 || ay < 0 || ax >= g.width || ay >= g.height || g.data[ay * g.width + ax] < cut) continue;
      inside[ny * side + nx] = 1;
      stack.push(ny * side + nx);
    }
  }
  const count = memberX.length;
  // A single hot pixel or a cosmic ray has no width. Anything that runs out of the window (a streak, a bright
  // edge, a nebula) is not a star, and must not be counted as one or hidden from the streak search.
  if (count < 4 || !(sumW > 0) || touchesEdge) return null;
  const mx = sumX / sumW, my = sumY / sumW;
  let m20 = 0, m02 = 0, m11 = 0;
  for (let i = 0; i < count; i++) {
    const dx = memberX[i] - mx, dy = memberY[i] - my;
    m20 += memberW[i] * dx * dx; m02 += memberW[i] * dy * dy; m11 += memberW[i] * dx * dy;
  }
  m20 /= sumW; m02 /= sumW; m11 /= sumW;
  const mean = (m20 + m02) / 2;
  const spread = Math.sqrt(((m20 - m02) / 2) ** 2 + m11 ** 2);
  const l1 = mean + spread, l2 = mean - spread;
  if (!(l2 > 0.05)) return null;
  // A Gaussian's area above a quarter of its height is 2π σ² ln 4.
  const sigma = Math.sqrt(count / (2 * Math.PI * Math.log(4)));
  let angle = 0.5 * Math.atan2(2 * m11, m20 - m02) * 180 / Math.PI;
  if (angle < 0) angle += 180;
  return { x, y, peak, fwhm: 2.3548 * sigma, elongation: Math.sqrt(l1 / l2), angle };
}

/**
 * The brightest stars, fully measured, and the number of stars in all. Measuring is the costly part, so the faint
 * tail is counted from the rate at which the measured ones turned out to be real stars rather than hot pixels.
 */
function detect(g: Grid, map: BackgroundMap, noise: number): { stars: Star[]; total: number } {
  const w = g.width, h = g.height;
  const margin = 8;
  if (w <= margin * 2 + 2 || h <= margin * 2 + 2) return { stars: [], total: 0 };
  const { nx, ny } = map;
  // A cheap bound first: no pixel's interpolated background is below the smallest of the cells around it, so
  // anything under that bound plus the threshold cannot be a star.
  const lower = new Float32Array(nx * ny);
  for (let cy = 0; cy < ny; cy++) {
    for (let cx = 0; cx < nx; cx++) {
      let low = Infinity;
      for (let yy = Math.max(0, cy - 1); yy <= Math.min(ny - 1, cy + 1); yy++) {
        for (let xx = Math.max(0, cx - 1); xx <= Math.min(nx - 1, cx + 1); xx++) low = Math.min(low, map.values[yy * nx + xx]);
      }
      lower[cy * nx + cx] = low + DETECTION_SIGMA * noise;
    }
  }
  const cellW = w / nx, cellH = h / ny;
  const colCell = new Int32Array(w);
  for (let x = 0; x < w; x++) colCell[x] = Math.min(nx - 1, Math.floor(x / cellW));

  const cand: { x: number; y: number; peak: number }[] = [];
  const p = g.data;
  scan:
  for (let y = margin; y < h - margin; y++) {
    const row = y * w;
    const cellRow = Math.min(ny - 1, Math.floor(y / cellH)) * nx;
    for (let x = margin; x < w - margin; x++) {
      const v = p[row + x];
      if (v < lower[cellRow + colCell[x]]) continue;
      if (v < map.value(x, y) + DETECTION_SIGMA * noise) continue;
      // A strict maximum against the rows above and to the left, a loose one below and right, so a flat top
      // is reported once.
      if (v <= p[row + x - 1] || v <= p[row + x - w] || v <= p[row + x - w - 1] || v <= p[row + x - w + 1]) continue;
      if (v < p[row + x + 1] || v < p[row + x + w] || v < p[row + x + w - 1] || v < p[row + x + w + 1]) continue;
      cand.push({ x, y, peak: v });
      if (cand.length > 20_000) break scan;
    }
  }
  cand.sort((a, b) => b.peak - a.peak);

  const stars: Star[] = [];
  const limit = Math.min(cand.length, 1200);
  for (let i = 0; i < limit; i++) {
    const s = profile(g, map, cand[i].x, cand[i].y, cand[i].peak);
    if (s) stars.push(s);
  }
  if (limit === 0) return { stars, total: 0 };
  const rate = stars.length / limit;
  return { stars, total: Math.round(cand.length * rate) };
}

// ─── Streaks ──────────────────────────────────────────────────────────────

/**
 * A satellite or aeroplane leaves a straight line of faint pixels. Stars are masked out, what is left is searched
 * for one line holding a large share of the bright pixels, over a smoothed, shrunken copy so a faint streak adds up.
 */
function findStreak(g: Grid, map: BackgroundMap, noise: number, stars: Star[]): FrameStreak | null {
  const w = g.width, h = g.height;
  const bin = Math.max(2, Math.ceil(Math.max(w, h) / 256));
  const bw = Math.floor(w / bin), bh = Math.floor(h / bin);
  if (bw < 24 || bh < 24) return null;
  const pooled = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let sum = 0;
      for (let dy = 0; dy < bin; dy++) {
        const row = (by * bin + dy) * w + bx * bin;
        for (let dx = 0; dx < bin; dx++) sum += g.data[row + dx];
      }
      pooled[by * bw + bx] = sum / (bin * bin) - map.value(bx * bin + (bin >> 1), by * bin + (bin >> 1));
    }
  }
  const masked = new Uint8Array(bw * bh);
  for (const s of stars.slice(0, 3000)) {
    const reach = Math.max(1, Math.ceil(s.fwhm * 1.5 / bin) + 1);
    const cx = Math.floor(s.x / bin), cy = Math.floor(s.y / bin);
    for (let yy = Math.max(0, cy - reach); yy <= Math.min(bh - 1, cy + reach); yy++) {
      for (let xx = Math.max(0, cx - reach); xx <= Math.min(bw - 1, cx + reach); xx++) masked[yy * bw + xx] = 1;
    }
  }
  // Noise of the pooled copy, from the copy itself.
  const sample: number[] = [];
  for (let i = 0; i < pooled.length; i += 3) sample.push(pooled[i]);
  const mid = median(sample);
  if (mid === null) return null;
  const spread = (median(sample.map(s => Math.abs(s - mid))) ?? 0) * 1.4826;
  const threshold = mid + Math.max(spread, noise / bin) * 2.5;
  const px: number[] = [], py: number[] = [];
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      if (!masked[by * bw + bx] && pooled[by * bw + bx] > threshold) { px.push(bx); py.push(by); }
    }
  }
  const diagonal = Math.hypot(bw, bh);
  if (px.length < 20 || px.length >= 9000) return null;

  const angles = 180;
  const rhoMax = Math.floor(diagonal) + 2;
  const rhoBins = rhoMax * 2 + 1;
  const acc = new Int32Array(angles * rhoBins);
  const cosT = new Float32Array(angles), sinT = new Float32Array(angles);
  for (let t = 0; t < angles; t++) {
    const a = t * Math.PI / angles;
    cosT[t] = Math.cos(a); sinT[t] = Math.sin(a);
  }
  for (let i = 0; i < px.length; i++) {
    for (let t = 0; t < angles; t++) {
      acc[t * rhoBins + Math.round(px[i] * cosT[t] + py[i] * sinT[t]) + rhoMax] += 1;
    }
  }
  let bestCount = 0, bestT = 0;
  for (let t = 0; t < angles; t++) {
    for (let r = 1; r < rhoBins - 1; r++) {
      // A line a pixel or two wide: the bin and its neighbours.
      const c = acc[t * rhoBins + r - 1] + acc[t * rhoBins + r] + acc[t * rhoBins + r + 1];
      if (c > bestCount) { bestCount = c; bestT = t; }
    }
  }
  const need = Math.max(24, Math.floor(diagonal * 0.18));
  if (bestCount < need || bestCount < px.length * 0.25) return null;
  return { angle: bestT, strength: Math.min(1, bestCount / diagonal) };
}

// ─── Entry point ──────────────────────────────────────────────────────────

function measureGrid(g: Grid): FrameMetrics {
  const w = g.width, h = g.height;
  const pointing = { ra: g.ra, dec: g.dec };
  if (w < 8 || h < 8 || g.data.length === 0) {
    return {
      width: w, height: h, starCount: 0, fwhm: null, elongation: null, orientation: null, background: 0, noise: 0,
      gradient: 0, peakSNR: null, streak: null, saturatedFraction: 0, ...pointing,
    };
  }
  const map = new BackgroundMap(g, CELL);
  const noise = Math.max(map.noise, 1e-3);

  let saturated = 0;
  if (g.ceiling !== null) {
    const limit = g.ceiling * 0.98;
    for (let i = 0; i < g.data.length; i++) if (g.data[i] >= limit) saturated++;
  }

  const { stars, total } = detect(g, map, noise);
  const measured = stars.slice(0, MAX_MEASURED);
  const elongations = measured.map(s => s.elongation);
  const snrs = measured.map(s => (s.peak - map.value(s.x, s.y)) / noise);

  let orientation: number | null = null;
  if (elongations.length >= 5 && (median(elongations) ?? 1) > 1.2) {
    // Circular mean of the doubled angle, so 179° and 1° agree.
    let sx = 0, sy = 0;
    for (const s of measured) {
      sx += Math.cos(2 * s.angle * Math.PI / 180);
      sy += Math.sin(2 * s.angle * Math.PI / 180);
    }
    let a = Math.atan2(sy, sx) * 180 / Math.PI / 2;
    if (a < 0) a += 180;
    orientation = a;
  }

  return {
    width: w, height: h, starCount: total,
    fwhm: median(measured.map(s => s.fwhm)),
    elongation: median(elongations),
    orientation,
    background: map.level, noise, gradient: map.gradient,
    peakSNR: median(snrs),
    streak: findStreak(g, map, noise, stars),
    saturatedFraction: saturated / (w * h),
    ...pointing,
  };
}

/** Measure one raw sub-frame from the bytes of its FITS file. Throws FrameDecodeError for a file that is not a readable image. */
export function measureFrame(buf: Buffer): FrameMetrics {
  return measureGrid(decodeGrid(buf));
}

/** Exposed for tests: measure a grid built in memory. */
export function measureSyntheticGrid(data: Float32Array, width: number, height: number): FrameMetrics {
  return measureGrid({ data, width, height, ceiling: null, ra: null, dec: null });
}
