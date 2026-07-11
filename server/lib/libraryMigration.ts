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
  setNetworkLibraryConfig,
  writeMarker,
  readMarker,
  isDefaultLocation,
  isNetworkLocation,
  isLibraryAvailable,
  MARKER_FILENAME,
} from './libraryPath.js';
import { setLibraryMigrating } from './libraryMaintenance.js';
import {
  type NetworkLibraryConfig,
  resolveNetworkLibraryPath,
  ensureNetworkLibraryConnected,
  isNetworkLibraryMounted,
} from './libraryNetwork.js';

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

/**
 * Entries excluded from both the copy and the verification.
 *
 *  - The marker file is regenerated at the destination, not copied.
 *  - macOS writes AppleDouble `._name` sidecars (and `.DS_Store`) onto volumes
 *    that don't support native extended attributes (exFAT/FAT/SMB external
 *    drives). The kernel creates them transparently as we copy, one per file and
 *    per directory, ~4 KB each. They are not part of the library; counting them
 *    made the destination look larger than the source and failed verification.
 *
 * Skipping them on both sides keeps the source and destination counts
 * reconcilable regardless of the destination filesystem.
 */
function isIgnoredName(name: string): boolean {
  return name === MARKER_FILENAME || name === '.DS_Store' || name.startsWith('._');
}

/** Recursively total the bytes and file count under a directory, skipping
 *  ignored entries (marker + OS sidecars). */
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
    if (isIgnoredName(entry.name)) continue;
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

/** Copy a directory tree, updating progress counters as it goes. Ignored
 *  entries (marker + OS sidecars) are skipped; a fresh marker is written at
 *  finalize. */
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
    if (isIgnoredName(entry.name)) continue;
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
      const existing = (await fsp.readdir(resolvedTarget)).filter(n => !isIgnoredName(n));
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

async function run(source: string, target: string, networkConfig?: NetworkLibraryConfig): Promise<void> {
  try {
    status.phase = 'validating';

    // macOS has a single fixed mount point, so connecting a target share would
    // unmount the source share and make the source resolve as empty — a silent
    // zero-file "success" that orphans every database row. Block network→network
    // there; the user can move to a local folder first, then to the new share.
    if (networkConfig && process.platform === 'darwin' && isNetworkLocation()) {
      throw new MigrationError(
        'Moving directly from one network share to another is not supported on macOS. Move the library to a local folder first, then to the new share.',
      );
    }

    // Refuse to migrate away from a relocated source that isn't connected right
    // now: copyTree treats a missing/empty source as empty, which would silently
    // create an empty library at the target and orphan every database row. The
    // default location always exists, so only relocated sources need the guard.
    if (!isDefaultLocation() && !(await isLibraryAvailable())) {
      throw new MigrationError('The current library location is not connected. Reconnect it before moving the library.');
    }

    if (networkConfig) {
      // Connect (or fail fast) before validate() touches the filesystem, so
      // validate/copyTree/measureTree all operate on an already-live path
      // exactly as they do for a local/USB target — no changes needed there.
      // A connect that doesn't actually bring the share up must abort here:
      // otherwise, with an empty subpath, the target resolves to the bare
      // (unmounted) mount point and we would copy the whole library onto the
      // local boot disk and then flip the config to point at it.
      const reachable = await ensureNetworkLibraryConnected(networkConfig);
      if (!reachable || !(await isNetworkLibraryMounted())) {
        throw new MigrationError(
          'Could not connect to the network share. Check that it is online and the address, share name, and credentials are correct, then try again.',
        );
      }
      target = resolveNetworkLibraryPath(networkConfig);
      status.toPath = target;
    }
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
    if (networkConfig) {
      setNetworkLibraryConfig(networkConfig);
    } else {
      // An empty configured path means "default location"; store '' when the
      // target IS the default so resolution stays clean.
      const isDefaultTarget = path.resolve(target) === path.resolve(getDefaultLibraryDir());
      await setLibraryPath(isDefaultTarget ? '' : target);
    }

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
 * Begin a migration to `target` (or, when `networkConfig` is given, to that
 * network share — `target` is then ignored and the real destination is
 * resolved once the share connects, inside run()). Returns immediately; poll
 * getMigrationStatus() for progress. Single-flight: throws if a migration is
 * already running.
 */
export function startMigration(target: string, networkConfig?: NetworkLibraryConfig): MigrationStatus {
  if (isActivePhase(status.phase)) {
    throw new MigrationError('A migration is already in progress.');
  }
  const source = getLibraryDir();

  // Reset status for the new run. The network target isn't known yet (it
  // depends on connecting first) — run() fills in status.toPath once resolved.
  status.phase = 'validating';
  status.fromPath = source;
  status.toPath = networkConfig ? null : path.resolve(target);
  status.bytesTotal = 0;
  status.bytesCopied = 0;
  status.filesTotal = 0;
  status.filesCopied = 0;
  status.error = null;
  status.startedAt = Date.now();
  status.completedAt = null;
  status.previousPath = null;

  // Fire and forget; progress is observed via getMigrationStatus().
  void run(source, networkConfig ? '' : path.resolve(target), networkConfig);
  return getMigrationStatus();
}
