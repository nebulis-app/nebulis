import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Redirect DATA_DIR to a temp dir before any server module loads (paths.ts
// captures it at import time). Mirrors folderImportIdentification.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-linkedscan-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import db from '../../server/lib/db';
import { getLibraryDir } from '../../server/lib/libraryPath';
import { ensureLibraryDir } from '../../server/lib/library/objects';
import { scanSource, commitSource, getLibrarySource } from '../../server/lib/library/librarySources';
import { getLocalSessions, getLocalFiles } from '../../server/lib/library/observations';

const SETTINGS = { importJpg: true, importFits: true, importSubFrames: true };

afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  db.prepare('DELETE FROM libraryObjects').run();
  db.prepare('DELETE FROM libraryFiles').run();
  db.prepare('DELETE FROM librarySources').run();
});

/** The reporter's real layout, as confirmed against the running attribution
 *  engine: device folders, catalog-group folders, an object folder, a `_sub`
 *  companion — the exact shape the "6 objects named after group folders" bug
 *  came from. */
function buildReporterFixture(root: string): void {
  const c1 = path.join(root, '1. Seestar S50', '1. Caldwell Objects', 'C 1 - Polarissima Cluster');
  fs.mkdirSync(c1, { recursive: true });
  fs.writeFileSync(path.join(c1, 'Stacked_60_C 1_20.0s_IRCUT_20260524-231230.fit'), 'x'.repeat(200));
  const c1Sub = path.join(c1, 'C 1_sub');
  fs.mkdirSync(c1Sub, { recursive: true });
  fs.writeFileSync(path.join(c1Sub, 'Light_C 1_20.0s_IRCUT_20260524-231230.fit'), 'x'.repeat(100));

  const ngc = path.join(root, '1. Seestar S50', '4. NGC Objects', 'NGC 6910');
  fs.mkdirSync(ngc, { recursive: true });
  fs.writeFileSync(path.join(ngc, 'Stacked_210_NGC 6910_10.0s_IRCUT_20260915-213012.jpg'), 'x'.repeat(300));
}

describe('scanSource — read-only dry run', () => {
  it('finds the real objects in the reporters exact layout, with catalog matches, and touches nothing on disk', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-linkedscan-source-'));
    buildReporterFixture(root);

    const before = fs.statSync(path.join(root, '1. Seestar S50', '1. Caldwell Objects', 'C 1 - Polarissima Cluster', 'Stacked_60_C 1_20.0s_IRCUT_20260524-231230.fit'));
    const beforeBytes = before.size;
    const beforeMtime = before.mtimeMs;

    const result = scanSource(root, SETTINGS);

    expect(result.objects.map(o => o.objectId).sort()).toEqual(['NGC188', 'NGC6910']);
    const c1 = result.objects.find(o => o.objectId === 'NGC188')!;
    expect(c1.fileCount).toBe(2); // the stacked file plus its _sub companion
    expect(c1.catalogMatch).not.toBeNull();
    expect(c1.sessions).toHaveLength(1);
    expect(c1.sessions[0]!.date).toBe('2026-05-24');

    const ngc = result.objects.find(o => o.objectId === 'NGC6910')!;
    expect(ngc.fileCount).toBe(1);
    expect(ngc.sessions[0]!.date).toBe('2026-09-15');

    // Never mind what it found — did it touch the source?
    const after = fs.statSync(path.join(root, '1. Seestar S50', '1. Caldwell Objects', 'C 1 - Polarissima Cluster', 'Stacked_60_C 1_20.0s_IRCUT_20260524-231230.fit'));
    expect(after.size).toBe(beforeBytes);
    expect(after.mtimeMs).toBe(beforeMtime);

    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('commitSource — writes rows, copies zero bytes', () => {
  it('links the source and the objects become fully visible through the normal read path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-linkedcommit-source-'));
    buildReporterFixture(root);

    ensureLibraryDir();
    const libraryDirBefore = fs.readdirSync(getLibraryDir());

    const result = commitSource(root, SETTINGS, { label: 'MyWorks' });

    expect(result.objectsLinked).toBe(2);
    expect(result.filesLinked).toBe(3);

    const source = getLibrarySource(result.sourceId);
    expect(source).not.toBeNull();
    expect(source!.rootPath).toBe(root);
    expect(source!.enabled).toBe(true);

    // The whole point: no bytes copied anywhere under the managed library.
    expect(fs.readdirSync(getLibraryDir())).toEqual(libraryDirBefore);

    // And the object is now indistinguishable, from the app's own read path,
    // from one that was actually imported — this is what makes linking
    // useful rather than just safely inert.
    const sessions = getLocalSessions('NGC188');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.fileCount).toBe(2);

    const files = getLocalFiles('NGC188');
    expect(files).toHaveLength(2);
    expect(files.every(f => f.path.startsWith(`@src/${result.sourceId}/`))).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
