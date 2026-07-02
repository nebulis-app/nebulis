// Shared FITS file parsing and rendering utilities.
//
// Color support: smart-telescope FITS files come in three shapes —
//   1. RGB cubes (NAXIS3=3): stacked files, already demosaiced on-device.
//      Read all three planes and render true color.
//   2. CFA mosaics (NAXIS=2 + BAYERPAT): raw sub-frames. Debayered here
//      (bilinear for the viewer, 2x2 superpixel for thumbnails).
//   3. True mono: rendered through a colormap as before.
//
// Stretch: midtone-transfer-function (MTF) autostretch, the same approach
// Siril and PixInsight use for their default screen stretch. Each channel is
// stretched independently (unlinked), which also auto-white-balances the
// typically green-tinted raw data.

interface FitsHeader {
  BITPIX?: number;
  NAXIS1?: number;
  NAXIS2?: number;
  NAXIS3?: number;
  BZERO?: number;
  BSCALE?: number;
  BAYERPAT?: string;
  ROWORDER?: string;
  [key: string]: string | number | boolean | undefined;
}

interface RgbPlanes {
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  width: number;
  height: number;
}

export interface FitsData {
  header: FitsHeader;
  /** Mono plane, raw CFA mosaic, or first plane of an RGB cube. */
  imageData: Float32Array;
  width: number;
  height: number;
  /** Present when the file is an RGB cube (NAXIS3=3) — full-res color planes. */
  rgb: RgbPlanes | null;
  /** Bayer pattern (e.g. 'RGGB') when the file is an un-debayered CFA mosaic. */
  bayerPattern: string | null;
}

export type Colormap = 'gray' | 'heat' | 'cool';

const BAYER_PATTERNS = new Set(['RGGB', 'BGGR', 'GRBG', 'GBRG']);

export function parseFits(buffer: ArrayBuffer): FitsData {
  const view = new DataView(buffer);
  const header: FitsHeader = {};
  let offset = 0;

  let headerDone = false;
  while (!headerDone) {
    for (let i = 0; i < 36 && !headerDone; i++) {
      const card = new TextDecoder('ascii').decode(new Uint8Array(buffer, offset, 80));
      offset += 80;

      if (card.startsWith('END')) {
        headerDone = true;
        break;
      }

      const key = card.substring(0, 8).trim();
      if (card[8] === '=' && key) {
        let valStr = card.substring(10, 80).trim();
        const slashIdx = valStr.indexOf('/');
        if (slashIdx > 0 && !valStr.startsWith("'")) {
          valStr = valStr.substring(0, slashIdx).trim();
        }
        if (valStr === 'T') {
          header[key] = true;
        } else if (valStr === 'F') {
          header[key] = false;
        } else if (valStr.startsWith("'")) {
          header[key] = valStr.replace(/^'|'.*$/g, '').trim();
        } else if (valStr) {
          const num = parseFloat(valStr);
          if (!isNaN(num)) header[key] = num;
        }
      }
    }
    if (!headerDone) continue;
    const remainder = offset % 2880;
    if (remainder !== 0) offset += 2880 - remainder;
  }

  const bitpix = typeof header.BITPIX === 'number' ? header.BITPIX : 16;
  const width = typeof header.NAXIS1 === 'number' ? header.NAXIS1 : 0;
  const height = typeof header.NAXIS2 === 'number' ? header.NAXIS2 : 0;
  const naxis3 = typeof header.NAXIS3 === 'number' ? header.NAXIS3 : 1;
  const bzero = typeof header.BZERO === 'number' ? header.BZERO : 0;
  const bscale = typeof header.BSCALE === 'number' ? header.BSCALE : 1;

  const pixelCount = width * height;
  const bytesPerPixel = Math.abs(bitpix) / 8;

  const readPlane = (planeIndex: number): Float32Array => {
    const plane = new Float32Array(pixelCount);
    const planeOffset = offset + planeIndex * pixelCount * bytesPerPixel;
    for (let i = 0; i < pixelCount; i++) {
      const bytePos = planeOffset + i * bytesPerPixel;
      if (bytePos + bytesPerPixel > buffer.byteLength) break;

      let rawVal: number;
      switch (bitpix) {
        case 8:   rawVal = view.getUint8(bytePos); break;
        case 16:  rawVal = view.getInt16(bytePos, false); break;
        case 32:  rawVal = view.getInt32(bytePos, false); break;
        case -32: rawVal = view.getFloat32(bytePos, false); break;
        case -64: rawVal = view.getFloat64(bytePos, false); break;
        default:  rawVal = view.getInt16(bytePos, false);
      }

      plane[i] = rawVal * bscale + bzero;
    }
    return plane;
  };

  const imageData = readPlane(0);

  // RGB cube (stacked files): planes are R, G, B in axis-3 order.
  let rgb: RgbPlanes | null = null;
  if (naxis3 === 3) {
    rgb = { r: imageData, g: readPlane(1), b: readPlane(2), width, height };
  }

  // CFA mosaic: 2-D data with a recognized Bayer pattern keyword.
  const rawPattern = typeof header.BAYERPAT === 'string' ? header.BAYERPAT.trim().toUpperCase() : '';
  const bayerPattern = rgb === null && BAYER_PATTERNS.has(rawPattern) ? rawPattern : null;

  return { header, imageData, width, height, rgb, bayerPattern };
}

