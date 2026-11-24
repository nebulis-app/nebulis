/**
 * Observer coordinates from a JPEG's EXIF GPS block.
 *
 * A DWARF 3 writes no SITELAT/SITELONG into its FITS files, but from firmware
 * 1.5.x on it geotags the `stacked.jpg` it leaves in every observation folder:
 *
 *   GPSLatitudeRef 'N'  GPSLatitude  40/1 12/1 34/1   (whole seconds, ~30 m)
 *   GPSLongitudeRef 'W' GPSLongitude  3/1 41/1  5/1
 *   GPSAltitudeRef 0    GPSAltitude   75679/100        (metres above sea level)
 *
 * Earlier firmware writes an EXIF block with no GPS IFD at all, which reads as
 * null here, exactly like a file with no EXIF.
 *
 * Deliberately a small hand-rolled TIFF walk rather than `sharp().metadata()`:
 * it reads only the head of the file (the APP1 segment sits right after SOI),
 * never decodes the image, and works on a linked drive without pulling the
 * whole JPEG across the network.
 */
import fs from 'fs';

/** APP1 is at most 64 KB, and it comes first or right after APP0/JFIF. */
const HEAD_BYTES = 128 * 1024;

const TAG_GPS_IFD = 0x8825;
const GPS_LAT_REF = 1;
const GPS_LAT = 2;
const GPS_LON_REF = 3;
const GPS_LON = 4;
const GPS_ALT_REF = 5;
const GPS_ALT = 6;

const TYPE_ASCII = 2;
const TYPE_RATIONAL = 5;
const TYPE_SRATIONAL = 10;
const TYPE_BYTE = 1;

export interface JpegGps {
  lat: number;
  lon: number;
  /** Metres above sea level (negative below), or null when the file has none. */
  altM: number | null;
}

/** The TIFF block inside the first APP1 `Exif\0\0` segment, or null. */
function findExifTiff(buf: Buffer): Buffer | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null; // not a JPEG
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) return null;
    const marker = buf[pos + 1];
    // Fill bytes between segments.
    if (marker === 0xff) { pos++; continue; }
    // Start of scan or end of image: the metadata segments are all behind us.
    if (marker === 0xda || marker === 0xd9) return null;
    const len = buf.readUInt16BE(pos + 2);
    if (len < 2) return null;
    const start = pos + 4;
    const end = pos + 2 + len;
    if (marker === 0xe1 && end <= buf.length && buf.toString('latin1', start, start + 6) === 'Exif\0\0') {
      return buf.subarray(start + 6, end);
    }
    pos = end;
  }
  return null;
}

interface Entry { type: number; count: number; valueOffset: number }

/** Parse the IFD GPS-relevant tags out of a TIFF block. */
export function parseExifGps(tiff: Buffer): JpegGps | null {
  if (tiff.length < 8) return null;
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const le = order === 'II';
  const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const i32 = (o: number) => (le ? tiff.readInt32LE(o) : tiff.readInt32BE(o));
  if (u16(2) !== 42) return null;

  const readIfd = (offset: number): Map<number, Entry> | null => {
    if (offset < 8 || offset + 2 > tiff.length) return null;
    const n = u16(offset);
    if (offset + 2 + n * 12 > tiff.length) return null;
    const out = new Map<number, Entry>();
    for (let i = 0; i < n; i++) {
      const e = offset + 2 + i * 12;
      const type = u16(e + 2);
      const count = u32(e + 4);
      const unit = type === TYPE_RATIONAL || type === TYPE_SRATIONAL ? 8 : type === 3 ? 2 : type === 4 || type === 9 ? 4 : 1;
      // Values of four bytes or fewer sit in the entry itself.
      const valueOffset = unit * count > 4 ? u32(e + 8) : e + 8;
      out.set(u16(e), { type, count, valueOffset });
    }
    return out;
  };

  const ifd0 = readIfd(u32(4));
  const gpsPtr = ifd0?.get(TAG_GPS_IFD);
  if (!gpsPtr) return null;
  const gps = readIfd(u32(gpsPtr.valueOffset));
  if (!gps) return null;

  const ascii = (tag: number): string | null => {
    const e = gps.get(tag);
    if (!e || e.type !== TYPE_ASCII || e.valueOffset + 1 > tiff.length) return null;
    return tiff.toString('latin1', e.valueOffset, e.valueOffset + 1).toUpperCase();
  };
  const rationals = (tag: number): number[] | null => {
    const e = gps.get(tag);
    if (!e || (e.type !== TYPE_RATIONAL && e.type !== TYPE_SRATIONAL)) return null;
    if (e.valueOffset + e.count * 8 > tiff.length) return null;
    const out: number[] = [];
    for (let i = 0; i < e.count; i++) {
      const o = e.valueOffset + i * 8;
      const num = e.type === TYPE_SRATIONAL ? i32(o) : u32(o);
      const den = e.type === TYPE_SRATIONAL ? i32(o + 4) : u32(o + 4);
      if (den === 0) return null;
      out.push(num / den);
    }
    return out;
  };
  const dms = (v: number[] | null): number | null => {
    if (!v || v.length === 0) return null;
    return (v[0] ?? 0) + (v[1] ?? 0) / 60 + (v[2] ?? 0) / 3600;
  };

  const latRef = ascii(GPS_LAT_REF);
  const lonRef = ascii(GPS_LON_REF);
  const latAbs = dms(rationals(GPS_LAT));
  const lonAbs = dms(rationals(GPS_LON));
  if (latAbs === null || lonAbs === null || !latRef || !lonRef) return null;
  if (!'NS'.includes(latRef) || !'EW'.includes(lonRef)) return null;

  const lat = latRef === 'S' ? -latAbs : latAbs;
  const lon = lonRef === 'W' ? -lonAbs : lonAbs;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  // (0, 0) is the "no fix yet" value some devices write, not a site in the Gulf of Guinea.
  if (lat === 0 && lon === 0) return null;

  let altM: number | null = null;
  const alt = rationals(GPS_ALT);
  if (alt && alt.length > 0 && Number.isFinite(alt[0])) {
    const refEntry = gps.get(GPS_ALT_REF);
    const below = refEntry && refEntry.type === TYPE_BYTE && tiff[refEntry.valueOffset] === 1;
    altM = Math.round((below ? -alt[0] : alt[0]) * 100) / 100;
  }

  return { lat: round6(lat), lon: round6(lon), altM };
}

/** Six decimals is ~0.1 m: far below the device's own precision, and it keeps
 *  40°12'34" from coming back as 40.20944444444444. */
function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/** Read the GPS position a JPEG was geotagged with, or null. Never throws. */
export function readJpegGps(absPath: string): JpegGps | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    const tiff = findExifTiff(buf.subarray(0, read));
    return tiff ? parseExifGps(tiff) : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best-effort */ }
    }
  }
}
