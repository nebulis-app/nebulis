import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Same temp DATA_DIR redirection as libraryGalleryPagination.test.ts: paths.ts
// reads DATA_DIR / LIBRARY_DIR at module load, so it must be set first.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _os = require('os') as typeof import('os');
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'nebulis-gallery-date-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { getAllLibraryImages, invalidateAllImagesCache } from '../../server/lib/library/gallery';
import { stmts } from '../../server/lib/library/objects';
import { LIBRARY_DIR } from '../../server/lib/paths';
import { localDateKey } from '../../server/lib/timezone';
import db from '../../server/lib/db';

const OBJECT_ID = 'NGC891';
const FOLDER = 'NGC891';

function seedObject() {
  fs.mkdirSync(path.join(LIBRARY_DIR, FOLDER, 'processed'), { recursive: true });
  stmts.upsertObject.run(
    OBJECT_ID, FOLDER, 1, new Date().toISOString(), 0, null,
    null, 'Silver Sliver Galaxy', 'Galaxy', null, null, null, null, null, null,
  );
}

function addProcessed(filename: string, date: string | null, uploadedAt: string) {
  fs.writeFileSync(path.join(LIBRARY_DIR, FOLDER, 'processed', filename), 'x');
  stmts.insertProcessedImage.run(
    `proc_${filename}`, OBJECT_ID, date, filename, filename, '', '', 1, 'image/jpeg', uploadedAt, null, 'user',
  );
}

function galleryDate(filename: string): string | undefined {
  invalidateAllImagesCache();
  return getAllLibraryImages().items.find(img => img.name === filename)?.date;
}

describe('gallery date of processed images', () => {
  beforeEach(() => {
    if (fs.existsSync(LIBRARY_DIR)) fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
    db.prepare('DELETE FROM sessionProcessedImages').run();
    for (const obj of stmts.getAllObjects.all()) stmts.markObjectDeleted.run(new Date().toISOString(), obj.objectId);
    seedObject();
  });

  afterAll(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('shows an object-level upload (no session date) under its upload day, not "unknown"', () => {
    const uploadedAt = '2026-11-15T15:20:00.000Z';
    addProcessed('NGC891_final.jpg', null, uploadedAt);
    expect(galleryDate('NGC891_final.jpg')).toBe(localDateKey(new Date(uploadedAt)));
  });

  it('keeps the session date of a session-level upload', () => {
    addProcessed('NGC891_session.jpg', '2026-10-16', '2026-11-15T15:20:00.000Z');
    expect(galleryDate('NGC891_session.jpg')).toBe('2026-10-16');
  });

  it('falls back to "unknown" when the upload timestamp cannot be parsed', () => {
    addProcessed('NGC891_bad.jpg', null, 'not-a-date');
    expect(galleryDate('NGC891_bad.jpg')).toBe('unknown');
  });
});
