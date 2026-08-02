/**
 * The per-file record for the local library.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The library was originally "filesystem as database": there was no per-file
 * table, and `getLocalSessions` / `getLocalFiles` decided which session a file
 * belonged to by running `parseFilename(name).date` through `sessionNightFor`
 * at read time. That had one hard consequence: **a file whose name did not
 * parse was invisible after import**, so the importer had to rewrite filenames
 * to stamp a target and session timestamp into them.
 *
 * The renaming was never the goal. It was the price of throwing away the
 * source's own folder structure, which is where the capture date actually
 * lived (a Dwarf session folder is
 * `DWARF_RAW_TELE_IC 1396_EXP_60_GAIN_60_2026-07-05-23-25-49-658`, and the
 * files inside it are `stacked.jpg`, `stacked-16_*.fits` — no date at all).
 * Flat per-object folder → discarded folder name → forced rename.
 *
 * This table records what the filename used to have to encode. Once a file's
 * identity is a row rather than a string, the importer can keep the name the
 * telescope gave it, and files that carry no parseable date at all (sidecars
 * like `shotsInfo.json`) can be stored instead of dropped.
 *
 * ── The one subtlety: dates are stored raw, nights are derived ──────────────
 * `captureDate` / `captureTime` hold the RAW capture instant. The observing
 * night is computed on read via `observingNightDate`, which consults the
 * user's `groupObservingNights` setting. Storing a resolved night instead
 * would freeze that toggle for every imported file, because flipping it has to
 * move every session boundary in the app at once. `sessionDateOverride` is the
 * escape hatch for a date a user pinned by hand and always wins.
 *
 * This module deliberately stays low in the import graph: `db`, `libraryPath`,
 * `telescopeFiles`, and `importFilter` (which itself depends on nothing higher).
 * `objects.ts` imports *this*, so anything richer here (e.g. `getFolderName`)
 * would create a cycle; folder/object mapping is read straight from
 * `libraryObjects` instead.
 */
import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { getLibraryDir } from '../libraryPath.js';
import {
  parseFilename,
  isRealFile,
  observingNightDate,
  sessionNightFor,
} from '../telescopeFiles.js';
import { isDwarfMasterStack } from './importFilter.js';

/** What a file *is*, decided once at import instead of re-guessed per read.
 *
 *  `preview` covers rendered rasters that aren't the science frame (a stacking
 *  app's JPG/PNG export). `metadata` covers sidecars that were previously
 *  dropped outright because they aren't images. `unknown` is the deliberate
 *  catch-all: storing a file we can't classify is strictly better than the old
 *  behavior of silently refusing it, and it keeps "we chose to drop this" and
 *  "we couldn't index this" from collapsing into the same code path. */
export type LibraryFileRole =
  | 'stacked'
  | 'sub'
  | 'thumbnail'
  | 'preview'
  | 'video'
  | 'metadata'
  | 'unknown';

export interface LibraryFileRow {
  id: number;
  objectId: string;
  relPath: string;
  fileName: string;
  originalName: string;
  role: LibraryFileRole;
  captureDate: string | null;
  captureTime: string | null;
  sessionDateOverride: string | null;
  telescopeId: string | null;
  bytes: number;
  sourcePath: string | null;
  importedAt: string;
}

/** Everything needed to record one imported file. `fileName` is what landed on
 *  disk; `originalName` is what the source called it. They are equal whenever
 *  nothing was renamed, which is the goal state. */
export interface RecordFileInput {
  objectId: string;
  folderName: string;
  /** Session directory inside the object folder, for nested objects. Omit (or
   *  pass null) for a flat object, where files sit at object level. */
  sessionFolder?: string | null;
  fileName: string;
  originalName?: string;
  role?: LibraryFileRole;
  captureDate?: string | null;
  captureTime?: string | null;
  sessionDateOverride?: string | null;
  telescopeId?: string | null;
  bytes?: number;
  sourcePath?: string | null;
}

/** Sidecar and companion files that carry real information about a capture but
 *  are not themselves images. Kept separate from `isRealFile`'s allowlist,
 *  which gates the gallery and thumbnailing and must stay image-only. */
