import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import db from '../../server/lib/db';
import { DATA_DIR } from '../../server/lib/paths';
import { getLibraryDir } from '../../server/lib/libraryPath';
import { getLibraryFilesForObject, recordLibraryFiles } from '../../server/lib/library/libraryFiles';
import { writeArchiveMarker } from '../../server/lib/archive/archiveMarker';
import { readArchiveManifest, writeArchiveManifest } from '../../server/lib/archive/archiveManifest';
import { DEFAULT_ARCHIVE_CONFIG, setArchiveConfig, type ArchiveConfig } from '../../server/lib/archive/archiveConfig';
import { runArchive } from '../../server/lib/archive/archiveCopy';
import { listArchivedFiles, listArchivedObjects } from '../../server/lib/archive/archiveBrowse';
import { restoreArchivedFiles } from '../../server/lib/archive/archiveRestore';

/**
 * Browsing and restoring the archive.
 *
 * Browse is read-only and answers "what is on the disk, and what could come back".
 *
 * Restore is a write path *into* the library, which makes it the mirror of Step 7
 * and the reason the contract gave it its own risk entry. The rules:
 *
 *   - a restore target must be a strict descendant of its own object's folder, so
 *     a tampered manifest cannot steer a write at a sibling object or outside the
 *     library,
 *   - content that already exists locally and differs is never overwritten
 *     silently; that needs an explicit confirmation for the whole call,
 *   - content that already matches is left alone, which makes restore idempotent,
 *   - the archive is never modified, and
 *   - the object must already exist in the local library; bringing back an object
 *     the library no longer has is out of scope for v1.
 */

const created: string[] = [];
const seededObjectIds: string[] = [];
const STACKED_JPG = 'Stacked_10_M31_10.0s_LP_20241008-220000.jpg';
const STACKED_FIT = 'Stacked_50_M31_10.0s_LP_20241008-220000.fit';
const SUB_FIT_A = 'sub_00001_M31_10.0s_LP_20241008-220000.fit';
const SUB_FIT_B = 'sub_00002_M31_10.0s_LP_20241008-220000.fit';
const M31_FOLDER = 'M 31';
const SESSION = '2024-10-08_22-00-00';
const ARCHIVE_ID = 'archive-under-test';

const CONTENT = {
  stackedJpg: 'stacked-jpg',
  stackedFit: 'stacked-fits',
  subA: 'sub-a',
  subB: 'sub-b',
} as const;

function scratchDir(prefix = 'nebulis-archive-test-restore-'): string {
  const dir = fs.mkdtempSync(path.join(path.dirname(path.resolve(DATA_DIR)), prefix));
  created.push(dir);
  return dir;
}

function seedObject(objectId: string, folderName: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted) VALUES (?, ?, 0, ?, 0)',
  ).run(objectId, folderName, new Date().toISOString());
  seededObjectIds.push(objectId);
  db.prepare("UPDATE libraryObjects SET layout = 'nested' WHERE objectId = ?").run(objectId);
}

