/**
 * macOS SMB implementation — uses mount_smbfs (built into macOS) instead of
 * smbclient, which is not installed by default.
 *
 * Maintains a persistent mount so repeated calls within a session don't pay
 * mount overhead. Remounts automatically if the profile changes or the mount
 * goes stale.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import {
  BASE_PATH,
  type SmbEntry,
  type SmbProfile,
  sanitizePath,
  validatePathNoTraversal,
  loadSettings,
} from './smb.shared.js';
import type { TelescopeProfile } from './telescopes.js';

type ProfileArg = Partial<Pick<TelescopeProfile, 'hostname' | 'shareName' | 'username' | 'password'>> | null | undefined;

const execFileAsync = promisify(execFile);

let mountDir: string | null = null;
let mountedKey: string | null = null;

function profileKey(s: SmbProfile): string {
  return `${s.hostname}|${s.shareName}|${s.username}`;
}

function buildMountUrl(settings: SmbProfile): string {
  const enc = encodeURIComponent;
  const user = settings.username || 'guest';
  const pass = settings.password || '';
  // Always include user:pass@ even when password is empty.
  // Without explicit credentials mount_smbfs falls back to the current user's
  // system credentials (Kerberos/NTLM), which the Seestar rejects.
  // //user:@host/share = explicit guest / no-password auth, equivalent to smbclient -N.
  return `//${enc(user)}:${enc(pass)}@${settings.hostname}/${enc(settings.shareName)}`;
}

async function teardownMount(): Promise<void> {
  if (!mountDir) return;
  const mp = mountDir;
  mountDir = null;
  mountedKey = null;
  await execFileAsync('umount', [mp]).catch(() => {});
  try { fs.rmdirSync(mp); } catch { /* ignore */ }
}

// Check the OS mount table for an existing mount of this share (e.g. left over
// from a dev-server restart). macOS rejects a second mount_smbfs call for the
// same share, so we must reuse the existing mount point instead of creating one.
async function findExistingMount(url: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('mount', []);
    for (const line of stdout.split('\n')) {
      // Format: "//user:pass@host/share on /mount/point (smbfs, ...)"
      if (line.startsWith(url + ' on ')) {
        const mp = line.split(' on ')[1]?.split(' (')[0]?.trim();
        if (mp) return mp;
      }
    }
  } catch { /* ignore */ }
  return null;
}

async function ensureMount(settings: SmbProfile): Promise<string> {
  const key = profileKey(settings);

  if (mountDir && mountedKey === key) {
    // Quick liveness check — if the mount point is gone or disconnected, remount.
    try {
      await fs.promises.access(mountDir, fs.constants.R_OK);
      return mountDir;
    } catch {
      await teardownMount();
    }
  } else if (mountDir) {
    await teardownMount();
  }

  const url = buildMountUrl(settings);

  // Reuse a pre-existing OS-level mount rather than calling mount_smbfs again —
  // macOS refuses to mount the same share twice and would return an error.
  const existing = await findExistingMount(url);
  if (existing) {
    mountDir = existing;
    mountedKey = key;
    return existing;
  }

  const mp = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-smb-'));

  try {
    await execFileAsync('mount_smbfs', [url, mp], { timeout: 15000 });
  } catch (err) {
    try { fs.rmdirSync(mp); } catch { /* ignore */ }
    throw err;
  }

  mountDir = mp;
  mountedKey = key;
  return mp;
}

function extractMountReason(err: unknown): string {
  if (!(err instanceof Error)) return 'Unknown error';
  const stderr = (err as { stderr?: string }).stderr ?? '';
  const msg = `${err.message} ${stderr}`;
  console.warn('[smb] mount_smbfs raw error:', err.message, '| stderr:', stderr);
  if (msg.includes('Connection refused')) return 'Connection refused';
  if (/timed out|timeout/i.test(msg)) return 'Connection timed out';
  if (/auth|credentials|password/i.test(msg)) return 'Authentication failed';
  if (msg.includes('No such file') || msg.includes('does not exist')) return 'Share not found';
  return 'Connection failed';
}