const METADATA_EXTENSIONS = new Set(['.json', '.txt', '.xml', '.csv', '.log']);

/** Classify a file by name. Roles are recorded at import time so this runs
 *  once per file rather than on every read, but it stays exported and pure so
 *  the backfill and the tests can reuse the exact same rule. */
export function roleForFile(
  fileName: string,
  opts: { fromSubFolder?: boolean } = {},
): LibraryFileRole {
  const lower = fileName.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf('.'));
  if (METADATA_EXTENSIONS.has(ext)) return 'metadata';

  // The Dwarf master integration is a stack, not a preview, even though its
  // extension is .tif. See isDwarfMasterStack.
  if (isDwarfMasterStack(fileName)) return 'stacked';

  const parsed = parseFilename(fileName);
  if (parsed.isThumbnail) return 'thumbnail';
  // The directory outranks the filename: everything inside a `_sub` folder is
  // a sub-frame however it happens to be named. Mirrors classifyImportFile.
  if (opts.fromSubFolder === true || parsed.type === 'sub') return 'sub';
  if (parsed.type === 'stacked') return 'stacked';
  if (parsed.type === 'video') return 'video';
  if (ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.tif' || ext === '.tiff') {
    return 'preview';
  }
  if (ext === '.fit' || ext === '.fits' || ext === '.fts') return 'stacked';
  return 'unknown';
}

/**
 * The observing night a recorded file belongs to.
 *
 * This is the function that replaces `sessionNightFor(parseFilename(name))` as
 * the authority on session membership. A hand-pinned date wins; otherwise the
 * raw capture date is rolled through the user's current grouping setting.
 * Returns null for a file with no known capture date (a sidecar, or something
 * imported from a source that carried no date anywhere) — such a file belongs
 * to the object but to no particular night.
 */
export function sessionDateForRow(
  row: Pick<LibraryFileRow, 'captureDate' | 'captureTime' | 'sessionDateOverride'>,
): string | null {
  if (row.sessionDateOverride) return row.sessionDateOverride;
  if (!row.captureDate) return null;
  return observingNightDate(row.captureDate, row.captureTime);
}

const insertFileStmt = db.prepare(
  `INSERT INTO libraryFiles
     (objectId, relPath, fileName, originalName, role, captureDate, captureTime,
      sessionDateOverride, telescopeId, bytes, sourcePath, importedAt)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(relPath) DO UPDATE SET
     objectId = excluded.objectId,
     fileName = excluded.fileName,
     role = excluded.role,
     captureDate = excluded.captureDate,
     captureTime = excluded.captureTime,
     telescopeId = COALESCE(libraryFiles.telescopeId, excluded.telescopeId),
     bytes = excluded.bytes,
     sourcePath = COALESCE(excluded.sourcePath, libraryFiles.sourcePath),
     -- originalName and sessionDateOverride are first-write-wins: a re-import
     -- must not forget what the source called the file, nor silently undo a
     -- date the user pinned by hand.
     originalName = COALESCE(libraryFiles.originalName, excluded.originalName)`,
);

/** Record (or refresh) one file. Keyed on relPath, so re-importing the same
 *  file updates its row rather than duplicating it. */
export function recordLibraryFile(input: RecordFileInput): void {
  const relPath = input.sessionFolder
    ? `${input.folderName}/${input.sessionFolder}/${input.fileName}`
    : `${input.folderName}/${input.fileName}`;
  const parsed = parseFilename(input.fileName);
  // Fall back to whatever the filename yields so a caller that has no better
  // information still produces a row at least as good as the old derivation.
  const captureDate = input.captureDate !== undefined ? input.captureDate : (parsed.date ?? null);
  const captureTime = input.captureTime !== undefined
    ? input.captureTime
    : (parsed.timestamp ? parsed.timestamp.slice(-6) : null);

  insertFileStmt.run(
    input.objectId,
    relPath,
    input.fileName,
    input.originalName ?? input.fileName,
    input.role ?? roleForFile(input.fileName),
    captureDate,
    captureTime,
    input.sessionDateOverride ?? null,
    input.telescopeId ?? null,
    input.bytes ?? 0,
    input.sourcePath ?? null,
    new Date().toISOString(),
  );
}

