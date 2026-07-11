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
 * The library can also be relocated to a network share (UNC/SMB) instead of a
 * local path — see `libraryNetwork.ts` for the platform-specific connect and
 * path-resolution logic (Windows `net use`, macOS `mount_smbfs`; not supported
 * on Linux/Docker, where a host-level CIFS mount should be used as a regular
 * local location instead). `appSettings.libraryLocationType` selects between
 * the two; the network columns hold host/share/credentials (password sealed
 * via secretBox, matching telescopeTransports.password).
 *
 * Import note: this module imports db (and paths for DATA_DIR). paths.ts does
 * NOT import this module, so there is no cycle.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import db from './db.js';
import { DATA_DIR } from './paths.js';
import { encrypt, decrypt } from './crypto/secretBox.js';
import {
  type NetworkLibraryConfig,
  resolveNetworkLibraryPath,
  ensureNetworkLibraryConnected,
  isNetworkLibraryMounted,
  disconnectNetworkLibrary,
  invalidateNetworkLibraryReachability,
} from './libraryNetwork.js';

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
  path: string; // configured absolute path, or '' for default (local mode only)
  id: string; // libraryId, or '' if not yet assigned
  locationType: 'local' | 'network';
  network: NetworkLibraryConfig;
}

interface LibraryConfigRow {
  libraryPath: string;
  libraryId: string;
  libraryLocationType: string;
  libraryNetworkHost: string;
  libraryNetworkShare: string;
  libraryNetworkDomain: string;
  libraryNetworkUsername: string;
  libraryNetworkPasswordSealed: string;
  libraryNetworkSubpath: string;
}

let cache: LibraryConfig | null = null;

