/**
 * Library — import staging area.
 *
 * The folder-import wizard's upload step reconstructs the user's folder tree
 * under `{DATA_DIR}/import-tmp/<uuid>` before anything is imported, so a large
 * import transiently needs room for a second copy of every file. That temp
 * area lives on DATA_DIR's volume (the system drive on Windows) no matter
 * where the library itself points, which is how a 125 GB import filled a boot
 * disk that had plenty of room on the library drive.
 *
 * This module owns the staging path and everything that guards it: usage
 * reporting, purging, and the free-space preflight both the upload and the
 * commit run before they write. It deliberately depends on nothing but
 * `paths.ts` so it can be imported from routes, housekeeping, and the import
 * pipeline without a cycle.
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../paths.js';

export const IMPORT_TMP_BASE = path.join(DATA_DIR, 'import-tmp');

/** Upload session ids are UUIDs; anything else is not ours to touch. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidTmpId(id: string): boolean {
  return UUID_RE.test(id);
}

/**
 * True when `p` resolves to the staging base or something inside it.
 *
 * Both sides are resolved first: the caller's path is client-supplied, and a
 * literal-prefix startsWith on an unresolved path can be defeated by a `../`
 * segment that still textually starts with the base.
 */
export function isStagedPath(p: string): boolean {
  const resolved = path.resolve(p);
  return resolved === IMPORT_TMP_BASE || resolved.startsWith(IMPORT_TMP_BASE + path.sep);
}

function dirSize(dir: string): { bytes: number; files: number } {
  let bytes = 0, files = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { bytes, files };
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = dirSize(full);
      bytes += sub.bytes; files += sub.files;
    } else if (e.isFile()) {
      try { bytes += fs.statSync(full).size; } catch { /* skip */ }
      files++;
    }
  }
  return { bytes, files };
}

export interface ImportTmpUsage {
  path: string;
  /** Total bytes currently staged across all sessions. */
  bytes: number;
  files: number;
  /** Number of upload-session directories present. */
  sessions: number;
  /** ISO timestamp of the oldest session, or null when the area is empty. */
  oldestAt: string | null;
}

export function getImportTmpUsage(): ImportTmpUsage {
  const empty: ImportTmpUsage = { path: IMPORT_TMP_BASE, bytes: 0, files: 0, sessions: 0, oldestAt: null };
  if (!fs.existsSync(IMPORT_TMP_BASE)) return empty;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(IMPORT_TMP_BASE, { withFileTypes: true });
  } catch {
    return empty;
  }

  let bytes = 0, files = 0, sessions = 0;
  let oldestMs: number | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(IMPORT_TMP_BASE, entry.name);
    sessions++;
    const stats = dirSize(dirPath);
    bytes += stats.bytes;
    files += stats.files;
    try {
      const { mtimeMs } = fs.statSync(dirPath);
      if (oldestMs === null || mtimeMs < oldestMs) oldestMs = mtimeMs;
    } catch { /* unreadable; still counted as a session */ }
  }

  return {
    path: IMPORT_TMP_BASE,
    bytes,
    files,
    sessions,
    oldestAt: oldestMs === null ? null : new Date(oldestMs).toISOString(),
  };
}

export interface PurgeResult {
  deleted: number;
  errors: number;
  bytes: number;
  /** Sessions left alone because they were touched inside `minAgeMs`. */
  skippedActive: number;
}

/**
 * Delete staged upload sessions older than `minAgeMs`.
 *
 * The age floor is what keeps this from deleting an upload that is still
 * arriving: each batch writes into its session dir, which refreshes the dir's
 * mtime. Callers that run unattended (boot, nightly) pass a long age; the
 * manual "clean up" button passes a short one, because the user is looking at
 * the screen and an import that is genuinely running is refused higher up.
 */
