/**
 * Moves the library (imported images, FITS, sub-frames) to a new directory,
 * usually on a USB or external drive.
 *
 * Safety rules, in order:
 *   1. Validate the target (writable, distinct from source, not nested, enough
 *      free space, not already holding a different Nebulis library).
 *   2. Lock the library so nothing writes during the copy (isLibraryMigrating).
 *   3. Copy every file old → new. The source is NEVER modified or deleted.
 *   4. Verify the copy (file count + total bytes match).
 *   5. Only then write the marker at the new location and flip the configured
 *      path. If any step before this fails, the old location stays live.
 *
 * The old copy is left in place. The caller tells the user to verify the new
 * location and remove the old copy themselves; this module never deletes it.
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { log } from './logger.js';
import {
  getLibraryDir,
  getDefaultLibraryDir,
  getLibraryId,
  setLibraryPath,
  writeMarker,
  readMarker,
  MARKER_FILENAME,
} from './libraryPath.js';
import { setLibraryMigrating } from './libraryMaintenance.js';

export type MigrationPhase =
  | 'idle'
  | 'validating'
  | 'copying'
  | 'verifying'
  | 'finalizing'
  | 'complete'
  | 'error';

export interface MigrationStatus {
  phase: MigrationPhase;
  fromPath: string | null;
  toPath: string | null;
  bytesTotal: number;
  bytesCopied: number;
  filesTotal: number;
  filesCopied: number;
  error: string | null;
  startedAt: number | null;
  completedAt: number | null;
  /** After success: the old location the user should verify, then delete. */
  previousPath: string | null;
}

const status: MigrationStatus = {
  phase: 'idle',
  fromPath: null,
  toPath: null,
  bytesTotal: 0,
  bytesCopied: 0,
  filesTotal: 0,
  filesCopied: 0,
  error: null,
  startedAt: null,
  completedAt: null,
  previousPath: null,
};

export function getMigrationStatus(): MigrationStatus {
  return { ...status };
}

function isActivePhase(p: MigrationPhase): boolean {
  return p === 'validating' || p === 'copying' || p === 'verifying' || p === 'finalizing';
}

class MigrationError extends Error {}

/** Bytes available to an unprivileged process on the volume holding `dir`. */
function freeBytesAt(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bsize) * Number(s.bavail);
  } catch {
    return null;
  }
}

interface TreeStats {
  bytes: number;
  files: number;
}

/** Recursively total the bytes and file count under a directory, skipping the
 *  marker file (it is regenerated at the destination, not copied). */
async function measureTree(dir: string): Promise<TreeStats> {
  let bytes = 0;
  let files = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return { bytes, files };
  }
  for (const entry of entries) {
    if (entry.name === MARKER_FILENAME) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await measureTree(full);
      bytes += sub.bytes;
      files += sub.files;
    } else if (entry.isFile()) {
      try {
        bytes += (await fsp.stat(full)).size;
        files += 1;
      } catch {
        /* skip unreadable file */
      }
    }
  }
  return { bytes, files };
}

/** Copy a directory tree, updating progress counters as it goes. The marker
 *  file is skipped; a fresh one is written at finalize. */
async function copyTree(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  // Source may not exist yet (e.g. relocating during onboarding before any
  // import). Treat a missing source as empty.
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(src, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === MARKER_FILENAME) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyTree(from, to);
    } else if (entry.isFile()) {
      await fsp.copyFile(from, to);
      try {
        status.bytesCopied += (await fsp.stat(to)).size;
      } catch {
        /* progress only */
      }
      status.filesCopied += 1;
    }
  }
}

/** True when `child` is the same as or nested inside `parent`. */
function isSameOrInside(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}

