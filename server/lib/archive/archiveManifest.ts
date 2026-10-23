/**
 * The archive's own record of what it put on the disk, and when.
 *
 * Retention cannot be written safely without this. "Delete anything older than N
 * days" applied to a directory listing would remove whatever the user happened to
 * leave in the archive folder, and there is no other way to answer the three
 * questions that matter:
 *
 *   - which objects did *we* create here,
 *   - when did we last touch each one, and
 *   - which of their files are subframes, so the subframes-only mode can be
 *     authoritative instead of re-deriving roles from filenames (the library
 *     knows a file's role from the import record; the archive disk does not).
 *
 * **The read path is fail-closed.** A missing, truncated, or unrecognisable
 * manifest reads as empty, and an empty manifest means retention has nothing to
 * remove. A damaged file on a removable disk therefore *disables* pruning rather
 * than licensing it, which is the failure direction that matters here.
 *
 * Mirrors the library's per-object manifest (`libraryFiles.ts`): a dot-prefixed
 * filename, so `isRealFile` rejects it everywhere and it can never be selected for
 * archiving back into itself.
 */

import fs from 'fs';
import path from 'path';

import { isRecord, parseJsonRecord } from '../typeGuards.js';
import { resolveContainedArchivePath } from './archivePath.js';
import type { ArchiveCandidate } from './archiveSelect.js';

export const ARCHIVE_MANIFEST_FILENAME = '.nebulisarchive-manifest.json';

/** Version 2 adds a per-file size, mtime and digest, and the owning archive's id. A
 *  version 1 record reads fine: its files simply have no digest recorded yet, so the
 *  first run after an upgrade verifies them in full once and fills the fields in. */
const MANIFEST_VERSION = 2;
const READABLE_VERSIONS: readonly unknown[] = [1, 2];

export interface ArchiveManifestFile {
  /** Path relative to the object folder, posix-style. */
  relPath: string;
  /** From the selection's role at archive time, which is the library's own
   *  classification. Re-deriving this from the filename on the archive side would
   *  be a second, divergent definition. */
  isSubframe: boolean;
  /** What the run that archived this file saw, so an unchanged file is not hashed
   *  again. Absent on a record written before these were kept. Never used to decide
   *  that a file is safe to delete: deletion always re-verifies in full. */
  bytes?: number;
  mtimeMs?: number;
  sha256?: string;
}

export interface ArchiveManifestObject {
  /**
   * The library object this folder belonged to when it was last written.
   *
   * A folder name is not an identity. Delete object `M 31` from the library and
   * later import a different `M 31`, and the archive folder keeps its name while
   * the thing behind it is new. Without this field the new object would inherit
   * the old one's `lastArchivedAt`, and the next retention pass could prune it
   * minutes after it was archived. An empty string means "written by a build that
   * did not record this", which counts as a mismatch: the conservative direction
   * is to restart the clock, never to inherit a stale one.
   */
  objectId: string;
  /** When this object was first archived. Retention ages from `lastArchivedAt`,
   *  but this is what answers "how long has this been on the disk". */
  firstArchivedAt: string;
  lastArchivedAt: string;
  files: ArchiveManifestFile[];
}

export interface ArchiveManifest {
  version: typeof MANIFEST_VERSION;
  /**
   * The archive this record describes, matching the marker on the disk. A disk
   * adopted from another install carries that install's record; without this the
   * new owner would prune files on the strength of history it did not make. Absent
   * on records written before it was kept, which are accepted and stamped.
   */
  archiveId?: string;
  updatedAt: string;
  /** Keyed by object folder name, which is also the archive's folder name. */
  objects: Record<string, ArchiveManifestObject>;
}

/** The record for an archive with nothing in it, and the value every unreadable
 *  manifest degrades to. */
export const EMPTY_ARCHIVE_MANIFEST: ArchiveManifest = { version: MANIFEST_VERSION, updatedAt: '', objects: {} };

function parseManifestFile(value: unknown): ArchiveManifestFile | null {
  if (!isRecord(value)) return null;
  const { relPath, isSubframe, bytes, mtimeMs, sha256 } = value;
  if (typeof relPath !== 'string' || relPath.length === 0) return null;
  if (typeof isSubframe !== 'boolean') return null;
  const entry: ArchiveManifestFile = { relPath, isSubframe };
  // The digest fields are only meaningful together; a partial set is dropped so the
  // file is simply re-verified rather than trusted on half a record.
  if (typeof bytes === 'number' && Number.isFinite(bytes) && typeof mtimeMs === 'number' && Number.isFinite(mtimeMs)
    && typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256)) {
    entry.bytes = bytes;
    entry.mtimeMs = mtimeMs;
    entry.sha256 = sha256;
  }
  return entry;
}