// Clean up the mount when the process exits so we don't leave dangling mounts.
process.on('exit', () => {
  if (mountDir) {
    try { execFileSync('umount', [mountDir]); } catch { /* ignore */ }
    try { fs.rmdirSync(mountDir); } catch { /* ignore */ }
  }
});

export async function smbListDir(smbPath: string, profile?: ProfileArg): Promise<SmbEntry[]> {
  const settings = loadSettings(profile);
  if (!settings.hostname) {
    throw new Error('No SeeStar hostname configured. Please configure it in Settings.');
  }

  sanitizePath(smbPath);
  validatePathNoTraversal(smbPath);

  let mp: string;
  try {
    mp = await ensureMount(settings);
  } catch (err) {
    throw new Error(`SMB connection failed: ${extractMountReason(err)}`);
  }

  const fullPath = path.join(mp, smbPath);
  try {
    const dirents = await fs.promises.readdir(fullPath, { withFileTypes: true });
    // Stat all file entries in parallel — one logical wait regardless of count,
    // so the wall-clock cost is ~1 round-trip rather than N sequential ones.
    // Size and mtime are needed for import progress tracking and size-mismatch
    // checks; directories don't need them.
    return await Promise.all(
      dirents
        .filter(d => d.name !== '.' && d.name !== '..')
        .map(async (d): Promise<SmbEntry> => {
          const entry: SmbEntry = {
            name: d.name,
            type: d.isDirectory() ? 'dir' : 'file',
          };
          if (d.isFile()) {
            try {
              const stat = await fs.promises.stat(path.join(fullPath, d.name));
              entry.size = stat.size;
              entry.mtime = stat.mtime.toISOString();
            } catch { /* race: file removed between readdir and stat — skip size */ }
          }
          return entry;
        }),
    );
  } catch (err) {
    await teardownMount();
    throw new Error(`SMB connection failed: ${extractMountReason(err)}`);
  }
}

export async function smbGetFile(smbPath: string, maxBytes?: number, profile?: ProfileArg): Promise<Buffer> {
  const settings = loadSettings(profile);
  if (!settings.hostname) {
    throw new Error('No SeeStar hostname configured');
  }

  sanitizePath(smbPath);
  validatePathNoTraversal(smbPath);

  let mp: string;
  try {
    mp = await ensureMount(settings);
  } catch (err) {
    throw new Error(`SMB connection failed: ${extractMountReason(err)}`);
  }

  try {
    let data = await fs.promises.readFile(path.join(mp, smbPath));
    if (maxBytes && data.length > maxBytes) {
      data = data.subarray(0, maxBytes);
    }
    return data;
  } catch (err) {
    await teardownMount();
    throw new Error(`SMB connection failed: ${extractMountReason(err)}`);
  }
}

export async function smbPutFile(smbPath: string, data: Buffer, profile?: ProfileArg): Promise<void> {
  const settings = loadSettings(profile);
  if (!settings.hostname) {
    throw new Error('No SeeStar hostname configured');
  }

  sanitizePath(smbPath);
  validatePathNoTraversal(smbPath);

  let mp: string;
  try {
    mp = await ensureMount(settings);
  } catch (err) {
    throw new Error(`SMB connection failed: ${extractMountReason(err)}`);
  }

  try {
    await fs.promises.writeFile(path.join(mp, smbPath), data);
  } catch (err) {
    await teardownMount();
    throw new Error(`SMB connection failed: ${extractMountReason(err)}`);
  }
}

export async function smbDelete(smbPath: string, profile?: ProfileArg): Promise<void> {
  const settings = loadSettings(profile);
  if (!settings.hostname) {
    throw new Error('No SeeStar hostname configured');
  }

  sanitizePath(smbPath);
  validatePathNoTraversal(smbPath);

  if (!smbPath.startsWith(BASE_PATH)) {
    throw new Error('Can only delete files within MyWorks');
  }

  let mp: string;
  try {
    mp = await ensureMount(settings);
  } catch (err) {
    throw new Error(`SMB connection failed: ${extractMountReason(err)}`);
  }

  try {
    await fs.promises.unlink(path.join(mp, smbPath));
  } catch (err) {
    await teardownMount();
    throw new Error(`SMB connection failed: ${extractMountReason(err)}`);
  }
}