const selectByObjectStmt = db.prepare<[string], LibraryFileRow>(
  'SELECT * FROM libraryFiles WHERE objectId = ?',
);
const selectByRelPathStmt = db.prepare<[string], LibraryFileRow>(
  'SELECT * FROM libraryFiles WHERE relPath = ?',
);
const countByObjectStmt = db.prepare<[string], { n: number }>(
  'SELECT COUNT(*) as n FROM libraryFiles WHERE objectId = ?',
);

export function getLibraryFilesForObject(objectId: string): LibraryFileRow[] {
  return selectByObjectStmt.all(objectId);
}

export function getLibraryFileRow(relPath: string): LibraryFileRow | undefined {
  return selectByRelPathStmt.get(relPath);
}

/** True when this object has any recorded files. Read paths use it to decide
 *  whether the table can be trusted for this object or whether they should
 *  fall back to parsing filenames off disk (an object imported before the
 *  backfill ran, or one whose files were dropped in by hand). */
export function hasRecordedFiles(objectId: string): boolean {
  return (countByObjectStmt.get(objectId)?.n ?? 0) > 0;
}

const deleteByRelPathStmt = db.prepare('DELETE FROM libraryFiles WHERE relPath = ?');
const deleteByObjectStmt = db.prepare('DELETE FROM libraryFiles WHERE objectId = ?');

export function deleteLibraryFileRow(relPath: string): void {
  deleteByRelPathStmt.run(relPath);
}

export function deleteLibraryFileRowsForObject(objectId: string): void {
  deleteByObjectStmt.run(objectId);
}

/** Drop the rows for one observing night. Resolved in JS rather than SQL
 *  because the night is derived (grouping toggle + override), not a column. */
export function deleteLibraryFileRowsForSession(objectId: string, date: string): number {
  const rows = getLibraryFilesForObject(objectId).filter(r => sessionDateForRow(r) === date);
  const tx = db.transaction((victims: LibraryFileRow[]) => {
    for (const r of victims) deleteByRelPathStmt.run(r.relPath);
  });
  tx(rows);
  return rows.length;
}

const updatePathStmt = db.prepare(
  'UPDATE libraryFiles SET relPath = ?, fileName = ?, objectId = ? WHERE relPath = ?',
);

/**
 * Follow a file that moved or was renamed on disk.
 *
 * `toObjectRelPath` is the destination relative to the object folder, so it may
 * carry a session directory (`<session>/stacked.jpg`). `fileName` stays the
 * bare basename — it is the file's name, not its address, and the read paths
 * rely on that distinction.
 */
export function moveLibraryFileRow(
  fromRelPath: string,
  toObjectId: string,
  toFolderName: string,
  toObjectRelPath: string,
): void {
  const fileName = toObjectRelPath.slice(toObjectRelPath.lastIndexOf('/') + 1);
  updatePathStmt.run(`${toFolderName}/${toObjectRelPath}`, fileName, toObjectId, fromRelPath);
}

const setOverrideStmt = db.prepare(
  'UPDATE libraryFiles SET sessionDateOverride = ? WHERE relPath = ?',
);

/** Pin a file to a session date by hand. This is what the folder wizard's
 *  "unsorted" bucket and any later reassignment should use instead of
 *  rewriting the file's name to make the derivation come out right. */
export function setSessionDateOverride(relPath: string, date: string | null): void {
  setOverrideStmt.run(date, relPath);
}

/**
 * Per-object lookup used by the read paths.
 *
 * Existence stays the filesystem's job and identity becomes the table's. Read
 * paths still enumerate the directory (files can be deleted, restored, or
 * dropped in by hand outside the app, and the table must never claim a file
 * that isn't there), then ask this resolver what each one *is*.
 *
 * `session()` falls back to the historical filename derivation whenever a file
 * has no row. That fallback is what makes this change safe to ship
 * incrementally: an object imported before the backfill, or a file a user
 * copied into a library folder by hand, behaves exactly as it did before.
 */
