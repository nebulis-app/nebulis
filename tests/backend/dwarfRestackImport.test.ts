import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors dwarfIsolation.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-dwarfrestackimport-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { LIBRARY_DIR } from '../../server/lib/paths';
import { runImport, claimImportLock, getImportStatus, commitFolderImport, waitUpTo } from '../../server/lib/library/import';
import { scanImportFolder } from '../../server/lib/library/folderScan';
import { getAllProcessedImagesForObject } from '../../server/lib/library/processed';
import { getRestackArchiveDir } from '../../server/lib/library/archiveFolders';
import { createProfile } from '../../server/lib/telescopes';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('RESTACKED — live sync', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('matches a RESTACKED subfolder to an already-imported object and lands it as a processed image', async () => {
    const deviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dwarf-restack-device-'));
    const session = 'DWARF3_RAW_M42_EXP_30_GAIN_80_2026-08-01_21-00-00-000';
    fs.mkdirSync(path.join(deviceRoot, 'Astronomy', session), { recursive: true });
    fs.writeFileSync(path.join(deviceRoot, 'Astronomy', session, 'stacked.jpg'), 'stacked-jpg');
    // RESTACKED/M42/megastack.jpg — a combined stack of the same target.
    fs.mkdirSync(path.join(deviceRoot, 'Astronomy', 'RESTACKED', 'M42'), { recursive: true });
    fs.writeFileSync(path.join(deviceRoot, 'Astronomy', 'RESTACKED', 'M42', 'megastack.jpg'), 'megastack-bytes');

    const profile = createProfile({
      name: 'Dwarf Restack Test',
      kind: 'dwarf-3',
      connectionType: 'local',
      localPath: deviceRoot,
    });

    expect(claimImportLock()).toBe(true);
    await runImport(undefined, undefined, { telescopeId: profile.id });
    expect(getImportStatus().error).toBeFalsy();

    const processed = getAllProcessedImagesForObject('M42');
    expect(processed).toHaveLength(1);
    expect(processed[0].date).toBeNull();
    expect(processed[0].source).toBe('dwarf-restack');
    expect(processed[0].originalName).toBe('megastack.jpg');

    // Re-syncing must not duplicate the row.
    expect(claimImportLock()).toBe(true);
    await runImport(undefined, undefined, { telescopeId: profile.id });
    expect(getAllProcessedImagesForObject('M42')).toHaveLength(1);

    fs.rmSync(deviceRoot, { recursive: true, force: true });
  });

  it('never imports stacked_thumbnail.jpg as a processed image', async () => {
    const deviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dwarf-restack-preview-device-'));
    const session = 'DWARF3_RAW_M42_EXP_30_GAIN_80_2026-08-01_21-00-00-000';
    fs.mkdirSync(path.join(deviceRoot, 'Astronomy', session), { recursive: true });
    fs.writeFileSync(path.join(deviceRoot, 'Astronomy', session, 'stacked.jpg'), 'stacked-jpg');
    fs.mkdirSync(path.join(deviceRoot, 'Astronomy', 'RESTACKED', 'M42'), { recursive: true });
    fs.writeFileSync(path.join(deviceRoot, 'Astronomy', 'RESTACKED', 'M42', 'megastack.jpg'), 'megastack-bytes');
    fs.writeFileSync(path.join(deviceRoot, 'Astronomy', 'RESTACKED', 'M42', 'stacked_thumbnail.jpg'), 'preview-bytes');

    const profile = createProfile({
      name: 'Dwarf Restack Preview Test',
      kind: 'dwarf-3',
      connectionType: 'local',
      localPath: deviceRoot,
    });

    expect(claimImportLock()).toBe(true);
    await runImport(undefined, undefined, { telescopeId: profile.id });
    expect(getImportStatus().error).toBeFalsy();

    // The real image is still matched normally; only the redundant preview is skipped.
    const processed = getAllProcessedImagesForObject('M42');
    expect(processed).toHaveLength(1);
    expect(processed[0].originalName).toBe('megastack.jpg');
    expect(processed.some(img => img.originalName === 'stacked_thumbnail.jpg')).toBe(false);

    // Left unmatched, it still falls through to the archive -- bytes kept, just
    // never a processed-image row. Restack leftovers land in the shared
    // RESTACKED/ root, not this telescope's own archive scope.
    expect(fs.existsSync(path.join(getRestackArchiveDir(), 'M42', 'stacked_thumbnail.jpg'))).toBe(true);

    fs.rmSync(deviceRoot, { recursive: true, force: true });
  });

  it('matches via shotsInfo.json target when the subfolder name is not a bare target (real Dwarf 3 layout)', async () => {
    // Real-world layout, not the documented one: the subfolder name is the
    // raw session-folder name with "RESTACKED_" prepended, and its trailing
    // timestamp has no internal dashes (YYYYMMDD-HHMMSSmmm), which matches
    // neither pattern the walker's own timestamp stripper recognizes. Name
    // parsing alone can't recover "C 27" from this; shotsInfo.json can.
    const deviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dwarf-restack-shotsinfo-device-'));
    const session = 'DWARF3_RAW_NGC6888_EXP_30_GAIN_80_2026-08-01_21-00-00-000';
    fs.mkdirSync(path.join(deviceRoot, 'Astronomy', session), { recursive: true });
    fs.writeFileSync(path.join(deviceRoot, 'Astronomy', session, 'stacked.jpg'), 'stacked-jpg');

    const restackSub = 'RESTACKED_DWARF_RAW_TELE_C 27_Astro_20250709-010411632';
    fs.mkdirSync(path.join(deviceRoot, 'Astronomy', 'RESTACKED', restackSub), { recursive: true });
    fs.writeFileSync(path.join(deviceRoot, 'Astronomy', 'RESTACKED', restackSub, 'stacked.jpg'), 'megastack-bytes');
    fs.writeFileSync(
      path.join(deviceRoot, 'Astronomy', 'RESTACKED', restackSub, 'stacked-16_C 27_Astro_20250709-010411641.fits'),
      'fits-bytes',
    );
    fs.writeFileSync(
      path.join(deviceRoot, 'Astronomy', 'RESTACKED', restackSub, 'shotsInfo.json'),
      JSON.stringify({ DEC: 38.36, RA: 20.2, target: 'C 27' }),
    );

    const profile = createProfile({
      name: 'Dwarf Restack ShotsInfo Test',
      kind: 'dwarf-3',
      connectionType: 'local',
      localPath: deviceRoot,
    });

    expect(claimImportLock()).toBe(true);
    await runImport(undefined, undefined, { telescopeId: profile.id });
    expect(getImportStatus().error).toBeFalsy();

    const processed = getAllProcessedImagesForObject('NGC6888');
    expect(processed).toHaveLength(2);
    // shotsInfo.json has no date field; both files inherit the subfolder
    // name's own trailing timestamp instead of landing on "No specific session".
    for (const img of processed) {
      expect(img.source).toBe('dwarf-restack');
      expect(img.date).toBe('2025-07-09');
    }
    const jpg = processed.find(img => img.originalName === 'stacked.jpg')!;
    expect(jpg).toBeDefined();
    expect(jpg.thumbUrl).toBeNull(); // renderable directly, no server thumbnail needed
    const fits = processed.find(img => img.originalName.endsWith('.fits'))!;
    expect(fits).toBeDefined();
    expect(fits.thumbUrl).toContain('/fits-thumbnail');
    expect(fits.thumbUrl).toContain(encodeURIComponent(fits.path));

    // shotsInfo.json itself isn't a renderable/storable processed-image name,
    // so it still lands in the archive even though stacked.jpg was matched
    // away as a processed image. Shared RESTACKED/ root, not this
    // telescope's own archive scope.
    expect(fs.existsSync(path.join(getRestackArchiveDir(), restackSub, 'shotsInfo.json'))).toBe(true);

    fs.rmSync(deviceRoot, { recursive: true, force: true });
  });

  it('a RESTACKED subfolder for a target with no existing object creates one, rather than archiving', async () => {
    // No shotsInfo.json here, so this exercises the name-only fallback: the
    // subfolder name itself becomes the object id, the same trust level an
    // ordinary session folder already gets (see ensureRestackObject's doc).
    const deviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dwarf-restack-newtarget-device-'));
    fs.mkdirSync(path.join(deviceRoot, 'Astronomy', 'RESTACKED', 'TotallyNewTarget9000'), { recursive: true });
    fs.writeFileSync(
      path.join(deviceRoot, 'Astronomy', 'RESTACKED', 'TotallyNewTarget9000', 'stack.jpg'),
      'restack-bytes',
    );

    const profile = createProfile({
      name: 'Dwarf Restack New Target Test',
      kind: 'dwarf-3',
      connectionType: 'local',
      localPath: deviceRoot,
    });

    expect(claimImportLock()).toBe(true);
    await runImport(undefined, undefined, { telescopeId: profile.id });
    expect(getImportStatus().error).toBeFalsy();

    const { stmts } = await import('../../server/lib/library/objects');
    expect(stmts.getObject.get('TotallyNewTarget9000')).toBeDefined();

    const processed = getAllProcessedImagesForObject('TotallyNewTarget9000');
    expect(processed).toHaveLength(1);
    expect(processed[0].originalName).toBe('stack.jpg');
    expect(processed[0].source).toBe('dwarf-restack');

    fs.rmSync(deviceRoot, { recursive: true, force: true });
  });

  it('a RESTACKED subfolder with a genuinely empty name has nothing to create an object from, so it stays archived', async () => {
    // The one case ensureRestackObject can't help with: resolveRestackTargetId
    // itself returns null (nothing at all to name an object after), not a
    // low-confidence guess. Exercised directly rather than via a real device
    // folder, since a directory entry can't have an empty name on disk.
    const { resolveRestackTargetId } = await import('../../server/lib/library/dwarfRestack');
    expect(resolveRestackTargetId('', null)).toBeNull();
  });

  it('an empty RESTACKED subfolder (queued but not yet written by the Dwarf) creates no object', async () => {
    // Real-world case: the Dwarf app creates the subfolder as soon as a
    // restack is requested, before shotsInfo.json or any image exists. With
    // no sidecar, resolveRestackTargetId falls back to name-only parsing,
    // which is known-fragile on the real Dwarf 3 naming (see
    // resolveRestackTargetId's doc) and can resolve to a garbled string —
    // that must never become a permanent object when there's nothing to
    // actually attach to it.
    const deviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dwarf-restack-empty-device-'));
    fs.mkdirSync(
      path.join(deviceRoot, 'Astronomy', 'RESTACKED', 'RESTACKED_DWARF_RAW_TELE_C 20_Duo-Band_20250618-004302511'),
      { recursive: true },
    );

    const profile = createProfile({
      name: 'Dwarf Restack Empty Folder Test',
      kind: 'dwarf-3',
      connectionType: 'local',
      localPath: deviceRoot,
    });

    expect(claimImportLock()).toBe(true);
    await runImport(undefined, undefined, { telescopeId: profile.id });
    expect(getImportStatus().error).toBeFalsy();

    const { stmts } = await import('../../server/lib/library/objects');
    expect(stmts.getObject.get('RESTACKED_DWARF_RAW_TELE_C20_Duo-Band_20250618-004302511')).toBeUndefined();

    fs.rmSync(deviceRoot, { recursive: true, force: true });
  });

  it('a RESTACKED subfolder containing only stacked_thumbnail.jpg creates no object', async () => {
    // A narrower version of the empty-folder case: something with a file in
    // it, but not one that will ever become a processed image. The presence
    // check has to look past the thumbnail preview, not just "any file".
    const deviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dwarf-restack-onlypreview-device-'));
    fs.mkdirSync(path.join(deviceRoot, 'Astronomy', 'RESTACKED', 'OnlyPreviewTarget'), { recursive: true });
    fs.writeFileSync(
      path.join(deviceRoot, 'Astronomy', 'RESTACKED', 'OnlyPreviewTarget', 'stacked_thumbnail.jpg'),
      'preview-bytes',
    );

    const profile = createProfile({
      name: 'Dwarf Restack Only Preview Test',
      kind: 'dwarf-3',
      connectionType: 'local',
      localPath: deviceRoot,
    });

    expect(claimImportLock()).toBe(true);
    await runImport(undefined, undefined, { telescopeId: profile.id });
    expect(getImportStatus().error).toBeFalsy();

    const { stmts } = await import('../../server/lib/library/objects');
    expect(stmts.getObject.get('OnlyPreviewTarget')).toBeUndefined();

    fs.rmSync(deviceRoot, { recursive: true, force: true });
  });

  it('a loose file directly in RESTACKED/ (no subfolder) is archived, never dropped', async () => {
    const deviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dwarf-restack-loose-device-'));
    fs.mkdirSync(path.join(deviceRoot, 'Astronomy', 'RESTACKED'), { recursive: true });
    fs.writeFileSync(path.join(deviceRoot, 'Astronomy', 'RESTACKED', 'loose.jpg'), 'loose-bytes');

    const profile = createProfile({
      name: 'Dwarf Restack Loose Test',
      kind: 'dwarf-3',
      connectionType: 'local',
      localPath: deviceRoot,
    });

    expect(claimImportLock()).toBe(true);
    await runImport(undefined, undefined, { telescopeId: profile.id });
    expect(getImportStatus().error).toBeFalsy();

    expect(fs.existsSync(path.join(getRestackArchiveDir(), 'loose.jpg'))).toBe(true);

    fs.rmSync(deviceRoot, { recursive: true, force: true });
  });
});

