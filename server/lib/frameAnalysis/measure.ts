/**
 * Per-frame measurement for the sub-frame analyzer: how many stars a raw FITS sub-frame shows, how sharp and how
 * round they are, how bright and noisy the sky is, and whether a straight streak crosses it.
 *
 * Whether those numbers are good is not decided here. It depends on what the rest of the night looked like, so
 * `ranking.ts` judges each frame against its night. This file is a port of the macOS app's `FrameAnalyzer`, and
 * the two are meant to agree on the numbers, so change them together.
 */
import { fitsDataOffset, parseFitsHeader } from '../fitsParser.js';
import { blockMedians, findSpots, measureTarget, type FrameSpot, type FrameTarget, type GridWcs, type TargetSpec } from './field.js';

export type { FrameSpot, FrameTarget, TargetSpec } from './field.js';

export interface FrameStreak {
  /** Direction the streak runs in, degrees, 0 to 180, in the analysed picture. */
  angle: number;
  /** How much of the picture's diagonal it covers, 0...1. */
  strength: number;
}

export interface FrameRig {
  camera: string | null;
  focal: number | null;
  scale: number | null;
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
  /**
   * Light the stars bring in, in the grid's units: the median total flux of the stars ranked 20th to 120th by flux.
   * The same field keeps the same stars at those ranks whatever the sky does, so between frames of one target it
   * follows transparency directly (thin cloud, haze, dew on the optics), which the star count barely does.
   */
  signal: number | null;
  streak: FrameStreak | null;
  saturatedFraction: number;
  /**
   * The photographed object, when the header carries a plate solution and the object's place is known: how far it
   * stands out of the sky around it. Null otherwise.
   */
  target: FrameTarget | null;
  /** Round shadows darker than the sky around them (dust, or dew or frost near the sensor), in grid pixels. */
  spots: FrameSpot[];
  /**
   * What took the frame, from the header: frames are only comparable with frames of the same camera and focal
   * length. `scale` is arcseconds per grid pixel, from the plate solution or else from focal length and pixel size.
   */
  rig: FrameRig;
  /** Where the telescope pointed, degrees, from the header. A mosaic points somewhere new every frame. */
  ra: number | null;
  dec: number | null;
}

/** Bump when a change here makes the same file measure differently, so stored results are dropped on upgrade. */
export const FRAME_METRICS_VERSION = 7;

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
/** Ranks, by flux, of the stars whose median flux is the frame's signal. */
const SIGNAL_RANKS = [20, 120] as const;
/** A satellite or aeroplane trail is a few pixels wide; a band wider than this at half height is sky structure. */
const MAX_STREAK_WIDTH = 10;

export class FrameDecodeError extends Error {}

export interface Grid {
  data: Float32Array;
  width: number;
  height: number;
  /** The largest value a pixel can hold, when the file's format says so. */
  ceiling: number | null;
  ra: number | null;
  dec: number | null;
  /** The header's plate solution, mapped onto this grid. */
  wcs: GridWcs | null;
  rig: FrameRig;
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
    wcs: readWcs(v, bin ? 2 : 1),
    rig: readRig(v, bin ? 2 : 1),
  };
}

function headerText(values: Record<string, string | number | boolean>, ...keys: string[]): string | null {
  for (const k of keys) {
    const s = values[k];
    if (typeof s === 'string' && s.trim()) return s.trim();
  }
  return null;
}

/** Camera, focal length and scale. Smart telescopes write their name in INSTRUME or TELESCOP. */
function readRig(v: Record<string, string | number | boolean>, bin: number): FrameRig {
  const camera = headerText(v, 'INSTRUME', 'TELESCOP');
  const focalRaw = headerNumber(v, 'FOCALLEN') ?? headerNumber(v, 'FOCAL');
  const focal = focalRaw !== null && focalRaw > 0 ? focalRaw : null;
  const wcs = readWcs(v, bin);
  let scale: number | null = null;
  if (wcs) {
    const [a, b, c, d] = wcs.cd;
    scale = Math.sqrt(Math.abs(a * d - b * c)) * 3600 * bin;
  } else {
    const pixel = headerNumber(v, 'XPIXSZ') ?? headerNumber(v, 'PIXSIZE1');
    if (focal !== null && pixel !== null && pixel > 0) scale = (206.265 * pixel / focal) * bin;
  }
  return { camera, focal, scale: scale !== null && Number.isFinite(scale) ? Math.round(scale * 1000) / 1000 : null };
}

