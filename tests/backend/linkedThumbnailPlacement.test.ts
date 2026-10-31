import { describe, it, expect, vi } from 'vitest';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-linkedthumb-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import path from 'path';
import { generateFitsThumbnail, fitsThumbnailPath } from '../../server/lib/fitsThumbnail';
import { linkedThumbnailPath } from '../../server/lib/linkedDerivatives';

function tinyFits(w = 32, h = 32): Buffer {
  const cards = [
    'SIMPLE  =                    T', 'BITPIX  =                   16', 'NAXIS   =                    2',
    `NAXIS1  = ${String(w).padStart(20)}`, `NAXIS2  = ${String(h).padStart(20)}`,
    'BZERO   =                32768', 'BSCALE  =                    1', 'END',
  ].map(c => c.padEnd(80));
  const header = Buffer.from(cards.join('').padEnd(2880), 'ascii');
  const data = Buffer.alloc(2880 * Math.ceil((w * h * 2) / 2880));
  for (let i = 0; i < w * h; i++) data.writeInt16BE((i * 37) % 60000 - 32768, 2 * i);
  return Buffer.concat([header, data]);
}

describe('linked-file thumbnails', () => {
  it('are written to our own cache and never beside the user\'s file', async () => {
    const linkedRoot = path.join(TEST_DATA_DIR, 'archive-drive');
    fs.mkdirSync(linkedRoot, { recursive: true });
    const fitsPath = path.join(linkedRoot, 'light_001.fit');
    fs.writeFileSync(fitsPath, tinyFits());
    // A read-only archive: any attempt to create .thumbs beside the file would throw.
    fs.chmodSync(linkedRoot, 0o555);
    try {
      const target = linkedThumbnailPath(fitsPath, fs.statSync(fitsPath), path.basename(fitsThumbnailPath(fitsPath)));
      await generateFitsThumbnail(fitsPath, 'thumb', target);

      expect(fs.existsSync(target)).toBe(true);
      expect(target.startsWith(path.join(TEST_DATA_DIR, 'thumbnails'))).toBe(true);
      expect(fs.existsSync(path.join(linkedRoot, '.thumbs'))).toBe(false);
    } finally {
      fs.chmodSync(linkedRoot, 0o755);
    }
  });

  it('key on size and mtime, so a file replaced in place gets a fresh render', () => {
    const a = linkedThumbnailPath('/x/a.fit', { size: 10, mtimeMs: 1000 }, 'a.fit.v4.jpg');
    expect(linkedThumbnailPath('/x/a.fit', { size: 10, mtimeMs: 1000 }, 'a.fit.v4.jpg')).toBe(a);
    expect(linkedThumbnailPath('/x/a.fit', { size: 10, mtimeMs: 2000 }, 'a.fit.v4.jpg')).not.toBe(a);
    expect(linkedThumbnailPath('/x/a.fit', { size: 11, mtimeMs: 1000 }, 'a.fit.v4.jpg')).not.toBe(a);
  });
});

describe('generateFitsThumbnail', () => {
  it('renders a small frame, whose Buffer shares memory with others, without error', async () => {
    const dir = path.join(TEST_DATA_DIR, 'managed');
    fs.mkdirSync(dir, { recursive: true });
    const fitsPath = path.join(dir, 'small.fit');
    fs.writeFileSync(fitsPath, tinyFits(16, 16));
    await generateFitsThumbnail(fitsPath, 'thumb');
    expect(fs.existsSync(fitsThumbnailPath(fitsPath, 'thumb'))).toBe(true);
  });

  it('does not block the event loop while it reads', async () => {
    const dir = path.join(TEST_DATA_DIR, 'managed2');
    fs.mkdirSync(dir, { recursive: true });
    const fitsPath = path.join(dir, 'big.fit');
    fs.writeFileSync(fitsPath, tinyFits(1500, 1500)); // ~4.5 MB, reduced path
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 0);
    try {
      await generateFitsThumbnail(fitsPath, 'thumb');
    } finally {
      clearInterval(timer);
    }
    expect(fs.existsSync(fitsThumbnailPath(fitsPath, 'thumb'))).toBe(true);
    expect(ticks).toBeGreaterThan(0);
  });
});
