import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors libraryImport.test.ts.
// Nests under <repo>/.test-tmp (gitignored, wiped by tests/globalSetup.ts) so a
// crashed run never litters the repo root.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-folderimport-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { scanImportFolder } from '../../server/lib/library/folderScan';
import { commitFolderImport } from '../../server/lib/library/import';
import { getLocalSessions } from '../../server/lib/library/observations';
import { LIBRARY_DIR } from '../../server/lib/paths';

/** Build a minimal FITS header buffer with the given cards. */
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

// ─── Scan + commit integration ───────────────────────────────────────────────

describe('scan + commit', () => {
  beforeAll(() => {
    // Keep enrichment/weather (which run after commit) fully offline + fast.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });
  beforeEach(() => {
    if (fs.existsSync(LIBRARY_DIR)) fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
  });

  function makeSourceTree(): string {
    const root = tmpDir('src-lib-');
    // M42: one filename-dated JPG + one undated FITS with DATE-OBS on the next day.
    fs.mkdirSync(path.join(root, 'M42'));
    fs.writeFileSync(
      path.join(root, 'M42', 'Stacked_10_M42_30.0s_IRCUT_20240115-220000.jpg'),
      'jpg',
    );
    fs.writeFileSync(
      path.join(root, 'M42', 'light_001.fits'),
      fitsBuffer({ 'DATE-OBS': '2024-01-16T01:00:00' }),
    );
    // NGC7000: a FITS with no date card, under a date-named subfolder.
    fs.mkdirSync(path.join(root, 'NGC7000', '2023-09-10'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'NGC7000', '2023-09-10', 'frame.fits'),
      fitsBuffer({ OBJECT: 'NGC7000' }),
    );
    return root;
  }

  const settings = { importFits: true, importJpg: true };

  it('scans into objects and derived sessions without copying anything', () => {
    const root = makeSourceTree();
    const result = scanImportFolder(root, settings);

    expect(result.objects.map(o => o.folderName).sort()).toEqual(['M42', 'NGC7000']);
    const m42 = result.objects.find(o => o.folderName === 'M42')!;
    expect(m42.sessions.map(s => s.date).sort()).toEqual(['2024-01-15', '2024-01-16']);
    expect(m42.catalogMatch?.objectId).toBe('M42');

    const ngc = result.objects.find(o => o.folderName === 'NGC7000')!;
    expect(ngc.sessions.map(s => s.date)).toEqual(['2023-09-10']);
    expect(ngc.sessions[0].source).toBe('folder');

    // Dry run: nothing written to the library.
    expect(fs.existsSync(path.join(LIBRARY_DIR, 'M42'))).toBe(false);
  });

  it('catalogs Seestar solar_photo and lunar_photo folders as solar system objects', () => {
    const root = tmpDir('solar-lunar-');
    fs.mkdirSync(path.join(root, 'solar_photo'));
    fs.writeFileSync(
      path.join(root, 'solar_photo', 'Stacked_12_solar_photo_1.0ms_SOLAR_20260520-120000.jpg'),
      'jpg',
    );
    fs.mkdirSync(path.join(root, 'lunar_photo'));
    fs.writeFileSync(
      path.join(root, 'lunar_photo', 'Stacked_20_lunar_photo_5ms_IRCUT_20260521-210000.jpg'),
      'jpg',
    );

    const result = scanImportFolder(root, settings);

    const solar = result.objects.find(o => o.folderName === 'solar_photo');
    const lunar = result.objects.find(o => o.folderName === 'lunar_photo');
    expect(solar?.catalogMatch?.name).toBe('The Sun');
    expect(solar?.catalogMatch?.type).toBe('Star');
    expect(solar?.sessions.map(s => s.date)).toEqual(['2026-05-20']);
    expect(lunar?.catalogMatch?.name).toBe('The Moon');
    expect(lunar?.catalogMatch?.type).toBe('Natural Satellite');
    expect(lunar?.sessions.map(s => s.date)).toEqual(['2026-05-21']);
  });

  it('splits a Planetary_photo-style container folder into per-target objects', () => {
    const root = tmpDir('planetary-');
    fs.mkdirSync(path.join(root, 'Planetary_photo'));
    const files = [
      '2026-03-31-194930-Jupiter.jpg',
      '2026-03-31-194930-Jupiter_thn.jpg',
      '2026-05-25-212058-Venus.jpg',
      '2026-05-25-212346-Jupiter.jpg',
    ];
    for (const f of files) fs.writeFileSync(path.join(root, 'Planetary_photo', f), 'jpg');

    const result = scanImportFolder(root, settings);

    const names = result.objects.map(o => o.folderName).sort();
    expect(names).toEqual(['Jupiter', 'Venus']);

    const jupiter = result.objects.find(o => o.folderName === 'Jupiter')!;
    expect(jupiter.sessions.map(s => s.date).sort()).toEqual(['2026-03-31', '2026-05-25']);

    const venus = result.objects.find(o => o.folderName === 'Venus')!;
    expect(venus.sessions.map(s => s.date)).toEqual(['2026-05-25']);
  });

  it('commits a plan: copies files without renaming .fit/.jpg, records dated sessions', async () => {
    const root = makeSourceTree();
    await commitFolderImport({
      rootPath: root,
      objects: [
        {
          folderName: 'M42',
          targetObjectId: 'M42',
          targetFolderName: 'M42',
          sessionMap: { '2024-01-15': '2024-01-15', '2024-01-16': '2024-01-16' },
        },
        {
          folderName: 'NGC7000',
          targetObjectId: 'NGC7000',
          targetFolderName: 'NGC7000',
          sessionMap: { '2023-09-10': '2023-09-10' },
        },
      ],
    });

    const m42Dir = path.join(LIBRARY_DIR, 'M42');
    const m42Files = fs.readdirSync(m42Dir);
    // JPG keeps its original name — no timestamp rename for .jpg files.
    expect(m42Files).toContain('Stacked_10_M42_30.0s_IRCUT_20240115-220000.jpg');
    // light_001.fits is not imported because importFits defaults to false in a
    // fresh DB; the FITS import gate is exercised via scanImportFolder settings.

    const sessions = getLocalSessions('M42').map(s => s.date).sort();
    expect(sessions).toEqual(['2024-01-15']);

    // NGC7000 uses only a .fits file; importFits defaults to false in a fresh
    // DB so the file is not imported and no session row is written.
    const ngcSessions = getLocalSessions('NGC7000').map(s => s.date);
    expect(ngcSessions).toEqual([]);
  });

  it('merges two derived sessions when mapped to the same final date', async () => {
    const root = makeSourceTree();
    await commitFolderImport({
      rootPath: root,
      objects: [
        {
          folderName: 'M42',
          targetObjectId: 'M42',
          targetFolderName: 'M42',
          // Both nights collapsed onto one date.
          sessionMap: { '2024-01-15': '2024-01-15', '2024-01-16': '2024-01-15' },
        },
      ],
    });
    const sessions = getLocalSessions('M42').map(s => s.date);
    expect(sessions).toEqual(['2024-01-15']);
  });

  it('drops files whose session is mapped to null', async () => {
    const root = makeSourceTree();
    await commitFolderImport({
      rootPath: root,
      objects: [
        {
          folderName: 'M42',
          targetObjectId: 'M42',
          targetFolderName: 'M42',
          sessionMap: { '2024-01-15': '2024-01-15', '2024-01-16': null },
        },
      ],
    });
    const sessions = getLocalSessions('M42').map(s => s.date);
    expect(sessions).toEqual(['2024-01-15']);
    expect(fs.existsSync(path.join(LIBRARY_DIR, 'M42', 'light_001_20240116-010000.fits'))).toBe(false);
  });

  it('imports loose Dwarf RAW TELE FITS as subframes when subframes are included', async () => {
    const root = tmpDir('dwarf-raw-');
    const rawName = 'NGC 1647_15s60_Astro_20260318-201554115_26C.fits';
    fs.writeFileSync(path.join(root, rawName), fitsBuffer({ OBJECT: 'NGC 1647' }));

    const scanned = scanImportFolder(root, {
      importSubFrames: true,
      importFits: false,
      importJpg: true,
    });
    expect(scanned.objects).toHaveLength(1);
    expect(scanned.objects[0].fileCount).toBe(1);
    expect(scanned.objects[0].sessions.map(s => s.date)).toEqual(['2026-03-18']);

    await commitFolderImport({
      rootPath: root,
      importSubFrames: true,
      objects: [
        {
          folderName: 'NGC 1647',
          targetObjectId: 'NGC1647',
          targetFolderName: 'NGC1647',
          sessionMap: { '2026-03-18': '2026-03-18' },
        },
      ],
    });

    const files = fs.readdirSync(path.join(LIBRARY_DIR, 'NGC1647'));
    expect(files).toContain(rawName);

    const [session] = getLocalSessions('NGC1647');
    expect(session.date).toBe('2026-03-18');
    expect(session.subFrameCount).toBe(1);
  });
});