function parseManifestObject(value: unknown): ArchiveManifestObject | null {
  if (!isRecord(value)) return null;
  const { objectId, firstArchivedAt, lastArchivedAt, files } = value;
  if (typeof firstArchivedAt !== 'string' || firstArchivedAt.length === 0) return null;
  if (typeof lastArchivedAt !== 'string' || lastArchivedAt.length === 0) return null;
  if (!Array.isArray(files)) return null;
  const parsed: ArchiveManifestFile[] = [];
  for (const file of files) {
    const entry = parseManifestFile(file);
    if (!entry) return null;
    parsed.push(entry);
  }
  return { objectId: typeof objectId === 'string' ? objectId : '', firstArchivedAt, lastArchivedAt, files: parsed };
}

/** Parse manifest text, or null when it is not a manifest we fully understand. */
function parseManifestText(text: string): ArchiveManifest | null {
  const parsed = parseJsonRecord(text);
  if (!parsed || !READABLE_VERSIONS.includes(parsed.version)) return null;
  if (!isRecord(parsed.objects)) return null;

  const objects: Record<string, ArchiveManifestObject> = {};
  for (const [folderName, value] of Object.entries(parsed.objects)) {
    const entry = parseManifestObject(value);
    if (!entry) return null;
    objects[folderName] = entry;
  }

  return {
    version: MANIFEST_VERSION,
    ...(typeof parsed.archiveId === 'string' && parsed.archiveId !== '' ? { archiveId: parsed.archiveId } : {}),
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    objects,
  };
}

/** One rolling copy of the last manifest that read cleanly, written just before
 *  each replace. */
export const ARCHIVE_MANIFEST_BACKUP_FILENAME = `${ARCHIVE_MANIFEST_FILENAME}.bak`;
const ARCHIVE_MANIFEST_TMP_FILENAME = `${ARCHIVE_MANIFEST_FILENAME}.tmp`;

/**
 * What reading the manifest found. The three outcomes need three different
 * responses, which a bare "empty manifest" fallback cannot express:
 *
 *   - `absent`: no record yet. A new archive, so a run may start one.
 *   - `unreadable`: a record exists and cannot be trusted (truncated, invalid, or
 *     the disk would not read it). Nothing may write over it, because replacing it
 *     with a fresh one erases the only account of what is on the disk.
 *   - `ok`: `fromBackup` says the main file was bad and the rolling backup was used.
 */
export type ArchiveManifestRead =
  | { status: 'ok'; manifest: ArchiveManifest; fromBackup: boolean }
  | { status: 'absent' }
  | { status: 'unreadable'; reason: string };

export function readArchiveManifestResult(root: string, expectedArchiveId?: string): ArchiveManifestRead {
  /** A record that names another archive is history this install did not make. */
  const foreign = (manifest: ArchiveManifest): boolean =>
    expectedArchiveId !== undefined && expectedArchiveId !== '' && manifest.archiveId !== undefined && manifest.archiveId !== expectedArchiveId;
  const FOREIGN_REASON = 'the archive record on this disk belongs to a different archive';

  let reason: string;
  try {
    const text = fs.readFileSync(path.join(root, ARCHIVE_MANIFEST_FILENAME), 'utf8');
    const manifest = parseManifestText(text);
    if (manifest) {
      // The backup is not consulted for this: it describes the same disk.
      if (foreign(manifest)) return { status: 'unreadable', reason: FOREIGN_REASON };
      return { status: 'ok', manifest, fromBackup: false };
    }
    reason = 'the archive record is not valid';
  } catch (err) {
    if (isRecord(err) && err.code === 'ENOENT') return { status: 'absent' };
    reason = err instanceof Error ? err.message : 'the archive record could not be read';
  }

  try {
    const manifest = parseManifestText(fs.readFileSync(path.join(root, ARCHIVE_MANIFEST_BACKUP_FILENAME), 'utf8'));
    if (manifest) {
      if (foreign(manifest)) return { status: 'unreadable', reason: FOREIGN_REASON };
      return { status: 'ok', manifest, fromBackup: true };
    }
  } catch {
    // No usable backup either. The reason above is the one worth reporting.
  }
  return { status: 'unreadable', reason };
}

/**
 * Read the manifest, or an empty one.
 *
 * This is the fail-closed reader for retention, restore and local removal: a
 * record we cannot fully understand is not one we can safely delete from, and an
 * empty one deletes nothing. Anything that *writes* the manifest must use
 * `readArchiveManifestResult` instead, because "empty" here also covers "damaged".
 */
export function readArchiveManifest(root: string, expectedArchiveId?: string): ArchiveManifest {
  const result = readArchiveManifestResult(root, expectedArchiveId);
  return result.status === 'ok' ? result.manifest : EMPTY_ARCHIVE_MANIFEST;
}

