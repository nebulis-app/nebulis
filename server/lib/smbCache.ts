/**
 * Transparent caching layer for SMB access.
 *
 * Wraps smbListDir and smbGetFile:
 *   - On success: saves result to local disk cache, returns fresh data
 *   - On failure: falls back to cached data if available
 *
 * Cache lives in DATA_DIR/cache/ (Docker volume or local data/).
 * This means the app works even when the Seestar is powered off.
 *
 * Real consumers: routes/telescope.ts (`GET /telescope/test`), routes/storage.ts
 * (the storage dashboard's live SMB summary), and index.ts (`GET /health`'s
 * telescopeOnline flag). All other API routes read from the local library on
 * disk, never SMB.
 */
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { DATA_DIR } from './paths.js';
import {
  smbListDir as rawSmbListDir,
  smbGetFile as rawSmbGetFile,
  BASE_PATH,
} from './smb.js';
import { debugLog } from './debugLogger.js';
import type { TelescopeProfile } from './telescopes.js';

// `connectionType` and `localPath` are part of this even though nothing in
// this file reads them directly: smb.ts dispatches on connectionType, so
// omitting it from the type would let a caller pass a stripped-down object
// that silently routes a USB or FTP telescope through the SMB backend. They
// also feed `deviceKey` below, which is what keeps two telescopes' cache
// entries and online/offline state from colliding.
type ProfileArg =
  | Pick<TelescopeProfile, 'hostname' | 'shareName' | 'username' | 'password' | 'connectionType' | 'localPath'>
  | null
  | undefined;

// ─── Cache directory ────────────────────────────────────────────────

const CACHE_DIR = path.join(DATA_DIR, 'cache');
const DIR_CACHE_DIR = path.join(CACHE_DIR, 'dirs');
const FILE_CACHE_DIR = path.join(CACHE_DIR, 'files');

// How long a stale entry may still be served as an offline fallback, and how
// often the sweep reclaims entries nothing has read (or will ever read
// again, e.g. a removed telescope) since they went stale.
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

