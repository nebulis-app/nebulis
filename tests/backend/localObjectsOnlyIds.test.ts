import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  process.env.DATA_DIR = _fs.mkdtempSync(_path.join(_root, 'nebulis-onlyids-'));
});

import db from '../../server/lib/db';
import { getLocalObjects, listObjectGroupingRows } from '../../server/lib/library/objects';

// GET /library/objects/:id used to build every object in the library (plus a folder scan for each one without a picture)
// to return a single one.
describe('getLocalObjects({ onlyIds })', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM libraryObjects').run();
    for (const id of ['M31', 'M31_Mosaic', 'M42', 'NGC7000']) {
      db.prepare("INSERT INTO libraryObjects (objectId, folderName, lastImport, galleryImage) VALUES (?, ?, '2026-01-01', 'x.jpg')").run(id, id);
    }
  });

  it('returns only the requested ids', () => {
    const rows = getLocalObjects('', '', { onlyIds: new Set(['M31', 'M31_Mosaic']) });
    expect(rows.map(r => r.id).sort()).toEqual(['M31', 'M31_Mosaic']);
  });

  it('returns everything when no filter is given', () => {
    expect(getLocalObjects().length).toBe(4);
  });

  it('lists the grouping columns without touching the filesystem', () => {
    const rows = listObjectGroupingRows();
    expect(rows.map(r => r.id).sort()).toEqual(['M31', 'M31_Mosaic', 'M42', 'NGC7000']);
    expect(rows.every(r => r.catalogId.length > 0)).toBe(true);
  });
});