/**
 * Write the manifest into the archive root, atomically.
 *
 * The new record goes to a temporary file, is flushed to the disk, and is renamed
 * over the old one, so a crash or a pulled disk leaves either the old record or the
 * new one and never half of one. The previous record is copied to the rolling
 * backup first, but only when it parses: a damaged file must never replace the last
 * good backup.
 *
 * Contained through `resolveContainedArchivePath`, so even a caller holding a
 * hand-built root cannot have this write outside it. The root must already exist;
 * creating directory trees implicitly is how a typo in a destination turns into a
 * tree somewhere unexpected.
 */
export function writeArchiveManifest(root: string, manifest: ArchiveManifest): void {
  const target = resolveContainedArchivePath(root, ARCHIVE_MANIFEST_FILENAME);
  const tmp = resolveContainedArchivePath(root, ARCHIVE_MANIFEST_TMP_FILENAME);
  const backup = resolveContainedArchivePath(root, ARCHIVE_MANIFEST_BACKUP_FILENAME);
  if (target === null || tmp === null || backup === null) {
    throw new Error('Refusing to write the archive manifest outside the archive root.');
  }

  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, `${JSON.stringify(manifest, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    try {
      if (parseManifestText(fs.readFileSync(target, 'utf8'))) fs.copyFileSync(target, backup);
    } catch {
      // No current record, or one that is unreadable. Nothing worth backing up.
    }

    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Never created, or already gone.
    }
    throw err;
  }
}

/**
 * Fold one run's successfully archived files into the record.
 *
 * `firstArchivedAt` is set once and never moved: it is what answers how long an
 * object has been on the disk. `lastArchivedAt` advances on every run that
 * touches the object, which is what retention ages from, so an object still
 * receiving new captures is not pruned out from under an active project.
 *
 * Both clocks restart when the folder's recorded `objectId` is not the object
 * being archived. A folder name can be reused by a different object (delete, then
 * re-import), and inheriting the old object's `lastArchivedAt` would hand the new
 * one to retention as already expired. Files recorded by the previous occupant are
 * kept in the list, because they are still physically on the disk and retention is
 * the only thing that would ever remove them, but they age with the folder.
 *
 * Two *different* live objects whose folder names collide cannot happen through
 * `getLibraryObjectNames` (folder names are unique per object), and if a manifest
 * somehow held one, the id mismatch would restart the clock on every run and
 * retention would never prune it. That is the direction to fail in.
 *
 * Only files that actually landed are passed in, so a run with failures cannot
 * leave the record claiming files that are not on the disk.
 */
export function mergeArchiveRun(
  manifest: ArchiveManifest,
  candidates: ArchiveCandidate[],
  nowIso: string,
): ArchiveManifest {
  const objects: Record<string, ArchiveManifestObject> = { ...manifest.objects };

  const byFolder = new Map<string, { objectId: string; files: ArchiveManifestFile[] }>();
  for (const candidate of candidates) {
    const entry = byFolder.get(candidate.folderName) ?? { objectId: candidate.objectId, files: [] };
    const file: ArchiveManifestFile = { relPath: candidate.relPath, isSubframe: candidate.role === 'sub' };
    if (candidate.sha256 !== undefined) {
      file.bytes = candidate.bytes;
      file.mtimeMs = candidate.mtimeMs;
      file.sha256 = candidate.sha256;
    }
    entry.files.push(file);
    byFolder.set(candidate.folderName, entry);
  }

  for (const [folderName, incoming] of byFolder) {
    const existing = objects[folderName];
    const sameObject = existing !== undefined && existing.objectId !== '' && existing.objectId === incoming.objectId;
    const merged = new Map<string, ArchiveManifestFile>();
    for (const file of existing?.files ?? []) merged.set(file.relPath, file);
    for (const file of incoming.files) merged.set(file.relPath, file);
    objects[folderName] = {
      objectId: incoming.objectId,
      firstArchivedAt: sameObject ? existing.firstArchivedAt : nowIso,
      lastArchivedAt: nowIso,
      files: [...merged.values()].sort((a, b) => a.relPath.localeCompare(b.relPath)),
    };
  }

  return { version: MANIFEST_VERSION, ...(manifest.archiveId ? { archiveId: manifest.archiveId } : {}), updatedAt: nowIso, objects };
}

/**
 * Set aside the record of a disk that is being adopted from another install, so the
 * new owner starts with an empty one.
 *
 * The files stay where they are. They are simply not in this install's record, which
 * means retention can never prune them and local removal can never rely on them:
 * the safe direction for history nobody here made. The old record is renamed rather
 * than deleted, so it can be inspected or moved back by hand.
 */
export function retireArchiveManifest(root: string): boolean {
  let moved = false;
  for (const name of [ARCHIVE_MANIFEST_FILENAME, ARCHIVE_MANIFEST_BACKUP_FILENAME]) {
    const from = resolveContainedArchivePath(root, name);
    const to = resolveContainedArchivePath(root, `${name}.previous`);
    if (from === null || to === null) continue;
    try {
      fs.renameSync(from, to);
      moved = true;
    } catch {
      // Not there. Nothing to set aside.
    }
  }
  return moved;
}
