/**
 * Renders a FITS file straight to a thumbnail-sized RGB picture without ever holding it at full size.
 *
 * Each output pixel is the mean of the block of source pixels under it, accumulated as the file is read one row at
 * a time, so memory is the size of the thumbnail and the cost is one pass over the pixels that are read. A Bayer
 * mosaic is averaged per colour (each block gives a red, a green and a blue), which is the debayer. This is the
 * approach of the macOS app's `FITSDecode.decodeReduced`, and the stretch is the same shared autostretch.
 *
 * It replaces decoding all three planes at full resolution, blurring each one for its statistics and then
 * sampling a few hundred pixels back out, which cost about a second for a 50 MB frame whatever the thumbnail size.
 *
 * `sparse` reads only the first row of every block (two for a Bayer mosaic, so every colour is seen). Raw
 * sub-frames are looked at as a reminder of the frame, so a quarter of the file at 8:1 is enough; a stack is
 * looked at, so it is averaged in full.
 */
import { fitsDataOffset, parseFitsHeader } from './fitsParser.js';
import { applyStretch, computeAutoStretch } from './mtfStretch.js';

const BAYER_PATTERNS = new Set(['RGGB', 'BGGR', 'GRBG', 'GBRG']);
const SUPPORTED_BITPIX = new Set([8, 16, 32, -32, -64]);

/** Below this reduction the image is already about thumbnail size; the full-resolution path is as cheap. */
const MIN_REDUCTION = 2;

export interface ReducedRender {
  /** `size` x `size` RGB bytes, the picture letterboxed on black. */
  rgb: Buffer;
}

type RowReader = (buf: Buffer, byteStart: number, count: number, out: Float32Array) => void;

