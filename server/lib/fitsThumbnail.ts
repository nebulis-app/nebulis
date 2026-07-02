import fs from 'fs';
import path from 'path';
import sharp from './sharp-optional.js';

const THUMB_SIZE = 256;

// Bumped when the rendering pipeline changes so stale thumbnails regenerate.
// v2: color (RGB cubes + debayered CFA mosaics) with MTF autostretch.
const THUMB_SUFFIX = '.v2.jpg';

/** Thumbnail path for a FITS file (in the `.thumbs/` dir next to it). */
export function fitsThumbnailPath(fitsPath: string): string {
  return path.join(path.dirname(fitsPath), '.thumbs', path.basename(fitsPath) + THUMB_SUFFIX);
}

/** Thumbnail filename relative to the object folder, for URL building. */
export function fitsThumbnailRelName(fileName: string): string {
  return fileName + THUMB_SUFFIX;
}

/**
 * Generate a square JPEG thumbnail for a FITS subframe and save it to a
 * `.thumbs/` subdirectory next to the source file. No-ops if the thumbnail
 * already exists. Throws on parse or write failure.
 *
 * Color handling mirrors src/lib/fits.ts: RGB cubes (NAXIS3=3) read all three
 * planes; Bayer mosaics (BAYERPAT) are debayered with a 2x2 superpixel pass;
 * everything is stretched with a per-channel MTF autostretch.
 */
export async function generateFitsThumbnail(fitsPath: string): Promise<void> {
  const thumbPath = fitsThumbnailPath(fitsPath);
  if (fs.existsSync(thumbPath)) return;

  fs.mkdirSync(path.dirname(thumbPath), { recursive: true });

  const nodeBuffer = fs.readFileSync(fitsPath);
  // Node.js Buffer may share its underlying ArrayBuffer with an offset — slice
  // to get a clean, offset-free ArrayBuffer before handing to DataView.
  const ab = nodeBuffer.buffer.slice(
    nodeBuffer.byteOffset,
    nodeBuffer.byteOffset + nodeBuffer.byteLength,
  ) as ArrayBuffer;

  const parsed = parseFitsPixels(ab);
  if (parsed.width === 0 || parsed.height === 0 || parsed.imageData.length === 0) {
    throw new Error('FITS file has zero dimensions or no pixel data');
  }

  const rgb = renderToRgbBuffer(parsed, THUMB_SIZE);

  await sharp(rgb, { raw: { width: THUMB_SIZE, height: THUMB_SIZE, channels: 3 } })
    .jpeg({ quality: 85 })
    .toFile(thumbPath);
}

// ─── FITS pixel parser (mirrors src/lib/fits.ts — browser DataView works in Node too) ───

interface RgbPlanes {
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  width: number;
  height: number;
}

interface FitsPixels {
  imageData: Float32Array;
  width: number;
  height: number;
  /** Present when the file is an RGB cube (NAXIS3=3). */
  rgb: RgbPlanes | null;
  /** Bayer pattern when the file is an un-debayered CFA mosaic. */
  bayerPattern: string | null;
  rowOrder: string;
}

const BAYER_PATTERNS = new Set(['RGGB', 'BGGR', 'GRBG', 'GBRG']);

function parseFitsPixels(buffer: ArrayBuffer): FitsPixels {
  const view = new DataView(buffer);
  let offset = 0;
  let bitpix = 16, width = 0, height = 0, naxis3 = 1, bzero = 0, bscale = 1;
  // No ROWORDER keyword means top-down for smart-telescope files (their own
  // JPG renders confirm it), despite the FITS standard saying bottom-up.
  let bayerRaw = '', rowOrder = '';
  let headerDone = false;

  while (!headerDone) {
    for (let i = 0; i < 36 && !headerDone; i++) {
      const card = new TextDecoder('ascii').decode(new Uint8Array(buffer, offset, 80));
      offset += 80;
      if (card.startsWith('END')) { headerDone = true; break; }
      const key = card.substring(0, 8).trim();
      if (card[8] === '=' && key) {
        let val = card.substring(10, 80).trim();
        const sl = val.indexOf('/');
        if (sl > 0 && !val.startsWith("'")) val = val.substring(0, sl).trim();
        if (val.startsWith("'")) {
          const str = val.replace(/^'|'.*$/g, '').trim();
          if      (key === 'BAYERPAT') bayerRaw = str.toUpperCase();
          else if (key === 'ROWORDER') rowOrder = str.toUpperCase();
          continue;
        }
        const num = parseFloat(val);
        if (!isNaN(num)) {
          if      (key === 'BITPIX') bitpix = num;
          else if (key === 'NAXIS1') width  = num;
          else if (key === 'NAXIS2') height = num;
          else if (key === 'NAXIS3') naxis3 = num;
          else if (key === 'BZERO')  bzero  = num;
          else if (key === 'BSCALE') bscale = num;
        }
      }
    }
    if (!headerDone) continue;
    const rem = offset % 2880;
    if (rem !== 0) offset += 2880 - rem;
  }

  const count = width * height;
  const bpp   = Math.abs(bitpix) / 8;

  const readPlane = (planeIndex: number): Float32Array => {
    const plane = new Float32Array(count);
    const planeOffset = offset + planeIndex * count * bpp;
    for (let i = 0; i < count; i++) {
      const pos = planeOffset + i * bpp;
      if (pos + bpp > buffer.byteLength) break;
      let raw: number;
      switch (bitpix) {
        case   8: raw = view.getUint8(pos); break;
        case  16: raw = view.getInt16(pos, false); break;
        case  32: raw = view.getInt32(pos, false); break;
        case -32: raw = view.getFloat32(pos, false); break;
        case -64: raw = view.getFloat64(pos, false); break;
        default:  raw = view.getInt16(pos, false);
      }
      plane[i] = raw * bscale + bzero;
    }
    return plane;
  };

  const imageData = readPlane(0);
  let rgb: RgbPlanes | null = null;
  if (naxis3 === 3) {
    rgb = { r: imageData, g: readPlane(1), b: readPlane(2), width, height };
  }
  const bayerPattern = rgb === null && BAYER_PATTERNS.has(bayerRaw) ? bayerRaw : null;

  return { imageData, width, height, rgb, bayerPattern, rowOrder };
}

