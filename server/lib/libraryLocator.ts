/**
 * Finds the library again when its drive comes back somewhere else.
 *
 * The library lives at a saved path, and a removable drive does not always return to the same one: macOS mounts it as
 * `/Volumes/Drive 1` when a stale `/Volumes/Drive` is still around, Windows can hand the drive a new letter. The
 * marker file (`.nebulis-library.json`) at the library root carries the library's ID, so a folder holding our ID is
 * ours wherever it now sits. This module only searches; `libraryPath.ts` decides what to do with the answer.
 *
 * Two things keep it from reconnecting to the wrong copy. A library that was moved leaves its old folder behind with
 * the same marker, so a folder carrying a "moved" note is never a candidate. And when two folders both claim to be the
 * library it answers nothing, because guessing between them is how a library ends up on two drives.
 *
 * Pure of the filesystem and the OS (both are passed in), so it can be tested against a fixture tree.
 */
import path from 'path';

/** Marks an old library folder that was moved elsewhere; written beside it by the migration. */
export const RETIRED_MARKER_FILENAME = '.nebulis-library-moved.json';

export interface LocatorDeps {
  libraryId: string;
  /** The saved path that no longer holds the library. */
  configuredPath: string;
  /** Roots of the mounted volumes: `/Volumes/X`, `D:\`, `/media/user/X`. */
  volumeRoots: string[];
  /** The library ID in the marker at `dir`, or null when there is no readable marker. */
  readMarkerId: (dir: string) => Promise<string | null>;
  /** True when `dir` carries the note that its library was moved away. */
  isRetired: (dir: string) => Promise<boolean>;
  /** Names of the folders directly inside `dir`. */
  listDirs: (dir: string) => Promise<string[]>;
  platform?: NodeJS.Platform;
  /** Give up looking after this many folders in total, so a big drive cannot stall a request. */
  maxFolders?: number;
}

export type LocateResult =
  | { status: 'found'; dir: string }
  | { status: 'none' }
  | { status: 'ambiguous'; dirs: string[] };

/** Folders that are never a library and are slow or noisy to look into. Not `library`: that is what the default folder is called. */
const SKIPPED = new Set([
  '$recycle.bin', 'system volume information', '.trashes', '.spotlight-v100', '.fseventsd', 'lost+found',
  'node_modules', 'windows', 'program files', 'program files (x86)', 'applications', 'system', 'users',
]);

/**
 * The part of a path below its volume, as `Astro/library` for `/Volumes/Drive/Astro/library`. Empty when the path is
 * the volume itself or the shape is not recognised.
 */
export function pathBelowVolume(p: string, platform: NodeJS.Platform = process.platform): string {
  const patterns: RegExp[] = platform === 'win32'
    ? [/^[A-Za-z]:[\\/]+(.+)$/]
    : platform === 'darwin'
      ? [/^\/Volumes\/[^/]+\/(.+)$/]
      : [/^\/run\/media\/[^/]+\/[^/]+\/(.+)$/, /^\/media\/[^/]+\/[^/]+\/(.+)$/, /^\/mnt\/[^/]+\/(.+)$/, /^\/media\/[^/]+\/(.+)$/];
  for (const re of patterns) {
    const m = re.exec(p);
    if (m) return m[1].replace(/[\\/]+$/, '');
  }
  return '';
}

export async function locateLibrary(deps: LocatorDeps): Promise<LocateResult> {
  const platform = deps.platform ?? process.platform;
  const budget = { left: deps.maxFolders ?? 400 };
  const below = pathBelowVolume(deps.configuredPath, platform);
  const found: string[] = [];
  const seen = new Set<string>();
  const norm = (p: string) => path.normalize(p).replace(/[\\/]+$/, '').toLowerCase();
  const configured = norm(deps.configuredPath);

  async function consider(dir: string): Promise<void> {
    const key = norm(dir);
    if (seen.has(key) || key === configured) return;
    seen.add(key);
    budget.left--;
    if ((await deps.readMarkerId(dir)) !== deps.libraryId) return;
    if (await deps.isRetired(dir)) return;
    found.push(dir);
  }

  for (const root of deps.volumeRoots) {
    // The same place on the new volume, then the volume itself, then a short look around inside it.
    if (below) await consider(path.join(root, below));
    await consider(root);
    if (found.length > 0) continue;

    let children: string[] = [];
    try {
      children = (await deps.listDirs(root)).filter(n => !n.startsWith('.') && !SKIPPED.has(n.toLowerCase()));
    } catch {
      continue;
    }
    for (const child of children) {
      if (budget.left <= 0) break;
      await consider(path.join(root, child));
    }
    if (found.length > 0) continue;
    for (const child of children) {
      if (budget.left <= 0) break;
      let grandchildren: string[] = [];
      try {
        grandchildren = (await deps.listDirs(path.join(root, child))).filter(n => !n.startsWith('.') && !SKIPPED.has(n.toLowerCase()));
      } catch {
        continue;
      }
      for (const g of grandchildren) {
        if (budget.left <= 0) break;
        await consider(path.join(root, child, g));
      }
    }
  }

  if (found.length === 1) return { status: 'found', dir: found[0] };
  if (found.length > 1) return { status: 'ambiguous', dirs: found };
  return { status: 'none' };
}
