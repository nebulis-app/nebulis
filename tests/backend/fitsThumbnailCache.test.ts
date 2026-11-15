import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  fitsThumbnailIsStale,
  generateFitsThumbnail,
  fitsThumbnailPath,
} from '../../server/lib/fitsThumbnail';

/**
 * A FITS file keeps its name when it is downloaded again, so the render beside it has to be checked
 * against the file, not just for its own existence. Before this, `.thumbs/<name>.v4.jpg` was created
 * once and served forever: a frame re-downloaded over a wrong or partial copy kept showing the old
 * picture, on every client, until the folder was deleted by hand.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-fitscache-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** 16-bit mono FITS whose pixels run one way or the other, so two files render differently. */
function fits(reversed: boolean, size = 64): Buffer {
  const cards = [
    'SIMPLE  =                    T',
    'BITPIX  =                   16',
    'NAXIS   =                    2',
    `NAXIS1  = ${String(size).padStart(20)}`,
    `NAXIS2  = ${String(size).padStart(20)}`,
    'END',
  ].map(c => c.padEnd(80));
  const header = Buffer.from(cards.join('').padEnd(2880), 'ascii');
  const data = Buffer.alloc(2880 * Math.ceil((size * size * 2) / 2880));
  for (let i = 0; i < size * size; i++) {
    const v = reversed ? (size * size - i) % 60000 : (i * 37) % 60000;
    data.writeInt16BE(v - 32768, 2 * i);
  }
  return Buffer.concat([header, data]);
}

describe('FITS thumbnail cache', () => {
  it('treats a missing render as stale and a missing source as not its business', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'missing-'));
    const fitsPath = path.join(dir, 'frame.fit');
    fs.writeFileSync(fitsPath, fits(false));
    expect(await fitsThumbnailIsStale(fitsPath)).toBe(true);

    await generateFitsThumbnail(fitsPath);
    expect(await fitsThumbnailIsStale(fitsPath)).toBe(false);

    fs.unlinkSync(fitsPath);
    // The route stats the source and reports the read error; re-rendering a file that is gone could
    // only throw.
    expect(await fitsThumbnailIsStale(fitsPath)).toBe(false);
  });

  it('redraws the picture when the FITS is replaced in place under the same name', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'replaced-'));
    const fitsPath = path.join(dir, 'sub_00001_M 45_20.0s_IRCUT_20261108-213926.fit');
    const thumbPath = fitsThumbnailPath(fitsPath);

    fs.writeFileSync(fitsPath, fits(false));
    await generateFitsThumbnail(fitsPath);
    const before = fs.readFileSync(thumbPath);

    // A fresh download lands on the same name with different pixels.
    fs.writeFileSync(fitsPath, fits(true));
    expect(await fitsThumbnailIsStale(fitsPath, thumbPath)).toBe(true);

    await generateFitsThumbnail(fitsPath);
    const after = fs.readFileSync(thumbPath);
    expect(after.equals(before)).toBe(false);
    expect(await fitsThumbnailIsStale(fitsPath, thumbPath)).toBe(false);
  });

  it('does not re-render forever when the telescope clock put the frame in the future', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'future-'));
    const fitsPath = path.join(dir, 'frame.fit');
    fs.writeFileSync(fitsPath, fits(false));
    // A telescope whose clock runs an hour fast stamps its files this way.
    const ahead = new Date(Date.now() + 60 * 60 * 1000);
    fs.utimesSync(fitsPath, ahead, ahead);

    await generateFitsThumbnail(fitsPath);
    // The stamp records the frame exactly as it is, so the next request is a cache hit instead of
    // another sharp pass on every tile.
    expect(await fitsThumbnailIsStale(fitsPath)).toBe(false);
  });

  it('redraws for a replacement that kept an older timestamp', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'restored-'));
    const fitsPath = path.join(dir, 'frame.fit');
    fs.writeFileSync(fitsPath, fits(false));
    await generateFitsThumbnail(fitsPath);

    // Restored from a backup, or handed over by a telescope whose clock runs slow: the new copy keeps
    // the old mtime. It is still a new file, and its picture must be redrawn.
    fs.writeFileSync(fitsPath, fits(true));
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    fs.utimesSync(fitsPath, old, old);

    expect(await fitsThumbnailIsStale(fitsPath)).toBe(true);
  });

  it('stamps the file it read, so a replacement landing mid-render is caught on the next request', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'midrender-'));
    const fitsPath = path.join(dir, 'frame.fit');
    fs.writeFileSync(fitsPath, fits(false));

    // The re-download arrives after the frame was read but before the render finished.
    const realReadFile = fs.promises.readFile;
    const spy = vi.spyOn(fs.promises, 'readFile').mockImplementation(async (...args: Parameters<typeof realReadFile>) => {
      const bytes = await realReadFile(...args);
      if (args[0] === fitsPath) fs.writeFileSync(fitsPath, fits(true, 80));
      return bytes;
    });
    try {
      await generateFitsThumbnail(fitsPath);
    } finally {
      spy.mockRestore();
    }

    expect(await fitsThumbnailIsStale(fitsPath)).toBe(true);
  });

  it('leaves a render that is already newer than the FITS alone', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'warm-'));
    const fitsPath = path.join(dir, 'frame.fit');
    fs.writeFileSync(fitsPath, fits(false));
    await generateFitsThumbnail(fitsPath);
    const before = fs.statSync(fitsThumbnailPath(fitsPath)).mtimeMs;

    await generateFitsThumbnail(fitsPath);
    expect(fs.statSync(fitsThumbnailPath(fitsPath)).mtimeMs).toBe(before);
  });
});
