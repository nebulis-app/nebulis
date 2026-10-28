/**
 * Decode guard for files that reach sharp.
 *
 * The upload filter only looks at the file extension, and sharp picks its
 * loader from the file CONTENT, so a file named `photo.jpg` that actually holds
 * SVG would be handed to librsvg. Thumbnails of library files are generated on
 * routes that need no credential, so the loader chosen for an attacker-supplied
 * file matters. This reads the first bytes ourselves and only lets known raster
 * formats through, without asking libvips to parse anything first (metadata()
 * already runs the loader).
 *
 * Call it before `sharp(<path>)` for any file that did not come from our own
 * renderers. Raw pixel buffers and sharp's own output need no check.
 */
import fs from 'fs';

export type RasterFormat = 'jpeg' | 'png' | 'tiff' | 'webp' | 'gif' | 'avif' | 'heif';

export class UnsafeImageError extends Error {
  constructor(file: string) {
    super(`Not a supported raster image: ${file}`);
    this.name = 'UnsafeImageError';
  }
}

/** ISO base media brands that mean AVIF or HEIF. */
const AVIF_BRANDS = new Set(['avif', 'avis']);
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'mif1', 'msf1']);

/** Identify a raster format from its leading bytes, or null if it is anything else. */
export function sniffRasterFormat(head: Buffer): RasterFormat | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (head.length >= 4) {
    const le = head[0] === 0x49 && head[1] === 0x49 && head[3] === 0x00 && (head[2] === 0x2a || head[2] === 0x2b);
    const be = head[0] === 0x4d && head[1] === 0x4d && head[2] === 0x00 && (head[3] === 0x2a || head[3] === 0x2b);
    if (le || be) return 'tiff';
  }
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (head.length >= 6 && head.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (head.length >= 12 && head.toString('latin1', 4, 8) === 'ftyp') {
    const brand = head.toString('latin1', 8, 12);
    if (AVIF_BRANDS.has(brand)) return 'avif';
    if (HEIF_BRANDS.has(brand)) return 'heif';
  }
  return null;
}

/** Throws UnsafeImageError unless the file starts like a supported raster image. */
export async function assertSafeRaster(file: string): Promise<RasterFormat> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, 'r');
    const head = Buffer.alloc(16);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const format = sniffRasterFormat(head.subarray(0, bytesRead));
    if (!format) throw new UnsafeImageError(file);
    return format;
  } finally {
    await handle?.close();
  }
}
