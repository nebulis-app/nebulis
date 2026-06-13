/**
 * Minimal JPEG EXIF reader — extracts DateTimeOriginal (tag 0x9003) from the
 * EXIF APP1 header using only Node built-ins.
 *
 * Reads at most the first 64 KB of a file, which is always enough for EXIF.
 * Both functions return 'YYYY-MM-DD' or null; they never throw.
 */

import fs from 'node:fs';

const MAX_HEADER_BYTES = 65536;

/** Read DateTimeOriginal from a JPEG file on disk (reads first 64 KB only). */
export function exifDateFromFile(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(MAX_HEADER_BYTES);
    const n = fs.readSync(fd, buf, 0, MAX_HEADER_BYTES, 0);
    return exifDateFromBuffer(buf.subarray(0, n));
  } catch {
    return null;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Extract DateTimeOriginal from a Buffer containing (part of) a JPEG.
 * Passing the full download buffer works — EXIF is always near the start.
 */
export function exifDateFromBuffer(buf: Buffer): string | null {
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;

  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xFF) return null;
    const marker = buf[pos + 1];
    if (marker === 0xDA) return null; // Start of scan — no more header markers

    const segLen = buf.readUInt16BE(pos + 2);
    if (segLen < 2) return null;

    if (
      marker === 0xE1 &&
      pos + 10 <= buf.length &&
      buf.toString('ascii', pos + 4, pos + 8) === 'Exif' &&
      buf[pos + 8] === 0 && buf[pos + 9] === 0
    ) {
      return parseTiff(buf, pos + 10);
    }

    pos += 2 + segLen;
  }
  return null;
}

// ── TIFF/EXIF internals ──────────────────────────────────────────────────────

function parseTiff(buf: Buffer, tiffStart: number): string | null {
  if (tiffStart + 8 > buf.length) return null;

  const order = buf.toString('ascii', tiffStart, tiffStart + 2);
  if (order !== 'II' && order !== 'MM') return null;
  const le = order === 'II';

  const r16 = le
    ? (o: number) => buf.readUInt16LE(o)
    : (o: number) => buf.readUInt16BE(o);
  const r32 = le
    ? (o: number) => buf.readUInt32LE(o)
    : (o: number) => buf.readUInt32BE(o);

  if (r16(tiffStart + 2) !== 0x002A) return null;

  const ifd0Off = r32(tiffStart + 4);
  const exifIfdOff = ifdLongValue(buf, tiffStart, tiffStart + ifd0Off, r16, r32, 0x8769);
  if (exifIfdOff === null) return null;

  return ifdAsciiValue(buf, tiffStart, tiffStart + exifIfdOff, r16, r32, 0x9003);
}

function ifdLongValue(
  buf: Buffer, tiffStart: number, ifdStart: number,
  r16: (o: number) => number, r32: (o: number) => number,
  tag: number,
): number | null {
  if (ifdStart + 2 > buf.length) return null;
  const count = r16(ifdStart);
  for (let i = 0; i < count; i++) {
    const e = ifdStart + 2 + i * 12;
    if (e + 12 > buf.length) break;
    if (r16(e) === tag) return r32(e + 8);
  }
  return null;
}

function ifdAsciiValue(
  buf: Buffer, tiffStart: number, ifdStart: number,
  r16: (o: number) => number, r32: (o: number) => number,
  tag: number,
): string | null {
  if (ifdStart + 2 > buf.length) return null;
  const count = r16(ifdStart);
  for (let i = 0; i < count; i++) {
    const e = ifdStart + 2 + i * 12;
    if (e + 12 > buf.length) break;
    if (r16(e) !== tag) continue;
    if (r16(e + 2) !== 2) return null; // Must be ASCII type

    const len = r32(e + 4);
    const valOrOff = r32(e + 8);
    const dataStart = len <= 4 ? e + 8 : tiffStart + valOrOff;
    if (dataStart + len > buf.length) return null;

    const raw = buf.toString('ascii', dataStart, dataStart + len - 1); // strip null terminator
    const m = raw.match(/^(\d{4}):(\d{2}):(\d{2})/);
    if (!m || m[1] === '0000') return null;
    return `${m[1]}-${m[2]}-${m[3]}`;
  }
  return null;
}