describe('RESTACKED — folder-import wizard', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('matches a RESTACKED subfolder to an object imported in the same run', async () => {
    if (fs.existsSync(LIBRARY_DIR)) fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'src-restack-wizard-'));
    fs.mkdirSync(path.join(root, 'M42'));
    fs.writeFileSync(
      path.join(root, 'M42', 'Stacked_10_M42_30.0s_IRCUT_20260801-210000.jpg'),
      'jpg',
    );
    fs.mkdirSync(path.join(root, 'RESTACKED', 'M42'), { recursive: true });
    fs.writeFileSync(path.join(root, 'RESTACKED', 'M42', 'megastack.jpg'), 'megastack-bytes');

    const scan = scanImportFolder(root, {});
    const m42 = scan.objects.find(o => o.folderName === 'M42')!;
    expect(m42).toBeDefined();

    await commitFolderImport({
      rootPath: root,
      importFits: true,
      objects: [{
        folderName: 'M42',
        targetObjectId: 'M42',
        targetFolderName: 'M42',
        sessionMap: Object.fromEntries(m42.sessions.map(s => [s.date, s.date])),
      }],
    });

    const processed = getAllProcessedImagesForObject('M42');
    expect(processed).toHaveLength(1);
    expect(processed[0].source).toBe('dwarf-restack');

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('matches via shotsInfo.json target when the subfolder name is not a bare target (real Dwarf 3 layout)', async () => {
    if (fs.existsSync(LIBRARY_DIR)) fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'src-restack-wizard-shotsinfo-'));
    fs.mkdirSync(path.join(root, 'NGC6888'));
    fs.writeFileSync(
      path.join(root, 'NGC6888', 'Stacked_10_NGC6888_30.0s_IRCUT_20260801-210000.jpg'),
      'jpg',
    );
    const restackSub = 'RESTACKED_DWARF_RAW_TELE_C 27_Astro_20250709-010411632';
    fs.mkdirSync(path.join(root, 'RESTACKED', restackSub), { recursive: true });
    fs.writeFileSync(path.join(root, 'RESTACKED', restackSub, 'stacked.jpg'), 'megastack-bytes');
    fs.writeFileSync(
      path.join(root, 'RESTACKED', restackSub, 'stacked-16_C 27_Astro_20250709-010411641.fits'),
      'fits-bytes',
    );
    fs.writeFileSync(
      path.join(root, 'RESTACKED', restackSub, 'shotsInfo.json'),
      JSON.stringify({ DEC: 38.36, RA: 20.2, target: 'C 27' }),
    );

    const scan = scanImportFolder(root, {});
    const ngc6888 = scan.objects.find(o => o.folderName === 'NGC6888')!;
    expect(ngc6888).toBeDefined();

    await commitFolderImport({
      rootPath: root,
      importFits: true,
      objects: [{
        folderName: 'NGC6888',
        targetObjectId: 'NGC6888',
        targetFolderName: 'NGC6888',
        sessionMap: Object.fromEntries(ngc6888.sessions.map(s => [s.date, s.date])),
      }],
    });

    const processed = getAllProcessedImagesForObject('NGC6888');
    expect(processed).toHaveLength(2);
    for (const img of processed) {
      expect(img.source).toBe('dwarf-restack');
      expect(img.date).toBe('2025-07-09');
    }
    const fits = processed.find(img => img.originalName.endsWith('.fits'))!;
    expect(fits).toBeDefined();
    expect(fits.thumbUrl).toContain('/fits-thumbnail');

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('never imports stacked_thumbnail.jpg as a processed image', async () => {
    if (fs.existsSync(LIBRARY_DIR)) fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'src-restack-wizard-preview-'));
    fs.mkdirSync(path.join(root, 'M42'));
    fs.writeFileSync(
      path.join(root, 'M42', 'Stacked_10_M42_30.0s_IRCUT_20260801-210000.jpg'),
      'jpg',
    );
    fs.mkdirSync(path.join(root, 'RESTACKED', 'M42'), { recursive: true });
    fs.writeFileSync(path.join(root, 'RESTACKED', 'M42', 'megastack.jpg'), 'megastack-bytes');
    fs.writeFileSync(path.join(root, 'RESTACKED', 'M42', 'stacked_thumbnail.jpg'), 'preview-bytes');

    const scan = scanImportFolder(root, {});
    const m42 = scan.objects.find(o => o.folderName === 'M42')!;
    expect(m42).toBeDefined();

    await commitFolderImport({
      rootPath: root,
      importFits: true,
      objects: [{
        folderName: 'M42',
        targetObjectId: 'M42',
        targetFolderName: 'M42',
        sessionMap: Object.fromEntries(m42.sessions.map(s => [s.date, s.date])),
      }],
    });

    const processed = getAllProcessedImagesForObject('M42');
    expect(processed).toHaveLength(1);
    expect(processed[0].originalName).toBe('megastack.jpg');

    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('RESTACKED — stacked_thumbnail.jpg never displays, even if already imported', () => {
  it('getAllProcessedImagesForObject and getProcessedImages both filter out a pre-existing row', async () => {
    const { stmts } = await import('../../server/lib/library/objects');
    const { getProcessedImages } = await import('../../server/lib/library/processed');

    // Own object id, unused by every other test in this file (the shared
    // SQLite DB persists for the whole file's run, so a shared id like
    // 'M42' would pick up rows other tests already inserted).
    const objectId = 'NGC0001PREVIEWTEST';

    // Simulate a row written before this filter existed -- direct DB insert,
    // bypassing addProcessedImage, since the point is that a *read* filters
    // it regardless of when or how it got there.
    const cat = { catalogId: objectId, objectName: objectId, objectType: 'Galaxy', constellation: '', description: '', magnitude: null, ra: null, dec: null, distanceLy: null };
    stmts.upsertObject.run(objectId, objectId, 1, new Date().toISOString(), 0, null,
      cat.catalogId, cat.objectName, cat.objectType, cat.constellation,
      cat.description, cat.magnitude, cat.ra, cat.dec, cat.distanceLy);
    stmts.insertProcessedImage.run(
      'proc_preview_test', objectId, '2026-08-01', 'stacked_thumbnail.jpg', 'stacked_thumbnail.jpg',
      '', '', 100, 'image/jpeg', new Date().toISOString(), null, 'dwarf-restack',
    );
    stmts.insertProcessedImage.run(
      'proc_real_test', objectId, '2026-08-01', 'stacked.jpg', 'stacked.jpg',
      '', '', 100, 'image/jpeg', new Date().toISOString(), null, 'dwarf-restack',
    );

    const all = getAllProcessedImagesForObject(objectId);
    expect(all.map(i => i.originalName)).toEqual(['stacked.jpg']);

    const bySession = getProcessedImages(objectId, '2026-08-01');
    expect(bySession.map(i => i.originalName)).toEqual(['stacked.jpg']);
  });

  it('getAllLibraryImages (the library-wide Gallery page) also filters out a pre-existing row', async () => {
    const { stmts } = await import('../../server/lib/library/objects');
    const { getAllLibraryImages, invalidateAllImagesCache } = await import('../../server/lib/library/gallery');

    // Own object id, unused by every other test in this file — see the note
    // on the sibling test above about the shared per-file SQLite DB.
    const objectId = 'NGC0002PREVIEWTEST';

    const cat = { catalogId: objectId, objectName: objectId, objectType: 'Galaxy', constellation: '', description: '', magnitude: null, ra: null, dec: null, distanceLy: null };
    stmts.upsertObject.run(objectId, objectId, 1, new Date().toISOString(), 0, null,
      cat.catalogId, cat.objectName, cat.objectType, cat.constellation,
      cat.description, cat.magnitude, cat.ra, cat.dec, cat.distanceLy);
    stmts.insertProcessedImage.run(
      'proc_preview_test_2', objectId, '2026-08-01', 'stacked_thumbnail.jpg', 'stacked_thumbnail.jpg',
      '', '', 100, 'image/jpeg', new Date().toISOString(), null, 'dwarf-restack',
    );
    stmts.insertProcessedImage.run(
      'proc_real_test_2', objectId, '2026-08-01', 'stacked.jpg', 'stacked.jpg',
      '', '', 100, 'image/jpeg', new Date().toISOString(), null, 'dwarf-restack',
    );

    // getAllLibraryImages caches the filesystem walk for 15s -- force a fresh
    // one so this test doesn't depend on run order relative to other tests
    // that may have already populated (and cached) the walk before this
    // object existed.
    invalidateAllImagesCache();
    const { items } = getAllLibraryImages();
    const forThisObject = items.filter(i => i.objectId === objectId);
    expect(forThisObject.map(i => i.name)).toEqual(['stacked.jpg']);
  });
});

// ── Regression: RESTACKED must never write into the source, and must never
// leave an empty (or flat) object behind ──────────────────────────────────────
//
// Real incident (2026-10-07): a folder import of a Dwarf card whose RESTACKED/
// folder was read-only. The folder import copied each restack to a temp file
// *beside the source file*, which failed with EACCES for every file, but only
// after ensureRestackObject had already created the target (C 27 → NGC6888).
// The object was created flat, so the empty row raised the "Your library needs
// a one-time update" prompt. On a writable source the same code briefly wrote
// `*.restack-import-<uuid>` files into the user's own folder.

const canDenyRead = typeof process.getuid !== 'function' || process.getuid() !== 0;

/** Every file under `dir` with its size and mode, so any write, rename or
 *  leftover temp file in the source shows up as a diff. */
function snapshotTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) { out.push(`${r}/`); walk(abs, r); }
      else out.push(`${r}:${fs.statSync(abs).size}`);
    }
  };
  walk(dir, '');
  return out.sort();
}