// ─── Debayer (CFA mosaic → RGB planes) ────────────────────────────────────────

/**
 * Smart-telescope FITS files (SeeStar, Dwarf 3) store pixels top-down and the
 * BAYERPAT keyword applies directly in storage order — verified empirically
 * against Dwarf 3 frames by comparing debayer output to the device's own
 * renders (the row-phase-flipped alternative shows a magenta checkerboard).
 * An explicit ROWORDER=BOTTOM-UP keyword flips the display at render time
 * (see isBottomUp); the pattern still anchors at storage row 0.
 */
function cfaColorAt(pattern: string, y: number, x: number): string {
  return pattern[(y & 1) * 2 + (x & 1)];
}

/**
 * Whether rows are stored bottom-up and display must flip vertically. The FITS
 * standard says bottom-up, but smart telescopes write top-down without a
 * ROWORDER keyword — and their own JPG/PNG renders confirm it. Flipping by
 * default would mirror every image against its JPEG preview, so we only flip
 * on an explicit BOTTOM-UP.
 */
function isBottomUp(header: FitsHeader): boolean {
  return typeof header.ROWORDER === 'string' && header.ROWORDER.trim().toUpperCase() === 'BOTTOM-UP';
}

/**
 * Full-resolution bilinear debayer. Each output pixel keeps its own sample and
 * interpolates the two missing colors from immediate neighbors. Quality is
 * fine for on-screen viewing (no fringing visible at typical zoom).
 */
function debayerBilinear(mosaic: Float32Array, width: number, height: number, pattern: string): RgbPlanes {
  const pat = pattern;
  const r = new Float32Array(width * height);
  const g = new Float32Array(width * height);
  const b = new Float32Array(width * height);

  const at = (x: number, y: number): number => {
    // Clamp to edges so border pixels interpolate from what exists.
    const cx = x < 0 ? 0 : x >= width ? width - 1 : x;
    const cy = y < 0 ? 0 : y >= height ? height - 1 : y;
    return mosaic[cy * width + cx];
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const v = mosaic[idx];
      const color = cfaColorAt(pat, y, x);

      if (color === 'G') {
        g[idx] = v;
        // Horizontal neighbors are one non-green color, vertical the other.
        const hColor = cfaColorAt(pat, y, x + 1);
        const hAvg = (at(x - 1, y) + at(x + 1, y)) / 2;
        const vAvg = (at(x, y - 1) + at(x, y + 1)) / 2;
        if (hColor === 'R') { r[idx] = hAvg; b[idx] = vAvg; }
        else { b[idx] = hAvg; r[idx] = vAvg; }
      } else {
        // R or B site: green from the 4-cross, the opposite color from diagonals.
        const cross = (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) / 4;
        const diag = (at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1)) / 4;
        g[idx] = cross;
        if (color === 'R') { r[idx] = v; b[idx] = diag; }
        else { b[idx] = v; r[idx] = diag; }
      }
    }
  }

  return { r, g, b, width, height };
}

/**
 * Half-resolution superpixel debayer: each 2x2 CFA block becomes one RGB pixel
 * (greens averaged). No interpolation artifacts and 4x fewer pixels — ideal
 * for thumbnails.
 */
