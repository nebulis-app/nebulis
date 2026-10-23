import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-folder-asiair-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { scanImportFolder } from '../../server/lib/library/folderScan';
import { commitFolderImport } from '../../server/lib/library/import';
import { createProfile } from '../../server/lib/telescopes';
import { addOpticalConfig } from '../../server/lib/telescopeOpticalConfigs';
import { stmts } from '../../server/lib/library/objects';
import { LIBRARY_DIR } from '../../server/lib/paths';

const DARK = 'Dark_60s_Bin1_20240320-235959_0018.fit';
const FLAT = 'Flat_1.0ms_Bin1_S_gain100_20240320-233122_-10.5C_0001.fit';
const LIGHT = 'Light_M42_10.0s_Bin1_S_gain360_20240320-203324_-10.0C_0001.fit';

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

describe('folder import of an ASIAIR tree', () => {
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

  it('always archives calibration folders nested under a capture mode', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asiair-wizard-'));
    const write = (rel: string, contents: string) => {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, contents);
    };
    write(path.join('Autorun', 'Light', 'M42', LIGHT), 'light');
    write(path.join('Autorun', 'Dark', DARK), 'dark');
    write(path.join('Plan', 'Flat', FLAT), 'flat');

    const profile = createProfile({ name: 'ASIAIR Wizard', kind: 'asiair' });

    const scan = scanImportFolder(root, { importFits: true, importSubFrames: true }, 'asiair');
    // The wizard sees the calibration folders as excluded, not as objects...
    expect(scan.objects.map(o => o.folderName)).toEqual(['M42']);
    expect(scan.excludedFolders).toEqual(expect.arrayContaining(['Autorun/Dark', 'Plan/Flat']));

    // ...and archiveAllFiles is off, yet calibration must still be kept.
    await commitFolderImport({
      rootPath: root,
      importFits: true,
      importSubFrames: true,
      telescopeId: profile.id,
      objects: [{
        folderName: 'M42',
        targetObjectId: 'M42',
        targetFolderName: 'M42',
        sessionMap: { '2024-03-20': '2024-03-20' },
      }],
    });

    const archived = filesUnder(LIBRARY_DIR).map(f => f.slice(LIBRARY_DIR.length + 1));
    const darkEntry = archived.find(f => f.endsWith(DARK));
    const flatEntry = archived.find(f => f.endsWith(FLAT));
    expect(darkEntry).toBeDefined();
    expect(flatEntry).toBeDefined();
    // Kept as archived bytes, under their original capture-mode folder,
    // scoped to the telescope the plan was tagged with.
    expect(darkEntry!.startsWith('_archive')).toBe(true);
    expect(darkEntry).toContain(path.join('Autorun', 'Dark'));
    expect(flatEntry).toContain(path.join('Plan', 'Flat'));
    // ...and they never became library objects.
    expect(fs.existsSync(path.join(LIBRARY_DIR, 'Dark'))).toBe(false);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('stamps the chosen optical configuration on the imported nights, and only one of that telescope', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asiair-optics-'));
    fs.mkdirSync(path.join(root, 'M42'), { recursive: true });
    fs.writeFileSync(path.join(root, 'M42', LIGHT), 'light');
    const profile = createProfile({ name: 'Elendil', kind: 'asiair' });
    const other = createProfile({ name: 'Other', kind: 'asiair' });
    const reducer = addOpticalConfig(profile.id, { name: 'Reducer', focalLengthMm: 456, sensorWidthMm: 11.1, sensorHeightMm: 6.3 });
    const foreign = addOpticalConfig(other.id, { name: 'Foreign', focalLengthMm: 250, sensorWidthMm: 11.1, sensorHeightMm: 6.3 });
    const plan = (configId: string) => ({
      rootPath: root, importFits: true, importSubFrames: true, telescopeId: profile.id, opticalConfigId: configId,
      objects: [{ folderName: 'M42', targetObjectId: 'M42', targetFolderName: 'M42', sessionMap: { '2024-03-20': '2024-03-20' } }],
    });

    await commitFolderImport(plan(reducer.id));
    expect(stmts.getSession.get('M42', '2024-03-20')).toMatchObject({ telescopeId: profile.id, opticalConfigId: reducer.id });

    if (fs.existsSync(LIBRARY_DIR)) fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
    stmts.clearSessions.run('M42');
    await commitFolderImport(plan(foreign.id));
    expect(stmts.getSession.get('M42', '2024-03-20')?.opticalConfigId).not.toBe(foreign.id);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
