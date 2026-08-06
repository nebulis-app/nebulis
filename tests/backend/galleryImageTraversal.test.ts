import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors folderImport.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-gallerytraversal-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { resolveObjectImagePath, setGalleryImageUserChosen } from '../../server/lib/library/gallery';
import { stmts } from '../../server/lib/library/objects';
import { LIBRARY_DIR } from '../../server/lib/paths';
import db from '../../server/lib/db';

beforeAll(() => {
  // resolveObjectImagePath falls through to an external DSS2/HiPS fetch when
  // no catalog image is cached — keep it offline and fast.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
});
afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare('DELETE FROM libraryObjects').run();
  fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
});

describe('resolveObjectImagePath — galleryImage traversal', () => {
  it('never resolves a user-set galleryImage that escapes LIBRARY_DIR', async () => {
    // Regression: a maliciously-crafted galleryImage used to reach
    // path.join(getLibraryDir(), row.galleryImage) unchecked. The result feeds
    // sharp() on the *public* (auth-bypassed) /objects/:objectId/thumbnail
    // route, so an unvalidated escape was an unauthenticated arbitrary file
    // read (and, on a sharp decode failure, an arbitrary file delete).
    stmts.upsertObject.run(
      'M31', 'M31', 0, new Date().toISOString(), 0, null,
      null, null, null, null, null, null, null, null, null,
    );

    // A real file outside the library that a traversal could reach.
    const secretDir = fs.mkdtempSync(path.join(path.dirname(LIBRARY_DIR), 'nebulis-secret-'));
    const secretFile = path.join(secretDir, 'secret.jpg');
    fs.writeFileSync(secretFile, 'not-actually-a-jpeg-but-pretend-sensitive-data');

    // Compute a relative traversal from LIBRARY_DIR to the secret file.
    const relTraversal = path.relative(LIBRARY_DIR, secretFile);
    expect(relTraversal.startsWith('..')).toBe(true);

    setGalleryImageUserChosen('M31', relTraversal);

    const resolved = await resolveObjectImagePath('M31');
    expect(resolved).not.toBe(path.resolve(secretFile));
    // Falls through to sky-survey/telescope fallbacks (none configured here),
    // ending in null rather than the escaped path.
    expect(resolved).toBeNull();

    fs.rmSync(secretDir, { recursive: true, force: true });
  });

  it('still resolves a legitimate in-library user-set galleryImage', async () => {
    stmts.upsertObject.run(
      'M42', 'M42', 0, new Date().toISOString(), 0, null,
      null, null, null, null, null, null, null, null, null,
    );
    fs.mkdirSync(path.join(LIBRARY_DIR, 'M42'), { recursive: true });
    fs.writeFileSync(path.join(LIBRARY_DIR, 'M42', 'gallery_M42.jpg'), 'jpg-bytes');

    setGalleryImageUserChosen('M42', 'M42/gallery_M42.jpg');

    const resolved = await resolveObjectImagePath('M42');
    expect(resolved).toBe(path.resolve(LIBRARY_DIR, 'M42', 'gallery_M42.jpg'));
  });
});