function debayerSuperpixel(mosaic: Float32Array, width: number, height: number, pattern: string): RgbPlanes {
  const pat = pattern;
  const w2 = Math.floor(width / 2);
  const h2 = Math.floor(height / 2);
  const r = new Float32Array(w2 * h2);
  const g = new Float32Array(w2 * h2);
  const b = new Float32Array(w2 * h2);

  // Sample offsets within each 2x2 block for each color.
  const rOff = pat.indexOf('R');
  const bOff = pat.indexOf('B');
  const g1 = pat.indexOf('G');
  const g2 = pat.lastIndexOf('G');

  const blockVal = (bx: number, by: number, cell: number): number => {
    const y = by * 2 + (cell >> 1);
    const x = bx * 2 + (cell & 1);
    return mosaic[y * width + x];
  };

  for (let by = 0; by < h2; by++) {
    for (let bx = 0; bx < w2; bx++) {
      const idx = by * w2 + bx;
      r[idx] = blockVal(bx, by, rOff);
      b[idx] = blockVal(bx, by, bOff);
      g[idx] = (blockVal(bx, by, g1) + blockVal(bx, by, g2)) / 2;
    }
  }

  return { r, g, b, width: w2, height: h2 };
}

// Debayered planes are cached per-mosaic so moving the stretch slider doesn't
// re-debayer an 8-megapixel frame on every input event.
const bilinearCache = new WeakMap<Float32Array, RgbPlanes>();
const superpixelCache = new WeakMap<Float32Array, RgbPlanes>();

function getViewerPlanes(fits: FitsData): RgbPlanes | null {
  if (fits.rgb) return fits.rgb;
  if (!fits.bayerPattern) return null;
  let planes = bilinearCache.get(fits.imageData);
  if (!planes) {
    planes = debayerBilinear(fits.imageData, fits.width, fits.height, fits.bayerPattern);
    bilinearCache.set(fits.imageData, planes);
  }
  return planes;
}

function getThumbnailPlanes(fits: FitsData): RgbPlanes | null {
  if (fits.rgb) return fits.rgb;
  if (!fits.bayerPattern) return null;
  let planes = superpixelCache.get(fits.imageData);
  if (!planes) {
    planes = debayerSuperpixel(fits.imageData, fits.width, fits.height, fits.bayerPattern);
    superpixelCache.set(fits.imageData, planes);
  }
  return planes;
}

// ─── Colormaps (mono files only) ──────────────────────────────────────────────

