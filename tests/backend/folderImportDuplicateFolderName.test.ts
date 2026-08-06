import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors folderImport.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-dupfolder-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { collectObjectSources } from '../../server/lib/library/folderScan';
import { commitFolderImport } from '../../server/lib/library/import';
import { getLocalSessions } from '../../server/lib/library/observations';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('collectObjectSources — duplicate folderName disambiguation', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  function tmpDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  }

  /** A root where two independently-discovered sources both resolve to the
   *  same folderName "Jupiter": a subdirectory whose files all name "Jupiter"
   *  (planObjectFolder's whole-with-rename branch) and loose root files that
   *  also name "Jupiter" (the loose-file groupByTarget branch). Before the
   *  fix, commitFolderImport's planByFolder Map (keyed on folderName) would
   *  collapse these into one plan entry, so one source's session-date
   *  decisions silently applied to the other's files too. */
  function makeCollidingTree(): string {
    const root = tmpDir('collide-');
    fs.mkdirSync(path.join(root, 'session1'));
    fs.writeFileSync(path.join(root, 'session1', '2026-05-25-212058-Jupiter.jpg'), 'jpg');
    fs.writeFileSync(path.join(root, '2026-03-31-194930-Jupiter.jpg'), 'jpg');
    return root;
  }

  it('gives every source a unique folderName even when two sources independently resolve to the same target', () => {
    const root = makeCollidingTree();
    const { sources } = collectObjectSources(root);
    const names = sources.map(s => s.folderName);
    expect(new Set(names).size).toBe(names.length); // no duplicates
    expect(names).toContain('Jupiter');
    expect(names.some(n => n === 'Jupiter (2)')).toBe(true);
  });

  it('imports both colliding sources sessions intact instead of one silently losing its session-date decisions', async () => {
    const root = makeCollidingTree();
    const { sources } = collectObjectSources(root);
    expect(sources).toHaveLength(2);

    // Both really are the same astronomical target, so the user maps both
    // disambiguated rows to the same targetObjectId — this is the realistic
    // "merge them back together" case the disambiguation should still allow.
    await commitFolderImport({
      rootPath: root,
      objects: sources.map(s => ({
        folderName: s.folderName,
        targetObjectId: 'Jupiter',
        targetFolderName: 'Jupiter',
        sessionMap: s.folderName === 'Jupiter'
          ? { '2026-05-25': '2026-05-25' }
          : { '2026-03-31': '2026-03-31' },
      })),
    });

    const sessions = getLocalSessions('Jupiter').map(s => s.date).sort();
    expect(sessions).toEqual(['2026-03-31', '2026-05-25']);
  });
});