function writeLibraryFile(relPath: string, content: string): void {
  const abs = path.join(getLibraryDir(), relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const localPath = (relPath: string): string => path.join(getLibraryDir(), M31_FOLDER, relPath);
const archivedPath = (dest: string, relPath: string): string => path.join(dest, M31_FOLDER, relPath);
const archivedRel = (relPath: string): string => `${M31_FOLDER}/${relPath}`;

function configFor(dest: string, overrides: Partial<ArchiveConfig> = {}): ArchiveConfig {
  return { ...DEFAULT_ARCHIVE_CONFIG, path: dest, archiveId: ARCHIVE_ID, includeSubframes: true, ...overrides };
}

beforeEach(() => {
  seededObjectIds.length = 0;
});

afterEach(() => {
  setArchiveConfig(DEFAULT_ARCHIVE_CONFIG);
  for (const objectId of seededObjectIds.splice(0)) {
    db.prepare('DELETE FROM libraryFiles WHERE objectId = ?').run(objectId);
    db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run(objectId);
  }
  fs.rmSync(getLibraryDir(), { recursive: true, force: true });
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function archiveOneObject(dest: string): Promise<void> {
  writeArchiveMarker(dest, ARCHIVE_ID);
  seedObject('M31', M31_FOLDER);
  writeLibraryFile(`${M31_FOLDER}/${SESSION}/${STACKED_JPG}`, CONTENT.stackedJpg);
  writeLibraryFile(`${M31_FOLDER}/${SESSION}/${STACKED_FIT}`, CONTENT.stackedFit);
  writeLibraryFile(`${M31_FOLDER}/${SESSION}/${SUB_FIT_A}`, CONTENT.subA);
  writeLibraryFile(`${M31_FOLDER}/${SESSION}/${SUB_FIT_B}`, CONTENT.subB);
  recordLibraryFiles([
    { objectId: 'M31', folderName: M31_FOLDER, sessionFolder: SESSION, fileName: STACKED_JPG, role: 'stacked' },
    { objectId: 'M31', folderName: M31_FOLDER, sessionFolder: SESSION, fileName: STACKED_FIT, role: 'stacked' },
    { objectId: 'M31', folderName: M31_FOLDER, sessionFolder: SESSION, fileName: SUB_FIT_A, role: 'sub' },
    { objectId: 'M31', folderName: M31_FOLDER, sessionFolder: SESSION, fileName: SUB_FIT_B, role: 'sub' },
  ]);
  const result = await runArchive(configFor(dest));
  expect(result.failures).toEqual([]);
}

/** Simulate the post-Step-7 state: subframes archived, then removed locally. */
function removeLocally(relPath: string): void {
  fs.rmSync(localPath(relPath));
  db.prepare('DELETE FROM libraryFiles WHERE relPath = ?').run(archivedRel(relPath));
}

describe('listArchivedObjects', () => {
  let dest: string;

  beforeEach(async () => {
    dest = scratchDir();
    await archiveOneObject(dest);
  });

  it('lists what is on the disk, with counts and subframe totals', async () => {
    const result = await listArchivedObjects(configFor(dest));
    expect(result.warnings).toEqual([]);
    expect(result.objects).toHaveLength(1);
    const [object] = result.objects;
    expect(object.folderName).toBe(M31_FOLDER);
    expect(object.objectId).toBe('M31');
    expect(object.filesTotal).toBe(4);
    expect(object.subframes).toBe(2);
    expect(object.bytes).toBeGreaterThan(0);
  });

  it('counts the files that are no longer present locally, which are the restorable ones', async () => {
    removeLocally(`${SESSION}/${SUB_FIT_A}`);
    removeLocally(`${SESSION}/${SUB_FIT_B}`);

    const { objects } = await listArchivedObjects(configFor(dest));
    const [object] = objects;
    expect(object.missingLocally).toBe(2);
  });

  it('marks an object the local library no longer has, without hiding it', async () => {
    db.prepare('UPDATE libraryObjects SET deleted = 1 WHERE objectId = ?').run('M31');
    const { objects } = await listArchivedObjects(configFor(dest));
    const [object] = objects;
    expect(object.objectId).toBeNull();
    // Still listed: the archive is the record of what the user has, even when the
    // library has moved on.
    expect(object.filesTotal).toBe(4);
  });

  it('refuses to browse a disk that is not our archive', async () => {
    const foreign = scratchDir();
    writeArchiveMarker(foreign, 'someone-elses');
    const result = await listArchivedObjects(configFor(foreign));
    expect(result.objects).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('lists the files of one object with whether each is present locally', async () => {
    removeLocally(`${SESSION}/${SUB_FIT_A}`);
    const result = await listArchivedFiles(configFor(dest), M31_FOLDER);
    const byPath = Object.fromEntries(result.files.map(f => [f.relPath, f.presentLocally]));
    expect(byPath[`${SESSION}/${SUB_FIT_A}`]).toBe(false);
    expect(byPath[`${SESSION}/${SUB_FIT_B}`]).toBe(true);
    expect(result.files.find(f => f.relPath.endsWith(SUB_FIT_A))?.isSubframe).toBe(true);
  });
});

describe('restoreArchivedFiles — refusals', () => {
  let dest: string;

  beforeEach(async () => {
    dest = scratchDir();
    await archiveOneObject(dest);
  });

  it('refuses when the disk is not this install\'s archive', async () => {
    const foreign = scratchDir();
    writeArchiveMarker(foreign, 'someone-elses');
    const result = await restoreArchivedFiles(configFor(foreign), [
      { folderName: M31_FOLDER, relPath: `${SESSION}/${SUB_FIT_A}` },
    ]);

    expect(result.ran).toBe(false);
    expect(result.restored).toBe(0);
  });

  it('refuses a folder whose object id would collide with another object', async () => {
    removeLocally(`${SESSION}/${SUB_FIT_A}`);
    db.prepare('DELETE FROM libraryFiles WHERE objectId = ?').run('M31');
    db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run('M31');
    seedObject('M31', 'Some other folder');

    const result = await restoreArchivedFiles(configFor(dest), [
      { folderName: M31_FOLDER, relPath: `${SESSION}/${SUB_FIT_A}` },
    ]);
    expect(result.restored).toBe(0);
    expect(result.createdObjects).toBe(0);
    expect(result.failures.join(' ')).toMatch(/different folder/i);
  });

  it('refuses a folder whose name a different, trashed object still holds', async () => {
    db.prepare('DELETE FROM libraryFiles WHERE objectId = ?').run('M31');
    db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run('M31');
    seedObject('SOMETHING', M31_FOLDER);
    db.prepare('UPDATE libraryObjects SET deleted = 1 WHERE objectId = ?').run('SOMETHING');

    const result = await restoreArchivedFiles(configFor(dest), [
      { folderName: M31_FOLDER, relPath: `${SESSION}/${SUB_FIT_A}` },
    ]);
    expect(result.restored).toBe(0);
    expect(result.failures.join(' ')).toMatch(/already used by SOMETHING/);
  });

  it.each(['../evil', 'a/b', 'a\\b', '..', '.', 'x\u0000y'])('refuses an archived object id of %j', async (badId) => {
    db.prepare('DELETE FROM libraryFiles WHERE objectId = ?').run('M31');
    db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run('M31');
    const manifest = readArchiveManifest(dest);
    manifest.objects[M31_FOLDER].objectId = badId;
    writeArchiveManifest(dest, manifest);

    const result = await restoreArchivedFiles(configFor(dest), [
      { folderName: M31_FOLDER, relPath: `${SESSION}/${SUB_FIT_A}` },
    ]);
    expect(result.restored).toBe(0);
    expect(result.createdObjects).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM libraryObjects WHERE objectId = ?').get(badId)).toEqual({ n: 0 });
  });

  it('refuses a manifest path that escapes the object folder', async () => {
    // A tampered manifest on a removable disk. `..` must not steer a write at a
    // sibling object, or anywhere else.
    const manifest = readArchiveManifest(dest);
    manifest.objects[M31_FOLDER].files.push({ relPath: `../../../escape.fit`, isSubframe: true });
    writeArchiveManifest(dest, manifest);

    const result = await restoreArchivedFiles(configFor(dest), [
      { folderName: M31_FOLDER, relPath: `../../../escape.fit` },
    ]);
    expect(result.restored).toBe(0);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(path.dirname(getLibraryDir()), 'escape.fit'))).toBe(false);
  });

  it('does not overwrite differing local content without an explicit confirmation', async () => {
    const local = localPath(`${SESSION}/${SUB_FIT_A}`);
    fs.writeFileSync(local, 'the user edited this');

    const result = await restoreArchivedFiles(configFor(dest), [
      { folderName: M31_FOLDER, relPath: `${SESSION}/${SUB_FIT_A}` },
    ]);

    expect(result.restored).toBe(0);
    expect(result.conflicts).toHaveLength(1);
    // The user's version wins unless they said otherwise.
    expect(fs.readFileSync(local, 'utf8')).toBe('the user edited this');
  });

  it('overwrites when the call says so explicitly', async () => {
    const local = localPath(`${SESSION}/${SUB_FIT_A}`);
    fs.writeFileSync(local, 'the user edited this');

    const result = await restoreArchivedFiles(
      configFor(dest),
      [{ folderName: M31_FOLDER, relPath: `${SESSION}/${SUB_FIT_A}` }],
      { overwrite: true },
    );

    expect(result.restored).toBe(1);
    expect(fs.readFileSync(local, 'utf8')).toBe(CONTENT.subA);
  });

  it('refuses to write through something that is not a regular file, even when confirmed', async () => {
    removeLocally(`${SESSION}/${SUB_FIT_A}`);
    const elsewhere = scratchDir();
    const real = path.join(elsewhere, 'real.fit');
    fs.writeFileSync(real, 'elsewhere');

    const local = localPath(`${SESSION}/${SUB_FIT_A}`);
    fs.symlinkSync(real, local);

    const result = await restoreArchivedFiles(
      configFor(dest),
      [{ folderName: M31_FOLDER, relPath: `${SESSION}/${SUB_FIT_A}` }],
      { overwrite: true },
    );

    // Following the link would write outside the library, which no confirmation
    // makes acceptable.
    expect(result.restored).toBe(0);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(fs.readFileSync(real, 'utf8')).toBe('elsewhere');
  });

  it('fails a request whose archived copy is missing, leaving nothing behind', async () => {
    removeLocally(`${SESSION}/${SUB_FIT_A}`);
    fs.rmSync(archivedPath(dest, `${SESSION}/${SUB_FIT_A}`));

    const result = await restoreArchivedFiles(configFor(dest), [
      { folderName: M31_FOLDER, relPath: `${SESSION}/${SUB_FIT_A}` },
    ]);

    expect(result.restored).toBe(0);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(fs.existsSync(localPath(`${SESSION}/${SUB_FIT_A}`))).toBe(false);
    expect(fs.readdirSync(path.dirname(localPath(`${SESSION}/${SUB_FIT_A}`))).filter(n => n.endsWith('.part'))).toEqual([]);
  });
});

describe('restoreArchivedFiles — restoring', () => {
  let dest: string;

  beforeEach(async () => {
    dest = scratchDir();
    await archiveOneObject(dest);
    removeLocally(`${SESSION}/${SUB_FIT_A}`);
    removeLocally(`${SESSION}/${SUB_FIT_B}`);
  });

  it('brings back a missing local file, byte for byte', async () => {
    const result = await restoreArchivedFiles(configFor(dest), [
      { folderName: M31_FOLDER, relPath: `${SESSION}/${SUB_FIT_A}` },
    ]);

    expect(result.ran).toBe(true);
    expect(result.restored).toBe(1);
    expect(fs.readFileSync(localPath(`${SESSION}/${SUB_FIT_A}`), 'utf8')).toBe(CONTENT.subA);
  });

  it('never modifies the archive', async () => {
    const before = fs.readFileSync(archivedPath(dest, `${SESSION}/${SUB_FIT_A}`), 'utf8');
    await restoreArchivedFiles(configFor(dest), [{ folderName: M31_FOLDER, relPath: `${SESSION}/${SUB_FIT_A}` }]);
    expect(fs.readFileSync(archivedPath(dest, `${SESSION}/${SUB_FIT_A}`), 'utf8')).toBe(before);
  });

  it('is idempotent: restoring again finds it already there', async () => {
    await restoreArchivedFiles(configFor(dest), [{ folderName: M31_FOLDER, relPath: `${SESSION}/${SUB_FIT_A}` }]);
    const second = await restoreArchivedFiles(configFor(dest), [
      { folderName: M31_FOLDER, relPath: `${SESSION}/${SUB_FIT_A}` },
    ]);
    expect(second.restored).toBe(0);
    expect(second.conflicts).toEqual([]);
  });

  it('records the restored file in the library', async () => {
    await restoreArchivedFiles(configFor(dest), [{ folderName: M31_FOLDER, relPath: `${SESSION}/${SUB_FIT_A}` }]);

    const rows = getLibraryFilesForObject('M31');
    expect(rows.some(r => r.relPath === archivedRel(`${SESSION}/${SUB_FIT_A}`))).toBe(true);
    const count = db.prepare('SELECT fileCount FROM libraryObjects WHERE objectId = ?').get('M31') as { fileCount: number };
    expect(count.fileCount).toBe(3);
  });

  it('does not clobber the library row of a file it restores', async () => {
    const dest = scratchDir();
    await archiveOneObject(dest);

    // A row that already exists with real metadata, as an import would have left it.
    db.prepare('UPDATE libraryFiles SET bytes = 4242, captureDate = ? WHERE relPath = ?').run(
      '2026-01-01',
      archivedRel(`${SESSION}/${SUB_FIT_A}`),
    );

    // The file is gone but its row is not: a state reachable by an interrupted
    // deletion, and one the restore has to cope with.
    fs.rmSync(localPath(`${SESSION}/${SUB_FIT_A}`));

    const result = await restoreArchivedFiles(configFor(dest), [
      { folderName: M31_FOLDER, relPath: `${SESSION}/${SUB_FIT_A}` },
    ]);
    expect(result.restored).toBe(1);

    const row = db
      .prepare('SELECT bytes, captureDate FROM libraryFiles WHERE relPath = ?')
      .get(archivedRel(`${SESSION}/${SUB_FIT_A}`)) as { bytes: number; captureDate: string };

    // recordLibraryFile is an upsert that carries neither field, so recording over an
    // existing row would zero the byte count and replace the captured date with one
    // reparsed from the filename. The library already knows this file; there is nothing
    // to record.
    expect(row.bytes).toBe(4242);
    expect(row.captureDate).toBe('2026-01-01');
  });

  it('records a file the library has no row for', async () => {
    const dest = scratchDir();
    await archiveOneObject(dest);
    // removeLocally drops the row as well as the file, which is what Step 7 does.
    removeLocally(`${SESSION}/${SUB_FIT_A}`);

    await restoreArchivedFiles(configFor(dest), [
      { folderName: M31_FOLDER, relPath: `${SESSION}/${SUB_FIT_A}` },
    ]);

    const rows = getLibraryFilesForObject('M31');
    expect(rows.some(r => r.relPath === archivedRel(`${SESSION}/${SUB_FIT_A}`))).toBe(true);
  });

  it('restores several files in one call and reports the bytes', async () => {
    const result = await restoreArchivedFiles(configFor(dest), [
      { folderName: M31_FOLDER, relPath: `${SESSION}/${SUB_FIT_A}` },
      { folderName: M31_FOLDER, relPath: `${SESSION}/${SUB_FIT_B}` },
    ]);
    expect(result.restored).toBe(2);
    expect(result.bytesRestored).toBe(Buffer.byteLength(CONTENT.subA) + Buffer.byteLength(CONTENT.subB));
  });

  it('reports a conflict without abandoning the rest of the call', async () => {
    const local = localPath(`${SESSION}/${SUB_FIT_B}`);
    fs.writeFileSync(local, 'edited');

    const result = await restoreArchivedFiles(configFor(dest), [
      { folderName: M31_FOLDER, relPath: `${SESSION}/${SUB_FIT_A}` },
      { folderName: M31_FOLDER, relPath: `${SESSION}/${SUB_FIT_B}` },
    ]);

    expect(result.restored).toBe(1);
    expect(result.conflicts).toHaveLength(1);
    expect(fs.existsSync(localPath(`${SESSION}/${SUB_FIT_A}`))).toBe(true);
    expect(fs.readFileSync(local, 'utf8')).toBe('edited');
  });
});

describe('restore fidelity: a restored file reads like an imported one', () => {
  it('gives the row its size, capture date and telescope, and keeps the night listed', async () => {
    const dest = scratchDir();
    await archiveOneObject(dest);
    // What an import records for the night: the rig the frames came from.
    db.prepare("UPDATE libraryFiles SET telescopeId = 'tel_seestar' WHERE objectId = 'M31'").run();
    const imported = db
      .prepare<[string], { bytes: number; captureDate: string | null; captureTime: string | null }>(
        'SELECT bytes, captureDate, captureTime FROM libraryFiles WHERE relPath = ?',
      )
      .get(archivedRel(`${SESSION}/${STACKED_JPG}`))!;

    removeLocally(`${SESSION}/${SUB_FIT_A}`);
    db.prepare('DELETE FROM librarySessions WHERE objectId = ?').run('M31');

    const result = await restoreArchivedFiles(configFor(dest), [
      { folderName: M31_FOLDER, relPath: `${SESSION}/${SUB_FIT_A}` },
    ]);
    expect(result.restored).toBe(1);

    const row = db
      .prepare<[string], { bytes: number; role: string; captureDate: string | null; telescopeId: string | null }>(
        'SELECT bytes, role, captureDate, telescopeId FROM libraryFiles WHERE relPath = ?',
      )
      .get(archivedRel(`${SESSION}/${SUB_FIT_A}`))!;
    expect(row.bytes).toBe(Buffer.byteLength(CONTENT.subA));
    expect(row.role).toBe('sub');
    expect(row.captureDate).toBe(imported.captureDate);
    expect(row.telescopeId).toBe('tel_seestar');

    const sessions = db.prepare<[string], { date: string }>('SELECT date FROM librarySessions WHERE objectId = ?').all('M31');
    expect(sessions.length).toBeGreaterThan(0);
  });

  it('takes the date from the session folder when the filename carries none', async () => {
    const dest = scratchDir();
    writeArchiveMarker(dest, ARCHIVE_ID);
    seedObject('M31', M31_FOLDER);
    const odd = 'frame_without_a_date.fit';
    writeLibraryFile(`${M31_FOLDER}/${SESSION}/${odd}`, 'odd-frame');
    recordLibraryFiles([{ objectId: 'M31', folderName: M31_FOLDER, sessionFolder: SESSION, fileName: odd, role: 'sub' }]);
    await runArchive(configFor(dest));
    removeLocally(`${SESSION}/${odd}`);

    await restoreArchivedFiles(configFor(dest), [{ folderName: M31_FOLDER, relPath: `${SESSION}/${odd}` }]);
    const row = db.prepare<[string], { captureDate: string | null }>('SELECT captureDate FROM libraryFiles WHERE relPath = ?').get(archivedRel(`${SESSION}/${odd}`))!;
    expect(row.captureDate).toBe(SESSION.slice(0, 10));
  });
});

describe('restore: abandoned .part files', () => {
  it('clears an old .part beside a file it restores', async () => {
    const dest = scratchDir();
    await archiveOneObject(dest);
    removeLocally(`${SESSION}/${SUB_FIT_A}`);
    const stale = `${localPath(`${SESSION}/${SUB_FIT_A}`)}.part`;
    fs.writeFileSync(stale, 'half');
    const old = new Date(Date.now() - 3 * 24 * 60 * 60_000);
    fs.utimesSync(stale, old, old);

    const result = await restoreArchivedFiles(configFor(dest), [{ folderName: M31_FOLDER, relPath: `${SESSION}/${SUB_FIT_A}` }]);
    expect(result.restored).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
  });
});

describe('restoreArchivedFiles — objects the library no longer has', () => {
  let dest: string;

  beforeEach(async () => {
    dest = scratchDir();
    await archiveOneObject(dest);
  });

  /** The library lost the object entirely: row, files and folder. */
  function loseObject(): void {
    db.prepare('DELETE FROM libraryFiles WHERE objectId = ?').run('M31');
    db.prepare('DELETE FROM librarySessions WHERE objectId = ?').run('M31');
    db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run('M31');
    fs.rmSync(path.join(getLibraryDir(), M31_FOLDER), { recursive: true, force: true });
  }

  const all = (): Array<{ folderName: string; relPath: string }> =>
    [STACKED_JPG, STACKED_FIT, SUB_FIT_A, SUB_FIT_B].map(f => ({ folderName: M31_FOLDER, relPath: `${SESSION}/${f}` }));

  it('creates the object, then restores its files, sessions and layout', async () => {
    loseObject();
    seededObjectIds.push('M31');

    const result = await restoreArchivedFiles(configFor(dest), all());

    expect(result.failures).toEqual([]);
    expect(result).toMatchObject({ restored: 4, createdObjects: 1, revivedObjects: 0, writtenObjects: ['M31'] });
    const row = db.prepare<[string], { folderName: string; deleted: number; fileCount: number; layout: string }>(
      'SELECT folderName, deleted, fileCount, layout FROM libraryObjects WHERE objectId = ?',
    ).get('M31');
    expect(row).toEqual({ folderName: M31_FOLDER, deleted: 0, fileCount: 4, layout: 'nested' });
    expect(fs.readFileSync(localPath(`${SESSION}/${STACKED_JPG}`), 'utf8')).toBe(CONTENT.stackedJpg);
    expect(getLibraryFilesForObject('M31')).toHaveLength(4);
    expect(db.prepare('SELECT COUNT(*) AS n FROM librarySessions WHERE objectId = ?').get('M31')).toEqual({ n: 1 });
  });

  it('brings an object back from the trash instead of creating a second one', async () => {
    db.prepare('UPDATE libraryObjects SET deleted = 1, deletedAt = ? WHERE objectId = ?').run('2026-01-01T00:00:00Z', 'M31');
    removeLocally(`${SESSION}/${SUB_FIT_A}`);

    const result = await restoreArchivedFiles(configFor(dest), [
      { folderName: M31_FOLDER, relPath: `${SESSION}/${SUB_FIT_A}` },
    ]);

    expect(result).toMatchObject({ restored: 1, createdObjects: 0, revivedObjects: 1 });
    expect(db.prepare('SELECT deleted, deletedAt FROM libraryObjects WHERE objectId = ?').get('M31')).toEqual({ deleted: 0, deletedAt: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM libraryObjects WHERE objectId = ?').get('M31')).toEqual({ n: 1 });
  });

  it('creates a flat object when the archive holds its files at the top level', async () => {
    loseObject();
    seededObjectIds.push('M31');
    const manifest = readArchiveManifest(dest);
    manifest.objects[M31_FOLDER].files = [{ relPath: STACKED_JPG, isSubframe: false }];
    writeArchiveManifest(dest, manifest);
    fs.mkdirSync(path.join(dest, M31_FOLDER), { recursive: true });
    fs.writeFileSync(path.join(dest, M31_FOLDER, STACKED_JPG), 'flat');

    const result = await restoreArchivedFiles(configFor(dest), [{ folderName: M31_FOLDER, relPath: STACKED_JPG }]);

    expect(result).toMatchObject({ restored: 1, createdObjects: 1 });
    expect(db.prepare('SELECT layout FROM libraryObjects WHERE objectId = ?').get('M31')).toEqual({ layout: 'flat' });
  });

  it('counts an object once however many of its files are restored', async () => {
    loseObject();
    seededObjectIds.push('M31');

    const first = await restoreArchivedFiles(configFor(dest), all().slice(0, 2));
    const second = await restoreArchivedFiles(configFor(dest), all().slice(2));

    expect(first.createdObjects).toBe(1);
    expect(second).toMatchObject({ createdObjects: 0, revivedObjects: 0, restored: 2 });
  });

  it('flags an object it would create when browsing', async () => {
    loseObject();

    const { objects } = await listArchivedObjects(configFor(dest));

    expect(objects[0]).toMatchObject({ folderName: M31_FOLDER, objectId: null, willCreate: true });
  });

  it('does not flag an object that is already in the library', async () => {
    const { objects } = await listArchivedObjects(configFor(dest));

    expect(objects[0].willCreate).toBe(false);
  });
});