// Interpolate between color stops for a value in [0,1]
function lerpStops(v: number, stops: number[][]): [number, number, number] {
  const n = stops.length - 1;
  const pos = Math.max(0, Math.min(n, v * n));
  const i = Math.min(Math.floor(pos), n - 1);
  const t = pos - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function applyColormap(v: number, cm: Colormap): [number, number, number] {
  switch (cm) {
    case 'gray': {
      const b = Math.round(Math.max(0, Math.min(1, v)) * 255);
      return [b, b, b];
    }
    case 'heat': {
      // Inferno-inspired: black → purple → orange → yellow → white
      return lerpStops(v, [
        [0, 0, 4],
        [20, 11, 53],
        [58, 9, 99],
        [96, 19, 110],
        [132, 33, 107],
        [166, 54, 89],
        [197, 83, 62],
        [224, 120, 29],
        [241, 164, 12],
        [249, 210, 60],
        [252, 255, 164],
      ]);
    }
    case 'cool': {
      // Blue → cyan → white (cool astronomical palette)
      return lerpStops(v, [
        [0, 0, 0],
        [0, 0, 128],
        [0, 64, 200],
        [0, 160, 255],
        [100, 210, 255],
        [255, 255, 255],
      ]);
    }
  }
}

// ─── MTF autostretch ──────────────────────────────────────────────────────────

interface StretchParams {
  /** Input black point in native data units. */
  lo: number;
  /** Input white point in native data units. */
  hi: number;
  /** Midtone balance parameter for the MTF curve. */
  m: number;
}

/** Midtone transfer function: maps [0,1] → [0,1] with midtone balance m. */
function mtf(x: number, m: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return ((m - 1) * x) / ((2 * m - 1) * x - m);
}

/**
 * Siril/PixInsight-style autostretch for one channel: clip shadows at
 * median − 2.8·MADN and pick the midtone so the background lands at
 * `targetBg`. Statistics are computed on a sparse sample for speed.
 */
function computeAutoStretch(data: Float32Array | Float64Array, targetBg: number, sampleRate = 8): StretchParams {
  const sampled: number[] = [];
  for (let i = 0; i < data.length; i += sampleRate) {
    const v = data[i];
    if (Number.isFinite(v)) sampled.push(v);
  }
  sampled.sort((a, b) => a - b);
  const n = sampled.length;
  if (n === 0) return { lo: 0, hi: 1, m: 0.5 };

  const min = sampled[0];
  // 99.9th percentile as white point — hot pixels and star cores may clip,
  // which is what every screen stretch does.
  const hi = sampled[Math.min(n - 1, Math.floor(n * 0.999))];
  const range = hi - min;
  if (range <= 0) return { lo: min, hi: min + 1, m: 0.5 };

  const median = sampled[Math.floor(n / 2)];

  // MAD about the median (on the same sample, normalized to the data range).
  const deviations = new Float64Array(n);
  for (let i = 0; i < n; i++) deviations[i] = Math.abs(sampled[i] - median);
  deviations.sort();
  const madn = 1.4826 * deviations[Math.floor(n / 2)];

  const medNorm = (median - min) / range;
  const madnNorm = madn / range;

  // Shadow clip point (normalized), then the median's position above it.
  const c = madnNorm > 0 ? Math.max(0, medNorm - 2.8 * madnNorm) : 0;
  const xm = Math.min(1, Math.max(1e-6, (medNorm - c) / (1 - c)));

  // Solve mtf(x, m) = target for m (inverse of the midtone function).
  const solveM = (x: number, target: number): number => {
    const denom = 2 * target * x - target - x;
    if (Math.abs(denom) < 1e-9) return 0.5;
    return Math.min(1 - 1e-6, Math.max(1e-6, (x * (target - 1)) / denom));
  };

  let m = solveM(xm, targetBg);

  // Highlight guard: the background-targeting stretch assumes the median is
  // sky. For bright subjects (the Moon, planets) it would blow the subject to
  // white. If the 95th-percentile pixel would land above 0.85, relax the
  // midtone so it lands at 0.85 instead. Star fields are unaffected — their
  // 95th percentile is still background. Larger m = gentler stretch.
  const q95 = sampled[Math.floor(n * 0.95)];
  const brightNorm = ((q95 - min) / range - c) / (1 - c);
  if (brightNorm > 0 && brightNorm < 1 && mtf(brightNorm, m) > 0.85) {
    m = Math.max(m, solveM(brightNorm, 0.85));
  }

  return { lo: min + c * range, hi, m };
}

/** Apply a computed stretch to one value: native units → [0,1]. */
function applyStretch(v: number, p: StretchParams): number {
  const x = (v - p.lo) / (p.hi - p.lo);
  return mtf(x, p.m);
}

/**
 * Map the UI stretch slider (0–1) to an MTF target background level.
 * 0.5 (the default) lands on 0.25 — the Siril autostretch default.
 */
function sliderToTargetBg(stretch: number): number {
  return 0.05 + Math.max(0, Math.min(1, stretch)) * 0.4;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

/**
 * Render a parsed FITS image to a canvas at full resolution (for FitsViewer).
 * Color files (RGB cubes, Bayer mosaics) render in color with per-channel
 * autostretch; mono files render through the given colormap.
 */
export function renderFitsToCanvas(
  canvas: HTMLCanvasElement,
  fits: FitsData,
  stretch: number,
  colormap: Colormap = 'gray',
  dpr = 1,
) {
  const { width, height } = fits;
  const pw = Math.round(width * dpr);
  const ph = Math.round(height * dpr);
  canvas.width = pw;
  canvas.height = ph;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const targetBg = sliderToTargetBg(stretch);
  const planes = getViewerPlanes(fits);
  const imgData = ctx.createImageData(pw, ph);

  const flip = isBottomUp(fits.header);

  if (planes) {
    const pr = computeAutoStretch(planes.r, targetBg);
    const pg = computeAutoStretch(planes.g, targetBg);
    const pb = computeAutoStretch(planes.b, targetBg);
    const sw = planes.width;
    const sh = planes.height;
    const sx = sw / pw;
    const sy = sh / ph;
    for (let y = 0; y < ph; y++) {
      const srcY = Math.min(sh - 1, Math.floor(y * sy));
      const rowBase = (flip ? sh - 1 - srcY : srcY) * sw;
      for (let x = 0; x < pw; x++) {
        const srcIdx = rowBase + Math.min(sw - 1, Math.floor(x * sx));
        const dstIdx = (y * pw + x) * 4;
        imgData.data[dstIdx] = Math.round(applyStretch(planes.r[srcIdx], pr) * 255);
        imgData.data[dstIdx + 1] = Math.round(applyStretch(planes.g[srcIdx], pg) * 255);
        imgData.data[dstIdx + 2] = Math.round(applyStretch(planes.b[srcIdx], pb) * 255);
        imgData.data[dstIdx + 3] = 255;
      }
    }
  } else {
    const p = computeAutoStretch(fits.imageData, targetBg);
    for (let y = 0; y < ph; y++) {
      const srcY = Math.min(height - 1, Math.floor(y / dpr));
      const rowBase = (flip ? height - 1 - srcY : srcY) * width;
      for (let x = 0; x < pw; x++) {
        const srcIdx = rowBase + Math.min(width - 1, Math.floor(x / dpr));
        const dstIdx = (y * pw + x) * 4;
        const val = applyStretch(fits.imageData[srcIdx], p);
        const [r, g, b] = applyColormap(val, colormap);
        imgData.data[dstIdx] = r;
        imgData.data[dstIdx + 1] = g;
        imgData.data[dstIdx + 2] = b;
        imgData.data[dstIdx + 3] = 255;
      }
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

/**
 * Render a parsed FITS image to a square canvas of size `size x size`.
 * The image is scaled to fit inside the square with black letterboxing so the
 * canvas is always square — required because CSS object-cover doesn't apply to
 * <canvas> and a non-square canvas stretches badly in a square tile grid.
 */
export function renderFitsThumbnail(
  canvas: HTMLCanvasElement,
  fits: FitsData,
  stretch: number,
  colormap: Colormap,
  size = 512,
  dpr = 1,
) {
  const physical = Math.round(size * dpr);
  canvas.width = physical;
  canvas.height = physical;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const planes = getThumbnailPlanes(fits);
  const srcWidth = planes ? planes.width : fits.width;
  const srcHeight = planes ? planes.height : fits.height;
  if (srcWidth === 0 || srcHeight === 0) return;

  // Scale to fit within the square, preserving aspect ratio
  const scale = Math.min(physical / srcWidth, physical / srcHeight);
  const dstWidth = Math.max(1, Math.round(srcWidth * scale));
  const dstHeight = Math.max(1, Math.round(srcHeight * scale));
  const offsetX = Math.floor((physical - dstWidth) / 2);
  const offsetY = Math.floor((physical - dstHeight) / 2);

  // Black background for letterbox bars
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, physical, physical);

  const targetBg = sliderToTargetBg(stretch);
  const imgData = ctx.createImageData(dstWidth, dstHeight);
  const flip = isBottomUp(fits.header);

  if (planes) {
    const pr = computeAutoStretch(planes.r, targetBg);
    const pg = computeAutoStretch(planes.g, targetBg);
    const pb = computeAutoStretch(planes.b, targetBg);
    for (let y = 0; y < dstHeight; y++) {
      const srcY = Math.min(srcHeight - 1, Math.floor(y / scale));
      const rowBase = (flip ? srcHeight - 1 - srcY : srcY) * srcWidth;
      for (let x = 0; x < dstWidth; x++) {
        const srcIdx = rowBase + Math.min(srcWidth - 1, Math.floor(x / scale));
        const dstIdx = (y * dstWidth + x) * 4;
        imgData.data[dstIdx] = Math.round(applyStretch(planes.r[srcIdx], pr) * 255);
        imgData.data[dstIdx + 1] = Math.round(applyStretch(planes.g[srcIdx], pg) * 255);
        imgData.data[dstIdx + 2] = Math.round(applyStretch(planes.b[srcIdx], pb) * 255);
        imgData.data[dstIdx + 3] = 255;
      }
    }
  } else {
    const p = computeAutoStretch(fits.imageData, targetBg);
    for (let y = 0; y < dstHeight; y++) {
      const srcY = Math.min(srcHeight - 1, Math.floor(y / scale));
      const rowBase = (flip ? srcHeight - 1 - srcY : srcY) * srcWidth;
      for (let x = 0; x < dstWidth; x++) {
        const srcIdx = rowBase + Math.min(srcWidth - 1, Math.floor(x / scale));
        const val = applyStretch(fits.imageData[srcIdx], p);
        const [r, g, b] = applyColormap(val, colormap);
        const dstIdx = (y * dstWidth + x) * 4;
        imgData.data[dstIdx] = r;
        imgData.data[dstIdx + 1] = g;
        imgData.data[dstIdx + 2] = b;
        imgData.data[dstIdx + 3] = 255;
      }
    }
  }
  ctx.putImageData(imgData, offsetX, offsetY);
}
