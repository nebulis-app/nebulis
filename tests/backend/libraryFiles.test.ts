import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';

// Redirect DATA_DIR to an isolated temp dir before any server module loads
// (paths.ts captures it at import time). Same pattern as folderImport.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-libfiles-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import {
  recordLibraryFile,
  roleForFile,
  sessionDateForRow,
  resolverFor,
  getLibraryFilesForObject,
  getLibraryFileRow,
  deleteLibraryFileRow,
  deleteLibraryFileRowsForObject,
  deleteLibraryFileRowsForSession,
  moveLibraryFileRow,
  setSessionDateOverride,
  writeObjectManifest,
  rebuildFromManifests,
  backfillLibraryFiles,
  hasRecordedFiles,
  MANIFEST_NAME,
} from '../../server/lib/library/libraryFiles';
import { LIBRARY_DIR } from '../../server/lib/paths';
import { updateSettingsData } from '../../server/lib/telescopes';
import { stmts } from '../../server/lib/library/objects';
import db from '../../server/lib/db';

const FOLDER = 'M31';
const OBJECT_ID = 'M31';

function objDir(): string {
  return path.join(LIBRARY_DIR, FOLDER);
}

/** Register the object so the backfill (which walks libraryObjects) sees it. */
function seedObject(objectId = OBJECT_ID, folderName = FOLDER): void {
  stmts.upsertObject.run(
    objectId, folderName, 0, new Date().toISOString(), 0, null,
    null, null, null, null, null, null, null, null, null,
  );
}

function writeFile(name: string, contents = 'x'): void {
  fs.mkdirSync(objDir(), { recursive: true });
  fs.writeFileSync(path.join(objDir(), name), contents);
}

beforeEach(() => {
  db.prepare('DELETE FROM libraryFiles').run();
  db.prepare('DELETE FROM libraryObjects').run();
  db.prepare('DELETE FROM librarySessions').run();
  fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  updateSettingsData({ groupObservingNights: true });
});

describe('roleForFile', () => {
  it('classifies sidecars as metadata rather than refusing them', () => {
    // The whole point of the role column: shotsInfo.json is the best metadata a
    // Dwarf produces and used to be dropped for not being an image.
    expect(roleForFile('shotsInfo.json')).toBe('metadata');
    expect(roleForFile('notes.txt')).toBe('metadata');
  });

  it('lets a _sub directory outrank the filename', () => {
    // A file that looks like a stack but sits in a _sub folder is a sub-frame.
    expect(roleForFile('stacked-16_M31.fits')).toBe('stacked');
    expect(roleForFile('stacked-16_M31.fits', { fromSubFolder: true })).toBe('sub');
  });

  it('recognises thumbnails by the _thn convention', () => {
    expect(roleForFile('DWARF3_M31_2026-07-05_thn.jpg')).toBe('thumbnail');
  });
});

describe('sessionDateForRow', () => {
  it('derives the observing night from the raw capture instant', () => {
    // 00:30 rolls back to the previous evening when grouping is on.
    expect(sessionDateForRow({
      captureDate: '2026-07-06', captureTime: '003000', sessionDateOverride: null,
    })).toBe('2026-07-05');
  });

  it('follows the groupObservingNights setting instead of freezing it', () => {
    // This is why captureDate is stored raw rather than pre-rolled: toggling
    // the setting has to move every session boundary, including imported files.
    const row = { captureDate: '2026-07-06', captureTime: '003000', sessionDateOverride: null };
    expect(sessionDateForRow(row)).toBe('2026-07-05');
    updateSettingsData({ groupObservingNights: false });
    expect(sessionDateForRow(row)).toBe('2026-07-06');
  });

  it('lets a hand-pinned override win over the derivation', () => {
    expect(sessionDateForRow({
      captureDate: '2026-07-06', captureTime: '003000', sessionDateOverride: '2026-01-01',
    })).toBe('2026-01-01');
  });

  it('returns null for a file with no date at all', () => {
    expect(sessionDateForRow({
      captureDate: null, captureTime: null, sessionDateOverride: null,
    })).toBeNull();
  });
});