/**
 * Keys are **object-relative paths**, not bare filenames: `stacked.jpg` for a
 * flat object, `<sessionFolder>/stacked.jpg` for a nested one. This matters —
 * every Dwarf session folder contains a `stacked.jpg`, so a basename-keyed map
 * would collapse every session of an object onto one row. Callers that only
 * have a filename (a flat object) can pass it directly, since for a flat object
 * the two forms are identical.
 */
export interface FileIdentityResolver {
  session(relPath: string): string | null;
  role(relPath: string): LibraryFileRole;
  originalName(relPath: string): string;
  has(relPath: string): boolean;
}

/** Strip the leading `<folderName>/` from a stored relPath, leaving the path
 *  relative to the object folder. Object folder names never contain a slash,
 *  so the first separator is always the boundary. */
export function objectRelativePath(relPath: string): string {
  const slash = relPath.indexOf('/');
  return slash >= 0 ? relPath.slice(slash + 1) : relPath;
}

export function resolverFor(objectId: string): FileIdentityResolver {
  const byPath = new Map<string, LibraryFileRow>();
  for (const row of getLibraryFilesForObject(objectId)) {
    byPath.set(objectRelativePath(row.relPath), row);
  }
  // The historical fallback parses a *filename*, so a nested path has to be
  // reduced to its basename before it can be asked the old question.
  const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

  return {
    has: (relPath) => byPath.has(relPath),
    session: (relPath) => {
      const row = byPath.get(relPath);
      if (row) return sessionDateForRow(row);
      return sessionNightFor(parseFilename(baseOf(relPath)));
    },
    role: (relPath) => byPath.get(relPath)?.role ?? roleForFile(baseOf(relPath)),
    originalName: (relPath) => byPath.get(relPath)?.originalName ?? baseOf(relPath),
  };
}

// ─── Manifest (rebuild-from-disk) ────────────────────────────────────────────

/** Per-object sidecar holding this object's rows.
 *
 *  The original filesystem-as-database design had one real virtue worth
 *  keeping: the library was inspectable and rebuildable without the SQLite
 *  file. A per-file table gives that up unless the rows also live next to the
 *  files, so every write to the table is mirrored into this manifest and
 *  `rebuildFromManifests()` can restore the table from disk alone.
 *
 *  Dot-prefixed so `isRealFile` already rejects it everywhere. */
export const MANIFEST_NAME = '.nebulis-files.json';

interface ManifestShape {
  version: 1;
  objectId: string;
  updatedAt: string;
  files: Array<Omit<LibraryFileRow, 'id' | 'objectId'>>;
}