// Ensure cache directories exist
for (const dir of [CACHE_DIR, DIR_CACHE_DIR, FILE_CACHE_DIR]) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (err) {
    console.warn('SMB cache dir init failed:', dir, err instanceof Error ? err.message : err);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Identity of the device a path belongs to. Two telescopes can report the
 *  same relative path (e.g. both use the default share layout); without a
 *  device component in the cache key, one telescope's stale listing/file
 *  bytes could be served to a different telescope's UI. */
function deviceKey(profile: ProfileArg): string {
  if (!profile) return 'default';
  return `${profile.connectionType}|${profile.hostname ?? ''}|${profile.shareName ?? ''}|${profile.localPath ?? ''}`;
}

/** Convert a device + SMB path to a safe, collision-free filesystem path for
 *  caching. Hashing (rather than sanitizing) the raw string keeps keys
 *  unique and bounded regardless of what characters the path contains. */
function pathToKey(smbPath: string, profile: ProfileArg): string {
  return crypto.createHash('sha1').update(`${deviceKey(profile)}|${smbPath}`).digest('hex');
}

function isFresh(cachePath: string): boolean {
  try {
    return Date.now() - fs.statSync(cachePath).mtimeMs < CACHE_MAX_AGE_MS;
  } catch {
    return false;
  }
}

function readDirCache(smbPath: string, profile: ProfileArg): Array<{ name: string; type: 'dir' | 'file'; size?: number }> | null {
  const cachePath = path.join(DIR_CACHE_DIR, `${pathToKey(smbPath, profile)}.json`);
  if (!isFresh(cachePath)) {
    try { fs.unlinkSync(cachePath); } catch { /* already gone */ }
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeDirCache(smbPath: string, profile: ProfileArg, entries: Array<{ name: string; type: 'dir' | 'file'; size?: number }>): void {
  try {
    fs.mkdirSync(DIR_CACHE_DIR, { recursive: true });
    const cachePath = path.join(DIR_CACHE_DIR, `${pathToKey(smbPath, profile)}.json`);
    fs.writeFileSync(cachePath, JSON.stringify(entries));
  } catch (err) {
    console.warn('SMB dir cache write failed:', smbPath, err instanceof Error ? err.message : err);
  }
}

function readFileCache(smbPath: string, profile: ProfileArg): Buffer | null {
  const cachePath = path.join(FILE_CACHE_DIR, pathToKey(smbPath, profile));
  if (!isFresh(cachePath)) {
    try { fs.unlinkSync(cachePath); } catch { /* already gone */ }
    return null;
  }
  try {
    return fs.readFileSync(cachePath);
  } catch {
    return null;
  }
}

function writeFileCache(smbPath: string, profile: ProfileArg, data: Buffer): void {
  try {
    fs.mkdirSync(FILE_CACHE_DIR, { recursive: true });
    const cachePath = path.join(FILE_CACHE_DIR, pathToKey(smbPath, profile));
    fs.writeFileSync(cachePath, data);
  } catch (err) {
    console.warn('SMB file cache write failed:', smbPath, err instanceof Error ? err.message : err);
  }
}

/** Delete every cache entry older than `CACHE_MAX_AGE_MS`. Lazy eviction on
 *  read (above) only reclaims entries that are still being queried; this
 *  sweep reclaims ones that never will be again, e.g. a deleted transport's
 *  orphaned key. */
function sweepStaleEntries(): void {
  for (const dir of [DIR_CACHE_DIR, FILE_CACHE_DIR]) {
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const full = path.join(dir, name);
      if (!isFresh(full)) {
        try { fs.unlinkSync(full); } catch { /* already gone */ }
      }
    }
  }
}

const sweepTimer = setInterval(sweepStaleEntries, SWEEP_INTERVAL_MS);
sweepTimer.unref();

// ─── Track online/offline state, per device ─────────────────────────
// Keyed by device identity (see `deviceKey`) so one offline telescope no
// longer marks every other telescope "offline" too.

const deviceOnline = new Map<string, boolean>();

export function isTelescopeOnline(profile?: ProfileArg): boolean {
  return deviceOnline.get(deviceKey(profile)) ?? true;
}

/** Drop cached listings/files and known online state for one device, or
 *  every device when omitted. Call this after transport CRUD (address/share
 *  edits, deletes) so a corrected hostname doesn't keep serving a prior
 *  device's cached entries. The on-disk cache is content-addressed by a hash
 *  of the device identity, so a targeted per-device wipe would need a
 *  reverse index; a full sweep is simpler and the cache is cheap to rebuild. */
export function invalidateDeviceCache(profile?: ProfileArg): void {
  if (profile) {
    deviceOnline.delete(deviceKey(profile));
  } else {
    deviceOnline.clear();
  }
  for (const dir of [DIR_CACHE_DIR, FILE_CACHE_DIR]) {
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      try { fs.unlinkSync(path.join(dir, name)); } catch { /* already gone */ }
    }
  }
}

// ─── Cached wrappers ────────────────────────────────────────────────

export async function cachedSmbListDir(
  smbPath: string,
  profile?: ProfileArg,
): Promise<Array<{ name: string; type: 'dir' | 'file'; size?: number }>> {
  try {
    const entries = await rawSmbListDir(smbPath, profile);
    writeDirCache(smbPath, profile, entries);
    deviceOnline.set(deviceKey(profile), true);
    return entries;
  } catch (err) {
    deviceOnline.set(deviceKey(profile), false);
    const cached = readDirCache(smbPath, profile);
    if (cached) {
      debugLog('smb-cache', `listDir "${smbPath}" live call failed, served ${cached.length} entr${cached.length === 1 ? 'y' : 'ies'} from stale cache — ${err instanceof Error ? err.message : err}`);
      return cached;
    }
    debugLog('smb-cache', `listDir "${smbPath}" live call failed and no cache available — ${err instanceof Error ? err.message : err}`);
    throw err;
  }
}

export async function cachedSmbGetFile(
  smbPath: string,
  maxBytes?: number,
  profile?: ProfileArg,
): Promise<Buffer> {
  try {
    const data = await rawSmbGetFile(smbPath, maxBytes, profile);
    // Every backend returns a maxBytes-capped read as a truncated buffer, not
    // the whole file. Caching that under the same key as a full read would
    // let a later uncapped request that fails live fall back to serving the
    // truncated bytes as if they were the complete file. Only a full read is
    // safe to remember as "the file".
    if (maxBytes === undefined && data.length < 50 * 1024 * 1024) {
      writeFileCache(smbPath, profile, data);
    }
    deviceOnline.set(deviceKey(profile), true);
    return data;
  } catch (err) {
    deviceOnline.set(deviceKey(profile), false);
    // The cache only ever holds full reads (see above), so a capped request
    // can safely subarray it down to maxBytes for its offline fallback.
    const cached = readFileCache(smbPath, profile);
    if (cached) {
      let data = cached;
      if (maxBytes && data.length > maxBytes) {
        data = data.subarray(0, maxBytes);
      }
      debugLog('smb-cache', `getFile "${smbPath}" live call failed, served ${data.length} bytes from stale cache — ${err instanceof Error ? err.message : err}`);
      return data;
    }
    debugLog('smb-cache', `getFile "${smbPath}" live call failed and no cache available — ${err instanceof Error ? err.message : err}`);
    throw err;
  }
}

// Re-export BASE_PATH for convenience
export { BASE_PATH };
