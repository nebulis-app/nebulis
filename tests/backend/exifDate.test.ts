import { describe, it, expect } from 'vitest';
import { exifDateFromBuffer } from '../../server/lib/exifDate';

// ── Minimal JPEG EXIF buffer builder ────────────────────────────────────────
//
// Constructs the smallest valid JPEG APP1/EXIF payload needed to test the
// parser without relying on real image files.
//
// Layout (little-endian TIFF):
//   JPEG SOI + APP1 marker + segment length
//   "Exif\0\0"
//   TIFF header: "II" + 0x002A + IFD0 offset (8)
//   IFD0: 1 entry — ExifIFD pointer (tag 0x8769) → offset 22
//   ExifIFD: 1 entry — DateTimeOriginal (tag 0x9003) → offset 36
//   DateTimeOriginal string (20 bytes): "YYYY:MM:DD HH:MM:SS\0"

function buildExifJpeg(dateTimeOriginal: string): Buffer {
  const dtBuf = Buffer.alloc(20);
  dtBuf.write(dateTimeOriginal.slice(0, 19), 'ascii'); // null terminator already 0

  // TIFF block (56 bytes)
  const tiff = Buffer.alloc(56);
  let o = 0;
  // TIFF header
  tiff.write('II', o, 'ascii'); o += 2;          // little-endian
  tiff.writeUInt16LE(0x002A, o); o += 2;         // TIFF magic
  tiff.writeUInt32LE(8, o); o += 4;              // IFD0 at offset 8
  // IFD0 (starts at offset 8)
  tiff.writeUInt16LE(1, o); o += 2;              // 1 entry
  tiff.writeUInt16LE(0x8769, o); o += 2;         // tag: ExifIFD pointer
  tiff.writeUInt16LE(4, o); o += 2;              // type: LONG
  tiff.writeUInt32LE(1, o); o += 4;              // count: 1
  tiff.writeUInt32LE(22, o); o += 4;             // value: ExifIFD at offset 22
  // ExifIFD (starts at offset 22)
  tiff.writeUInt16LE(1, o); o += 2;              // 1 entry
  tiff.writeUInt16LE(0x9003, o); o += 2;         // tag: DateTimeOriginal
  tiff.writeUInt16LE(2, o); o += 2;              // type: ASCII
  tiff.writeUInt32LE(20, o); o += 4;             // count: 20 (including null)
  tiff.writeUInt32LE(36, o); o += 4;             // value: string at offset 36
  // DateTimeOriginal string at offset 36
  dtBuf.copy(tiff, 36);

  // APP1 segment: FF E1 + 2-byte length + "Exif\0\0" + tiff
  const exifHeader = Buffer.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]); // "Exif\0\0"
  const segLen = 2 + exifHeader.length + tiff.length; // length includes itself

  const app1 = Buffer.alloc(2 + segLen);
  app1[0] = 0xFF; app1[1] = 0xE1;
  app1.writeUInt16BE(segLen, 2);
  exifHeader.copy(app1, 4);
  tiff.copy(app1, 10);

  return Buffer.concat([Buffer.from([0xFF, 0xD8]), app1]);
}

describe('exifDateFromBuffer', () => {
  it('extracts DateTimeOriginal and returns YYYY-MM-DD', () => {
    const buf = buildExifJpeg('2025:03:23 06:08:20');
    expect(exifDateFromBuffer(buf)).toBe('2025-03-23');
  });

  it('handles end-of-year dates', () => {
    const buf = buildExifJpeg('2025:07:15 13:30:40');
    expect(exifDateFromBuffer(buf)).toBe('2025-07-15');
  });

  it('returns null for a non-JPEG buffer', () => {
    expect(exifDateFromBuffer(Buffer.from('not a jpeg'))).toBeNull();
  });

  it('returns null for a JPEG with no EXIF', () => {
    // Minimal JPEG with only SOI + EOI, no APP1
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]);
    expect(exifDateFromBuffer(buf)).toBeNull();
  });

  it('returns null for an empty buffer', () => {
    expect(exifDateFromBuffer(Buffer.alloc(0))).toBeNull();
  });

  it('returns null when DateTimeOriginal is all zeros', () => {
    const buf = buildExifJpeg('0000:00:00 00:00:00');
    expect(exifDateFromBuffer(buf)).toBeNull();
  });
});