export function writeObjectManifest(objectId: string, folderName: string): void {
  const objDir = path.join(getLibraryDir(), folderName);
  if (!fs.existsSync(objDir)) return;
  const rows = getLibraryFilesForObject(objectId);
  const manifest: ManifestShape = {
    version: 1,
    objectId,
    updatedAt: new Date().toISOString(),
    // id and objectId are omitted: id is a local autoincrement that means
    // nothing on another machine, and objectId is already on the envelope.
    files: rows.map(row => ({
      relPath: row.relPath,
      fileName: row.fileName,
      originalName: row.originalName,
      role: row.role,
      captureDate: row.captureDate,
      captureTime: row.captureTime,
      sessionDateOverride: row.sessionDateOverride,
      telescopeId: row.telescopeId,
      bytes: row.bytes,
      sourcePath: row.sourcePath,
      importedAt: row.importedAt,
    })),
  };
  const dest = path.join(objDir, MANIFEST_NAME);
  const tmp = `${dest}.tmp`;
  try {
    // Write-then-rename so a crash mid-write can't leave a truncated manifest
    // that would silently lose rows on the next rebuild.
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
    fs.renameSync(tmp, dest);
  } catch (err) {
    // A manifest is a convenience, never the authority. Failing to write one
    // must not fail an import that already put the file on disk.
    console.warn(`[libraryFiles] Could not write manifest for ${objectId}:`, err instanceof Error ? err.message : err);
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

/** Restore table rows from the on-disk manifests. Returns the number of rows
 *  restored. Only fills gaps: an object that already has rows is left alone. */
export function rebuildFromManifests(): number {
  const libraryDir = getLibraryDir();
  if (!fs.existsSync(libraryDir)) return 0;
  let restored = 0;
  for (const folderName of fs.readdirSync(libraryDir)) {
    const manifestPath = path.join(libraryDir, folderName, MANIFEST_NAME);
    if (!fs.existsSync(manifestPath)) continue;
    let manifest: ManifestShape;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch {
      continue;
    }
    if (manifest.version !== 1 || !Array.isArray(manifest.files)) continue;
    if (hasRecordedFiles(manifest.objectId)) continue;
    const tx = db.transaction(() => {
      for (const f of manifest.files) {
        // Skip rows whose file is no longer on disk — the manifest is a
        // record of intent, the filesystem is the record of fact.
        if (!fs.existsSync(path.join(libraryDir, f.relPath))) continue;
        insertFileStmt.run(
          manifest.objectId, f.relPath, f.fileName, f.originalName, f.role,
          f.captureDate, f.captureTime, f.sessionDateOverride, f.telescopeId,
          f.bytes, f.sourcePath, f.importedAt,
        );
        restored++;
      }
    });
    tx();
  }
  return restored;
}

// ─── Backfill ────────────────────────────────────────────────────────────────

/**
 * Populate the table from an existing library.
 *
 * Deliberately reproduces the OLD derivation exactly (`sessionNightFor` over
 * `parseFilename`) rather than trying to do better. The point of the backfill
 * is that the first read after upgrading returns precisely what the last read
 * before upgrading did — the date stops being *derived* and starts being
 * *recorded*, and nothing else changes on that boundary. Improving a date is a
 * separate, opt-in action (re-import), not something a migration should do
 * silently to a user's library.
 *
 * One asymmetry worth knowing: the old derivation produced a rolled observing
 * night, while the column wants a raw capture date. Passing the rolled night
 * back through the roller would double-roll it, so the parsed raw date is
 * stored when there is one, and the rolled night is pinned as an override only
 * when the file has no parseable date of its own to re-derive from.
 *
 * Idempotent: objects that already have rows are skipped, so it is safe to
 * call on every boot.
 */
export function backfillLibraryFiles(): { objects: number; files: number } {
  const libraryDir = getLibraryDir();
  if (!fs.existsSync(libraryDir)) return { objects: 0, files: 0 };

  const objectRows = db.prepare<[], { objectId: string; folderName: string }>(
    'SELECT objectId, folderName FROM libraryObjects WHERE deleted = 0',
  ).all();

  let objects = 0;
  let files = 0;
  for (const { objectId, folderName } of objectRows) {
    if (hasRecordedFiles(objectId)) continue;
    const objDir = path.join(libraryDir, folderName);
    if (!fs.existsSync(objDir)) continue;

    let entries: string[];
    try {
      entries = fs.readdirSync(objDir);
    } catch {
      continue;
    }
    // `sky_`/`gallery_` are app-generated artwork, not captures. Every existing
    // read path already excludes them by prefix; keep them out of the table so
    // the table never reports a file the old code wouldn't have.
    const candidates = entries.filter(
      f => isRealFile(f) && !f.startsWith('sky_') && !f.startsWith('gallery_'),
    );
    if (candidates.length === 0) continue;

    const tx = db.transaction(() => {
      for (const fileName of candidates) {
        const parsed = parseFilename(fileName);
        const night = sessionNightFor(parsed);
        let bytes = 0;
        try { bytes = fs.statSync(path.join(objDir, fileName)).size; } catch { /* best effort */ }
        recordLibraryFile({
          objectId,
          folderName,
          fileName,
          // Pre-backfill the on-disk name is all we have. Anything renamed on
          // the way in lost its source name before this table existed; that is
          // unrecoverable and honestly recorded as "same as on disk".
          originalName: fileName,
          role: roleForFile(fileName),
          captureDate: parsed.date ?? null,
          captureTime: parsed.timestamp ? parsed.timestamp.slice(-6) : null,
          sessionDateOverride: parsed.date ? null : night,
          bytes,
        });
        files++;
      }
    });
    tx();
    writeObjectManifest(objectId, folderName);
    objects++;
  }
  return { objects, files };
}