// ─── Superpixel debayer (mirrors src/lib/fits.ts) ─────────────────────────────

// BAYERPAT applies directly in storage order — verified empirically against
// Dwarf 3 frames (the row-phase-flipped alternative produces a magenta
// checkerboard). See src/lib/fits.ts for the full notes.
function debayerSuperpixel(mosaic: Float32Array, width: number, height: number, pattern: string): RgbPlanes {
  const pat = pattern;
  const w2 = Math.floor(width / 2);
  const h2 = Math.floor(height / 2);
  const r = new Float32Array(w2 * h2);
  const g = new Float32Array(w2 * h2);
  const b = new Float32Array(w2 * h2);

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

// ─── MTF autostretch (mirrors src/lib/fits.ts) ────────────────────────────────

interface StretchParams { lo: number; hi: number; m: number }

function mtf(x: number, m: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return ((m - 1) * x) / ((2 * m - 1) * x - m);
}

const TARGET_BG = 0.25; // Siril autostretch default

function computeAutoStretch(data: Float32Array, sampleRate = 8): StretchParams {
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

  // Highlight guard (mirrors src/lib/fits.ts): keep bright subjects like the
  // Moon from blowing out — if the 95th-percentile pixel would land above
  // 0.85, relax the midtone so it lands at 0.85 instead.
  const q95 = sampled[Math.floor(n * 0.95)];
  const brightNorm = ((q95 - min) / range - c) / (1 - c);
  if (brightNorm > 0 && brightNorm < 1 && mtf(brightNorm, m) > 0.85) {
    m = Math.max(m, solveM(brightNorm, 0.85));
  }

  return { lo: min + c * range, hi, m };
}

function applyStretch(v: number, p: StretchParams): number {
  return mtf((v - p.lo) / (p.hi - p.lo), p.m);
}

// ─── Render to a square RGB Buffer ────────────────────────────────────────────

function renderToRgbBuffer(parsed: FitsPixels, size: number): Buffer {
  // Pick the color source: cube planes, debayered mosaic, or mono.
  const planes = parsed.rgb
    ?? (parsed.bayerPattern
      ? debayerSuperpixel(parsed.imageData, parsed.width, parsed.height, parsed.bayerPattern)
      : null);

  // Smart telescopes store rows top-down (matching their own JPG renders);
  // flip only on an explicit FITS-standard BOTTOM-UP keyword.
  const flip = parsed.rowOrder === 'BOTTOM-UP';

  const srcW = planes ? planes.width : parsed.width;
  const srcH = planes ? planes.height : parsed.height;

  // Scale to fit within the square, black letterboxing (mirrors renderFitsThumbnail)
  const scale = Math.min(size / srcW, size / srcH);
  const dstW  = Math.max(1, Math.round(srcW * scale));
  const dstH  = Math.max(1, Math.round(srcH * scale));
  const offX  = Math.floor((size - dstW) / 2);
  const offY  = Math.floor((size - dstH) / 2);

  const rgb = Buffer.alloc(size * size * 3, 0); // black background

  if (planes) {
    const pr = computeAutoStretch(planes.r);
    const pg = computeAutoStretch(planes.g);
    const pb = computeAutoStretch(planes.b);
    for (let y = 0; y < dstH; y++) {
      const srcY = Math.min(srcH - 1, Math.floor(y / scale));
      const rowBase = (flip ? srcH - 1 - srcY : srcY) * srcW;
      for (let x = 0; x < dstW; x++) {
        const srcIdx = rowBase + Math.min(srcW - 1, Math.floor(x / scale));
        const dstIdx = ((offY + y) * size + (offX + x)) * 3;
        rgb[dstIdx]     = Math.round(applyStretch(planes.r[srcIdx], pr) * 255);
        rgb[dstIdx + 1] = Math.round(applyStretch(planes.g[srcIdx], pg) * 255);
        rgb[dstIdx + 2] = Math.round(applyStretch(planes.b[srcIdx], pb) * 255);
      }
    }
  } else {
    const p = computeAutoStretch(parsed.imageData);
    for (let y = 0; y < dstH; y++) {
      const srcY = Math.min(srcH - 1, Math.floor(y / scale));
      const rowBase = (flip ? srcH - 1 - srcY : srcY) * srcW;
      for (let x = 0; x < dstW; x++) {
        const srcIdx = rowBase + Math.min(srcW - 1, Math.floor(x / scale));
        const byte = Math.round(applyStretch(parsed.imageData[srcIdx], p) * 255);
        const dstIdx = ((offY + y) * size + (offX + x)) * 3;
        rgb[dstIdx] = rgb[dstIdx + 1] = rgb[dstIdx + 2] = byte;
      }
    }
  }

  return rgb;
}
