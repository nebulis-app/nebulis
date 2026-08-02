/**
 * On-disk layout of a library object: flat (legacy) or nested (per-session).
 *
 * ── The two layouts ─────────────────────────────────────────────────────────
 *
 *   flat (legacy)                        nested
 *   library/IC1396/                      library/IC1396/
 *     DWARF3_IC1396_20260705-232544.jpg    DWARF_RAW_TELE_IC 1396_EXP_60_.../
 *     DWARF3_IC1396_20260705-232544_thn.jpg   stacked.jpg
 *     ...every night mixed together           stacked_thumbnail.jpg
 *     processed/                              shotsInfo.json
 *                                          DWARF_RAW_TELE_IC 1396_EXP_60_.../
 *                                          processed/
 *
 * Flat is why the importer renames. Session identity had nowhere to live except
 * the filename, and every session's files shared one directory, so names had to
 * be made unique by stamping a target and timestamp into them. Nested puts
 * identity back in the path: the folder is unique, so the file inside it does
 * not have to be.
 *
 * ── Why the session folder mirrors the source name ──────────────────────────
 *
 * The obvious choice is to name the folder after the observing night
 * (`IC1396/2026-07-05/`). That is wrong, and the user's own library proves it:
 *
 *   DWARF_RAW_TELE_C 5_EXP_60_GAIN_60_2026-02-26-21-54-49-673
 *   DWARF_RAW_TELE_C 5_EXP_120_GAIN_40_2026-02-26-23-11-44-030
 *
 * Two captures of C 5 on one night at different exposure and gain. Both roll to
 * the night 2026-02-26, so a date-named folder would put both `stacked.jpg`
 * files at the same path and lose one — the very collision nesting exists to
 * fix. Mirroring the source folder name keeps them apart *and* preserves the
 * exposure/gain the date would have discarded.
 *
 * A device that has no session folder of its own (SeeStar keeps one flat
 * directory per target plus a `_sub` companion) gets a canonical folder built
 * from the session start instead. Same guarantee, synthesized rather than
 * copied.
 */
import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { getLibraryDir } from '../libraryPath.js';
import { ILLEGAL_FS_CHARS } from './importNaming.js';

export type LibraryLayout = 'flat' | 'nested';

/** Object-level directories that are not session folders and must never be
 *  mistaken for one by a nested walk. `processed/` holds user-uploaded
 *  post-processing output keyed by (objectId, date) in its own table; it stays
 *  at object level because a processed image can span several sessions. */
const RESERVED_DIRS = new Set(['processed', 'thumbnails', 'thumbnail']);

export function isReservedObjectDir(name: string): boolean {
  return RESERVED_DIRS.has(name.toLowerCase());
}

/** True when a directory entry inside an object folder should be treated as a
 *  session folder. Dot-prefixed entries are Nebulis bookkeeping (`.thumbs`, the
 *  per-file manifest). */
export function isSessionFolderEntry(name: string): boolean {
  return !name.startsWith('.') && !isReservedObjectDir(name);
}

/** Make a source folder name safe to use as a directory without changing what
 *  it says. Only characters the filesystem cannot take are replaced; spaces and
 *  case are preserved, because the whole point is to mirror the source. Returns
 *  null when nothing usable is left. */
