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
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-linkedrescan-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import db from '../../server/lib/db';
import { getLibraryDir } from '../../server/lib/libraryPath';
import { ensureLibraryDir } from '../../server/lib/library/objects';
import { getLocalObjects } from '../../server/lib/library/objects';
import { getObjectLocation } from '../../server/lib/library/objectLocation';
import {
  commitSource, rescanSource, deleteSource, renameSource, assertLinkableRoot, summarizeSources, scanSource, LinkSourceError,
} from '../../server/lib/library/librarySources';

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
  db.prepare('DELETE FROM notes').run();
  ensureLibraryDir();
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-rescan-source-'));
  roots.push(root);
  const m31 = path.join(root, 'Galaxies', 'M 31 - Andromeda');
  fs.mkdirSync(m31, { recursive: true });
  fs.writeFileSync(path.join(m31, 'Stacked_60_M 31_10.0s_IRCUT_20260101-200000.jpg'), 'a'.repeat(100));
  fs.writeFileSync(path.join(m31, 'Stacked_60_M 31_10.0s_IRCUT_20260102-200000.jpg'), 'b'.repeat(100));
  return root;
}

const fileRows = (id: string) =>
  db.prepare<[string], { relPath: string; missingSince: string | null }>('SELECT relPath, missingSince FROM libraryFiles WHERE sourceId = ?').all(id);

describe('rescanSource', () => {
  it('reports nothing changed on an untouched tree and writes nothing to disk', () => {
    const root = makeRoot();
    const { sourceId } = commitSource(root, SETTINGS, { label: 'x' });
    const r = rescanSource(sourceId, SETTINGS);
    expect(r).toMatchObject({ added: 0, updated: 0, missing: 0, removed: 0, unchanged: 2, offline: false });
  });

  it('reads the tree with the options the link used, not the app-wide setting of the day', () => {
    const root = makeRoot();
    const sub = path.join(root, 'Galaxies', 'M 31 - Andromeda', 'M 31_sub');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'Light_M 31_10.0s_IRCUT_20260101-200500.fit'), 'f'.repeat(80));

    const { sourceId } = commitSource(root, SETTINGS, { label: 'x', importOptions: { importSubFrames: true } });
    expect(fileRows(sourceId)).toHaveLength(3);

    // The global setting says no sub-frames; the link said yes.
    const r = rescanSource(sourceId, { ...SETTINGS, importSubFrames: false });
    expect(r).toMatchObject({ missing: 0, removed: 0, unchanged: 3 });
  });

  it('adds a new file and updates a modified one', () => {
    const root = makeRoot();
    const { sourceId } = commitSource(root, SETTINGS, { label: 'x' });
    const dir = path.join(root, 'Galaxies', 'M 31 - Andromeda');
    fs.writeFileSync(path.join(dir, 'Stacked_60_M 31_10.0s_IRCUT_20260103-200000.jpg'), 'c'.repeat(50));
    fs.writeFileSync(path.join(dir, 'Stacked_60_M 31_10.0s_IRCUT_20260101-200000.jpg'), 'z'.repeat(250));
    const r = rescanSource(sourceId, SETTINGS);
    expect(r.added).toBe(1);
    expect(r.updated).toBe(1);
    expect(fileRows(sourceId)).toHaveLength(3);
  });

  it('flags a deleted file on the first miss and removes its row once it has stayed missing a day', () => {
    const root = makeRoot();
    const { sourceId } = commitSource(root, SETTINGS, { label: 'x' });
    fs.rmSync(path.join(root, 'Galaxies', 'M 31 - Andromeda', 'Stacked_60_M 31_10.0s_IRCUT_20260102-200000.jpg'));

    const first = rescanSource(sourceId, SETTINGS);
    expect(first).toMatchObject({ missing: 1, removed: 0 });
    expect(fileRows(sourceId).filter(r => r.missingSince)).toHaveLength(1);

    // A second scan straight away is not a second strike: the row is only an index
    // entry, so it costs nothing to keep and a flaky mount must not be able to spend it.
    const quick = rescanSource(sourceId, SETTINGS);
    expect(quick).toMatchObject({ removed: 0 });
    expect(fileRows(sourceId)).toHaveLength(2);

    const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE libraryFiles SET missingSince = ? WHERE sourceId = ? AND missingSince IS NOT NULL').run(longAgo, sourceId);
    const later = rescanSource(sourceId, SETTINGS);
    expect(later).toMatchObject({ missing: 0, removed: 1 });
    expect(fileRows(sourceId)).toHaveLength(1);
  });

  it('un-flags a file that comes back between rescans', () => {
    const root = makeRoot();
    const { sourceId } = commitSource(root, SETTINGS, { label: 'x' });
    const file = path.join(root, 'Galaxies', 'M 31 - Andromeda', 'Stacked_60_M 31_10.0s_IRCUT_20260102-200000.jpg');
    const bytes = fs.readFileSync(file);
    fs.rmSync(file);
    rescanSource(sourceId, SETTINGS);
    fs.writeFileSync(file, bytes);
    rescanSource(sourceId, SETTINGS);
    expect(fileRows(sourceId).filter(r => r.missingSince)).toHaveLength(0);
    expect(fileRows(sourceId)).toHaveLength(2);
  });

  it('marks the source offline and touches no rows when the root is gone', () => {
    const root = makeRoot();
    const { sourceId } = commitSource(root, SETTINGS, { label: 'x' });
    const moved = `${root}-moved`;
    fs.renameSync(root, moved);
    roots.push(moved);
    const r = rescanSource(sourceId, SETTINGS);
    expect(r.offline).toBe(true);
    expect(fileRows(sourceId)).toHaveLength(2);
    expect(fileRows(sourceId).every(f => f.missingSince === null)).toBe(true);
    expect(summarizeSources()[0].offline).toBe(true);
  });
});