/**
 * A TAN plate solution (CRVAL, CRPIX and a CD matrix, or CDELT with CROTA2) mapped onto the analysed grid. Higher
 * order distortion terms are left out: across a target's few hundred pixels they move it by a pixel or two.
 */
function readWcs(v: Record<string, string | number | boolean>, bin: number): GridWcs | null {
  const crval1 = headerNumber(v, 'CRVAL1'), crval2 = headerNumber(v, 'CRVAL2');
  const crpix1 = headerNumber(v, 'CRPIX1'), crpix2 = headerNumber(v, 'CRPIX2');
  if (crval1 === null || crval2 === null || crpix1 === null || crpix2 === null) return null;
  let cd11 = headerNumber(v, 'CD1_1'), cd12 = headerNumber(v, 'CD1_2');
  let cd21 = headerNumber(v, 'CD2_1'), cd22 = headerNumber(v, 'CD2_2');
  if (cd11 === null || cd22 === null) {
    const d1 = headerNumber(v, 'CDELT1'), d2 = headerNumber(v, 'CDELT2');
    if (d1 === null || d2 === null) return null;
    const rot = (headerNumber(v, 'CROTA2') ?? 0) * Math.PI / 180;
    cd11 = d1 * Math.cos(rot); cd12 = -d2 * Math.sin(rot); cd21 = d1 * Math.sin(rot); cd22 = d2 * Math.cos(rot);
  }
  cd12 ??= 0; cd21 ??= 0;
  if (!(Math.abs(cd11 * cd22 - cd12 * cd21) > 0)) return null;
  return { crval1, crval2, crpix1, crpix2, cd: [cd11, cd12, cd21, cd22], bin };
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
  /** Total flux above the background, from the Gaussian-weighted moments. */
  flux: number;
  /** Peak over the noise. */
  snr: number;
  /** The core reaches the level where the picture clips: its shape and flux are not to be trusted. */
  saturated: boolean;
  fwhm: number;
  elongation: number;
  /** Degrees, 0 to 180. */
  angle: number;
}

/**
 * Size, shape and flux of one star.
 *
 * The pixels connected to the peak above a quarter of its height only decide whether this is a star at all: a hot
 * pixel has no width, a streak, a bright edge or a nebula runs out of the window. They are not used for the size:
 * stars here are often only one or two pixels across, and a count of whole pixels moves in steps (two seeings a
 * quarter apart read the same) and makes round stars look oval.
 *
 * The size comes from adaptive Gaussian-weighted second moments instead (as in weak-lensing and survey photometry):
 * the moments are taken under a Gaussian window that is matched, iteration by iteration, to the star itself. For a
 * Gaussian star under a matched window the measured moments are half the star's own, whatever its size compared
 * with the pixels; the pixels' own width (1/12 px²) is then taken off. This reads sub-pixel changes of size and
 * true elongation down to about a pixel and a half across.
 */