/** chmod a tree back to writable so cleanup can remove it. */
function makeWritable(dir: string): void {
  fs.chmodSync(dir, 0o755);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) makeWritable(abs);
    else fs.chmodSync(abs, 0o644);
  }
}

/** A Dwarf-style source with one ordinary session (M42) plus a RESTACKED
 *  subfolder for a target that is not in the import plan, so the restack is
 *  the only thing that can create it. Returns the root and the restack dir. */
function seedRestackSource(prefix: string, caldwell: string): { root: string; subDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, 'M42'));
  fs.writeFileSync(path.join(root, 'M42', 'Stacked_10_M42_30.0s_IRCUT_20260801-210000.jpg'), 'jpg');
  const sub = `RESTACKED_DWARF_RAW_TELE_${caldwell}_Astro_20250709-010411632`;
  const subDir = path.join(root, 'RESTACKED', sub);
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'stacked.jpg'), 'megastack-bytes');
  fs.writeFileSync(path.join(subDir, `stacked-16_${caldwell}_Astro_20250709-010411641.fits`), 'fits-bytes');
  fs.writeFileSync(path.join(subDir, 'shotsInfo.json'), JSON.stringify({ RA: 20.2, DEC: 38.3, target: caldwell }));
  return { root, subDir };
}

async function commitWithM42(root: string): Promise<void> {
  const scan = scanImportFolder(root, {});
  const m42 = scan.objects.find(o => o.folderName === 'M42')!;
  await commitFolderImport({
    rootPath: root,
    importFits: true,
    objects: [{
      folderName: 'M42',
      targetObjectId: 'M42',
      targetFolderName: 'M42',
      sessionMap: Object.fromEntries(m42.sessions.map(s => [s.date, s.date])),
    }],
  });
}

