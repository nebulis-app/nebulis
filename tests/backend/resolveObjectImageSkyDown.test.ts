import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// A dot-free temp DATA_DIR, set before any server module loads (paths.ts captures it at import time).
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _os = require('os') as typeof import('os');
  const _path = require('path') as typeof import('path');
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'nebulis-sky-down-'));
  process.env.DATA_DIR = dir;
  return dir;
});

// The sky service never answers: what an unreachable CDS looks like to the caller.
const prefetchSkyImage = vi.hoisted(() => vi.fn(() => new Promise<string | null>(() => { /* never settles */ })));
vi.mock('../../server/lib/skyImage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/lib/skyImage')>()),
  prefetchSkyImage,
}));

import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import db from '../../server/lib/db';
import { LIBRARY_DIR } from '../../server/lib/paths';
import { resolveObjectImagePath } from '../../server/lib/library/gallery';

const OBJECT_ID = 'NGC6888';
const GALLERY_REL = `${OBJECT_ID}/gallery_${OBJECT_ID}.jpg`;

beforeAll(async () => {
  fs.mkdirSync(path.join(LIBRARY_DIR, OBJECT_ID), { recursive: true });
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#445566' } })
    .jpeg()
    .toFile(path.join(LIBRARY_DIR, GALLERY_REL));
  db.prepare('INSERT OR IGNORE INTO libraryObjects (objectId, folderName, fileCount, lastImport) VALUES (?, ?, 1, ?)')
    .run(OBJECT_ID, OBJECT_ID, new Date().toISOString());
  // An auto-picked image (not user-set), no cached sky master: the state right after an import.
  db.prepare('UPDATE libraryObjects SET galleryImage = ?, galleryImageUserSet = 0 WHERE objectId = ?')
    .run(GALLERY_REL, OBJECT_ID);
});

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('resolveObjectImagePath while the sky service is down', () => {
  it('answers with the object\'s own picture instead of waiting for the sky download', async () => {
    const started = Date.now();
    const result = await Promise.race([
      resolveObjectImagePath(OBJECT_ID),
      new Promise<'timed out'>(resolve => setTimeout(() => resolve('timed out'), 2000)),
    ]);
    expect(result).toBe(path.join(LIBRARY_DIR, GALLERY_REL));
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('still starts the sky download in the background so the next request can use it', async () => {
    prefetchSkyImage.mockClear();
    await resolveObjectImagePath(OBJECT_ID);
    expect(prefetchSkyImage).toHaveBeenCalledTimes(1);
  });
});
