import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-dwarfmosaic-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { scanImportFolder } from '../../server/lib/library/folderScan';
import { commitFolderImport } from '../../server/lib/library/import';
import { LIBRARY_DIR } from '../../server/lib/paths';
import { getActiveSite, updateSite } from '../../server/lib/observingSites';
import { updateSettingsData } from '../../server/lib/telescopes';
import { getLibraryFilesForObject } from '../../server/lib/library/libraryFiles';
import { getLocalFiles, getLocalObservations, getLocalSessions } from '../../server/lib/library/observations';
import db from '../../server/lib/db';

/** Minimal FITS header buffer; the import only reads the header. */
function fitsBuffer(cards: Record<string, string>): Buffer {
  const lines: string[] = [];
  const card = (key: string, value: string) =>
    (`${key.padEnd(8)}= '${value}'`).padEnd(80).slice(0, 80);
  lines.push(`${'SIMPLE'.padEnd(8)}=                    T`.padEnd(80).slice(0, 80));
  for (const [k, v] of Object.entries(cards)) lines.push(card(k, v));
  lines.push('END'.padEnd(80));
  const buf = Buffer.alloc(2880, ' ');
  buf.write(lines.join(''), 0, 'ascii');
  return buf;
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const PARENT = 'DWARF_RAW_TELE_MOSAIC_IC 1805_EXP_10_GAIN_200_2026-11-05-20-40-32-316';
const PANEL_1 = 'DWARF_RAW_TELE_IC 1805(1)_EXP_10_GAIN_200_2026-11-05-20-40-32-347';
const PANEL_2 = 'DWARF_RAW_TELE_IC 1805(2)_EXP_10_GAIN_200_2026-11-05-20-40-32-357';

/** A real Dwarf Mini mosaic export, reduced to one frame per panel. */
function makeMosaicTree(): string {
  const root = tmpDir('src-dwarf-mosaic-');
  const parent = path.join(root, PARENT);
  fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(path.join(parent, 'shotsInfo.json'), JSON.stringify({ target: 'IC 1805' }));
  fs.writeFileSync(path.join(parent, 'stacked.jpg'), 'jpg');

  for (const [panel, ts] of [[PANEL_1, '204148160'], [PANEL_2, '204939736']] as const) {
    const dir = path.join(parent, panel);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'shotsInfo.json'), JSON.stringify({ target: panel.replace(/^DWARF_RAW_TELE_|_EXP_.*$/g, '') }));
    fs.writeFileSync(
      path.join(dir, `stacked-16_IC 1805(${panel.includes('(1)') ? 1 : 2})_10s200_Duo-Band_20261105-${ts}.fits`),
      fitsBuffer({ 'DATE-OBS': '2026-11-05T20:41:48', OBJECT: 'IC 1805' }),
    );
    fs.writeFileSync(
      path.join(dir, `IC 1805(${panel.includes('(1)') ? 1 : 2})_10s200_Duo-Band_20261105-${ts}_19C.fits`),
      fitsBuffer({ 'DATE-OBS': '2026-11-05T20:41:48', OBJECT: 'IC 1805' }),
    );
    fs.writeFileSync(path.join(dir, 'stacked.jpg'), 'jpg');
  }
  return root;
}

