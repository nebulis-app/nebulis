import { describe, it, expect, beforeEach, vi } from 'vitest';

// Redirect DATA_DIR before any server module loads (paths.ts captures it at
// import time). Same pattern as folderImport.test.ts.
vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  process.env.DATA_DIR = _fs.mkdtempSync(_path.join(_root, 'nebulis-objecttype-test-'));
});

import db from '../../server/lib/db';
import { applyCatalogMetaToLibraryObject } from '../../server/lib/library/objects';
import { getLibraryObjectFilterTags } from '../../server/lib/library/objectFilters';
import { saveOverride, deleteOverride } from '../../server/lib/catalogOverrides';

const OBJECT_ID = 'M31';

function seedObject(): void {
  db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run(OBJECT_ID);
  db.prepare(
    `INSERT INTO libraryObjects (objectId, folderName, fileCount, lastImport, objectType)
     VALUES (?, ?, 0, ?, ?)`,
  ).run(OBJECT_ID, OBJECT_ID, new Date().toISOString(), 'Galaxy');
}

function storedType(): string | null {
  return db
    .prepare<[string], { objectType: string | null }>('SELECT objectType FROM libraryObjects WHERE objectId = ?')
    .get(OBJECT_ID)?.objectType ?? null;
}

describe('user-corrected object types reach the library grid', () => {
  beforeEach(() => {
    deleteOverride(OBJECT_ID);
    seedObject();
  });

  it('pushes a saved type override onto the stored library columns', () => {
    // The override merges into getCatalogEntry at read time, so object detail
    // showed the correction immediately. The grid and the filter chips read
    // libraryObjects.objectType, which used to keep the stale value until the
    // next import happened to re-resolve it.
    saveOverride(OBJECT_ID, { type: 'Dark Nebula' }, null);
    expect(applyCatalogMetaToLibraryObject(OBJECT_ID)).toBe(true);
    expect(storedType()).toBe('Dark Nebula');
    // "Dark Nebula" files under the Nebula chip through the word-boundary match.
    expect(getLibraryObjectFilterTags(storedType()!)).toContain('nebula');
  });

  it('reverts to catalog truth when the override is cleared', () => {
    saveOverride(OBJECT_ID, { type: 'Dark Nebula' }, null);
    applyCatalogMetaToLibraryObject(OBJECT_ID);
    deleteOverride(OBJECT_ID);
    applyCatalogMetaToLibraryObject(OBJECT_ID);
    // Back to what the bundled catalog says about M31, not the seeded value.
    expect(storedType()).toBe('Spiral Galaxy');
    expect(getLibraryObjectFilterTags(storedType()!)).toContain('galaxy');
  });

  it('does not blank an enriched description the catalog has no value for', () => {
    // Enrichment stores the Wikipedia extract in the same column, so a catalog
    // entry with no description must leave it alone.
    db.prepare('UPDATE libraryObjects SET description = ? WHERE objectId = ?')
      .run('Enriched from Wikipedia.', OBJECT_ID);
    saveOverride(OBJECT_ID, { type: 'Galaxy' }, null);
    applyCatalogMetaToLibraryObject(OBJECT_ID);
    const row = db
      .prepare<[string], { description: string | null }>('SELECT description FROM libraryObjects WHERE objectId = ?')
      .get(OBJECT_ID);
    expect(row?.description).toBeTruthy();
  });

  it('reports a miss for an id that is not in the library', () => {
    expect(applyCatalogMetaToLibraryObject('NOT-IN-LIBRARY-1234')).toBe(false);
  });
});
