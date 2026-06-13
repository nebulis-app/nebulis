import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// paths.ts captures DATA_DIR / LIBRARY_DIR at module load. Redirect both to a
// per-test-file temp dir before any server module imports resolve.
//
// Lives under os.tmpdir() so a hard crash (vitest timeout, native segfault)
// leaks into the OS-managed temp area instead of polluting the project root.
// libraryImport.test.ts deliberately does NOT do this — its DATA_DIR has to
// be outside os.tmpdir() to exercise import.ts's defense-in-depth check
// (server/lib/library/import.ts:1305-1320), so it lives under cwd by design.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _os = require('os') as typeof import('os');
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'nebulis-gallery-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { getAllLibraryImages, invalidateAllImagesCache } from '../../server/lib/library/gallery';
import { stmts } from '../../server/lib/library/objects';
import { LIBRARY_DIR } from '../../server/lib/paths';

// Seed N objects, each with a single stacked JPG. Filenames use distinct dates
// so the sort order is deterministic (newest first). Returns the expected file
// paths in display order (newest → oldest).
function seedLibrary(count: number): string[] {
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  const expected: string[] = [];
  // Build dates that sort lexicographically: 2024-01-01, 2024-01-02, …
  // We want index 0 to be newest, so generate dates descending.
  for (let i = 0; i < count; i++) {
    const day = String(count - i).padStart(2, '0');
    const date = `2024-01-${day}`; // newest first when i=0
    const folder = `obj${i}`;
    const objId = `obj-${i}`;
    fs.mkdirSync(path.join(LIBRARY_DIR, folder), { recursive: true });
    // parseFilename pulls a date out of filenames like "M31_2024-01-01-12-00-00.jpg".
    // The file just needs to exist; content doesn't matter for listing.
    const fname = `M31_${date}-12-00-00.jpg`;
    fs.writeFileSync(path.join(LIBRARY_DIR, folder, fname), 'x');
    stmts.upsertObject.run(
      objId, folder, 1, new Date().toISOString(), 0, null,
      null, `Object ${i}`, 'Galaxy', null, null, null, null, null, null
    );
    expected.push(`${folder}/${fname}`);
  }
  return expected;
}

function wipeLibrary() {
  if (fs.existsSync(LIBRARY_DIR)) {
    fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
  }
  // Clear DB rows so each test starts clean.
  for (const obj of stmts.getAllObjects.all()) {
    stmts.markObjectDeleted.run(new Date().toISOString(), obj.objectId);
  }
  // getAllLibraryImages caches its filesystem walk for a short TTL. These tests
  // mutate the library directly on disk (bypassing the import flow that would
  // normally invalidate it), so reset the cache as part of the clean-state reset.
  invalidateAllImagesCache();
}

describe('getAllLibraryImages — pagination', () => {
  beforeAll(() => {
    wipeLibrary();
  });

  beforeEach(() => {
    wipeLibrary();
  });

  afterAll(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('returns the full list with total and nextOffset:null when no params are passed (legacy behavior)', () => {
    seedLibrary(7);
    const result = getAllLibraryImages('');
    expect(result.items).toHaveLength(7);
    expect(result.total).toBe(7);
    expect(result.nextOffset).toBeNull();
  });

  it('slices to limit and computes nextOffset when more remain', () => {
    seedLibrary(120);
    const result = getAllLibraryImages('', { limit: 50, offset: 0 });
    expect(result.items).toHaveLength(50);
    expect(result.total).toBe(120);
    expect(result.nextOffset).toBe(50);
  });

  it('returns the final page with nextOffset:null when the slice reaches total', () => {
    seedLibrary(120);
    const result = getAllLibraryImages('', { limit: 50, offset: 100 });
    expect(result.items).toHaveLength(20);
    expect(result.total).toBe(120);
    expect(result.nextOffset).toBeNull();
  });

  it('returns items:[] and nextOffset:null when offset is past the end', () => {
    seedLibrary(10);
    const result = getAllLibraryImages('', { limit: 50, offset: 9999 });
    expect(result.items).toEqual([]);
    expect(result.total).toBe(10);
    expect(result.nextOffset).toBeNull();
  });

  it('clamps limit > 500 down to 500 instead of 4xx', () => {
    seedLibrary(550);
    const result = getAllLibraryImages('', { limit: 10000, offset: 0 });
    expect(result.items).toHaveLength(500);
    expect(result.total).toBe(550);
    expect(result.nextOffset).toBe(500);
  });

  it('falls back to default page size 100 when limit is 0 or invalid', () => {
    // limit=0 is documented as "fall back to default", not 4xx. The helper is
    // forgiving so the iOS client and SPA never see a 400 from a bad cache.
    seedLibrary(150);
    const result = getAllLibraryImages('', { limit: 0, offset: 0 });
    expect(result.items).toHaveLength(100);
    expect(result.nextOffset).toBe(100);
  });

  it('preserves item shape across pagination (same keys as legacy)', () => {
    seedLibrary(3);
    const legacy = getAllLibraryImages('');
    const paged = getAllLibraryImages('', { limit: 2, offset: 0 });
    expect(Object.keys(paged.items[0]).sort()).toEqual(Object.keys(legacy.items[0]).sort());
  });

  it('returns items in the same sorted order as the legacy call', () => {
    seedLibrary(20);
    const legacy = getAllLibraryImages('');
    const page1 = getAllLibraryImages('', { limit: 5, offset: 0 });
    const page2 = getAllLibraryImages('', { limit: 5, offset: 5 });
    expect(page1.items.map(i => i.path)).toEqual(legacy.items.slice(0, 5).map(i => i.path));
    expect(page2.items.map(i => i.path)).toEqual(legacy.items.slice(5, 10).map(i => i.path));
  });
});