describe('linking into an object that already exists', () => {
  it('keeps its managed bookkeeping instead of zeroing it', () => {
    db.prepare(
      `INSERT INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted) VALUES ('M31', 'M31', 42, '2026-01-01T00:00:00.000Z', 0)`,
    ).run();
    commitSource(makeRoot(), SETTINGS, { label: 'x' });
    expect(db.prepare('SELECT fileCount, lastImport, deleted FROM libraryObjects WHERE objectId = ?').get('M31'))
      .toEqual({ fileCount: 42, lastImport: '2026-01-01T00:00:00.000Z', deleted: 0 });
  });

  it('un-deletes an object the user had removed once files arrive for it', () => {
    db.prepare(
      `INSERT INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted, deletedAt) VALUES ('M31', 'M31', 0, '2026-01-01T00:00:00.000Z', 1, '2026-02-01T00:00:00.000Z')`,
    ).run();
    commitSource(makeRoot(), SETTINGS, { label: 'x' });
    expect(db.prepare('SELECT deleted FROM libraryObjects WHERE objectId = ?').get('M31')).toEqual({ deleted: 0 });
  });
});

const sessionDates = (objectId: string) =>
  db.prepare<[string], { date: string }>('SELECT date FROM librarySessions WHERE objectId = ? ORDER BY date').all(objectId).map(r => r.date);

describe('session rows for linked files', () => {
  it('gives a linked-only object its sessions, so the Library shows nights instead of zero', () => {
    commitSource(makeRoot(), SETTINGS, { label: 'x' });
    expect(sessionDates('M31')).toEqual(['2026-01-01', '2026-01-02']);
  });

  it('heals a link made before session rows existed, on the next rescan', () => {
    const { sourceId } = commitSource(makeRoot(), SETTINGS, { label: 'x' });
    db.prepare('DELETE FROM librarySessions').run();
    rescanSource(sourceId, SETTINGS);
    expect(sessionDates('M31')).toEqual(['2026-01-01', '2026-01-02']);
  });

  it('removes only the nights that lose every file on unlink, keeping a managed night', () => {
    const { sourceId } = commitSource(makeRoot(), SETTINGS, { label: 'x' });
    db.prepare(
      `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, captureDate, bytes, importedAt)
       VALUES ('M31', 'M31/managed.jpg', 'managed.jpg', 'managed.jpg', 'stacked', '2026-01-01', 1, '2026-01-01')`,
    ).run();
    deleteSource(sourceId);
    expect(sessionDates('M31')).toEqual(['2026-01-01']);
  });
});