function profile(g: Grid, map: BackgroundMap, x: number, y: number, peak: number, noise: number, clip: number): Star | null {
  const r = 9, side = 2 * r + 1;
  const bg = map.value(x, y);
  const top = peak - bg;
  if (!(top > 0)) return null;
  const cut = bg + top * 0.25;
  const inside = new Uint8Array(side * side);
  const stack: number[] = [r * side + r];
  inside[r * side + r] = 1;
  let count = 0;
  let touchesEdge = false;
  while (stack.length > 0) {
    const cur = stack.pop() as number;
    const cx = cur % side, cy = (cur - cx) / side;
    count++;
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
  // A single hot pixel or a cosmic ray has no width. Anything that runs out of the window (a streak, a bright
  // edge, a nebula) is not a star, and must not be counted as one or hidden from the streak search.
  if (count < 3 || touchesEdge) return null;

  const m = adaptiveMoments(g, bg, x, y, Math.max(0.5, count / (2 * Math.PI * Math.log(4))));
  if (!m) return null;
  // What is left once the pixel's own width is taken off.
  const cxx = m.cxx - 1 / 12, cyy = m.cyy - 1 / 12, cxy = m.cxy;
  const mean = (cxx + cyy) / 2;
  const spread = Math.sqrt(((cxx - cyy) / 2) ** 2 + cxy ** 2);
  const l1 = mean + spread, l2 = mean - spread;
  // Narrower than a third of a pixel: a hot pixel spread by the colour interpolation, not a star.
  if (!(l2 > 0.1)) return null;
  let angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy) * 180 / Math.PI;
  if (angle < 0) angle += 180;
  return {
    x, y, peak,
    fwhm: 2.3548 * Math.sqrt(Math.sqrt(l1 * l2)),
    elongation: Math.sqrt(l1 / l2),
    angle,
    flux: m.flux,
    snr: top / noise,
    saturated: peak >= clip,
  };
}

/**
 * Gaussian-weighted moments with a window matched to the star. For a Gaussian star of covariance C under a Gaussian
 * window W, the weighted moments are M = (C⁻¹ + W⁻¹)⁻¹, so C = (M⁻¹ − W⁻¹)⁻¹ whatever the window; the window is
 * moved towards 2M (where it equals the star) but never below a pixel or so across, because a narrower window over
 * a star one or two pixels wide reads mostly its central pixel and stops seeing its width. Returns the star's
 * covariance, pixel width included, and its flux. Null when it does not settle: a blend, a galaxy, noise.
 */
function adaptiveMoments(g: Grid, bg: number, x0: number, y0: number, start: number):
  { cxx: number; cyy: number; cxy: number; flux: number } | null {
  const floor = 0.8;
  let wxx = Math.max(start, floor), wyy = wxx, wxy = 0;
  let mx = x0, my = y0;
  for (let it = 0; it < 40; it++) {
    const det = wxx * wyy - wxy * wxy;
    const ia = wyy / det, ib = -wxy / det, ic = wxx / det;
    const reach = Math.min(9, Math.ceil(3.5 * Math.sqrt(Math.max(wxx, wyy))) + 1);
    const ix = Math.round(mx), iy = Math.round(my);
    let s0 = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let yy = Math.max(0, iy - reach); yy <= Math.min(g.height - 1, iy + reach); yy++) {
      const dy = yy - my;
      for (let xx = Math.max(0, ix - reach); xx <= Math.min(g.width - 1, ix + reach); xx++) {
        const dx = xx - mx;
        const q = ia * dx * dx + 2 * ib * dx * dy + ic * dy * dy;
        if (q > 16) continue;
        const wt = Math.exp(-0.5 * q);
        const v = (g.data[yy * g.width + xx] - bg) * wt;
        s0 += v; sx += v * dx; sy += v * dy; sxx += v * dx * dx; syy += v * dy * dy; sxy += v * dx * dy;
      }
    }
    if (!(s0 > 0)) return null;
    const ex = sx / s0, ey = sy / s0;
    const mxx = sxx / s0 - ex * ex, myy = syy / s0 - ey * ey, mxy = sxy / s0 - ex * ey;
    const mdet = mxx * myy - mxy * mxy;
    if (!(mxx > 0 && myy > 0 && mdet > 0)) return null;
    mx += ex; my += ey;
    if (Math.abs(mx - x0) > 3 || Math.abs(my - y0) > 3) return null;
    // Next window: twice the moments, held to the floor, kept a proper ellipse.
    const nxx = Math.max(2 * mxx, floor), nyy = Math.max(2 * myy, floor);
    let nxy = 2 * mxy;
    const room = Math.sqrt(nxx * nyy) * 0.95;
    if (Math.abs(nxy) > room) nxy = Math.sign(nxy) * room;
    // Wider than a window this size can hold: a blend or extended object.
    if (nxx > 16 || nyy > 16) return null;
    const settled = Math.abs(nxx - wxx) < 1e-3 * wxx && Math.abs(nyy - wyy) < 1e-3 * wyy
      && Math.abs(nxy - wxy) < 1e-3 * Math.sqrt(wxx * wyy) && Math.abs(ex) < 1e-3 && Math.abs(ey) < 1e-3;
    if (settled || it === 39) {
      if (!settled) return null;
      // C = (M⁻¹ − W⁻¹)⁻¹, with the window the moments were taken under.
      const pa = myy / mdet - ia, pb = -mxy / mdet - ib, pc = mxx / mdet - ic;
      const pdet = pa * pc - pb * pb;
      if (!(pa > 0 && pc > 0 && pdet > 0)) return null;
      // Flux: the weighted sum over the integral of star × window, ∫G_C·w = √(det W / det(C + W)).
      const cxx = pc / pdet, cyy = pa / pdet, cxy = -pb / pdet;
      const sumDet = (cxx + wxx) * (cyy + wyy) - (cxy + wxy) ** 2;
      return { cxx, cyy, cxy, flux: s0 * Math.sqrt(sumDet / det) };
    }
    wxx = nxx; wyy = nyy; wxy = nxy;
  }
  return null;
}

