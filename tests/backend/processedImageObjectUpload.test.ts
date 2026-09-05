import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors dwarfRestackImport.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-proc-object-upload-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { LIBRARY_DIR } from '../../server/lib/paths';
import {
  addProcessedImage,
  replaceProcessedImageFile,
  getAllProcessedImagesForObject,
  getProcessedImages,
  getProcessedImageRecord,
} from '../../server/lib/library/processed';
import { stmts } from '../../server/lib/library/objects';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function seedObject(objectId: string, folderName: string): void {
  stmts.upsertObject.run(
    objectId, folderName, 0, new Date().toISOString(), 0, null,
    null, null, null, null, null, null, null, null, null,
  );
  fs.mkdirSync(path.join(LIBRARY_DIR, folderName), { recursive: true });
}

/** Stage a temp source file the way the multer upload handler hands one in. */
function stagedFile(name: string, contents = 'bytes'): string {
  const p = path.join(os.tmpdir(), `proc-object-test-${Date.now()}-${name}`);
  fs.writeFileSync(p, contents);
  return p;
}

describe('object-level processed image upload (no session date)', () => {
  it('stores the image with a null date and source "user", and it shows in the object rollup', () => {
    seedObject('NGC7000', 'NGC7000');

    const record = addProcessedImage(
      'NGC7000',
      null,
      stagedFile('NGC7000_final.jpg'),
      'NGC7000_final.jpg',
      'image/jpeg',
      'HOO final',
      '',
      null,
      'user',
    );

    expect(record.date).toBeNull();
    expect(record.source).toBe('user');
    expect(record.title).toBe('HOO final');
    expect(fs.existsSync(path.join(LIBRARY_DIR, 'NGC7000', 'processed', record.filename))).toBe(true);

    const rollup = getAllProcessedImagesForObject('NGC7000');
    expect(rollup.map(r => r.id)).toContain(record.id);
    expect(rollup.find(r => r.id === record.id)?.date).toBeNull();
  });

  it('a null-date object upload is not returned by any single session query', () => {
    seedObject('M16', 'M16');
    const record = addProcessedImage(
      'M16', null, stagedFile('M16.png'), 'M16.png', 'image/png', '', '', null, 'user',
    );

    expect(getProcessedImages('M16', '2026-08-01')).toHaveLength(0);
    expect(getAllProcessedImagesForObject('M16').map(r => r.id)).toContain(record.id);
  });
});

describe('replaceProcessedImageFile — image editor "Save" (overwrite in place)', () => {
  it('swaps the file bytes but keeps the id, title, notes and date', () => {
    seedObject('M42', 'M42');
    const original = addProcessedImage(
      'M42', '2026-01-01', stagedFile('M42_orig.png', 'old'),
      'M42_orig.png', 'image/png', 'My edit', 'some notes', null, 'user',
    );
    const oldOnDisk = path.join(LIBRARY_DIR, 'M42', 'processed', original.filename);
    expect(fs.existsSync(oldOnDisk)).toBe(true);

    const updated = replaceProcessedImageFile(
      original.id, stagedFile('M42_edited.jpg', 'new bytes'), 'M42_edited.jpg', 'image/jpeg',
    );

    expect(updated).not.toBeNull();
    expect(updated!.id).toBe(original.id);
    expect(updated!.title).toBe('My edit');
    expect(updated!.notes).toBe('some notes');
    expect(updated!.date).toBe('2026-01-01');
    expect(updated!.mimeType).toBe('image/jpeg');
    // Cache-busting version query so the browser refetches the new bytes.
    expect(updated!.url).toMatch(/\?v=\d+$/);

    // Old file removed, new file holds the new bytes.
    expect(fs.existsSync(oldOnDisk)).toBe(false);
    const newOnDisk = path.join(LIBRARY_DIR, 'M42', 'processed', updated!.filename);
    expect(fs.readFileSync(newOnDisk, 'utf8')).toBe('new bytes');

    // The single row still resolves to exactly one record.
    expect(getProcessedImages('M42', '2026-01-01').filter(r => r.id === original.id)).toHaveLength(1);
    expect(getProcessedImageRecord(original.id)?.filename).toBe(updated!.filename);
  });

  it('returns null and cleans up the staged file when the id is unknown', () => {
    const staged = stagedFile('orphan.jpg', 'x');
    expect(replaceProcessedImageFile('proc_does_not_exist', staged, 'orphan.jpg', 'image/jpeg')).toBeNull();
    expect(fs.existsSync(staged)).toBe(false);
  });
});
