/**
 * Resolves where the library (the user's imported images, FITS, and
 * sub-frames) lives. By default this is `{DATA_DIR}/library`, but the user can
 * relocate it to another volume (a USB or external drive) via Settings →
 * Storage. Only the library moves; the database, secrets, thumbnails, and logs
 * always stay on the local data directory.
 *
 * The configured path lives in appSettings.libraryPath (empty = default), so
 * no restart is needed: callers read getLibraryDir() at runtime and the cache
 * is refreshed when the path changes.
 *
 * A marker file (`.nebulis-library.json`) is written at the library root with
 * a stable libraryId that is also stored locally. On reconnect we match the
 * marker to this install, so a drive that mounts at the same path but holds
 * different (or no) data is never mistaken for our library. This mirrors the
 * `.nebulis.dat` identity file telescopes write (see deviceIdentity.ts).
 *
 * Import note: this module imports db (and paths for DATA_DIR). paths.ts does
 * NOT import this module, so there is no cycle.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import db from './db.js';
import { DATA_DIR } from './paths.js';

export const MARKER_FILENAME = '.nebulis-library.json';

export interface LibraryMarker {
  libraryId: string;
  createdAt: string;
  appVersion: string;
  note: string;
}

/** Thrown by ensureLibraryDir() when a relocated library is not reachable. */
export class LibraryUnavailableError extends Error {
  readonly code = 'LIBRARY_UNAVAILABLE';
  constructor(public readonly libraryDir: string) {
    super(`Library directory is not available: ${libraryDir}`);
    this.name = 'LibraryUnavailableError';
  }
}

interface LibraryConfig {
  path: string; // configured absolute path, or '' for default
  id: string; // libraryId, or '' if not yet assigned
}

let cache: LibraryConfig | null = null;

function load(): LibraryConfig {
  if (cache) return cache;
  const row = db
    .prepare<[], { libraryPath: string; libraryId: string }>(
      'SELECT libraryPath, libraryId FROM appSettings WHERE id = 1',
    )
    .get();
  cache = { path: row?.libraryPath?.trim() ?? '', id: row?.libraryId ?? '' };
  return cache;
}

/** Drop the in-memory cache so the next read reflects the DB. */
export function refreshLibraryConfig(): void {
  cache = null;
}

/** The built-in library location, always on the local data directory. */
export function getDefaultLibraryDir(): string {
  return path.join(DATA_DIR, 'library');
}

/** Where the library currently lives (configured path, or the default). */
export function getLibraryDir(): string {
  const cfg = load();
  return cfg.path ? cfg.path : getDefaultLibraryDir();
}

/** True when the library is at its built-in location (not relocated). */
export function isDefaultLocation(): boolean {
  return !load().path;
}

/**
 * Stable id for this install's library. Generated and persisted on first use
 * so a relocated drive can be matched back to us via its marker file.
 */
export function getLibraryId(): string {
  const cfg = load();
  if (cfg.id) return cfg.id;
  const id = randomUUID();
  db.prepare('UPDATE appSettings SET libraryId = ? WHERE id = 1').run(id);
  cache = { ...cfg, id };
  return id;
}

function readAppVersion(): string {
  // Best-effort; the marker is informational only.
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '';
  } catch {
    return '';
  }
}

/** Read and parse the marker at a directory, or null if absent/invalid. */
export function readMarker(dir: string): LibraryMarker | null {
  try {
    const raw = fs.readFileSync(path.join(dir, MARKER_FILENAME), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'libraryId' in parsed) {
      const id = (parsed as { libraryId: unknown }).libraryId;
      if (typeof id === 'string' && id.length > 0) return parsed as LibraryMarker;
    }
    return null;
  } catch {
    return null;
  }
}

/** Write (or refresh) the marker file at a library directory. */
export function writeMarker(dir: string, libraryId: string): void {
  const marker: LibraryMarker = {
    libraryId,
    createdAt: new Date().toISOString(),
    appVersion: readAppVersion(),
    note: 'This folder holds your Nebulis astronomy library. Do not rename or delete files here.',
  };
  fs.writeFileSync(path.join(dir, MARKER_FILENAME), JSON.stringify(marker, null, 2), 'utf8');
}

/**
 * Whether the library can be read/written right now.
 *
 * The default location is always considered available (it lives on the local
 * data directory). A relocated location is available only when the directory
 * exists AND its marker matches our libraryId. A folder that exists but has no
 * marker, or a marker for a different library, is treated as unavailable so we
 * never write into the wrong place or mistake an empty drive for data loss.
 */
export function isLibraryAvailable(): boolean {
  if (isDefaultLocation()) return true;
  const dir = getLibraryDir();
  if (!fs.existsSync(dir)) return false;
  const marker = readMarker(dir);
  return marker !== null && marker.libraryId === getLibraryId();
}

/**
 * Ensure the library directory exists and return it. Safe to call before any
 * write. For the default location it creates the directory on demand. For a
 * relocated location it throws LibraryUnavailableError when the drive is not
 * reachable, rather than recreating the path on the wrong volume (on macOS,
 * mkdir of an unmounted /Volumes/X path would silently write to the boot disk).
 */
export function ensureLibraryDir(): string {
  const dir = getLibraryDir();
  if (isDefaultLocation()) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  if (!isLibraryAvailable()) throw new LibraryUnavailableError(dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Persist a new library path and refresh the cache. Pass '' to reset to the
 * default location. Does not move any files; the migration engine handles the
 * copy and writes the marker before calling this.
 */
export function setLibraryPath(newPath: string): void {
  db.prepare('UPDATE appSettings SET libraryPath = ? WHERE id = 1').run(newPath.trim());
  refreshLibraryConfig();
}

export interface LibraryLocationInfo {
  path: string;
  isDefault: boolean;
  available: boolean;
  libraryId: string;
}

export function getLibraryLocationInfo(): LibraryLocationInfo {
  return {
    path: getLibraryDir(),
    isDefault: isDefaultLocation(),
    available: isLibraryAvailable(),
    libraryId: getLibraryId(),
  };
}