/**
 * The level at which the picture clips. A colour frame is debayered and binned before it is measured, so a burnt
 * core does not reach the file's ceiling here; it shows instead as many pixels sharing the picture's top value.
 */
function clipLevel(g: Grid): number {
  let max = -Infinity;
  for (let i = 0; i < g.data.length; i++) if (g.data[i] > max) max = g.data[i];
  let near = 0;
  for (let i = 0; i < g.data.length; i++) if (g.data[i] >= max * 0.995) near++;
  const fromFile = g.ceiling !== null ? g.ceiling * 0.95 : Infinity;
  return near >= 8 ? Math.min(max * 0.97, fromFile) : fromFile;
}

/**
 * The brightest stars, fully measured, and the number of stars in all. Measuring is the costly part, so the faint
 * tail is counted from the rate at which the measured ones turned out to be real stars rather than hot pixels.
 */
function detect(g: Grid, map: BackgroundMap, noise: number, clip: number): { stars: Star[]; total: number } {
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
    const s = profile(g, map, cand[i].x, cand[i].y, cand[i].peak, noise, clip);
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
  // Strongest lines first, each a few degrees and bins from the ones before it.
  const need = Math.max(24, Math.floor(diagonal * 0.18));
  const minVotes = Math.max(need, Math.ceil(px.length * 0.25));
  const peaks: { t: number; r: number; c: number }[] = [];
  for (let t = 0; t < angles; t++) {
    for (let r = 1; r < rhoBins - 1; r++) {
      // A line a pixel or two wide: the bin and its neighbours.
      const c = acc[t * rhoBins + r - 1] + acc[t * rhoBins + r] + acc[t * rhoBins + r + 1];
      if (c >= minVotes) peaks.push({ t, r: r - rhoMax, c });
    }
  }
  peaks.sort((a, b) => b.c - a.c);
  const tried: { t: number; r: number }[] = [];
  for (const p of peaks) {
    if (tried.length >= 12) break;
    if (tried.some(q => Math.min(Math.abs(q.t - p.t), angles - Math.abs(q.t - p.t)) <= 3 && Math.abs(q.r - p.r) <= 3)) continue;
    tried.push(p);
    if (isTrail(p.t, p.r)) {
      // `t` is the direction of the line's normal; the streak runs at right angles to it.
      return { angle: (p.t + 90) % 180, strength: Math.min(1, p.c / diagonal) };
    }
  }
  return null;

  /**
   * Whether the line at (t, r) is a trail rather than something else the vote lines up: a satellite leaves one
   * thin, unbroken line. A nebula filament, a galaxy or a cloud edge is a broad band that also lights the bins
   * beside it; a row of stretched stars or of stars that escaped the mask is many short pieces with gaps between;
   * amp glow or a stacking edge hugs a side of the frame.
   */
  function isTrail(t: number, r: number): boolean {
    const c = cosT[t], s = sinT[t];
    const along: number[] = [];
    let core = 0, flank = 0, nearSide = 0;
    for (let i = 0; i < px.length; i++) {
      const d = Math.abs(px[i] * c + py[i] * s - r);
      if (d <= 1.5) {
        core++;
        along.push(-px[i] * s + py[i] * c);
        if (Math.min(px[i], py[i], bw - 1 - px[i], bh - 1 - py[i]) <= 4) nearSide++;
      } else if (d > 1.5 && d <= 4.5) flank++;
    }
    if (core < need) return false;
    // Pixels per bin of width: the core is 3 bins wide, the flanks 3 on each side. A trail is a bin or two wide
    // in this copy, so its flanks hold little more than noise.
    if (flank / 6 > (core / 3) * 0.3) return false;
    // Mostly along a side of the frame.
    if (nearSide > core * 0.6) return false;
    // Longest stretch along the line, bridging the holes masked stars leave.
    along.sort((a, b) => a - b);
    const gap = Math.max(4, diagonal * 0.04);
    let run = 0, start = along[0];
    for (let i = 1; i <= along.length; i++) {
      if (i === along.length || along[i] - along[i - 1] > gap) {
        run = Math.max(run, along[i - 1] - start);
        if (i < along.length) start = along[i];
      }
    }
    if (run < need * 0.8) return false;
    // In the shrunken copy a filament can look thin once the background map has taken its wings: measure the
    // width at full size, across the run.
    let first = along[0], last = along[0], runStart = along[0];
    for (let i = 1; i <= along.length; i++) {
      if (i === along.length || along[i] - along[i - 1] > gap) {
        if (along[i - 1] - runStart > last - first) { first = runStart; last = along[i - 1]; }
        if (i < along.length) runStart = along[i];
      }
    }
    const width = fullWidth(c, s, r, first, last);
    return width === null || width <= MAX_STREAK_WIDTH;
  }

  /**
   * Full width at half maximum, in pixels of the grid, of the line between `from` and `to` (positions along it in
   * the shrunken copy). Short pieces of the line are averaged across their length, each piece is centred on its own
   * peak (the vote is only good to a bin or so), and the median of the pieces is measured. Null when the line is
   * too faint for its width to be read.
   */
  function fullWidth(c: number, s: number, r: number, from: number, to: number): number | null {
    const half = bin / 2;
    const rho = r * bin + half * (c + s);
    const slack = 2 * bin + 2, reach = slack + 30;
    const piece = 4 * bin;
    const profiles: number[][] = [];
    for (let u = from * bin; u + piece <= to * bin + bin; u += piece) {
      const sum = new Float64Array(2 * reach + 1), n = new Int32Array(2 * reach + 1);
      for (let k = 0; k < piece; k++) {
        const along2 = u + k + half;
        const fx = rho * c - along2 * s, fy = rho * s + along2 * c;
        for (let o = -reach; o <= reach; o++) {
          const x = Math.round(fx + o * c), y = Math.round(fy + o * s);
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          sum[o + reach] += g.data[y * w + x]; n[o + reach]++;
        }
      }
      if (n[reach] < piece / 2) continue;
      const prof = Array.from(sum, (v, i) => (n[i] > 0 ? v / n[i] : NaN));
      let peakAt = reach;
      for (let i = reach - slack; i <= reach + slack; i++) {
        const v = (prof[i - 1] + prof[i] + prof[i + 1]) / 3;
        if (v > (prof[peakAt - 1] + prof[peakAt] + prof[peakAt + 1]) / 3) peakAt = i;
      }
      profiles.push(Array.from({ length: 2 * 30 + 1 }, (_, j) => prof[peakAt - 30 + j]));
    }
    if (profiles.length < 3) return null;
    const profile = Array.from({ length: 61 }, (_, j) => median(profiles.map(p => p[j]).filter(v => Number.isFinite(v))) ?? NaN);
    const base = median(profile.filter((v, j) => Math.abs(j - 30) >= 24 && Number.isFinite(v)));
    if (base === null) return null;
    const top = profile[30] - base;
    if (!(top > (noise / Math.sqrt(piece)) * 4)) return null;
    let lo = 30, hi = 30;
    while (lo > 0 && profile[lo - 1] - base > top / 2) lo--;
    while (hi < 60 && profile[hi + 1] - base > top / 2) hi++;
    return hi - lo + 1;
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────

function measureGrid(g: Grid, target?: TargetSpec | null): FrameMetrics {
  const w = g.width, h = g.height;
  const pointing = { ra: g.ra, dec: g.dec };
  if (w < 8 || h < 8 || g.data.length === 0) {
    return {
      width: w, height: h, starCount: 0, fwhm: null, elongation: null, orientation: null, background: 0, noise: 0,
      gradient: 0, peakSNR: null, signal: null, streak: null, saturatedFraction: 0, target: null, spots: [], rig: g.rig, ...pointing,
    };
  }
  const map = new BackgroundMap(g, CELL);
  const noise = Math.max(map.noise, 1e-3);

  let saturated = 0;
  if (g.ceiling !== null) {
    const limit = g.ceiling * 0.98;
    for (let i = 0; i < g.data.length; i++) if (g.data[i] >= limit) saturated++;
  }

  const clip = clipLevel(g);
  const { stars, total } = detect(g, map, noise, clip);
  // Shapes from stars that are clear of the noise and not clipped; the brightest of those first.
  const measured = stars.filter(s => !s.saturated && s.snr >= 10).slice(0, MAX_MEASURED);
  const elongations = measured.map(s => s.elongation);
  const snrs = stars.slice(0, MAX_MEASURED).map(s => s.snr);

  let orientation: number | null = null;
  if (elongations.length >= 5 && (median(elongations) ?? 1) > 1.15) {
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

  // Ranked by flux with the clipped stars kept in the ranking (they are the brightest), so the window holds the
  // same stars of the field from one frame to the next; only its unclipped members are read.
  const blocks = blockMedians(g);
  const byFlux = [...stars].sort((a, b) => b.flux - a.flux);
  const window = byFlux.slice(SIGNAL_RANKS[0], SIGNAL_RANKS[1]).filter(s => !s.saturated);
  const signal = window.length >= 10 ? median(window.map(s => s.flux))
    : byFlux.length >= 10 ? median(byFlux.filter(s => !s.saturated).map(s => s.flux)) : null;

  return {
    width: w, height: h, starCount: total,
    fwhm: median(measured.map(s => s.fwhm)),
    elongation: median(elongations),
    orientation,
    background: map.level, noise, gradient: map.gradient,
    peakSNR: median(snrs),
    signal,
    streak: findStreak(g, map, noise, stars),
    saturatedFraction: saturated / (w * h),
    target: target ? measureTarget(g, blocks, target) : null,
    spots: findSpots(blocks),
    rig: g.rig,
    ...pointing,
  };
}

/** Measure one raw sub-frame from the bytes of its FITS file. Throws FrameDecodeError for a file that is not a readable image. */
export function measureFrame(buf: Buffer, target?: TargetSpec | null): FrameMetrics {
  return measureGrid(decodeGrid(buf), target);
}

/** Exposed for tests: measure a grid built in memory. */
export function measureSyntheticGrid(data: Float32Array, width: number, height: number): FrameMetrics {
  return measureGrid({ data, width, height, ceiling: null, ra: null, dec: null, wcs: null, rig: { camera: null, focal: null, scale: null } });
}