describe('recordLibraryFile', () => {
  it('records a file whose name carries no date, which the old scheme could not', () => {
    // `stacked.jpg` is the exact case that forced renaming: the date lived in
    // the Dwarf session folder, not the filename.
    seedObject();
    recordLibraryFile({
      objectId: OBJECT_ID,
      folderName: FOLDER,
      fileName: 'stacked.jpg',
      originalName: 'stacked.jpg',
      captureDate: '2026-07-05',
      captureTime: '232544',
    });
    const row = getLibraryFileRow('M31/stacked.jpg')!;
    expect(row).toBeDefined();
    expect(sessionDateForRow(row)).toBe('2026-07-05');
    // Name preserved verbatim — nothing stamped into it.
    expect(row.fileName).toBe('stacked.jpg');
    expect(row.originalName).toBe('stacked.jpg');
  });

  it('is keyed on relPath so a re-import updates rather than duplicates', () => {
    seedObject();
    const input = {
      objectId: OBJECT_ID, folderName: FOLDER, fileName: 'a.fits', bytes: 10,
    };
    recordLibraryFile(input);
    recordLibraryFile({ ...input, bytes: 99 });
    const rows = getLibraryFilesForObject(OBJECT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].bytes).toBe(99);
  });

  it('keeps the original name across a re-import that no longer knows it', () => {
    // first-write-wins on originalName: a later run that only sees the on-disk
    // name must not overwrite what the source called the file.
    seedObject();
    recordLibraryFile({
      objectId: OBJECT_ID, folderName: FOLDER,
      fileName: 'DWARF3_M31_2026-07-05.jpg', originalName: 'stacked.jpg',
    });
    recordLibraryFile({
      objectId: OBJECT_ID, folderName: FOLDER,
      fileName: 'DWARF3_M31_2026-07-05.jpg',
    });
    expect(getLibraryFileRow('M31/DWARF3_M31_2026-07-05.jpg')!.originalName).toBe('stacked.jpg');
  });

  it('falls back to the filename for dates when the caller supplies none', () => {
    seedObject();
    recordLibraryFile({
      objectId: OBJECT_ID, folderName: FOLDER,
      fileName: 'Stacked_30_M31_10.0s_IRCUT_20261015-210530.jpg',
    });
    const row = getLibraryFileRow('M31/Stacked_30_M31_10.0s_IRCUT_20261015-210530.jpg')!;
    expect(row.captureDate).toBe('2026-10-15');
  });
});

describe('resolverFor', () => {
  it('answers from the table when a row exists', () => {
    seedObject();
    recordLibraryFile({
      objectId: OBJECT_ID, folderName: FOLDER, fileName: 'stacked.jpg',
      captureDate: '2026-07-05', captureTime: '232544',
    });
    expect(resolverFor(OBJECT_ID).session('stacked.jpg')).toBe('2026-07-05');
  });

  it('falls back to parsing the filename when the file has no row', () => {
    // This fallback is what makes the change safe to ship incrementally: files
    // dropped in by hand, or imported before the backfill, behave as before.
    seedObject();
    const name = 'Stacked_30_M31_10.0s_IRCUT_20261015-210530.jpg';
    expect(resolverFor(OBJECT_ID).session(name)).toBe('2026-10-15');
    expect(resolverFor(OBJECT_ID).has(name)).toBe(false);
  });

  it('returns null for an unrecorded name that carries no date', () => {
    seedObject();
    expect(resolverFor(OBJECT_ID).session('stacked.jpg')).toBeNull();
  });
});

describe('deletes', () => {
  beforeEach(() => {
    seedObject();
    recordLibraryFile({
      objectId: OBJECT_ID, folderName: FOLDER, fileName: 'a.jpg',
      captureDate: '2026-07-05', captureTime: '220000',
    });
    recordLibraryFile({
      objectId: OBJECT_ID, folderName: FOLDER, fileName: 'b.jpg',
      captureDate: '2026-07-08', captureTime: '220000',
    });
  });

  it('removes a single row by path', () => {
    deleteLibraryFileRow('M31/a.jpg');
    expect(getLibraryFilesForObject(OBJECT_ID).map(r => r.fileName)).toEqual(['b.jpg']);
  });

  it('removes only the rows for one observing night', () => {
    expect(deleteLibraryFileRowsForSession(OBJECT_ID, '2026-07-05')).toBe(1);
    expect(getLibraryFilesForObject(OBJECT_ID).map(r => r.fileName)).toEqual(['b.jpg']);
  });

  it('removes every row for an object', () => {
    deleteLibraryFileRowsForObject(OBJECT_ID);
    expect(hasRecordedFiles(OBJECT_ID)).toBe(false);
  });
});

describe('moveLibraryFileRow', () => {
  it('follows a file to another object folder', () => {
    seedObject();
    seedObject('M42', 'M42');
    recordLibraryFile({
      objectId: OBJECT_ID, folderName: FOLDER, fileName: 'a.jpg',
      captureDate: '2026-07-05', captureTime: '220000',
    });
    moveLibraryFileRow('M31/a.jpg', 'M42', 'M42', 'a.jpg');
    expect(getLibraryFilesForObject(OBJECT_ID)).toHaveLength(0);
    const moved = getLibraryFileRow('M42/a.jpg')!;
    expect(moved.objectId).toBe('M42');
    // The capture instant survives the move — the night is still derivable.
    expect(sessionDateForRow(moved)).toBe('2026-07-05');
  });
});