export function purgeImportTmp(minAgeMs: number): PurgeResult {
  const result: PurgeResult = { deleted: 0, errors: 0, bytes: 0, skippedActive: 0 };
  if (!fs.existsSync(IMPORT_TMP_BASE)) return result;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(IMPORT_TMP_BASE, { withFileTypes: true });
  } catch {
    return result;
  }

  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(IMPORT_TMP_BASE, entry.name);
    try {
      const { mtimeMs } = fs.statSync(dirPath);
      // Clamped at zero: mtimeMs carries sub-millisecond precision while
      // Date.now() is truncated to whole milliseconds, so a directory written
      // this instant can read as very slightly in the future. Without the
      // clamp that negative age looks younger than any floor, and a purge with
      // a zero floor would skip everything it was asked to delete.
      const ageMs = Math.max(0, now - mtimeMs);
      if (ageMs < minAgeMs) {
        result.skippedActive++;
        continue;
      }
      // Measure before deleting so the caller can report what was reclaimed.
      const { bytes } = dirSize(dirPath);
      fs.rmSync(dirPath, { recursive: true, force: true });
      result.deleted++;
      result.bytes += bytes;
    } catch {
      result.errors++;
    }
  }
  return result;
}

/** Drop one upload session by id. Used when the wizard is dismissed mid-upload
 *  so an abandoned 100 GB staging dir doesn't wait for the sweeper. */
export function purgeImportTmpSession(tmpId: string): { deleted: boolean; bytes: number } {
  if (!isValidTmpId(tmpId)) return { deleted: false, bytes: 0 };
  const dirPath = path.join(IMPORT_TMP_BASE, tmpId);
  if (!fs.existsSync(dirPath)) return { deleted: false, bytes: 0 };
  const { bytes } = dirSize(dirPath);
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
    return { deleted: true, bytes };
  } catch {
    return { deleted: false, bytes: 0 };
  }
}

// ─── Free-space preflight ────────────────────────────────────────────────────

/** Headroom left free on top of whatever an import needs. Filling a disk to
 *  the last byte breaks far more than the import: SQLite's WAL, the logs, and
 *  on Windows the pagefile all need room to keep working. */
const SPACE_MARGIN_BYTES = 512 * 1024 * 1024;

export interface SpaceCheck {
  ok: boolean;
  path: string;
  freeBytes: number;
  requiredBytes: number;
  /** User-facing explanation, set only when `ok` is false. */
  message: string | null;
}

function freeBytesAt(p: string): number | null {
  try {
    const s = fs.statfsSync(p);
    return Number(s.bsize) * Number(s.bavail);
  } catch {
    return null;
  }
}

function gb(bytes: number): string {
  if (bytes < 1024 * 1024 * 1024) return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Check that `dir`'s volume can take `bytes` more data, plus headroom.
 *
 * Returns ok when the volume can't be measured: refusing an import because
 * statfs failed on some unusual filesystem would be worse than letting it try
 * and surface a real ENOSPC.
 */
export function checkFreeSpace(dir: string, bytes: number, label: string): SpaceCheck {
  const required = bytes + SPACE_MARGIN_BYTES;
  const free = freeBytesAt(dir);
  if (free === null) {
    return { ok: true, path: dir, freeBytes: 0, requiredBytes: required, message: null };
  }
  if (free >= required) {
    return { ok: true, path: dir, freeBytes: free, requiredBytes: required, message: null };
  }
  return {
    ok: false,
    path: dir,
    freeBytes: free,
    requiredBytes: required,
    message:
      `Not enough free space ${label}. This needs about ${gb(required)} on ${dir} ` +
      `but only ${gb(free)} is available. Free up space, or move your library to a ` +
      `drive with more room in Settings, Storage.`,
  };
}

/** True when `a` and `b` sit on the same volume, so bytes freed on one are
 *  bytes gained on the other. Assumes different on any stat failure, which is
 *  the conservative direction for a space check. */
export function onSameVolume(a: string, b: string): boolean {
  try {
    return fs.statSync(a).dev === fs.statSync(b).dev;
  } catch {
    return false;
  }
}