describe('RESTACKED — progress counts', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  // Real incident (2026-10-07): the dialog read "319 of 312 files". Restack
  // files that match no object are archived after matching, and each one ticked
  // filesDone without ever having been added to filesTotal.
  it('folder import: filesDone never exceeds filesTotal when restack leftovers are archived', async () => {
    const { root } = seedRestackSource('src-restack-counts-', 'C 38');
    try {
      await commitWithM42(root);

      const status = getImportStatus();
      // shotsInfo.json is not an image, so it is always left over and archived.
      expect(status.restackArchivedFiles).toBeGreaterThan(0);
      expect(status.filesDone).toBeLessThanOrEqual(status.filesTotal);
      expect(status.filesDone).toBe(status.filesTotal);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('waitUpTo — the import does not wait on slow thumbnail work', () => {
  // Real incident (2026-10-07): after the last file the import awaited thumbnail
  // pre-warming, whose sky-survey fallback timed out per object, so the dialog
  // sat at 100% for about a minute. The wait is now capped.
  it('returns at the cap while the work is still running', async () => {
    let finished = false;
    const slow = new Promise<void>(resolve => setTimeout(() => { finished = true; resolve(); }, 400));
    const started = Date.now();
    await waitUpTo(slow, 30);
    expect(Date.now() - started).toBeLessThan(300);
    expect(finished).toBe(false);
    await slow; // let it settle so the test leaves no timer behind
  });

  it('returns as soon as the work finishes, and swallows its rejection', async () => {
    const started = Date.now();
    await waitUpTo(Promise.reject(new Error('boom')), 5_000);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('RESTACKED — never touches the source, never leaves an empty or flat object', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  // A before/after snapshot only catches files left behind. The old code's
  // temp file beside the source was moved away again on a writable source, so
  // the transient write itself is caught by the read-only test below.
  it('folder import: leaves a writable source unchanged and creates the new object nested', async () => {
    const { resolveRestackTargetId } = await import('../../server/lib/library/dwarfRestack');
    const { getObjectLayout } = await import('../../server/lib/library/libraryLayout');
    const { root, subDir } = seedRestackSource('src-restack-untouched-', 'C 33');
    const targetId = resolveRestackTargetId(path.basename(subDir), 'C 33')!;
    const before = snapshotTree(root);
    try {
      await commitWithM42(root);

      expect(snapshotTree(root)).toEqual(before);
      expect(getAllProcessedImagesForObject(targetId)).toHaveLength(2);
      // A brand-new object is nested, like every other new object.
      expect(getObjectLayout(targetId)).toBe('nested');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(canDenyRead)('folder import: imports restacks from a read-only source', async () => {
    const { resolveRestackTargetId } = await import('../../server/lib/library/dwarfRestack');
    const { getObjectLayout } = await import('../../server/lib/library/libraryLayout');
    const { root, subDir } = seedRestackSource('src-restack-readonly-', 'C 34');
    const targetId = resolveRestackTargetId(path.basename(subDir), 'C 34')!;
    fs.chmodSync(subDir, 0o555);
    fs.chmodSync(path.dirname(subDir), 0o555);
    const before = snapshotTree(root);
    try {
      await commitWithM42(root);

      expect(snapshotTree(root)).toEqual(before);
      const processed = getAllProcessedImagesForObject(targetId);
      expect(processed.map(p => p.originalName).sort()).toEqual(['stacked-16_C 34_Astro_20250709-010411641.fits', 'stacked.jpg']);
      expect(getObjectLayout(targetId)).toBe('nested');
    } finally {
      makeWritable(root);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(canDenyRead)('folder import: when every restack copy fails, no object is created and the prompt count does not move', async () => {
    const { resolveRestackTargetId } = await import('../../server/lib/library/dwarfRestack');
    const { countFlatObjects } = await import('../../server/lib/library/libraryRenest');
    const { stmts } = await import('../../server/lib/library/objects');
    const { root, subDir } = seedRestackSource('src-restack-allfail-', 'C 49');
    const targetId = resolveRestackTargetId(path.basename(subDir), 'C 49')!;
    for (const f of fs.readdirSync(subDir)) {
      if (f !== 'shotsInfo.json') fs.chmodSync(path.join(subDir, f), 0o000);
    }
    const flatBefore = countFlatObjects();
    try {
      await commitWithM42(root);

      expect(stmts.getObject.get(targetId)).toBeUndefined();
      expect(getAllProcessedImagesForObject(targetId)).toHaveLength(0);
      expect(countFlatObjects()).toBe(flatBefore);
    } finally {
      makeWritable(root);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(canDenyRead)('folder import: a failed restack does not revive a deleted object', async () => {
    const { resolveRestackTargetId } = await import('../../server/lib/library/dwarfRestack');
    const { stmts } = await import('../../server/lib/library/objects');
    const { root, subDir } = seedRestackSource('src-restack-tombstone-', 'C 11');
    const targetId = resolveRestackTargetId(path.basename(subDir), 'C 11')!;
    stmts.upsertObject.run(
      targetId, targetId, 0, '2026-01-01T00:00:00Z', 1, '2026-01-02T00:00:00Z',
      null, null, null, null, null, null, null, null, null,
    );
    for (const f of fs.readdirSync(subDir)) {
      if (f !== 'shotsInfo.json') fs.chmodSync(path.join(subDir, f), 0o000);
    }
    try {
      await commitWithM42(root);

      const row = stmts.getObject.get(targetId)!;
      expect(row.deleted).toBe(1);
      expect(row.deletedAt).toBe('2026-01-02T00:00:00Z');
    } finally {
      makeWritable(root);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('live sync: a restack-only target is created nested, so its later raw syncs keep device names', async () => {
    const { getObjectLayout } = await import('../../server/lib/library/libraryLayout');
    const deviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dwarf-restack-nested-device-'));
    fs.mkdirSync(path.join(deviceRoot, 'Astronomy', 'RESTACKED', 'RestackOnlyNested1'), { recursive: true });
    fs.writeFileSync(path.join(deviceRoot, 'Astronomy', 'RESTACKED', 'RestackOnlyNested1', 'stack.jpg'), 'restack-bytes');
    const profile = createProfile({ name: 'Dwarf Restack Nested Test', kind: 'dwarf-3', connectionType: 'local', localPath: deviceRoot });
    const before = snapshotTree(deviceRoot);
    try {
      expect(claimImportLock()).toBe(true);
      await runImport(undefined, undefined, { telescopeId: profile.id });

      expect(getAllProcessedImagesForObject('RestackOnlyNested1')).toHaveLength(1);
      expect(getObjectLayout('RestackOnlyNested1')).toBe('nested');
      // `.nebulis.dat` is the device-identity marker the sync writes at the
      // device root on purpose (deviceIdentity.ts). Anything else is a leak.
      expect(snapshotTree(deviceRoot).filter(e => !e.startsWith('.nebulis.dat:'))).toEqual(before);
    } finally {
      fs.rmSync(deviceRoot, { recursive: true, force: true });
    }
  });

  it.runIf(canDenyRead)('live sync: when the restack download fails, no object is created', async () => {
    const { stmts } = await import('../../server/lib/library/objects');
    const { countFlatObjects } = await import('../../server/lib/library/libraryRenest');
    const deviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dwarf-restack-dlfail-device-'));
    const subDir = path.join(deviceRoot, 'Astronomy', 'RESTACKED', 'RestackFailTarget1');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'stack.jpg'), 'restack-bytes');
    fs.chmodSync(path.join(subDir, 'stack.jpg'), 0o000);
    const profile = createProfile({ name: 'Dwarf Restack Fail Test', kind: 'dwarf-3', connectionType: 'local', localPath: deviceRoot });
    const flatBefore = countFlatObjects();
    try {
      expect(claimImportLock()).toBe(true);
      await runImport(undefined, undefined, { telescopeId: profile.id });

      expect(stmts.getObject.get('RestackFailTarget1')).toBeUndefined();
      expect(countFlatObjects()).toBe(flatBefore);
    } finally {
      makeWritable(deviceRoot);
      fs.rmSync(deviceRoot, { recursive: true, force: true });
    }
  });
});