function numberCard(values: Record<string, string | number | boolean>, key: string, fallback: number): number {
  const v = values[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** A reader that turns `count` samples starting at a byte offset into scaled floats. 16-bit, the common case, is byte-swapped natively. */
function rowReader(bitpix: number, bscale: number, bzero: number): RowReader {
  switch (bitpix) {
    case 16: {
      let swapped: Buffer | null = null;
      return (buf, start, count, out) => {
        if (!swapped || swapped.length < count * 2) swapped = Buffer.allocUnsafe(count * 2);
        buf.copy(swapped, 0, start, start + count * 2);
        swapped.swap16();
        const view = new Int16Array(swapped.buffer, swapped.byteOffset, count);
        for (let i = 0; i < count; i++) out[i] = view[i] * bscale + bzero;
      };
    }
    case 8:
      return (buf, start, count, out) => { for (let i = 0; i < count; i++) out[i] = buf[start + i] * bscale + bzero; };
    case 32:
      return (buf, start, count, out) => { for (let i = 0; i < count; i++) out[i] = buf.readInt32BE(start + i * 4) * bscale + bzero; };
    case -32:
      return (buf, start, count, out) => {
        for (let i = 0; i < count; i++) {
          const v = buf.readFloatBE(start + i * 4);
          out[i] = (Number.isFinite(v) ? v : 0) * bscale + bzero;
        }
      };
    default:
      return (buf, start, count, out) => {
        for (let i = 0; i < count; i++) {
          const v = buf.readDoubleBE(start + i * 8);
          out[i] = (Number.isFinite(v) ? v : 0) * bscale + bzero;
        }
      };
  }
}

/**
 * The stretched thumbnail of a FITS file, or null when the picture is too small to gain from reducing it (the
 * caller then uses the full-resolution path) or is not a layout this reads. Throws for a file that cannot be an image.
 */
export function renderReducedFits(buf: Buffer, size: number, sparse: boolean): ReducedRender | null {
  const header = parseFitsHeader(buf);
  const v = header.values;
  const bitpix = numberCard(v, 'BITPIX', 16);
  const width = numberCard(v, 'NAXIS1', 0);
  const height = numberCard(v, 'NAXIS2', 0);
  const depth = Math.max(1, numberCard(v, 'NAXIS3', 1));
  if (width <= 0 || height <= 0) {
    throw new Error(`Invalid FITS: no usable image dimensions (NAXIS1=${width}, NAXIS2=${height})`);
  }
  if (!SUPPORTED_BITPIX.has(bitpix)) throw new Error(`Invalid FITS: unsupported BITPIX ${bitpix}`);
  const bytes = Math.abs(bitpix) / 8;
  const cube = depth === 3;
  const planes = cube ? 3 : 1;
  const pixels = width * height;
  const dataStart = fitsDataOffset(buf);
  // A header that lies about its size must not become a half-black thumbnail.
  if (buf.length - dataStart < pixels * bytes * planes) {
    throw new Error(`Invalid FITS: pixel data truncated (${buf.length - dataStart} of ${pixels * bytes * planes} bytes)`);
  }

  const reduction = Math.max(width, height) / size;
  if (reduction < MIN_REDUCTION) return null;

  const bscale = numberCard(v, 'BSCALE', 1);
  const bzero = numberCard(v, 'BZERO', 0);
  const patternRaw = typeof v.BAYERPAT === 'string' ? v.BAYERPAT.toUpperCase() : '';
  const bayer = !cube && BAYER_PATTERNS.has(patternRaw) ? patternRaw : null;
  const flip = typeof v.ROWORDER === 'string' && v.ROWORDER.toUpperCase() === 'BOTTOM-UP';

  // Output grid: the picture scaled to fit the square, as the full-resolution path does.
  const scale = size / Math.max(width, height);
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  const stepX = width / outW;
  const stepY = height / outH;

  const colOf = new Int32Array(width);
  for (let x = 0; x < width; x++) colOf[x] = Math.min(outW - 1, Math.floor(x / stepX));

  // Colour of each cell of the 2 x 2 pattern: 0 red, 1 green, 2 blue.
  const cellColor = bayer ? [...bayer].map(c => (c === 'R' ? 0 : c === 'B' ? 2 : 1)) : [0, 0, 0, 0];
  const channels = bayer || cube ? 3 : 1;
  const out = Array.from({ length: channels }, () => new Float32Array(outW * outH));
  const read = rowReader(bitpix, bscale, bzero);
  const row = new Float32Array(width);

  const sums = new Float64Array(channels * outW);
  const counts = new Uint32Array(channels * outW);

  for (let plane = 0; plane < planes; plane++) {
    const planeStart = dataStart + plane * pixels * bytes;
    const target = cube ? out[plane] : null;
    for (let oy = 0; oy < outH; oy++) {
      const r0 = Math.ceil(oy * stepY - 1e-9);
      const r1 = Math.min(height, Math.ceil((oy + 1) * stepY - 1e-9));
      if (r1 <= r0) continue;
      sums.fill(0);
      counts.fill(0);

      let first = r0, last = r1;
      if (sparse && r1 - r0 >= 4) {
        // A mosaic needs both rows of a cell pair to see every colour; anything else needs one.
        first = bayer ? r0 + (r0 & 1) : r0;
        last = Math.min(r1, first + (bayer ? 2 : 1));
      }
      for (let sy = first; sy < last; sy++) {
        read(buf, planeStart + sy * width * bytes, width, row);
        if (bayer) {
          const rowBits = (sy & 1) << 1;
          for (let sx = 0; sx < width; sx++) {
            const k = cellColor[rowBits | (sx & 1)] * outW + colOf[sx];
            sums[k] += row[sx];
            counts[k]++;
          }
        } else {
          for (let sx = 0; sx < width; sx++) {
            const k = colOf[sx];
            sums[k] += row[sx];
            counts[k]++;
          }
        }
      }

      const base = oy * outW;
      if (bayer) {
        for (let c = 0; c < 3; c++) {
          for (let ox = 0; ox < outW; ox++) {
            const k = c * outW + ox;
            out[c][base + ox] = counts[k] > 0 ? sums[k] / counts[k] : 0;
          }
        }
      } else {
        const dest = target ?? out[0];
        for (let ox = 0; ox < outW; ox++) dest[base + ox] = counts[ox] > 0 ? sums[ox] / counts[ox] : 0;
      }
    }
  }

  // Stretch each channel from the reduced picture, which is already smooth: no separate blur is needed.
  const sampleRate = Math.max(1, Math.floor((outW * outH) / 60_000));
  const params = out.map(ch => computeAutoStretch(ch, sampleRate));
  const offX = Math.floor((size - outW) / 2);
  const offY = Math.floor((size - outH) / 2);
  const rgb = Buffer.alloc(size * size * 3, 0);
  for (let y = 0; y < outH; y++) {
    const srcRow = (flip ? outH - 1 - y : y) * outW;
    for (let x = 0; x < outW; x++) {
      const dst = ((offY + y) * size + (offX + x)) * 3;
      const i = srcRow + x;
      if (channels === 3) {
        rgb[dst] = Math.round(applyStretch(out[0][i], params[0]) * 255);
        rgb[dst + 1] = Math.round(applyStretch(out[1][i], params[1]) * 255);
        rgb[dst + 2] = Math.round(applyStretch(out[2][i], params[2]) * 255);
      } else {
        rgb[dst] = rgb[dst + 1] = rgb[dst + 2] = Math.round(applyStretch(out[0][i], params[0]) * 255);
      }
    }
  }
  return { rgb };
}
