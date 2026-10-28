import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { assertSafeRaster, sniffRasterFormat, UnsafeImageError } from '../../server/lib/imageSniff';

const root = path.join(process.cwd(), '.test-tmp');
fs.mkdirSync(root, { recursive: true });
const dir = fs.mkdtempSync(path.join(root, 'nebulis-imagesniff-'));

const pixels = { create: { width: 8, height: 8, channels: 3 as const, background: '#336699' } };
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';

function write(name: string, data: Buffer | string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, data);
  return p;
}

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('assertSafeRaster accepts what sharp writes', () => {
  const cases: Array<[string, () => Promise<Buffer>, string]> = [
    ['jpeg', () => sharp(pixels).jpeg().toBuffer(), 'jpeg'],
    ['png', () => sharp(pixels).png().toBuffer(), 'png'],
    ['tiff', () => sharp(pixels).tiff().toBuffer(), 'tiff'],
    ['webp', () => sharp(pixels).webp().toBuffer(), 'webp'],
    ['gif', () => sharp(pixels).gif().toBuffer(), 'gif'],
    ['avif', () => sharp(pixels).avif().toBuffer(), 'avif'],
  ];
  for (const [name, make, expected] of cases) {
    it(name, async () => {
      const file = write(`ok.${name}`, await make());
      await expect(assertSafeRaster(file)).resolves.toBe(expected);
    });
  }
});

describe('assertSafeRaster refuses everything else, whatever the file is called', () => {
  it('SVG named .jpg', async () => {
    await expect(assertSafeRaster(write('evil.jpg', SVG))).rejects.toBeInstanceOf(UnsafeImageError);
  });
  it('SVG with an XML prolog and leading whitespace', async () => {
    await expect(assertSafeRaster(write('evil2.png', `\n  <?xml version="1.0"?>${SVG}`))).rejects.toBeInstanceOf(UnsafeImageError);
  });
  it('gzipped SVG (.svgz)', async () => {
    const zlib = await import('zlib');
    await expect(assertSafeRaster(write('evil.tif', zlib.gzipSync(SVG)))).rejects.toBeInstanceOf(UnsafeImageError);
  });
  it('HTML, PDF and a FITS header', async () => {
    for (const [n, body] of [['a.jpg', '<html><script>1</script></html>'], ['b.jpg', '%PDF-1.7\n'], ['c.jpg', 'SIMPLE  =                    T']] as const) {
      await expect(assertSafeRaster(write(n, body))).rejects.toBeInstanceOf(UnsafeImageError);
    }
  });
  it('empty, tiny and truncated files', async () => {
    await expect(assertSafeRaster(write('empty.jpg', ''))).rejects.toBeInstanceOf(UnsafeImageError);
    await expect(assertSafeRaster(write('one.jpg', Buffer.from([0xff])))).rejects.toBeInstanceOf(UnsafeImageError);
    await expect(assertSafeRaster(write('riff.webp', 'RIFF'))).rejects.toBeInstanceOf(UnsafeImageError);
  });
  it('a RIFF container that is not WebP', async () => {
    await expect(assertSafeRaster(write('wav.webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')])))).rejects.toBeInstanceOf(UnsafeImageError);
  });
  it('an ISO media file that is neither AVIF nor HEIF', async () => {
    const head = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(4)]);
    await expect(assertSafeRaster(write('video.avif', head))).rejects.toBeInstanceOf(UnsafeImageError);
  });
  it('a missing file rejects with the filesystem error, not a pass', async () => {
    await expect(assertSafeRaster(path.join(dir, 'nope.jpg'))).rejects.toThrow();
  });
});

describe('sniffRasterFormat', () => {
  it('recognises both TIFF byte orders and BigTIFF', () => {
    expect(sniffRasterFormat(Buffer.from([0x49, 0x49, 0x2a, 0x00]))).toBe('tiff');
    expect(sniffRasterFormat(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))).toBe('tiff');
    expect(sniffRasterFormat(Buffer.from([0x49, 0x49, 0x2b, 0x00]))).toBe('tiff');
  });
  it('recognises HEIF brands', () => {
    expect(sniffRasterFormat(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic')]))).toBe('heif');
  });
  it('rejects an empty buffer', () => {
    expect(sniffRasterFormat(Buffer.alloc(0))).toBeNull();
  });
});

describe('a disguised SVG never reaches the renderer', () => {
  it('sharp alone would happily decode it (why the guard exists)', async () => {
    const file = write('control.jpg', SVG);
    const meta = await sharp(file).metadata();
    expect(meta.format).toBe('svg');
    await expect(assertSafeRaster(file)).rejects.toBeInstanceOf(UnsafeImageError);
  });
});
