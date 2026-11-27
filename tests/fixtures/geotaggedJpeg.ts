/**
 * A minimal JPEG carrying an EXIF GPS block laid out the way a DWARF 3 writes
 * it in `stacked.jpg`: whole degrees/minutes/seconds as RATIONALs, ASCII refs,
 * altitude in centimetres over 100.
 *
 * The image itself is a real 1×1 JPEG, so the thumbnail and frame-analysis
 * stages that run after a link decode it cleanly; the APP1 segment is spliced
 * in right after SOI, where a camera writes it.
 */

/** A valid 1×1 baseline JPEG (268 bytes), made with sharp. */
const ONE_PIXEL_JPEG = Buffer.from(
  '/9j/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhC'
  + 'Y2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAA'
  + 'AAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAQP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCUAVD/2Q==',
  'base64',
);

export interface GpsFixture {
  lat: number;
  lon: number;
  altM?: number;
  /** Write the TIFF block big-endian ('MM') instead of the DWARF's 'II'. */
  bigEndian?: boolean;
}

function toDms(deg: number): [number, number, number] {
  const a = Math.abs(deg);
  const d = Math.floor(a);
  const mFloat = (a - d) * 60;
  const m = Math.floor(mFloat);
  const s = Math.round((mFloat - m) * 60);
  // Rounding 59.6" up must carry, or the fixture would encode 60 seconds.
  if (s === 60) return m === 59 ? [d + 1, 0, 0] : [d, m + 1, 0];
  return [d, m, s];
}

/** Build the TIFF block. `gps: null` gives an EXIF block with no GPS IFD (older DWARF firmware). */
export function exifTiff(gps: GpsFixture | null): Buffer {
  const le = !gps?.bigEndian;
  const parts: Buffer[] = [];
  const u16 = (v: number) => { const b = Buffer.alloc(2); if (le) b.writeUInt16LE(v); else b.writeUInt16BE(v); return b; };
  const u32 = (v: number) => { const b = Buffer.alloc(4); if (le) b.writeUInt32LE(v); else b.writeUInt32BE(v); return b; };
  const entry = (tag: number, type: number, count: number, value: Buffer) => {
    const v = Buffer.alloc(4);
    value.copy(v, 0, 0, Math.min(4, value.length));
    return Buffer.concat([u16(tag), u16(type), u32(count), v]);
  };

  // Header (8) + IFD0 with Make and, optionally, the GPS pointer.
  const header = Buffer.concat([Buffer.from(le ? 'II' : 'MM', 'latin1'), u16(42), u32(8)]);
  const ifd0Count = gps ? 2 : 1;
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const makeOffset = 8 + ifd0Size;
  const make = Buffer.from('DWARFLAB\0', 'latin1');
  const gpsOffset = makeOffset + make.length + (make.length % 2);

  const ifd0Entries = [entry(0x010f, 2, make.length, u32(makeOffset))];
  if (gps) ifd0Entries.push(entry(0x8825, 4, 1, u32(gpsOffset)));
  parts.push(header, u16(ifd0Count), ...ifd0Entries, u32(0), make);
  if (make.length % 2) parts.push(Buffer.alloc(1));
  if (!gps) return Buffer.concat(parts);

  const gpsCount = 6;
  const dataStart = gpsOffset + 2 + gpsCount * 12 + 4;
  const latData = Buffer.concat(toDms(gps.lat).flatMap(v => [u32(v), u32(1)]));
  const lonData = Buffer.concat(toDms(gps.lon).flatMap(v => [u32(v), u32(1)]));
  const altData = Buffer.concat([u32(Math.round(Math.abs(gps.altM ?? 0) * 100)), u32(100)]);

  const latOff = dataStart;
  const lonOff = latOff + latData.length;
  const altOff = lonOff + lonData.length;
  const gpsEntries = [
    entry(1, 2, 2, Buffer.from(gps.lat < 0 ? 'S\0' : 'N\0', 'latin1')),
    entry(2, 5, 3, u32(latOff)),
    entry(3, 2, 2, Buffer.from(gps.lon < 0 ? 'W\0' : 'E\0', 'latin1')),
    entry(4, 5, 3, u32(lonOff)),
    entry(5, 1, 1, Buffer.from([gps.altM !== undefined && gps.altM < 0 ? 1 : 0])),
    entry(6, 5, 1, u32(altOff)),
  ];
  parts.push(u16(gpsCount), ...gpsEntries, u32(0), latData, lonData, altData);
  return Buffer.concat(parts);
}

/** A JPEG whose only metadata is the EXIF block above. */
export function geotaggedJpeg(gps: GpsFixture | null): Buffer {
  const tiff = exifTiff(gps);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2);
  return Buffer.concat([
    ONE_PIXEL_JPEG.subarray(0, 2), // SOI
    Buffer.from([0xff, 0xe1]), len, payload,
    ONE_PIXEL_JPEG.subarray(2),
  ]);
}
