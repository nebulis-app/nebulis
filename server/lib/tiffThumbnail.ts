import fs from 'fs';
import path from 'path';
import sharp from './sharp-optional.js';
import { computeAutoStretch, applyStretch } from './mtfStretch.js';

// Bumped when the rendering pipeline changes so stale thumbnails regenerate.
export type TiffThumbnailTier = 'thumb' | 'preview';

const TIERS: Record<TiffThumbnailTier, { size: number; suffix: string }> = {
  thumb: { size: 256, suffix: '.tiff.v1.jpg' },
  preview: { size: 1024, suffix: '.tiff.preview.v1.jpg' },
};

/** Thumbnail path for a TIFF file (in the `.thumbs/` dir next to it). */
export function tiffThumbnailPath(tiffPath: string, tier: TiffThumbnailTier = 'thumb'): string {
  return path.join(path.dirname(tiffPath), '.thumbs', path.basename(tiffPath) + TIERS[tier].suffix);
}

/**
 * Generate a square JPEG thumbnail for a TIFF and save it to a `.thumbs/`
 * subdirectory next to the source file. No-ops if the thumbnail already
 * exists. Throws on read or write failure.
 *
 * A Dwarf's `img_stacked_all.tif` is a ~100 MB, 32-bit float, scene-linear
 * RGB master stack. Handing it to sharp's normal resize+encode path (as any
 * other renderable image gets) produces a solid white square: sharp reads
 * the pixels as scRGB where 1.0 is white, but the stored samples run into
 * the millions, so every pixel clips (see server/lib/library/observations.ts
 * for the measurements that pinned this down). The fix is the same one
 * server/lib/fitsThumbnail.ts already applies to FITS: read the true linear
 * sample values directly and run them through an MTF autostretch before
 * ever handing bytes to sharp.
 *
 * That direct read only makes sense for the exact shape these devices write
 * (uncompressed, chunky, 32-bit IEEE float). Anything else — an ordinary
 * 8-bit TIFF, for instance — has no clipping problem and sharp's normal
 * resize+encode already renders it fine, so `readLinearFloatIfd` returns
 * null for those and this falls back to that plain path instead of failing.
 */