describe('setSessionDateOverride', () => {
  it('repins a file without touching its name on disk', () => {
    seedObject();
    recordLibraryFile({
      objectId: OBJECT_ID, folderName: FOLDER, fileName: 'a.jpg',
      captureDate: '2026-07-05', captureTime: '220000',
    });
    setSessionDateOverride('M31/a.jpg', '2026-01-01');
    expect(sessionDateForRow(getLibraryFileRow('M31/a.jpg')!)).toBe('2026-01-01');
    expect(getLibraryFileRow('M31/a.jpg')!.fileName).toBe('a.jpg');
  });
});

describe('backfillLibraryFiles', () => {
  it('reproduces the old filename derivation exactly', () => {
    // The migration must be a no-op from the reader's point of view: the date
    // stops being derived and starts being recorded, and nothing else moves.
    seedObject();
    writeFile('Stacked_30_M31_10.0s_IRCUT_20261015-210530.jpg');
    const { files } = backfillLibraryFiles();
    expect(files).toBe(1);
    const row = getLibraryFileRow('M31/Stacked_30_M31_10.0s_IRCUT_20261015-210530.jpg')!;
    expect(sessionDateForRow(row)).toBe('2026-10-15');
  });

  it('pins the rolled night for a file with no parseable date of its own', () => {
    // Guards the double-roll trap: a file whose only date came from the old
    // derivation must not be re-rolled on every subsequent read.
    seedObject();
    writeFile('mystery.jpg');
    backfillLibraryFiles();
    const row = getLibraryFileRow('M31/mystery.jpg')!;
    expect(row.captureDate).toBeNull();
    expect(sessionDateForRow(row)).toBeNull();
  });

  it('does not double-roll a cross-midnight capture', () => {
    seedObject();
    // 00:30 capture — parses to 2026-10-16, rolls to the 2026-10-15 night.
    writeFile('Stacked_30_M31_10.0s_IRCUT_20261016-003000.jpg');
    backfillLibraryFiles();
    const row = getLibraryFileRow('M31/Stacked_30_M31_10.0s_IRCUT_20261016-003000.jpg')!;
    expect(row.captureDate).toBe('2026-10-16');
    expect(sessionDateForRow(row)).toBe('2026-10-15');
  });

  it('skips objects that already have rows, so it is safe on every boot', () => {
    seedObject();
    writeFile('Stacked_30_M31_10.0s_IRCUT_20261015-210530.jpg');
    expect(backfillLibraryFiles().files).toBe(1);
    expect(backfillLibraryFiles().files).toBe(0);
    expect(getLibraryFilesForObject(OBJECT_ID)).toHaveLength(1);
  });

  it('leaves app-generated artwork out of the table', () => {
    seedObject();
    writeFile('sky_M31.jpg');
    writeFile('gallery_M31.jpg');
    expect(backfillLibraryFiles().files).toBe(0);
  });
});

describe('manifest', () => {
  it('round-trips rows through disk so the table can be rebuilt without the DB', () => {
    seedObject();
    writeFile('stacked.jpg');
    recordLibraryFile({
      objectId: OBJECT_ID, folderName: FOLDER, fileName: 'stacked.jpg',
      originalName: 'stacked.jpg', captureDate: '2026-07-05', captureTime: '232544',
    });
    writeObjectManifest(OBJECT_ID, FOLDER);
    expect(fs.existsSync(path.join(objDir(), MANIFEST_NAME))).toBe(true);

    // Simulate losing the database but keeping the library.
    db.prepare('DELETE FROM libraryFiles').run();
    expect(hasRecordedFiles(OBJECT_ID)).toBe(false);

    expect(rebuildFromManifests()).toBe(1);
    const row = getLibraryFileRow('M31/stacked.jpg')!;
    expect(row.originalName).toBe('stacked.jpg');
    expect(sessionDateForRow(row)).toBe('2026-07-05');
  });

  it('does not restore rows for files that are no longer on disk', () => {
    seedObject();
    writeFile('stacked.jpg');
    recordLibraryFile({ objectId: OBJECT_ID, folderName: FOLDER, fileName: 'stacked.jpg' });
    writeObjectManifest(OBJECT_ID, FOLDER);
    fs.rmSync(path.join(objDir(), 'stacked.jpg'));
    db.prepare('DELETE FROM libraryFiles').run();
    expect(rebuildFromManifests()).toBe(0);
  });

  it('leaves an object alone when it already has rows', () => {
    seedObject();
    writeFile('stacked.jpg');
    recordLibraryFile({ objectId: OBJECT_ID, folderName: FOLDER, fileName: 'stacked.jpg' });
    writeObjectManifest(OBJECT_ID, FOLDER);
    expect(rebuildFromManifests()).toBe(0);
  });

  it('survives a corrupt manifest without throwing', () => {
    seedObject();
    writeFile('stacked.jpg');
    fs.writeFileSync(path.join(objDir(), MANIFEST_NAME), '{ not json');
    expect(() => rebuildFromManifests()).not.toThrow();
  });
});

describe('TEST_DATA_DIR isolation', () => {
  it('runs against its own data dir', () => {
    expect(process.env.DATA_DIR).toBe(TEST_DATA_DIR);
  });
});
