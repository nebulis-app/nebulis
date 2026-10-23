/**
 * Proof, during a run, that the archive disk is still the disk the run started on.
 *
 * The readiness check (`ensureArchiveDestinationReady`) answers that question once, before a run. A run
 * lasts minutes to hours, and a disk can be pulled, a share can drop, a host mount can go stale at any
 * point in it. On macOS and Windows the mount point usually disappears with the disk, so the next write
 * fails. On Linux and in Docker it does not: the mount point is an ordinary folder that outlives the mount,
 * so writing into it works, and the run carried on for every remaining file, filling the app's own disk
 * with a stray, unmarked "archive" that the disk would hide when plugged back in, and then reported success.
 *
 * Two rules stop that, and both live here so no write path can forget them:
 *
 *   1. **The archive root is never created by a run.** It must already exist. Only folders below it are
 *      made (`mkdirBelowRoot`). A missing root is a disconnected disk, not something to build.
 *   2. **The disk is re-proven around every write** (`assertPresent`): the root still exists, still sits on
 *      the same device it started on (a mount change flips the device id, even when the marker looks right),
 *      and still carries this install's marker.
 *
 * Restore does not use this. It writes into the library, whose own availability checks are separate.
 */

import fsp from 'fs/promises';
import path from 'path';

import { readArchiveMarker } from './archiveMarker.js';
import { errnoCode } from '../errors.js';

/** The archive disk is no longer the one the run started on. Carries a message fit to show the user. */
export class DiskGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiskGoneError';
  }
}

export const DISK_LOST_MESSAGE =
  'The archive disk was disconnected during the run. Files already copied are safe. Reconnect the disk and run the archive again.';

export interface DiskGuard {
  readonly root: string;
  /** Throws `DiskGoneError` unless the root is still the disk this run started on. */
  assertPresent(): Promise<void>;
  /**
   * Create the folders from the root down to `dir`, never the root itself, and return the ones this call
   * created (outermost first) so a failed write can take them away again. Throws `DiskGoneError` when the
   * root is missing.
   */
  mkdirBelowRoot(dir: string): Promise<string[]>;
}

export async function createDiskGuard(root: string, archiveId: string): Promise<DiskGuard> {
  let startDev: number;
  try {
    const stat = await fsp.stat(root);
    if (!stat.isDirectory()) throw new Error('not a directory');
    startDev = stat.dev;
  } catch {
    throw new DiskGoneError('The archive folder is not there.');
  }

  const assertPresent = async (): Promise<void> => {
    let stat: Awaited<ReturnType<typeof fsp.stat>>;
    try {
      stat = await fsp.stat(root);
    } catch {
      throw new DiskGoneError(DISK_LOST_MESSAGE);
    }
    if (!stat.isDirectory() || stat.dev !== startDev) throw new DiskGoneError(DISK_LOST_MESSAGE);
    // Small enough to read on every file, and the only check that also catches a disk that was swapped or wiped.
    if (readArchiveMarker(root, archiveId).state !== 'match') throw new DiskGoneError(DISK_LOST_MESSAGE);
  };

  const mkdirBelowRoot = async (dir: string): Promise<string[]> => {
    const relative = path.relative(root, dir);
    if (relative === '') return [];
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Refusing to create a folder outside the archive root.');
    }
    const created: string[] = [];
    let current = root;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      try {
        // Not recursive: with `recursive: true` a missing root is quietly rebuilt on whatever disk is there.
        await fsp.mkdir(current);
        created.push(current);
      } catch (err) {
        const code = errnoCode(err);
        if (code === 'EEXIST') continue;
        if (code === 'ENOENT') throw new DiskGoneError(DISK_LOST_MESSAGE);
        throw err;
      }
    }
    return created;
  };

  return { root, assertPresent, mkdirBelowRoot };
}