describe('rescan after an attribution rule improves', () => {
  it('moves files to the corrected object and retires the junk one it leaves empty', () => {
    const root = makeRoot();
    const { sourceId } = commitSource(root, SETTINGS, { label: 'x' });
    // Simulate a link made under the old rule: everything filed under a junk object.
    db.prepare("INSERT INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted) VALUES ('Junk_sub', 'Junk_sub', 0, '', 0)").run();
    db.prepare("UPDATE libraryFiles SET objectId = 'Junk_sub' WHERE sourceId = ?").run(sourceId);
    db.prepare("UPDATE librarySessions SET objectId = 'Junk_sub' WHERE objectId = 'M31'").run();

    const r = rescanSource(sourceId, SETTINGS);
    expect(r.updated).toBe(2);
    expect(db.prepare('SELECT deleted FROM libraryObjects WHERE objectId = ?').get('Junk_sub')).toEqual({ deleted: 1 });
    expect(sessionDates('Junk_sub')).toEqual([]);
    expect(sessionDates('M31')).toEqual(['2026-01-01', '2026-01-02']);
  });
});

describe('rescan repairs a link that an earlier run left broken', () => {
  it('un-deletes an object that still owns live linked files', () => {
    const { sourceId } = commitSource(makeRoot(), SETTINGS, { label: 'x' });
    db.prepare("UPDATE libraryObjects SET deleted = 1, deletedAt = 'x' WHERE objectId = 'M31'").run();
    rescanSource(sourceId, SETTINGS);
    expect(db.prepare('SELECT deleted FROM libraryObjects WHERE objectId = ?').get('M31')).toEqual({ deleted: 0 });
  });
});

describe('uncatalogued objects', () => {
  it('get a space-free id and keep the folder spelling as their name', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-rescan-source-'));
    roots.push(root);
    const dir = path.join(root, 'Comets', 'C2099 Z9 - Test Comet');
    fs.mkdirSync(path.join(dir, 'C2099 Z9_sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Stacked_10_C2099 Z9_10.0s_IRCUT_20251020-210900.jpg'), 'x');
    fs.writeFileSync(path.join(dir, 'C2099 Z9_sub', 'Light_C2099 Z9_10.0s_IRCUT_20251020-205000.fit'), 'x');

    commitSource(root, SETTINGS, { label: 'x', importOptions: { importSubFrames: true } });
    const rows = db.prepare('SELECT objectId, objectName FROM libraryObjects').all();
    expect(rows).toEqual([{ objectId: 'C2099Z9-TestComet', objectName: 'C2099 Z9 - Test Comet' }]);
  });
});

describe('nicknames learned from folder labels', () => {
  function labelledRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-rescan-source-'));
    roots.push(root);
    const dir = path.join(root, '1. Caldwell Objects', 'C 1 - Cepheus Old Cluster');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Stacked_60_C 1_20.0s_IRCUT_20260524-231230.jpg'), 'x');
    return root;
  }

  it('stores the name on the object, shows it in the scan, and returns it with the library list', async () => {
    const root = labelledRoot();
    const scan = scanSource(root, SETTINGS);
    expect(scan.objects[0]).toMatchObject({ objectId: 'NGC188', aliases: ['C1'], nicknames: ['Cepheus Old Cluster'] });

    commitSource(root, SETTINGS, { label: 'x' });
    const stored = db.prepare('SELECT nicknames FROM libraryObjects WHERE objectId = ?').get('NGC188') as { nicknames: string };
    expect(JSON.parse(stored.nicknames)).toEqual(['Cepheus Old Cluster']);
    expect(getLocalObjects('u').find(o => o.id === 'NGC188')?.nicknames).toEqual(['Cepheus Old Cluster']);
  });
});