function load(): LibraryConfig {
  if (cache) return cache;
  const row = db
    .prepare<[], LibraryConfigRow>(
      `SELECT libraryPath, libraryId, libraryLocationType, libraryNetworkHost,
              libraryNetworkShare, libraryNetworkDomain, libraryNetworkUsername,
              libraryNetworkPasswordSealed, libraryNetworkSubpath
       FROM appSettings WHERE id = 1`,
    )
    .get();

  // decrypt() throws on bad ciphertext (e.g. DB restored with a different
  // DATA_KEY). Degrade to an empty password rather than 500ing every caller
  // of getLibraryDir() — same convention as telescopes.ts's rowToProfile.
  let password = '';
  if (row?.libraryNetworkPasswordSealed) {
    try {
      password = decrypt(row.libraryNetworkPasswordSealed);
    } catch (err) {
      console.warn(`[libraryPath] Failed to decrypt network library password: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  cache = {
    path: row?.libraryPath?.trim() ?? '',
    id: row?.libraryId ?? '',
    locationType: row?.libraryLocationType === 'network' ? 'network' : 'local',
    network: {
      host: row?.libraryNetworkHost ?? '',
      share: row?.libraryNetworkShare ?? '',
      domain: row?.libraryNetworkDomain ?? '',
      username: row?.libraryNetworkUsername ?? '',
      password,
      subpath: row?.libraryNetworkSubpath ?? '',
    },
  };
  return cache;
}

/** Drop the in-memory cache so the next read reflects the DB. */
export function refreshLibraryConfig(): void {
  cache = null;
}

/**
 * Races a promise against a timeout so a stale network mount can't block
 * forever. A stat/read against a stuck SMB share can hang far longer than any
 * reasonable request; this bounds the wait without cancelling the underlying
 * libuv threadpool call (Node has no way to abort an in-flight fs syscall).
 * Exported for reuse by any other library code that touches a file under
 * getLibraryDir() from a request handler or background job — see callers in
 * library/gallery.ts, library/objects.ts, library/observations.ts,
 * library/processed.ts, library/housekeeping.ts, and routes/library.ts.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      err => { clearTimeout(timer); reject(err); },
    );
  });
}

const NETWORK_STAT_TIMEOUT_MS = 5_000;

/** Shared timeout for any fs.promises call against a library path outside
 *  this module. Same bound as the network-availability check above. */
export const LIBRARY_IO_TIMEOUT_MS = NETWORK_STAT_TIMEOUT_MS;

/** Async, timeout-bounded equivalent of readMarker() for the network-share
 *  path, where a stale mount can otherwise hang the read indefinitely. */
async function readMarkerAsync(dir: string, timeoutMs: number): Promise<LibraryMarker | null> {
  try {
    const raw = await withTimeout(fs.promises.readFile(path.join(dir, MARKER_FILENAME), 'utf8'), timeoutMs);
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

/** The built-in library location, always on the local data directory. */
export function getDefaultLibraryDir(): string {
  return path.join(DATA_DIR, 'library');
}

/** Where the library currently lives (configured path, network share, or the
 *  default). No I/O for the network case — just builds the path string; call
 *  isLibraryAvailable() to know whether it's actually reachable right now. */
export function getLibraryDir(): string {
  const cfg = load();
  if (cfg.locationType === 'network') return resolveNetworkLibraryPath(cfg.network);
  return cfg.path ? cfg.path : getDefaultLibraryDir();
}

/** True when the library is at its built-in location (not relocated to a
 *  local path or a network share). */
export function isDefaultLocation(): boolean {
  const cfg = load();
  return cfg.locationType !== 'network' && !cfg.path;
}

/** True when the library is configured to live on a network share. */
export function isNetworkLocation(): boolean {
  return load().locationType === 'network';
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
 * data directory). A relocated location (local path or network share) is
 * available only when the directory exists AND its marker matches our
 * libraryId. A folder that exists but has no marker, or a marker for a
 * different library, is treated as unavailable so we never write into the
 * wrong place or mistake an empty drive (or share) for data loss.
 *
 * For a network share this first attempts to (re)connect — see
 * libraryNetwork.ts's ensureNetworkLibraryConnected(), which fails fast via a
 * cached TCP reachability probe rather than hanging a native mount call
 * against a dead host. Async because that reachability probe and the
 * platform connect call (net use / mount_smbfs) are both real network I/O;
 * there are exactly three callers in the whole codebase (the auto-import
 * scheduler, the /library write-guard middleware, and the settings reset
 * route), all already in async contexts.
 *
 * The reachability probe only covers the *connect* step: it doesn't catch a
 * share that was already mounted and has since gone stale (server dropped
 * off Wi-Fi, session wedged). A stat/read against a stale SMB mount can block
 * far longer than a probe would suggest, so the existence and marker checks
 * below use fs.promises + withTimeout rather than the sync fs API. This
 * previously used fs.existsSync/readFileSync, which blocks the whole Node
 * event loop, not just this check: because the auto-import scheduler calls
 * this function unconditionally every 60s, a stale mount froze the entire
 * server (every route, not just library ones) until the OS's SMB client gave
 * up. See incident 2026-07-07.
 */
export async function isLibraryAvailable(): Promise<boolean> {
  const cfg = load();
  if (cfg.locationType === 'network') {
    // (Re)connect first. A false return means the host is unreachable, so skip
    // the filesystem probes entirely rather than tying up a libuv thread on a
    // bounded-but-still-blocking stat against a dead share.
    const reachable = await ensureNetworkLibraryConnected(cfg.network);
    if (!reachable) return false;
    // On macOS a stale mount that connect just force-unmounted is now gone;
    // reading the mount table (no filesystem touch) short-circuits before the
    // access() below could hang. On Windows this is a no-op (returns true).
    if (!(await isNetworkLibraryMounted())) return false;
    let dir: string;
    try {
      dir = resolveNetworkLibraryPath(cfg.network);
    } catch {
      return false;
    }
    try {
      await withTimeout(fs.promises.access(dir), NETWORK_STAT_TIMEOUT_MS);
    } catch {
      return false;
    }
    const marker = await readMarkerAsync(dir, NETWORK_STAT_TIMEOUT_MS);
    return marker !== null && marker.libraryId === getLibraryId();
  }
  if (isDefaultLocation()) return true;
  const dir = getLibraryDir();
  if (!fs.existsSync(dir)) return false;
  const marker = readMarker(dir);
  return marker !== null && marker.libraryId === getLibraryId();
}

/**
 * Ensure the library directory exists and return it. Safe to call before any
 * write. For the default location it creates the directory on demand. For a
 * relocated location it throws LibraryUnavailableError when the drive (or
 * network share) is not reachable, rather than recreating the path on the
 * wrong volume (on macOS, mkdir of an unmounted /Volumes/X path would
 * silently write to the boot disk).
 *
 * Note: this particular export is not currently called anywhere — the local
 * library write paths (server/lib/library/objects.ts etc.) use their own
 * simpler mkdir-if-missing helper, relying on the router-level guard and the
 * auto-import scheduler (both gated on isLibraryAvailable()) to keep writes
 * off a disconnected location. Kept in sync here so it isn't a landmine if a
 * future caller picks it up.
 */
export async function ensureLibraryDir(): Promise<string> {
  const dir = getLibraryDir();
  if (isDefaultLocation()) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  if (!(await isLibraryAvailable())) throw new LibraryUnavailableError(dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Persist a new local library path and refresh the cache, clearing any
 * network configuration. Pass '' to reset to the default location. Does not
 * move any files; the migration engine handles the copy and writes the marker
 * before calling this.
 */
export async function setLibraryPath(newPath: string): Promise<void> {
  const wasNetwork = load().locationType === 'network';
  db.prepare(
    `UPDATE appSettings SET
       libraryPath = ?, libraryLocationType = 'local',
       libraryNetworkHost = '', libraryNetworkShare = '', libraryNetworkDomain = '',
       libraryNetworkUsername = '', libraryNetworkPasswordSealed = '', libraryNetworkSubpath = ''
     WHERE id = 1`,
  ).run(newPath.trim());
  refreshLibraryConfig();
  invalidateNetworkLibraryReachability();
  if (wasNetwork) await disconnectNetworkLibrary();
}

/**
 * Persist a network share as the library location (host/share/credentials —
 * the password encrypted via secretBox, same convention as
 * telescopeTransports.password) and refresh the cache. `libraryPath` is
 * cleared since the network columns become authoritative for path
 * resolution. Does not move any files; call this only after
 * libraryMigration.ts has copied and verified the data at the resolved path.
 */
export function setNetworkLibraryConfig(cfg: NetworkLibraryConfig): void {
  const sealed = cfg.password ? encrypt(cfg.password) : '';
  db.prepare(
    `UPDATE appSettings SET
       libraryPath = '', libraryLocationType = 'network',
       libraryNetworkHost = ?, libraryNetworkShare = ?, libraryNetworkDomain = ?,
       libraryNetworkUsername = ?, libraryNetworkPasswordSealed = ?, libraryNetworkSubpath = ?
     WHERE id = 1`,
  ).run(cfg.host.trim(), cfg.share.trim(), cfg.domain.trim(), cfg.username.trim(), sealed, cfg.subpath.trim());
  refreshLibraryConfig();
  // Drop any cached reachability for the old/new host so the next availability
  // check re-probes instead of trusting a stale (up to 5s) result.
  invalidateNetworkLibraryReachability();
}

export interface LibraryLocationInfo {
  path: string;
  isDefault: boolean;
  available: boolean;
  libraryId: string;
  locationType: 'local' | 'network';
  /** Non-secret network fields, kept even in local mode so the Settings UI can
   *  prefill the form with the last-used values. Never includes the password. */
  network: { host: string; share: string; domain: string; username: string; subpath: string };
  /** false on Linux/Docker — the UI should hide the "Network Share" option there. */
  networkLibrarySupported: boolean;
}

export async function getLibraryLocationInfo(): Promise<LibraryLocationInfo> {
  const cfg = load();
  return {
    path: getLibraryDir(),
    isDefault: isDefaultLocation(),
    available: await isLibraryAvailable(),
    libraryId: getLibraryId(),
    locationType: cfg.locationType,
    network: {
      host: cfg.network.host,
      share: cfg.network.share,
      domain: cfg.network.domain,
      username: cfg.network.username,
      subpath: cfg.network.subpath,
    },
    networkLibrarySupported: process.platform === 'win32' || process.platform === 'darwin',
  };
}
