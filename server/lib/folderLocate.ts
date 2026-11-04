/**
 * Suggests where a dropped folder lives on the server's own disk.
 *
 * The browser can never reveal where a dragged folder lives (the File API
 * strips absolute paths by design), so the import modal sends what it does
 * know: the top-level folder name plus a sample of relative file paths and
 * exact byte sizes. If a directory with that name exists on this machine and
 * every sampled file inside it matches by name and size, the drop almost
 * certainly came from that directory, and the import can read it in place
 * instead of streaming the same bytes through an upload.
 *
 * This is a *hint*, never a requirement. The folder browser is what makes an
 * in-place import always possible, so the search is built to be cheap and
 * bounded, not exhaustive:
 *   - it reads folder names only, never file listings of the whole disk;
 *   - it is shallow (MAX_DEPTH levels below each root), because import data
 *     lives at `E:\Astro\2025\M31`, not eight levels down;
 *   - every root (home, each drive) is searched in parallel with its own
 *     directory budget, so one huge drive or dead NAS mount cannot starve the
 *     others;
 *   - the whole request has a hard deadline, and every filesystem call is
 *     individually timed out (a mounted-but-dead share can block for many
 *     seconds).
 * A miss simply means the caller shows the folder browser, so it is never an
 * error and the cost of a miss is one extra click, never a wait.
 */
import fsp from 'fs/promises';
import type { Dirent } from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { listVolumes } from './volumes.js';

const execFileAsync = promisify(execFile);

export interface LocateSample {
  relativePath: string;
  size: number;
}

const DEADLINE_MS = 1_500;
/** Levels searched below each root. Root children are depth 1. */
const MAX_DEPTH = 5;
/** Directory listings allowed per root, so one huge drive cannot run away. */
const ROOT_MAX_DIRS = 4_000;
const BATCH = 16;
const FS_CALL_TIMEOUT_MS = 400;
const DRIVE_PROBE_TIMEOUT_MS = 300;
const SPOTLIGHT_TIMEOUT_MS = 800;

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
    fsp.readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []),
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

/**
 * Windows drive roots, found by probing each letter instead of asking
 * PowerShell. Spawning PowerShell + CIM takes 1-3 s cold, which is longer than
 * this whole search is allowed to run, so it used to return no drives at all.
 * Probing A:..Z: in parallel with a short timeout takes milliseconds.
 */
async function windowsDriveRoots(): Promise<string[]> {
  const letters = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
  const found = await Promise.all(letters.map(async letter => {
    const root = `${letter}:\\`;
    const ok = await withTimeout(
      fsp.access(root).then(() => true).catch(() => false), DRIVE_PROBE_TIMEOUT_MS, false);
    return ok ? root : null;
  }));
  return found.filter((r): r is string => r !== null);
}

async function macVolumeRoots(): Promise<string[]> {
  const vols = await withTimeout(listVolumes().catch(() => []), FS_CALL_TIMEOUT_MS * 2, []);
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

async function searchRoots(): Promise<string[]> {
  const roots = [os.homedir()];
  if (process.platform === 'win32') roots.push(...await windowsDriveRoots());
  else if (process.platform === 'darwin') roots.push('/Users/Shared', ...await macVolumeRoots());
  else roots.push(...(await withTimeout(listVolumes().catch(() => []), FS_CALL_TIMEOUT_MS * 2, [])).map(v => v.path));
  // Extra roots for tests and unusual setups: a folder deeper than MAX_DEPTH under home is only findable through Spotlight,
  // which lags behind folders created a moment ago.
  roots.push(...(process.env.NEBULIS_LOCATE_EXTRA_ROOTS ?? '').split(path.delimiter).filter(Boolean));
  return [...new Set(roots)];
}

/**
 * macOS only: Spotlight answers "where is a folder called X" from its index in
 * milliseconds on a drive of any size. Non-indexed volumes (many USB drives and
 * NAS mounts) return nothing, which is fine: this only ever adds candidates.
 */
async function spotlightCandidates(anchorName: string): Promise<string[]> {
  if (process.platform !== 'darwin') return [];
  try {
    const { stdout } = await execFileAsync(
      'mdfind',
      ['-name', anchorName],
      { timeout: SPOTLIGHT_TIMEOUT_MS },
    );
    return stdout.split('\n')
      .filter(line => line && path.basename(line).toLowerCase() === anchorName.toLowerCase());
  } catch {
    return [];
  }
}

interface SearchState {
  deadline: number;
  /** Set once any root has a verified match, so the other roots stop early. */
  done: boolean;
}

async function walkRoot(
  root: string,
  state: SearchState,
  anchorLower: string,
  pathsIncludeAnchor: boolean,
  samples: LocateSample[],
): Promise<string | null> {
  let queue: string[] = [root];
  let visited = 0;
  for (let depth = 1; depth <= MAX_DEPTH && queue.length > 0; depth++) {
    const next: string[] = [];
    while (queue.length > 0) {
      if (state.done || Date.now() > state.deadline || visited >= ROOT_MAX_DIRS) return null;
      const batch = queue.splice(0, BATCH);
      visited += batch.length;
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
          next.push(full);
        }
      }
    }
    queue = next;
  }
  return null;
}

/**
 * Search the given roots in parallel and return the first verified match.
 * Exported so tests can point it at temp directories.
 */
export async function locateFolderInRoots(
  roots: string[],
  anchorName: string,
  samples: LocateSample[],
  deadlineMs: number = DEADLINE_MS,
): Promise<string | null> {
  if (!validateLocateInput(anchorName, samples)) return null;
  const anchorLower = anchorName.toLowerCase();
  const pathsIncludeAnchor = samples[0].relativePath.split('/')[0] === anchorName;
  const state: SearchState = { deadline: Date.now() + deadlineMs, done: false };

  const attempts = roots.map(root =>
    walkRoot(root, state, anchorLower, pathsIncludeAnchor, samples)
      .catch((): null => null)
      .then(hit => {
        if (hit) state.done = true;
        return hit;
      }));

  // Resolve on the first hit rather than waiting for the slowest root.
  return new Promise<string | null>(resolve => {
    let pending = attempts.length;
    if (pending === 0) resolve(null);
    for (const attempt of attempts) {
      void attempt.then(hit => {
        if (hit) resolve(hit);
        else if (--pending === 0) resolve(null);
      });
    }
  });
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

  const pathsIncludeAnchor = samples[0].relativePath.split('/')[0] === anchorName;
  // Spotlight hits are checked first: they are exact and instant.
  for (const candidate of await spotlightCandidates(anchorName)) {
    const scanRoot = pathsIncludeAnchor ? path.dirname(candidate) : candidate;
    if (await verifySamples(scanRoot, samples)) return scanRoot;
  }
  return locateFolderInRoots(await searchRoots(), anchorName, samples);
}
