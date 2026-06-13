import fs from 'fs';
import path from 'path';
import sharp from './sharp-optional.js';

const THUMB_SIZE = 256;

/**
 * Generate a square JPEG thumbnail for a FITS subframe and save it to a
 * `.thumbs/` subdirectory next to the source file. No-ops if the thumbnail
 * already exists. Throws on parse or write failure.
 */
export async function generateFitsThumbnail(fitsPath: string): Promise<void> {
  const thumbDir = path.join(path.dirname(fitsPath), '.thumbs');
  const thumbPath = path.join(thumbDir, path.basename(fitsPath) + '.jpg');

  if (fs.existsSync(thumbPath)) return;

  fs.mkdirSync(thumbDir, { recursive: true });

  const nodeBuffer = fs.readFileSync(fitsPath);
  // Node.js Buffer may share its underlying ArrayBuffer with an offset — slice
  // to get a clean, offset-free ArrayBuffer before handing to DataView.
  const ab = nodeBuffer.buffer.slice(
    nodeBuffer.byteOffset,
    nodeBuffer.byteOffset + nodeBuffer.byteLength,
  ) as ArrayBuffer;

  const { imageData, width, height } = parseFitsPixels(ab);
  if (width === 0 || height === 0 || imageData.length === 0) {
    throw new Error('FITS file has zero dimensions or no pixel data');
  }

  const rgb = renderToRgbBuffer(imageData, width, height, 0.5, THUMB_SIZE);

  await sharp(rgb, { raw: { width: THUMB_SIZE, height: THUMB_SIZE, channels: 3 } })
    .jpeg({ quality: 85 })
    .toFile(thumbPath);
}

// ─── FITS pixel parser (mirrors src/lib/fits.ts — browser DataView works in Node too) ───

interface FitsPixels {
  imageData: Float64Array;
  width: number;
  height: number;
}

function parseFitsPixels(buffer: ArrayBuffer): FitsPixels {
  const view = new DataView(buffer);
  let offset = 0;
  let bitpix = 16, width = 0, height = 0, bzero = 0, bscale = 1;
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
        const num = parseFloat(val);
        if (!isNaN(num)) {
          if      (key === 'BITPIX') bitpix = num;
          else if (key === 'NAXIS1') width  = num;
          else if (key === 'NAXIS2') height = num;
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
  const imageData = new Float64Array(count);

  for (let i = 0; i < count; i++) {
    const pos = offset + i * bpp;
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
    imageData[i] = raw * bscale + bzero;
  }

  return { imageData, width, height };
}

// ─── Stretch + render to a square grayscale RGB Buffer ────────────────────────

function renderToRgbBuffer(
  imageData: Float64Array,
  srcWidth: number,
  srcHeight: number,
  stretch: number,
  size: number,
): Buffer {
  // Sample every 8th pixel for stretch bounds (same as client)
  const sampled: number[] = [];
  for (let i = 0; i < imageData.length; i += 8) sampled.push(imageData[i]);
  sampled.sort((a, b) => a - b);
  const lo    = sampled[Math.floor(sampled.length * 0.02)];
  const hi    = sampled[Math.floor(sampled.length * (0.98 + stretch * 0.019))];
  const range = hi - lo || 1;
  const gamma = 1.0 / (1.0 + stretch * 0.5);

  // Scale to fit within the square, black letterboxing (mirrors renderFitsThumbnail)
  const scale = Math.min(size / srcWidth, size / srcHeight);
  const dstW  = Math.max(1, Math.round(srcWidth  * scale));
  const dstH  = Math.max(1, Math.round(srcHeight * scale));
  const offX  = Math.floor((size - dstW) / 2);
  const offY  = Math.floor((size - dstH) / 2);

  const rgb = Buffer.alloc(size * size * 3, 0); // black background

  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const srcX   = Math.min(srcWidth  - 1, Math.floor(x / scale));
      const srcY   = Math.min(srcHeight - 1, Math.floor(y / scale));
      const srcIdx = (srcHeight - 1 - srcY) * srcWidth + srcX; // FITS is bottom-up
      const norm   = (imageData[srcIdx] - lo) / range;
      const v      = Math.max(0, Math.min(1, Math.pow(Math.max(0, norm), gamma)));
      const byte   = Math.round(v * 255);
      const dstIdx = ((offY + y) * size + (offX + x)) * 3;
      rgb[dstIdx] = rgb[dstIdx + 1] = rgb[dstIdx + 2] = byte;
    }
  }

  return rgb;
}