export async function generateTiffThumbnail(
  tiffPath: string,
  tier: TiffThumbnailTier = 'thumb',
): Promise<void> {
  const thumbPath = tiffThumbnailPath(tiffPath, tier);
  if (fs.existsSync(thumbPath)) return;

  fs.mkdirSync(path.dirname(thumbPath), { recursive: true });
  const tmpPath = `${thumbPath}.${process.pid}.tmp`;
  const size = TIERS[tier].size;

  try {
    const ifd = safeParseLinearFloatIfd(tiffPath);
    if (ifd) {
      const rgb = renderLinearFloatToRgbBuffer(tiffPath, ifd, size);
      await sharp(rgb, { raw: { width: size, height: size, channels: 3 } })
        .jpeg({ quality: 85 })
        .toFile(tmpPath);
    } else {
      // Not the linear-float shape this module exists for (e.g. an ordinary
      // 8-bit TIFF) — sharp's normal path has no clipping problem for those.
      await sharp(tiffPath)
        .resize(size, size, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toFile(tmpPath);
    }
    await fs.promises.rename(tmpPath, thumbPath);
  } catch (err) {
    try { await fs.promises.rm(tmpPath, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

// ─── Minimal TIFF IFD reader ───────────────────────────────────────────────
//
// Only reads the handful of baseline tags needed to locate pixel data and
// decide whether this is the uncompressed/chunky/32-bit-float shape Dwarf
// firmware writes. Anything else (compressed, tiled, planar, 8/16-bit) is
// deliberately not handled here — sharp already renders those correctly.

interface LinearFloatIfd {
  width: number;
  height: number;
  samplesPerPixel: number;
  rowsPerStrip: number;
  stripOffsets: number[];
  stripByteCounts: number[];
}

const TIFF_TAG_SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8 };

function safeParseLinearFloatIfd(tiffPath: string): LinearFloatIfd | null {
  try {
    return parseLinearFloatIfd(tiffPath);
  } catch {
    return null;
  }
}

function parseLinearFloatIfd(tiffPath: string): LinearFloatIfd | null {
  // The IFD sits after the (potentially huge) pixel block, but tag entries
  // themselves are a small fixed-size structure — read a header chunk first,
  // find the IFD offset, then read just the IFD bytes rather than the whole
  // file.
  const fd = fs.openSync(tiffPath, 'r');
  try {
    const head = Buffer.alloc(8);
    fs.readSync(fd, head, 0, 8, 0);
    const byteOrder = head.toString('ascii', 0, 2);
    // Little-endian only: the inline-value masking below for count-1 SHORT
    // tags (see `shortOrLong`) assumes the 2-byte value sits in the low bytes
    // of the 4-byte slot, which is only true for 'II'. Every device this
    // parser targets writes 'II'; a big-endian file just falls back to sharp.
    if (byteOrder !== 'II') return null;
    const little = true;
    const view0 = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (view0.getUint16(2, little) !== 42) return null;
    const ifdOffset = view0.getUint32(4, little);

    const countBuf = Buffer.alloc(2);
    fs.readSync(fd, countBuf, 0, 2, ifdOffset);
    const numEntries = new DataView(countBuf.buffer, countBuf.byteOffset, 2).getUint16(0, little);

    const entriesBuf = Buffer.alloc(numEntries * 12);
    fs.readSync(fd, entriesBuf, 0, entriesBuf.length, ifdOffset + 2);
    const view = new DataView(entriesBuf.buffer, entriesBuf.byteOffset, entriesBuf.byteLength);

    const tags = new Map<number, { type: number; count: number; offset: number; inlineValue: number }>();
    for (let i = 0; i < numEntries; i++) {
      const base = i * 12;
      const tag = view.getUint16(base, little);
      const type = view.getUint16(base + 2, little);
      const count = view.getUint32(base + 4, little);
      const size = (TIFF_TAG_SIZES[type] || 1) * count;
      const inlineValue = size <= 4 ? view.getUint32(base + 8, little) : 0;
      const offset = size <= 4 ? -1 : view.getUint32(base + 8, little);
      tags.set(tag, { type, count, offset, inlineValue });
    }

    const shortOrLong = (tagId: number): number | null => {
      const t = tags.get(tagId);
      if (!t) return null;
      return t.type === 3 ? (t.inlineValue & 0xffff) : t.inlineValue;
    };

    const width = shortOrLong(256);
    const height = shortOrLong(257);
    const compression = shortOrLong(259) ?? 1;
    const samplesPerPixel = shortOrLong(277) ?? 1;
    const rowsPerStrip = shortOrLong(278) ?? height ?? 0;
    const planarConfig = shortOrLong(284) ?? 1;
    const bitsPerSampleTag = tags.get(258);
    const sampleFormatTag = tags.get(339);
    // BitsPerSample/SampleFormat carry one value per sample when
    // SamplesPerPixel > 1, but the Dwarf writer uses the same bit depth and
    // format for every channel, so reading the first is sufficient to decide
    // whether this is the shape we handle specially.
    const bitsPerSample = bitsPerSampleTag
      ? readTagFirstValue(fd, bitsPerSampleTag, little)
      : null;
    const sampleFormat = sampleFormatTag
      ? readTagFirstValue(fd, sampleFormatTag, little)
      : 1; // default: unsigned integer

    if (
      width == null || height == null || width <= 0 || height <= 0
      || compression !== 1 // uncompressed only
      || planarConfig !== 1 // chunky (interleaved) only
      || bitsPerSample !== 32
      || sampleFormat !== 3 // IEEE float
      || (samplesPerPixel !== 1 && samplesPerPixel !== 3)
    ) {
      return null;
    }

    const stripOffsetsTag = tags.get(273);
    const stripByteCountsTag = tags.get(279);
    if (!stripOffsetsTag || !stripByteCountsTag) return null;

    const stripOffsets = readTagArray(fd, stripOffsetsTag, little);
    const stripByteCounts = readTagArray(fd, stripByteCountsTag, little);
    if (stripOffsets.length === 0 || stripOffsets.length !== stripByteCounts.length) return null;

    return { width, height, samplesPerPixel, rowsPerStrip: rowsPerStrip || height, stripOffsets, stripByteCounts };
  } finally {
    fs.closeSync(fd);
  }
}

function readTagFirstValue(
  fd: number,
  tag: { type: number; count: number; offset: number; inlineValue: number },
  little: boolean,
): number {
  if (tag.count === 1 || tag.offset === -1) {
    return tag.type === 3 ? (tag.inlineValue & 0xffff) : tag.inlineValue;
  }
  const size = TIFF_TAG_SIZES[tag.type] || 1;
  const buf = Buffer.alloc(size);
  fs.readSync(fd, buf, 0, size, tag.offset);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return tag.type === 3 ? view.getUint16(0, little) : view.getUint32(0, little);
}

function readTagArray(
  fd: number,
  tag: { type: number; count: number; offset: number; inlineValue: number },
  little: boolean,
): number[] {
  const size = TIFF_TAG_SIZES[tag.type] || 1;
  if (tag.offset === -1) {
    // Inline (fits in the 4-byte value slot) — only possible for count 1-2.
    if (tag.count === 1) return [tag.type === 3 ? (tag.inlineValue & 0xffff) : tag.inlineValue];
    if (tag.type === 3 && tag.count === 2) {
      return [tag.inlineValue & 0xffff, (tag.inlineValue >>> 16) & 0xffff];
    }
    return [tag.inlineValue];
  }
  const buf = Buffer.alloc(size * tag.count);
  fs.readSync(fd, buf, 0, buf.length, tag.offset);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const arr: number[] = new Array(tag.count);
  for (let i = 0; i < tag.count; i++) {
    arr[i] = tag.type === 3 ? view.getUint16(i * size, little) : view.getUint32(i * size, little);
  }
  return arr;
}

// ─── Render (row-at-a-time strip read → per-channel MTF autostretch) ───────

function renderLinearFloatToRgbBuffer(tiffPath: string, ifd: LinearFloatIfd, size: number): Buffer {
  const { width, height, samplesPerPixel, rowsPerStrip, stripOffsets, stripByteCounts } = ifd;
  const rowBytes = width * samplesPerPixel * 4;

  const fd = fs.openSync(tiffPath, 'r');
  let r: Float32Array, g: Float32Array, b: Float32Array;
  try {
    r = new Float32Array(width * height);
    g = samplesPerPixel === 3 ? new Float32Array(width * height) : r;
    b = samplesPerPixel === 3 ? new Float32Array(width * height) : r;

    const rowBuf = Buffer.alloc(rowBytes);
    for (let y = 0; y < height; y++) {
      const stripIndex = Math.min(stripOffsets.length - 1, Math.floor(y / rowsPerStrip));
      const rowInStrip = y - stripIndex * rowsPerStrip;
      const rowOffset = stripOffsets[stripIndex] + rowInStrip * rowBytes;
      if (rowOffset + rowBytes > stripOffsets[stripIndex] + stripByteCounts[stripIndex]) continue;
      fs.readSync(fd, rowBuf, 0, rowBytes, rowOffset);
      const view = new DataView(rowBuf.buffer, rowBuf.byteOffset, rowBuf.byteLength);
      const rowBase = y * width;
      if (samplesPerPixel === 3) {
        for (let x = 0; x < width; x++) {
          const off = x * 12;
          r[rowBase + x] = view.getFloat32(off, true);
          g[rowBase + x] = view.getFloat32(off + 4, true);
          b[rowBase + x] = view.getFloat32(off + 8, true);
        }
      } else {
        for (let x = 0; x < width; x++) {
          r[rowBase + x] = view.getFloat32(x * 4, true);
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  const pr = computeAutoStretch(r);
  const pg = samplesPerPixel === 3 ? computeAutoStretch(g) : pr;
  const pb = samplesPerPixel === 3 ? computeAutoStretch(b) : pr;

  const scale = Math.min(size / width, size / height);
  const dstW = Math.max(1, Math.round(width * scale));
  const dstH = Math.max(1, Math.round(height * scale));
  const offX = Math.floor((size - dstW) / 2);
  const offY = Math.floor((size - dstH) / 2);

  const rgb = Buffer.alloc(size * size * 3, 0);
  for (let y = 0; y < dstH; y++) {
    const srcY = Math.min(height - 1, Math.floor(y / scale));
    const rowBase = srcY * width;
    for (let x = 0; x < dstW; x++) {
      const srcIdx = rowBase + Math.min(width - 1, Math.floor(x / scale));
      const dstIdx = ((offY + y) * size + (offX + x)) * 3;
      rgb[dstIdx] = Math.round(applyStretch(r[srcIdx], pr) * 255);
      rgb[dstIdx + 1] = Math.round(applyStretch(g[srcIdx], pg) * 255);
      rgb[dstIdx + 2] = Math.round(applyStretch(b[srcIdx], pb) * 255);
    }
  }
  return rgb;
}
