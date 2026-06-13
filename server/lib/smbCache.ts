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
 * NOTE: These functions are only used by:
 *   - GET /seestar/test  (explicit connection test)
 *   - runImport()        (background sync from telescope to local library)
 *
 * All other API routes read from the local library on disk, never SMB.
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
import type { TelescopeProfile } from './telescopes.js';

type ProfileArg = Pick<TelescopeProfile, 'hostname' | 'shareName' | 'username' | 'password'> | null | undefined;

// ─── Cache directory ────────────────────────────────────────────────

const CACHE_DIR = path.join(DATA_DIR, 'cache');
const DIR_CACHE_DIR = path.join(CACHE_DIR, 'dirs');
const FILE_CACHE_DIR = path.join(CACHE_DIR, 'files');

// Ensure cache directories exist
for (const dir of [CACHE_DIR, DIR_CACHE_DIR, FILE_CACHE_DIR]) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (err) {
    console.warn('SMB cache dir init failed:', dir, err instanceof Error ? err.message : err);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Convert an SMB path to a safe, collision-free filesystem path for caching.
 *  The prior implementation collapsed every non-`[A-Za-z0-9._-]` character to
 *  `_`, so `MyWorks/M42` and `MyWorks_M42` produced the same key. Hashing the
 *  raw path keeps keys unique and bounded. */
function pathToKey(smbPath: string): string {
  return crypto.createHash('sha1').update(smbPath).digest('hex');
}

function readDirCache(smbPath: string): Array<{ name: string; type: 'dir' | 'file'; size?: number }> | null {
  try {
    const cachePath = path.join(DIR_CACHE_DIR, `${pathToKey(smbPath)}.json`);
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    return data;
  } catch {
    return null;
  }
}

function writeDirCache(smbPath: string, entries: Array<{ name: string; type: 'dir' | 'file'; size?: number }>): void {
  try {
    fs.mkdirSync(DIR_CACHE_DIR, { recursive: true });
    const cachePath = path.join(DIR_CACHE_DIR, `${pathToKey(smbPath)}.json`);
    fs.writeFileSync(cachePath, JSON.stringify(entries));
  } catch (err) {
    console.warn('SMB dir cache write failed:', smbPath, err instanceof Error ? err.message : err);
  }
}

function readFileCache(smbPath: string): Buffer | null {
  try {
    const cachePath = path.join(FILE_CACHE_DIR, pathToKey(smbPath));
    return fs.readFileSync(cachePath);
  } catch {
    return null;
  }
}

function writeFileCache(smbPath: string, data: Buffer): void {
  try {
    fs.mkdirSync(FILE_CACHE_DIR, { recursive: true });
    const cachePath = path.join(FILE_CACHE_DIR, pathToKey(smbPath));
    fs.writeFileSync(cachePath, data);
  } catch (err) {
    console.warn('SMB file cache write failed:', smbPath, err instanceof Error ? err.message : err);
  }
}

// ─── Track online/offline state ─────────────────────────────────────

let telescopeOnline = true;

export function isTelescopeOnline(): boolean {
  return telescopeOnline;
}

// ─── Cached wrappers ────────────────────────────────────────────────

export async function cachedSmbListDir(
  smbPath: string,
  profile?: ProfileArg,
): Promise<Array<{ name: string; type: 'dir' | 'file'; size?: number }>> {
  try {
    const entries = await rawSmbListDir(smbPath, profile);
    writeDirCache(smbPath, entries);
    telescopeOnline = true;
    return entries;
  } catch (err) {
    telescopeOnline = false;
    const cached = readDirCache(smbPath);
    if (cached) {
      return cached;
    }
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
    if (data.length < 50 * 1024 * 1024) {
      writeFileCache(smbPath, data);
    }
    telescopeOnline = true;
    return data;
  } catch (err) {
    telescopeOnline = false;
    const cached = readFileCache(smbPath);
    if (cached) {
      let data = cached;
      if (maxBytes && data.length > maxBytes) {
        data = data.subarray(0, maxBytes);
      }
      return data;
    }
    throw err;
  }
}

// Re-export BASE_PATH for convenience
export { BASE_PATH };