async function validate(source: string, target: string): Promise<void> {
  if (!path.isAbsolute(target)) {
    throw new MigrationError('Choose an absolute path for the new location.');
  }
  const resolvedTarget = path.resolve(target);
  const resolvedSource = path.resolve(source);

  if (resolvedTarget === resolvedSource) {
    throw new MigrationError('The new location is the same as the current one.');
  }
  if (isSameOrInside(resolvedTarget, resolvedSource) || isSameOrInside(resolvedSource, resolvedTarget)) {
    throw new MigrationError('The new location cannot be inside the current library, or contain it.');
  }

  // The parent must already exist. We never create a mount point: on macOS,
  // making /Volumes/X for an unmounted drive would write to the boot disk.
  const parent = path.dirname(resolvedTarget);
  if (!fs.existsSync(parent)) {
    throw new MigrationError(`The drive or folder for ${resolvedTarget} is not available. Connect it and try again.`);
  }

  // Target may be absent, empty, or already hold OUR library (a resumed move).
  // A folder with a different Nebulis marker, or any other files, is refused so
  // we never merge two libraries or overwrite unrelated data.
  if (fs.existsSync(resolvedTarget)) {
    const marker = readMarker(resolvedTarget);
    if (marker && marker.libraryId !== getLibraryId()) {
      throw new MigrationError('That folder already holds a different Nebulis library. Pick an empty folder.');
    }
    if (!marker) {
      const existing = (await fsp.readdir(resolvedTarget)).filter(n => n !== MARKER_FILENAME);
      if (existing.length > 0) {
        throw new MigrationError('That folder is not empty. Pick an empty folder or a new one.');
      }
    }
  }

  const sourceSize = (await measureTree(resolvedSource)).bytes;
  const free = freeBytesAt(parent);
  if (free !== null && free < sourceSize) {
    const gb = (n: number) => (n / 1024 ** 3).toFixed(2);
    throw new MigrationError(
      `Not enough free space. The library needs ${gb(sourceSize)} GB but only ${gb(free)} GB is free.`,
    );
  }
}

async function run(source: string, target: string): Promise<void> {
  try {
    status.phase = 'validating';
    await validate(source, target);

    const measured = await measureTree(source);
    status.bytesTotal = measured.bytes;
    status.filesTotal = measured.files;
    status.bytesCopied = 0;
    status.filesCopied = 0;

    setLibraryMigrating(true);

    status.phase = 'copying';
    await copyTree(source, target);

    status.phase = 'verifying';
    const copied = await measureTree(target);
    if (copied.files !== measured.files || copied.bytes !== measured.bytes) {
      throw new MigrationError(
        `Verification failed: copied ${copied.files} files (${copied.bytes} bytes), expected ${measured.files} (${measured.bytes}). The original library was not changed.`,
      );
    }

    status.phase = 'finalizing';
    writeMarker(target, getLibraryId());
    // An empty configured path means "default location"; store '' when the
    // target IS the default so resolution stays clean.
    const isDefaultTarget = path.resolve(target) === path.resolve(getDefaultLibraryDir());
    setLibraryPath(isDefaultTarget ? '' : target);

    status.previousPath = source;
    status.completedAt = Date.now();
    status.phase = 'complete';
    log.info({ from: source, to: target, files: copied.files, bytes: copied.bytes }, 'library migration complete');
  } catch (err) {
    status.error = err instanceof Error ? err.message : 'Migration failed.';
    status.phase = 'error';
    log.error({ from: source, to: target, err: status.error }, 'library migration failed');
    // Old location stays live (path was never flipped). Partial copy at the
    // target is harmless and can be removed or overwritten on retry.
  } finally {
    setLibraryMigrating(false);
  }
}

/**
 * Begin a migration to `target`. Returns immediately; poll getMigrationStatus()
 * for progress. Single-flight: throws if a migration is already running.
 */
export function startMigration(target: string): MigrationStatus {
  if (isActivePhase(status.phase)) {
    throw new MigrationError('A migration is already in progress.');
  }
  const source = getLibraryDir();

  // Reset status for the new run.
  status.phase = 'validating';
  status.fromPath = source;
  status.toPath = path.resolve(target);
  status.bytesTotal = 0;
  status.bytesCopied = 0;
  status.filesTotal = 0;
  status.filesCopied = 0;
  status.error = null;
  status.startedAt = Date.now();
  status.completedAt = null;
  status.previousPath = null;

  // Fire and forget; progress is observed via getMigrationStatus().
  void run(source, status.toPath);
  return getMigrationStatus();
}
