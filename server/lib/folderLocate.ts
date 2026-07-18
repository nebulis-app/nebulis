/**
 * Finds a dropped folder on the server's own disk by content fingerprint.
 *
 * The browser can never reveal where a dragged folder lives (the File API
 * strips absolute paths by design), so the import modal sends what it does
 * know: the top-level folder name plus a sample of relative file paths and
 * exact byte sizes. If a directory with that name exists on this machine and
 * every sampled file inside it matches by name and size, the drop almost
 * certainly came from that directory, and the import can read it in place
 * instead of streaming the same bytes through an upload.
 *
 * Best-effort by construction: a bounded breadth-first walk with a hard
 * deadline. Local roots (home directory) are walked to completion first;
 * mounted volumes only get whatever budget remains, and every filesystem call
 * is individually timed out, because a mounted-but-dead network share (e.g. a
 * telescope SMB mount after the telescope powered off) can block stat/readdir
 * for many seconds. Returning null just means the caller falls back to a
 * normal upload, so a miss is never an error.
 */
import fsp from 'fs/promises';
import type { Dirent } from 'fs';
import path from 'path';
import os from 'os';
import { listVolumes } from './volumes.js';

export interface LocateSample {
  relativePath: string;
  size: number;
}

const DEADLINE_MS = 2_500;
const MAX_DIRS = 20_000;
const BATCH = 16;
const FS_CALL_TIMEOUT_MS = 400;
const VOLUME_LIST_TIMEOUT_MS = 600;

// Directory names that are never a sensible import source and are often huge.
const SKIP_DIRS = new Set([
  'node_modules', 'library', 'applications', 'system',
  'windows', 'program files', 'program files (x86)', 'programdata',
  'appdata', '$recycle.bin', 'system volume information',
]);

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>(resolve => {
      const t = setTimeout(() => resolve(fallback), ms);
      // Don't let a pending timer hold the process open.
      if (typeof t.unref === 'function') t.unref();
    }),
  ]);
}

function isSafeRelativePath(rel: string): boolean {
  if (!rel || rel.includes('\\') || rel.startsWith('/')) return false;
  return rel.split('/').every(seg => seg !== '' && seg !== '.' && seg !== '..');
}

export function validateLocateInput(anchorName: string, samples: LocateSample[]): boolean {
  if (!anchorName || anchorName.includes('/') || anchorName.includes('\\')
    || anchorName === '.' || anchorName === '..') return false;
  if (samples.length === 0 || samples.length > 64) return false;
  return samples.every(s =>
    isSafeRelativePath(s.relativePath) && Number.isFinite(s.size) && s.size >= 0);
}

function readdirSafe(dir: string): Promise<Dirent[]> {
  return withTimeout(
    fsp.readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[]),
    FS_CALL_TIMEOUT_MS,
    [],
  );
}

/** Every sampled file must exist under base with the exact byte size. */
async function verifySamples(base: string, samples: LocateSample[]): Promise<boolean> {
  for (let i = 0; i < samples.length; i += BATCH) {
    const batch = samples.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(s =>
      withTimeout(
        fsp.stat(path.join(base, s.relativePath))
          .then(st => st.isFile() && st.size === s.size)
          .catch(() => false),
        FS_CALL_TIMEOUT_MS,
        false,
      )));
    if (!results.every(Boolean)) return false;
  }
  return true;
}

async function volumeRoots(): Promise<string[]> {
  // listVolumes stats every mount; a dead network mount can hang that, so the
  // whole listing gets a budget of its own. No volumes is a fine outcome.
  const vols = await withTimeout(listVolumes().catch(() => []), VOLUME_LIST_TIMEOUT_MS, []);
  const roots: string[] = [];
  for (const v of vols) {
    // The boot volume appears under /Volumes as a symlink to '/'. Walking it
    // would mean walking the whole system tree; the home-dir root already
    // covers where user files on the boot volume realistically live.
    const real = await withTimeout(
      fsp.realpath(v.path).catch(() => null), FS_CALL_TIMEOUT_MS, null);
    if (real === null || real === '/' || real === os.homedir()) continue;
    roots.push(v.path);
  }
  return roots;
}

interface WalkState {
  visited: number;
  deadline: number;
}

async function walk(
  roots: string[],
  state: WalkState,
  anchorLower: string,
  pathsIncludeAnchor: boolean,
  samples: LocateSample[],
): Promise<string | null> {
  const queue = [...roots];
  while (queue.length > 0) {
    if (Date.now() > state.deadline || state.visited >= MAX_DIRS) return null;
    const batch = queue.splice(0, BATCH);
    state.visited += batch.length;

    const listings = await Promise.all(
      batch.map(async dir => ({ dir, entries: await readdirSafe(dir) })));

    for (const { dir, entries } of listings) {
      for (const entry of entries) {
        // withFileTypes reflects lstat, so symlinked directories report as
        // symlinks (not directories) and are skipped here: no cycles, no
        // re-walking whole volumes through an alias.
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        if (name.startsWith('.') || SKIP_DIRS.has(name.toLowerCase())) continue;
        const full = path.join(dir, name);

        if (name.toLowerCase() === anchorLower) {
          const scanRoot = pathsIncludeAnchor ? dir : full;
          if (await verifySamples(scanRoot, samples)) return scanRoot;
        }
        queue.push(full);
      }
    }
  }
  return null;
}

/**
 * Returns the absolute path that should be used as the import scan root, or
 * null when no confidently matching directory is found in time.
 *
 * The sample paths are the ones the client would upload. When they start with
 * `anchorName` the scan root is the *parent* of the matched directory (the
 * client kept the folder name so the server can catalog-match it); otherwise
 * the matched directory itself is the root.
 */
export async function locateFolderOnDisk(
  anchorName: string,
  samples: LocateSample[],
): Promise<string | null> {
  if (!validateLocateInput(anchorName, samples)) return null;

  const anchorLower = anchorName.toLowerCase();
  const pathsIncludeAnchor = samples[0].relativePath.split('/')[0] === anchorName;
  const state: WalkState = { visited: 0, deadline: Date.now() + DEADLINE_MS };

  // Local roots first, to completion: they are fast and cover the common case.
  const localRoots = [os.homedir()];
  if (process.platform === 'darwin') localRoots.push('/Users/Shared');
  const localHit = await walk(localRoots, state, anchorLower, pathsIncludeAnchor, samples);
  if (localHit) return localHit;

  // Mounted volumes get the remaining budget only. A slow network mount can
  // burn it, but each fs call is capped so it degrades to fewer dirs searched,
  // never a hung request.
  if (Date.now() > state.deadline || state.visited >= MAX_DIRS) return null;
  return walk(await volumeRoots(), state, anchorLower, pathsIncludeAnchor, samples);
}
