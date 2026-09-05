import fs from 'fs';
import path from 'path';
import sharp from './sharp-optional.js';
import { computeAutoStretch, applyStretch } from './mtfStretch.js';

// Bumped when the rendering pipeline changes so stale thumbnails regenerate.
// v2: color (RGB cubes + debayered CFA mosaics) with MTF autostretch.
// v3: autostretch statistics are computed from a blurred copy of each channel
//     (smoothForStats) instead of the raw superpixel-debayered plane. The raw
//     R/B channels keep one un-averaged CFA sample per 2x2 block, which
//     inflated the MAD estimate enough to collapse the shadow-clip point to 0
//     and leave Bayer-mosaic thumbnails looking washed out next to the
//     full-resolution viewer's bilinear-smoothed stats.
//
// Two size tiers share the same pipeline:
//   - 'thumb'   256px, for grid/list previews (generated eagerly on import).
//   - 'preview' 1024px, for a full-screen preview that still avoids shipping
//     the multi-MB FITS to a phone. Generated lazily on first request.
export type FitsThumbnailTier = 'thumb' | 'preview';

// Exposed so route handlers can put it in the URL's query string. The
// `/fits-thumbnail` route is served with a long-lived `Cache-Control`, so a
// pipeline change that doesn't also change the *request URL* never reaches a
// client that already has the old image cached — it'll keep serving the
// stale render indefinitely regardless of what regenerates on disk.
export const FITS_THUMBNAIL_PIPELINE_VERSION = 'v3';

const TIERS: Record<FitsThumbnailTier, { size: number; suffix: string }> = {
  thumb: { size: 256, suffix: `.${FITS_THUMBNAIL_PIPELINE_VERSION}.jpg` },
  preview: { size: 1024, suffix: `.preview.${FITS_THUMBNAIL_PIPELINE_VERSION}.jpg` },
};

/** Thumbnail path for a FITS file (in the `.thumbs/` dir next to it). */
export function fitsThumbnailPath(fitsPath: string, tier: FitsThumbnailTier = 'thumb'): string {
  return path.join(path.dirname(fitsPath), '.thumbs', path.basename(fitsPath) + TIERS[tier].suffix);
}

/** Thumbnail filename relative to the object folder, for URL building. */
export function fitsThumbnailRelName(fileName: string, tier: FitsThumbnailTier = 'thumb'): string {
  return fileName + TIERS[tier].suffix;
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
export async function generateFitsThumbnail(
  fitsPath: string,
  tier: FitsThumbnailTier = 'thumb',
): Promise<void> {
  const thumbPath = fitsThumbnailPath(fitsPath, tier);
  if (fs.existsSync(thumbPath)) return;

  fs.mkdirSync(path.dirname(thumbPath), { recursive: true });

  const nodeBuffer = fs.readFileSync(fitsPath);
  // Node.js Buffer may share its underlying ArrayBuffer with an offset, so copy
  // the bytes out to get a clean, offset-free ArrayBuffer before handing it to
  // DataView. Copying through Uint8Array (rather than `buffer.slice(...)`)
  // gives a genuine `ArrayBuffer` back: `Buffer.buffer` is typed
  // `ArrayBufferLike`, which is what the assertion here used to paper over.
  const ab = new Uint8Array(nodeBuffer).buffer;

  const parsed = parseFitsPixels(ab);
  if (parsed.width === 0 || parsed.height === 0 || parsed.imageData.length === 0) {
    throw new Error('FITS file has zero dimensions or no pixel data');
  }

  const size = TIERS[tier].size;
  const rgb = renderToRgbBuffer(parsed, size);

  await sharp(rgb, { raw: { width: size, height: size, channels: 3 } })
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

// ─── Render to a square RGB Buffer ────────────────────────────────────────────

/**
 * 3x3 box blur, edge-clamped. Used only to derive autostretch statistics, never
 * to render pixels.
 *
 * The superpixel debayer above keeps exactly one raw, un-averaged CFA sample
 * per 2x2 block for the R and B channels (only G gets a 2-tap average). That
 * raw noise inflates the MAD estimate in computeAutoStretch enough that the
 * shadow-clip point collapses to 0 — the background noise floor never gets
 * crushed to black, and the thumbnail reads as flat and washed out. The
 * full-resolution viewer (src/lib/fits.ts) doesn't hit this: its bilinear
 * debayer interpolates every pixel from 2-4 neighbors, which is inherently
 * smoother. Blurring a copy purely for statistics — while still stretching
 * the original, unsmoothed plane per-pixel — gives the thumbnail the same
 * stable black point without softening the rendered image.
 */
function smoothForStats(plane: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(plane.length);
  const at = (x: number, y: number): number => {
    const cx = x < 0 ? 0 : x >= width ? width - 1 : x;
    const cy = y < 0 ? 0 : y >= height ? height - 1 : y;
    return plane[cy * width + cx];
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) sum += at(x + dx, y + dy);
      }
      out[y * width + x] = sum / 9;
    }
  }
  return out;
}

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
    const pr = computeAutoStretch(smoothForStats(planes.r, planes.width, planes.height));
    const pg = computeAutoStretch(smoothForStats(planes.g, planes.width, planes.height));
    const pb = computeAutoStretch(smoothForStats(planes.b, planes.width, planes.height));
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
    const p = computeAutoStretch(smoothForStats(parsed.imageData, parsed.width, parsed.height));
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
