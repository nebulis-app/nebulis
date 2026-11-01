import { describe, it, expect, vi } from 'vitest';

const DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-oneshot-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import Database from 'better-sqlite3';
import path from 'path';

// One-shot fixes are gated on a marker column. The column used to be added in one statement and the fix applied in
// later ones, so a crash between them left the marker present and the fix undone for good.
describe('one-shot migrations apply the fix together with the marker', () => {
  it('re-applies the sessionImportLog trim when the marker column is missing', async () => {
    const first = (await import('../../server/lib/db')).default;
    first.close();

    const raw = new Database(path.join(DATA_DIR, 'nebulis.db'));
    raw.prepare('ALTER TABLE libraryMeta DROP COLUMN importLogTrimmed').run();
    const insert = raw.prepare("INSERT INTO sessionImportLog (telescopeId, remotePath, importedAt, outcome) VALUES ('t', ?, 'x', ?)");
    insert.run('/a', 'skipped');
    insert.run('/b', 'skipped');
    insert.run('/c', 'imported');
    raw.close();

    vi.resetModules();
    const db = (await import('../../server/lib/db')).default;

    const outcomes = db.prepare<[], { outcome: string }>('SELECT outcome FROM sessionImportLog').all().map(r => r.outcome);
    expect(outcomes).toEqual(['imported']);
    const cols = db.prepare<[], { name: string }>('PRAGMA table_info(libraryMeta)').all().map(c => c.name);
    expect(cols).toContain('importLogTrimmed');
    expect(db.prepare<[], { importLogTrimmed: number }>('SELECT importLogTrimmed FROM libraryMeta WHERE id = 1').get()).toEqual({ importLogTrimmed: 1 });
  });
});