export function sanitizeSessionFolder(name: string): string | null {
  const cleaned = name.replace(ILLEGAL_FS_CHARS, '_').replace(/\.+$/, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return null;
  return cleaned;
}

/** Canonical session folder for a source that has none of its own:
 *  `YYYY-MM-DD_HH-MM-SS`, built from the session start. Time is included
 *  deliberately — see the module note about two sessions on one night. */
export function canonicalSessionFolder(date: string, time: string | null): string {
  if (!time || !/^\d{6}$/.test(time)) return `${date}_00-00-00`;
  return `${date}_${time.slice(0, 2)}-${time.slice(2, 4)}-${time.slice(4, 6)}`;
}

/**
 * The session folder a file should land in.
 *
 * `sourceFolder` is the device's own session directory when it had one (Dwarf).
 * Passing null falls back to the canonical form (SeeStar, folder imports of
 * loose files). Returns null only when there is neither a usable source folder
 * nor a date, in which case the caller should keep the file at object level
 * rather than invent a session for it.
 */
export function sessionFolderFor(
  sourceFolder: string | null,
  date: string | null,
  time: string | null,
): string | null {
  if (sourceFolder) {
    const safe = sanitizeSessionFolder(sourceFolder);
    if (safe) return safe;
  }
  if (date) return canonicalSessionFolder(date, time);
  return null;
}

// ─── Per-object layout state ─────────────────────────────────────────────────

const getLayoutStmt = db.prepare<[string], { layout: string | null }>(
  'SELECT layout FROM libraryObjects WHERE objectId = ?',
);
const setLayoutStmt = db.prepare(
  'UPDATE libraryObjects SET layout = ? WHERE objectId = ?',
);

/**
 * How this object is stored on disk.
 *
 * Recorded per object rather than globally so a migration can convert one
 * object at a time and a failure never leaves the library in a state where the
 * reader disagrees with the disk. Objects with no row default to 'flat', which
 * is what every pre-existing library is.
 */
export function getObjectLayout(objectId: string): LibraryLayout {
  return getLayoutStmt.get(objectId)?.layout === 'nested' ? 'nested' : 'flat';
}

export function setObjectLayout(objectId: string, layout: LibraryLayout): void {
  setLayoutStmt.run(layout, objectId);
}

/**
 * The layout a *new* object should be created with.
 *
 * New objects are nested. Existing objects keep whatever they already are until
 * explicitly migrated — mixing both shapes inside one object folder would put
 * some of a session's files in the folder and some beside it, which no read
 * path could sensibly explain to a user.
 */
export function layoutForNewObject(): LibraryLayout {
  return 'nested';
}

/**
 * Decide the layout to write with for an object that may or may not exist yet.
 * Existing objects keep their current layout; brand-new ones start nested.
 */
export function layoutForImport(objectId: string, objectExists: boolean): LibraryLayout {
  return objectExists ? getObjectLayout(objectId) : layoutForNewObject();
}

// ─── Walking ─────────────────────────────────────────────────────────────────

/** One file inside an object folder, with the session folder it came from
 *  (null for a file sitting at object level, which is every file in a flat
 *  object and any stray left at the root of a nested one). */
export interface ObjectFileEntry {
  /** Path relative to the object folder, posix-style. Usually
   *  `<session>/<file>`, but may be deeper: archive mode mirrors sub-directories
   *  the device keeps inside a session, such as a Dwarf's `Thumbnail/`. */
  relPath: string;
  fileName: string;
  /** First-level directory under the object folder, which is the session. Stays
   *  the session even for a file nested deeper inside it. */
  sessionFolder: string | null;
}

/** Depth cap for the walk inside a session directory. A real device nests one
 *  level (`Thumbnail/`); this only exists so a symlink loop or a pathological
 *  tree cannot spin the walk. */
const MAX_SESSION_DEPTH = 4;

/**
 * List an object's files for either layout.
 *
 * This is the single place that knows a nested object is two levels deep, so
 * read paths can stay layout-agnostic. Files left at the root of a nested
 * object are still returned (with a null sessionFolder) rather than hidden —
 * a partially-migrated object, or a file the user dropped in by hand, must not
 * silently disappear from the library.
 */
export function listObjectFiles(objDir: string, layout: LibraryLayout): ObjectFileEntry[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(objDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: ObjectFileEntry[] = [];
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    if (ent.isFile()) {
      out.push({ relPath: ent.name, fileName: ent.name, sessionFolder: null });
      continue;
    }
    if (!ent.isDirectory()) continue;
    if (layout !== 'nested') continue;
    if (!isSessionFolderEntry(ent.name)) continue;
    // Recurse, so a sub-directory the device keeps inside a session (a Dwarf's
    // per-frame `Thumbnail/`, mirrored under archive mode) is not invisible.
    // sessionFolder stays the first-level directory however deep the file sits.
    collectSessionFiles(path.join(objDir, ent.name), ent.name, ent.name, 1, out);
  }
  return out;
}

function collectSessionFiles(
  dir: string,
  sessionFolder: string,
  relPrefix: string,
  depth: number,
  out: ObjectFileEntry[],
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const rel = `${relPrefix}/${ent.name}`;
    if (ent.isFile()) {
      out.push({ relPath: rel, fileName: ent.name, sessionFolder });
      continue;
    }
    if (!ent.isDirectory()) continue;
    if (depth >= MAX_SESSION_DEPTH) continue;
    collectSessionFiles(path.join(dir, ent.name), sessionFolder, rel, depth + 1, out);
  }
}

/** Convenience wrapper resolving the object directory from a folder name. */
export function listObjectFilesByFolder(folderName: string, layout: LibraryLayout): ObjectFileEntry[] {
  return listObjectFiles(path.join(getLibraryDir(), folderName), layout);
}
