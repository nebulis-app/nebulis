import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-linkedcal-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import db from '../../server/lib/db';
import { ensureLibraryDir } from '../../server/lib/library/objects';
import { commitSource, rescanSource } from '../../server/lib/library/librarySources';
import { listCalibrationLibrary, deleteCalibrationBundle, findCalibrationBundle } from '../../server/lib/library/calibrationScan';
import { walkSource } from '../../server/lib/library/sourceWalk';
import { listLinkedCalibrationFolders, linkedScopeFor, isLinkedScope } from '../../server/lib/library/linkedCalibration';

const SETTINGS = { importJpg: true, importFits: true, importSubFrames: true };
const roots: string[] = [];

afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  db.prepare('DELETE FROM libraryObjects').run();
  db.prepare('DELETE FROM libraryFiles').run();
  db.prepare('DELETE FROM librarySources').run();
  ensureLibraryDir();
});

/** A tree like the report's: lights for M 31, and a Darks folder with two settings beside them. */
function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-linkedcal-'));
  roots.push(root);
  const m31 = path.join(root, 'Galaxies', 'M 31 - Andromeda');
  fs.mkdirSync(m31, { recursive: true });
  fs.writeFileSync(path.join(m31, 'Stacked_60_M 31_10.0s_IRCUT_20260101-200000.jpg'), 'a'.repeat(100));
  const darks = path.join(root, 'Calibration', 'Darks');
  fs.mkdirSync(darks, { recursive: true });
  fs.writeFileSync(path.join(darks, 'MasterDark_5_30.0s_26.0C_20261014-192837.fit'), 'd'.repeat(80));
  fs.writeFileSync(path.join(darks, 'MasterDark_5_60.0s_26.0C_20261014-193837.fit'), 'e'.repeat(80));
  return root;
}

describe('the walk of a linked folder', () => {
  it('notes the calibration folders, outermost only', async () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'CALI_FRAME', 'dark', 'cam_0'), { recursive: true });
    fs.writeFileSync(path.join(root, 'CALI_FRAME', 'dark', 'cam_0', 'dark_exp_60_gain_60_bin_1.fits'), 'x');
    const walked = await walkSource(root, SETTINGS);
    expect([...walked.calibrationDirs].sort()).toEqual(['CALI_FRAME', 'Calibration/Darks']);
  });
});

describe('calibration frames in a linked folder', () => {
  it('shows up in the Calibration Library, read in place, once the folder is linked', async () => {
    const root = makeRoot();
    const { sourceId } = await commitSource(root, SETTINGS, { label: 'My archive' });
    const group = listCalibrationLibrary().find(g => g.scope === linkedScopeFor(sourceId));
    expect(group).toBeDefined();
    expect(group).toMatchObject({ type: 'dark', folderName: 'Calibration/Darks', scopeLabel: 'My archive', linked: true, fileCount: 2 });
    // The frames are the files where they are: no copy was made.
    const files = group!.settingsGroups.flatMap(s => s.files.map(f => f.path));
    expect(files.every(f => f.startsWith(root))).toBe(true);
    expect(group!.settingsGroups).toHaveLength(2);
  });

  it('does not list them as light frames, and keeps lights out of the calibration list', async () => {
    const root = makeRoot();
    const { sourceId } = await commitSource(root, SETTINGS, { label: 'My archive' });
    const fileRows = db.prepare<[string], { relPath: string }>('SELECT relPath FROM libraryFiles WHERE sourceId = ?').all(sourceId);
    expect(fileRows.every(r => !/Dark/i.test(r.relPath))).toBe(true);
    const linkedGroups = listCalibrationLibrary().filter(g => isLinkedScope(g.scope));
    expect(linkedGroups.map(g => g.folderName)).toEqual(['Calibration/Darks']);
  });

  it('can be found for download, and can never be deleted from Nebulis', async () => {
    const root = makeRoot();
    const { sourceId } = await commitSource(root, SETTINGS, { label: 'My archive' });
    const scope = linkedScopeFor(sourceId);
    const group = listCalibrationLibrary().find(g => g.scope === scope)!;
    const key = group.settingsGroups[0].key;
    expect(findCalibrationBundle(scope, group.folderName, key)).not.toBeNull();

    expect(deleteCalibrationBundle(scope, group.folderName, key)).toBeNull();
    expect(fs.readdirSync(path.join(root, 'Calibration', 'Darks'))).toHaveLength(2);
  });

  it('follows the folder: new frames appear after a rescan, and an unlinked or paused folder drops out', async () => {
    const root = makeRoot();
    const { sourceId } = await commitSource(root, SETTINGS, { label: 'My archive' });
    fs.mkdirSync(path.join(root, 'Calibration', 'Flats'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Calibration', 'Flats', 'Flat_5_0.01s_26.0C_20261014-200000.fit'), 'f'.repeat(50));
    // Not seen until the next scan, which is what records where the folders are.
    expect(listLinkedCalibrationFolders().map(f => f.relDir)).toEqual(['Calibration/Darks']);
    await rescanSource(sourceId, SETTINGS);
    expect(listLinkedCalibrationFolders().map(f => f.relDir).sort()).toEqual(['Calibration/Darks', 'Calibration/Flats']);

    db.prepare('UPDATE librarySources SET enabled = 0 WHERE id = ?').run(sourceId);
    expect(listCalibrationLibrary().some(g => isLinkedScope(g.scope))).toBe(false);
  });

  it('ignores a stored folder that would leave the linked folder', async () => {
    const root = makeRoot();
    const { sourceId } = await commitSource(root, SETTINGS, { label: 'My archive' });
    db.prepare('UPDATE librarySources SET lastScanStats = ? WHERE id = ?')
      .run(JSON.stringify({ calibrationDirs: ['../outside', '/etc', 'a/../b', 'Calibration/Darks'] }), sourceId);
    expect(listLinkedCalibrationFolders().map(f => f.relDir)).toEqual(['Calibration/Darks']);
  });
});
