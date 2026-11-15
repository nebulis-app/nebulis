import { describe, it, expect, afterAll, vi } from 'vitest';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-sun-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import db from '../../server/lib/db';
import { getLibraryObjectFilterTags } from '../../server/lib/library/objectFilters';
import { getBaseCatalogEntry } from '../../server/data/catalog';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function seedSun(type: string): void {
  db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run('Sun');
  db.prepare('INSERT INTO libraryObjects (objectId, folderName, objectType, fileCount, lastImport, catalogId, distanceLy) VALUES (?, ?, ?, 0, ?, ?, ?)')
    .run('Sun', 'Sun', type, new Date().toISOString(), 'Sun', 0);
}
const storedType = () => (db.prepare('SELECT objectType FROM libraryObjects WHERE objectId = ?').get('Sun') as { objectType: string }).objectType;

describe('the Sun in the Library', () => {
  it('has a type of its own, which the Solar System chip matches and the Star chip does not', () => {
    expect(getBaseCatalogEntry('Sun')?.type).toBe('Sun');
    expect(getLibraryObjectFilterTags('Sun')).toContain('solar-system');
    expect(getLibraryObjectFilterTags('Sun')).not.toContain('star');
    expect(getLibraryObjectFilterTags('Star')).not.toContain('solar-system');
  });

  it('moves an existing Sun typed Star to its own type on startup', async () => {
    seedSun('Star');
    vi.resetModules();
    await import('../../server/lib/library/objects');
    expect(storedType()).toBe('Sun');
  });

  it('leaves a type the user chose by hand alone', async () => {
    seedSun('Star');
    db.prepare("INSERT OR REPLACE INTO catalogOverrides (objectId, type, updatedAt) VALUES ('SUN', 'Star', ?)").run(new Date().toISOString());
    vi.resetModules();
    await import('../../server/lib/library/objects');
    expect(storedType()).toBe('Star');
  });
});