describe('deleteSource', () => {
  it('unlinks rows, leaves the files on disk, and retires an object with nothing left', () => {
    const root = makeRoot();
    const { sourceId } = commitSource(root, SETTINGS, { label: 'x' });
    const out = deleteSource(sourceId);
    expect(out.filesUnlinked).toBe(2);
    expect(out.objectsRetired).toEqual(['M31']);
    expect(fs.existsSync(path.join(root, 'Galaxies', 'M 31 - Andromeda', 'Stacked_60_M 31_10.0s_IRCUT_20260101-200000.jpg'))).toBe(true);
    expect(db.prepare('SELECT deleted FROM libraryObjects WHERE objectId = ?').get('M31')).toMatchObject({ deleted: 1 });
  });

  it('keeps an object that has a note', () => {
    const root = makeRoot();
    const { sourceId } = commitSource(root, SETTINGS, { label: 'x' });
    db.prepare(`INSERT INTO notes (id, objectId, date, createdAt, updatedAt) VALUES ('n1', 'M31', '2026-01-01', '', '')`).run();
    expect(deleteSource(sourceId).objectsRetired).toEqual([]);
    expect(db.prepare('SELECT deleted FROM libraryObjects WHERE objectId = ?').get('M31')).toMatchObject({ deleted: 0 });
  });
});

describe('validation and rename', () => {
  it('refuses to link a folder that is already linked, or nested inside / around one', () => {
    const root = makeRoot();
    commitSource(root, SETTINGS, { label: 'x' });
    expect(() => assertLinkableRoot(root)).toThrow(LinkSourceError);
    expect(() => assertLinkableRoot(path.join(root, 'Galaxies'))).toThrow(/already linked/);
    expect(() => assertLinkableRoot(path.dirname(root))).toThrow(LinkSourceError);
  });

  it('refuses the Nebulis data directory and a non-folder', () => {
    expect(() => assertLinkableRoot(TEST_DATA_DIR)).toThrow(/overlaps/);
    expect(() => assertLinkableRoot(path.join(TEST_DATA_DIR, 'nope'))).toThrow(/not a directory/i);
  });

  it('renames a source and rejects an empty name', () => {
    const root = makeRoot();
    const { sourceId } = commitSource(root, SETTINGS, { label: 'x' });
    expect(renameSource(sourceId, '  MyWorks  ').label).toBe('MyWorks');
    expect(() => renameSource(sourceId, '   ')).toThrow(LinkSourceError);
    expect(() => renameSource('src_missing', 'a')).toThrow(/no longer exists/);
  });
});

describe('getObjectLocation for a linked object', () => {
  it('reports the real folder on the user\'s disk, not a managed-library path', async () => {
    const root = makeRoot();
    commitSource(root, SETTINGS, { label: 'MyWorks' });
    const loc = await getObjectLocation('M31');
    expect(loc.linked).toHaveLength(1);
    expect(loc.linked[0]).toMatchObject({
      sourceLabel: 'MyWorks',
      path: path.join(root, 'Galaxies', 'M 31 - Andromeda'),
      exists: true,
    });
    const session = await getObjectLocation('M31', '2026-01-01');
    expect(session.linked[0].path).toBe(path.join(root, 'Galaxies', 'M 31 - Andromeda'));
  });
});

