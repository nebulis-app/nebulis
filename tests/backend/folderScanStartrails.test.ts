import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors folderImport.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-folderscanstartrails-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { scanImportFolder } from '../../server/lib/library/folderScan';
import { commitFolderImport } from '../../server/lib/library/import';
import { getLocalSessions } from '../../server/lib/library/observations';
import { LIBRARY_DIR } from '../../server/lib/paths';
import { stmts } from '../../server/lib/library/objects';
import {
  STARTRAILS_TARGET_NAME,
  STARTRAILS_OBJECT_TYPE,
  getStartrailsObjectId,
} from '../../server/lib/library/dwarfStartrails';

/** Build a minimal FITS header buffer with the given cards — same helper as
 *  folderImport.test.ts, duplicated here to keep this file self-contained. */
function fitsBuffer(cards: Record<string, string>): Buffer {
  const lines: string[] = [];
  const card = (key: string, value: string) =>
    (`${key.padEnd(8)}= '${value}'`).padEnd(80).slice(0, 80);
  lines.push(`${'SIMPLE'.padEnd(8)}=                    T`.padEnd(80).slice(0, 80));
  for (const [k, v] of Object.entries(cards)) lines.push(card(k, v));
  lines.push('END'.padEnd(80));
  const body = lines.join('');
  const buf = Buffer.alloc(2880, ' ');
  buf.write(body, 0, 'ascii');
  return buf;
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A STARTRAILS folder with two capture subfolders, each dated via FITS
 *  DATE-OBS (deterministic — no reliance on file mtime). Real DWARF capture
 *  folder names carry no target and possibly no parseable timestamp, so the
 *  folder names here are deliberately opaque. */
function makeStartrailsTree(): string {
  const root = tmpDir('src-startrails-');
  const capture1 = path.join(root, 'STARTRAILS', 'capture-a');
  const capture2 = path.join(root, 'STARTRAILS', 'capture-b');
  fs.mkdirSync(capture1, { recursive: true });
  fs.mkdirSync(capture2, { recursive: true });
  fs.writeFileSync(path.join(capture1, 'trail.fits'), fitsBuffer({ 'DATE-OBS': '2026-08-01T22:15:00' }));
  fs.writeFileSync(path.join(capture2, 'trail.fits'), fitsBuffer({ 'DATE-OBS': '2026-08-02T21:40:00' }));
  return root;
}

describe('STARTRAILS folding into a synthetic object', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });
  beforeEach(() => {
    if (fs.existsSync(LIBRARY_DIR)) fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
  });

  it('scan folds STARTRAILS capture folders into one object and stops reporting it as excluded', () => {
    const root = makeStartrailsTree();
    const result = scanImportFolder(root, {});

    expect(result.objects.map(o => o.folderName)).toEqual([STARTRAILS_TARGET_NAME]);
    expect(result.excludedFolders).not.toContain('STARTRAILS');
    const startrailsObj = result.objects.find(o => o.folderName === STARTRAILS_TARGET_NAME)!;
    expect(startrailsObj.sessions.map(s => s.date).sort()).toEqual(['2026-08-01', '2026-08-02']);
  });

  it('commit creates one curated synthetic object with a session per capture', async () => {
    const root = makeStartrailsTree();
    const objectId = getStartrailsObjectId();

    await commitFolderImport({
      rootPath: root,
      importFits: true,
      objects: [{
        folderName: STARTRAILS_TARGET_NAME,
        targetObjectId: objectId,
        targetFolderName: objectId,
        sessionMap: { '2026-08-01': '2026-08-01', '2026-08-02': '2026-08-02' },
      }],
    });

    const row = stmts.getObject.get(objectId);
    expect(row).toBeDefined();
    expect(row?.objectName).toBe(STARTRAILS_TARGET_NAME);
    expect(row?.objectType).toBe(STARTRAILS_OBJECT_TYPE);
    expect(row?.description).toBeTruthy();

    const sessions = getLocalSessions(objectId);
    expect(sessions.map(s => s.date).sort()).toEqual(['2026-08-01', '2026-08-02']);
  });

  it('a re-import does not clobber the curated metadata with a generic placeholder', async () => {
    const root = makeStartrailsTree();
    const objectId = getStartrailsObjectId();
    const plan = {
      rootPath: root,
      importFits: true,
      objects: [{
        folderName: STARTRAILS_TARGET_NAME,
        targetObjectId: objectId,
        targetFolderName: objectId,
        sessionMap: { '2026-08-01': '2026-08-01', '2026-08-02': '2026-08-02' },
      }],
    };
    await commitFolderImport(plan);
    await commitFolderImport(plan);

    const row = stmts.getObject.get(objectId);
    expect(row?.objectType).toBe(STARTRAILS_OBJECT_TYPE);
    expect(row?.description).toBeTruthy();
  });

  it('an empty STARTRAILS folder (no capture subfolders) stays excluded, unfolded', () => {
    const root = tmpDir('src-startrails-empty-');
    fs.mkdirSync(path.join(root, 'STARTRAILS'));
    const result = scanImportFolder(root, {});

    expect(result.objects.map(o => o.folderName)).not.toContain(STARTRAILS_TARGET_NAME);
    expect(result.excludedFolders).toContain('STARTRAILS');
  });
});