describe('Dwarf mosaic import', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
    updateSite(getActiveSite().id, { timezone: 'UTC' });
    updateSettingsData({ importFits: true, importJpg: true, importSubFrames: true, importThumbnails: true });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });
  beforeEach(() => {
    if (fs.existsSync(LIBRARY_DIR)) fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
    for (const table of ['libraryFiles', 'librarySessions', 'libraryObjects']) {
      db.prepare(`DELETE FROM "${table}"`).run();
    }
  });

  const settings = { importFits: true, importJpg: true, importSubFrames: true, importThumbnails: true };

  it('scans the mosaic parent as one object, not one object per panel', () => {
    const root = makeMosaicTree();
    const parent = path.join(root, PARENT);

    const scan = scanImportFolder(parent, settings, 'dwarf-3', 'UTC');

    expect(scan.objects).toHaveLength(1);
    expect(scan.objects[0].folderName).toBe('IC 1805_mosaic');
    expect(scan.objects[0].targetObjectId).toBe('IC1805_mosaic');
    // Parent preview + sidecar, plus four files in each of the two panels.
    expect(scan.objects[0].fileCount).toBe(10);
    expect(scan.objects[0].sessions.map(s => s.date)).toEqual(['2026-11-05']);
  });

  it('scans a directory that contains the mosaic parent the same way', () => {
    const root = makeMosaicTree();

    const scan = scanImportFolder(root, settings, 'dwarf-3', 'UTC');

    expect(scan.objects).toHaveLength(1);
    expect(scan.objects[0].folderName).toBe('IC 1805_mosaic');
    expect(scan.objects[0].targetObjectId).toBe('IC1805_mosaic');
    expect(scan.objects[0].fileCount).toBe(10);
  });

  it('commits both panels under one mosaic session, keeping each panel as a sub-directory', async () => {
    const root = makeMosaicTree();
    const parent = path.join(root, PARENT);
    const scan = scanImportFolder(parent, settings, 'dwarf-3', 'UTC');
    const object = scan.objects[0];

    await commitFolderImport({
      rootPath: parent,
      objects: [{
        folderName: object.folderName,
        targetObjectId: object.targetObjectId!,
        targetFolderName: object.targetObjectId!,
        sessionMap: Object.fromEntries(object.sessions.map(s => [s.date, s.date])),
      }],
      importSubFrames: true,
      importFits: true,
    });

    const rows = getLibraryFilesForObject('IC1805_mosaic');
    const relPaths = rows.map(r => r.relPath).sort();
    const objectDir = 'IC1805_mosaic';

    expect(relPaths).toContain(`${objectDir}/${PARENT}/shotsInfo.json`);
    expect(relPaths).toContain(`${objectDir}/${PARENT}/stacked.jpg`);
    expect(relPaths).toContain(`${objectDir}/${PARENT}/${PANEL_1}/stacked-16_IC 1805(1)_10s200_Duo-Band_20261105-204148160.fits`);
    expect(relPaths).toContain(`${objectDir}/${PARENT}/${PANEL_2}/stacked-16_IC 1805(2)_10s200_Duo-Band_20261105-204939736.fits`);
    expect(relPaths).toContain(`${objectDir}/${PARENT}/${PANEL_1}/IC 1805(1)_10s200_Duo-Band_20261105-204148160_19C.fits`);
    expect(relPaths).toContain(`${objectDir}/${PARENT}/${PANEL_2}/IC 1805(2)_10s200_Duo-Band_20261105-204939736_19C.fits`);

    // Both panels are one observing session.
    const sessions = db.prepare<[], { objectId: string; date: string }>(
      'SELECT objectId, date FROM librarySessions WHERE objectId = ?',
    ).all('IC1805_mosaic');
    expect(sessions).toEqual([{ objectId: 'IC1805_mosaic', date: '2026-11-05' }]);

    // And every panel file exists on disk under the parent session folder.
    for (const rel of relPaths) {
      expect(fs.existsSync(path.join(LIBRARY_DIR, rel))).toBe(true);
    }
  });

  it('shows the combined mosaic preview on the session card, not a single panel', async () => {
    const root = makeMosaicTree();
    const parent = path.join(root, PARENT);
    const scan = scanImportFolder(parent, settings, 'dwarf-3', 'UTC');
    const object = scan.objects[0];

    await commitFolderImport({
      rootPath: parent,
      objects: [{
        folderName: object.folderName,
        targetObjectId: object.targetObjectId!,
        targetFolderName: object.targetObjectId!,
        sessionMap: Object.fromEntries(object.sessions.map(s => [s.date, s.date])),
      }],
      importSubFrames: true,
      importFits: true,
    });

    const [session] = getLocalSessions('IC1805_mosaic');
    const expectedPreview = `IC1805_mosaic/${PARENT}/stacked.jpg`;
    expect(session.thumbnailUrl).toContain(encodeURIComponent(expectedPreview));

    // The calendar/list card agrees with the object page.
    const calendar = getLocalObservations().find(o => o.objectId === 'IC1805_mosaic' && o.date === '2026-11-05');
    expect(calendar?.thumbnailUrl).toContain(encodeURIComponent(expectedPreview));

    // The combined preview is also a real file in the session listing, not
    // hidden as a redundant device preview now that panel stacks exist.
    const files = getLocalFiles('IC1805_mosaic');
    expect(files.some(f => f.path === expectedPreview)).toBe(true);
  });
});