describe('rescan does not mistake an unreadable or swapped tree for a deleted one', () => {
  const canRestrictDirs = process.platform !== 'win32' && process.getuid?.() !== 0;

  it.skipIf(!canRestrictDirs)('leaves the files under an unreadable directory alone', () => {
    const root = makeRoot();
    const orion = path.join(root, 'Nebulae', 'M 42 - Orion');
    fs.mkdirSync(orion, { recursive: true });
    fs.writeFileSync(path.join(orion, 'Stacked_60_M 42_10.0s_IRCUT_20260105-200000.jpg'), 'o'.repeat(60));
    const { sourceId } = commitSource(root, SETTINGS, { label: 'x' });
    expect(fileRows(sourceId)).toHaveLength(3);

    fs.chmodSync(orion, 0o000);
    try {
      rescanSource(sourceId, SETTINGS);
      // Twice, and with the grace period elapsed, so only the exemption can be what saves it.
      db.prepare("UPDATE libraryFiles SET missingSince = '2020-01-01T00:00:00.000Z' WHERE missingSince IS NOT NULL").run();
      rescanSource(sourceId, SETTINGS);
    } finally {
      fs.chmodSync(orion, 0o755);
    }
    const orionRows = fileRows(sourceId).filter(r => r.relPath.includes('M 42'));
    expect(orionRows).toHaveLength(1);
    expect(orionRows[0].missingSince).toBeNull();
  });

  it('treats a root replaced by an empty directory as offline and touches nothing', () => {
    const root = makeRoot();
    const { sourceId } = commitSource(root, SETTINGS, { label: 'x' });
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root); // an unmounted volume leaves exactly this behind

    const r = rescanSource(sourceId, SETTINGS);
    expect(r.offline).toBe(true);
    expect(fileRows(sourceId)).toHaveLength(2);
    expect(fileRows(sourceId).every(f => f.missingSince === null)).toBe(true);
  });

  it('treats a different disk mounted at the same path as offline', () => {
    const root = makeRoot();
    const { sourceId } = commitSource(root, SETTINGS, { label: 'x' });
    fs.rmSync(root, { recursive: true, force: true });
    const other = path.join(root, 'Holiday Photos', 'M 33 - Triangulum');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'Stacked_60_M 33_10.0s_IRCUT_20260110-200000.jpg'), 't'.repeat(70));

    const r = rescanSource(sourceId, SETTINGS);
    expect(r.offline).toBe(true);
    expect(fileRows(sourceId)).toHaveLength(2);
    expect(fileRows(sourceId).every(f => f.missingSince === null)).toBe(true);
  });

  it('stores a fingerprint at link time and keeps it current', () => {
    const root = makeRoot();
    const { sourceId } = commitSource(root, SETTINGS, { label: 'x' });
    const read = () => db.prepare<[string], { fingerprint: string | null }>('SELECT fingerprint FROM librarySources WHERE id = ?').get(sourceId)?.fingerprint;
    expect(JSON.parse(read() ?? 'null')).toEqual(['Galaxies']);

    fs.mkdirSync(path.join(root, 'Nebulae'));
    rescanSource(sourceId, SETTINGS);
    expect(JSON.parse(read() ?? 'null')).toEqual(['Galaxies', 'Nebulae']);
  });
});

describe('managed-copy detection when linking', () => {
  const NAME = 'Stacked_60_M 31_10.0s_IRCUT_20260101-200000.jpg';

  /** Put a managed copy of `content` in the library the way the importer would have. */
  function addManagedCopy(objectId: string, fileName: string, content: string): void {
    const objDir = path.join(getLibraryDir(), objectId);
    fs.mkdirSync(objDir, { recursive: true });
    fs.writeFileSync(path.join(objDir, fileName), content);
    db.prepare(
      `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, bytes, importedAt)
       VALUES (?, ?, ?, ?, 'stack', ?, ?)`,
    ).run(objectId, `${objectId}/${fileName}`, fileName, fileName, content.length, new Date().toISOString());
  }

  it('links a different frame that only shares the copy\'s name and size', () => {
    const root = makeRoot();
    // Same name and same 100 bytes as makeRoot's first frame, different pixels.
    addManagedCopy('M31', NAME, 'z'.repeat(100));
    const { filesLinked, filesAlreadyInLibrary } = commitSource(root, SETTINGS, { label: 'x' });
    expect(filesAlreadyInLibrary).toBe(0);
    expect(filesLinked).toBe(2);
  });

  it('still skips a file that really is the managed copy', () => {
    const root = makeRoot();
    addManagedCopy('M31', NAME, 'a'.repeat(100));
    const { filesLinked, filesAlreadyInLibrary } = commitSource(root, SETTINGS, { label: 'x' });
    expect(filesAlreadyInLibrary).toBe(1);
    expect(filesLinked).toBe(1);
  });

  it('compares the tail as well as the head on a large file', () => {
    const root = makeRoot();
    const big = path.join(root, 'Galaxies', 'M 31 - Andromeda', 'Stacked_60_M 31_10.0s_IRCUT_20260103-200000.jpg');
    const body = 'h'.repeat(300 * 1024);
    fs.writeFileSync(big, body + 'TAIL-A');
    // Identical head, different last bytes, same length.
    addManagedCopy('M31', path.basename(big), body + 'TAIL-B');
    const { filesAlreadyInLibrary } = commitSource(root, SETTINGS, { label: 'x' });
    expect(filesAlreadyInLibrary).toBe(0);
  });
});
