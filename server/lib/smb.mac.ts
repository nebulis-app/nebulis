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
  parseShareName,
} from './smb.shared.js';
import type { TelescopeProfile } from './telescopes.js';

type ProfileArg = Partial<Pick<TelescopeProfile, 'hostname' | 'shareName' | 'username' | 'password'>> | null | undefined;

const execFileAsync = promisify(execFile);

interface MountEntry {
  mountDir: string;
  /** True when `mountDir` is a mount we adopted rather than created, for
   *  example one the user mounted in Finder. Those must never be unmounted
   *  by us. */
  adopted: boolean;
}

/** One live mount per profileKey (host|share|user), not a single global mount.
 *  A single shared mountDir meant that touching telescope B while an import
 *  from telescope A was in flight tore down A's mount out from under it —
 *  every operation resolved paths against whatever ensureMount() last set,
 *  regardless of which profile it was for. */
const mounts = new Map<string, MountEntry>();
/** In-flight first-touch mount per key, so two concurrent callers for the
 *  same profile (e.g. a status poll racing an import's own discovery call)
 *  don't both invoke mount_smbfs — macOS refuses the second one for the same
 *  share and fails with "File exists". Mirrors the reachInFlight pattern in
 *  smb.ftp.ts. */
const mountInFlight = new Map<string, Promise<string>>();

/** Replace the password in a `//user:pass@host/share` URL. mount_smbfs echoes
 *  its whole command line in error messages, so anything derived from one has
 *  to pass through here before being logged. */
function scrubUrl(text: string): string {
  return text.replace(/(\/\/[^:/@\s]+):[^@\s]*@/g, '$1:***@');
}

/** Keyed on the share, not the raw share field: the mount is per-share, so two
 *  profiles pointing at different folders inside one share should reuse a
 *  single mount rather than tearing each other's down. */
function profileKey(s: SmbProfile): string {
  return `${s.hostname}|${parseShareName(s.shareName).share}|${s.username}`;
}

function buildMountUrl(settings: SmbProfile): string {
  const enc = encodeURIComponent;
  const user = settings.username || 'guest';
  const pass = settings.password || '';
  // Always include user:pass@ even when password is empty.
  // Without explicit credentials mount_smbfs falls back to the current user's
  // system credentials (Kerberos/NTLM), which the Seestar rejects.
  // //user:@host/share = explicit guest / no-password auth, equivalent to smbclient -N.
  // Only the share is mountable. A folder inside it is appended to the mount
  // point afterwards (see ensureMount) — percent-encoding the whole field made
  // "share/folder" become a single bogus share name that could never mount.
  return `//${enc(user)}:${enc(pass)}@${settings.hostname}/${enc(parseShareName(settings.shareName).share)}`;
}

async function teardownMount(key: string): Promise<void> {
  const entry = mounts.get(key);
  if (!entry) return;
  mounts.delete(key);
  // Never unmount a share we did not mount. It may be the user's own Finder
  // mount, and pulling it out from under them would be a surprising side
  // effect of opening a settings page.
  if (entry.adopted) return;
  await execFileAsync('umount', [entry.mountDir]).catch(() => {});
  try { fs.rmdirSync(entry.mountDir); } catch { /* ignore */ }
}

// Check the OS mount table for an existing mount of this share (e.g. left over
// from a dev-server restart). macOS rejects a second mount_smbfs call for the
// same share, so we must reuse the existing mount point instead of creating one.
/** One smbfs row from `mount`. Real format, which is NOT what this code
 *  previously assumed:
 *    //brent@Orion._smb._tcp.local/Seestar on /Volumes/Seestar (smbfs, nodev, ...)
 *  Note there is no password, and the host is whatever name the share was
 *  mounted with, which may be a Bonjour name where we hold an IP. */
interface MountedShare { user: string; host: string; share: string; mountPoint: string }

function parseMountLine(line: string): MountedShare | null {
  const m = /^\/\/([^@/]+)@([^/]+)\/(\S+) on (.+?) \((.*)\)\s*$/.exec(line);
  if (!m || !m[5].startsWith('smbfs')) return null;
  return {
    // The credential portion is kept verbatim by macOS, so a mount we made as
    // "//guest:@host/share" reports the user as "guest:" and one with a
    // password can report "user:password". Take only the username, or a guest
    // share (the Seestar's own default) would never match.
    user: decodeURIComponent(m[1].split(':')[0]),
    host: m[2],
    share: decodeURIComponent(m[3]),
    mountPoint: m[4],
  };
}

/**
 * Find an existing OS mount of this share so we can reuse it. macOS refuses a
 * second mount_smbfs of the same share and fails with "File exists", so
 * missing one here turns every operation into a hard failure.
 *
 * This used to compare the full mount URL, password included, against the
 * mount table. The table never contains a password, so the match could never
 * succeed and the reuse path was dead: any share already mounted (by Finder,
 * or by us before a dev-server restart) made Nebulis unusable for that share.
 *
 * Host is matched loosely on purpose. The same server is routinely mounted as
 * an IP by us and as a Bonjour name by Finder, so requiring an exact host
 * would reintroduce the same dead path. Share plus username is the identity we
 * can actually rely on; an exact host match is preferred when one exists.
 */
async function findExistingMount(settings: SmbProfile): Promise<string | null> {
  const { share } = parseShareName(settings.shareName);
  const user = settings.username || 'guest';
  try {
    const { stdout } = await execFileAsync('mount', []);
    const candidates = stdout
      .split('\n')
      .map(parseMountLine)
      .filter((m): m is MountedShare => m !== null && m.share === share && m.user === user);
    if (candidates.length === 0) return null;
    const exact = candidates.find(m => m.host === settings.hostname);
    return (exact ?? candidates[0]).mountPoint;
  } catch { /* ignore */ }
  return null;
}

/**
 * Mount the share and return the directory callers should resolve paths
 * against. That is the mount point plus any configured subpath, so every
 * caller's `path.join(mp, smbPath)` lands inside the right folder without
 * knowing a subpath exists. `mounts.get(key).mountDir` stays the true mount
 * point, which is what teardown and the liveness check need.
 */
async function ensureMount(settings: SmbProfile): Promise<string> {
  const key = profileKey(settings);
  const { subpath } = parseShareName(settings.shareName);
  const withSubpath = (root: string) => (subpath ? path.join(root, subpath) : root);

  const existingEntry = mounts.get(key);
  if (existingEntry) {
    // Quick liveness check — if the mount point is gone or disconnected, remount.
    try {
      await fs.promises.access(existingEntry.mountDir, fs.constants.R_OK);
      return withSubpath(existingEntry.mountDir);
    } catch {
      await teardownMount(key);
    }
  }

  // Serialize concurrent first-touch mounts for the same key so two callers
  // racing in (e.g. a status poll and an import's discovery call) don't both
  // invoke mount_smbfs for the same share.
  const inFlight = mountInFlight.get(key);
  if (inFlight) return withSubpath(await inFlight);

  const mountPromise = (async (): Promise<string> => {
    // Reuse a pre-existing OS-level mount rather than calling mount_smbfs
    // again — macOS refuses to mount the same share twice and would error.
    const existing = await findExistingMount(settings);
    if (existing) {
      mounts.set(key, { mountDir: existing, adopted: true });
      return existing;
    }

    const url = buildMountUrl(settings);
    const mp = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-smb-'));
    try {
      await execFileAsync('mount_smbfs', [url, mp], { timeout: 15000 });
    } catch (err) {
      try { fs.rmdirSync(mp); } catch { /* ignore */ }
      throw err;
    }
    mounts.set(key, { mountDir: mp, adopted: false });
    return mp;
  })();
  mountInFlight.set(key, mountPromise);
  try {
    return withSubpath(await mountPromise);
  } finally {
    mountInFlight.delete(key);
  }
}

function extractMountReason(err: unknown): string {
  if (!(err instanceof Error)) return 'Unknown error';
  const stderr = (err as { stderr?: string }).stderr ?? '';
  // Scrub before anything else. mount_smbfs echoes its full command line,
  // credentials included, and this was writing the user's SMB password to
  // server.log in plaintext. Classifying against the scrubbed text also stops
  // a password that happens to contain "auth" from steering the result.
  const msg = scrubUrl(`${err.message} ${stderr}`);
  console.warn('[smb] mount_smbfs raw error:', msg);
  if (msg.includes('Connection refused')) return 'Connection refused';
  if (/timed out|timeout/i.test(msg)) return 'Connection timed out';
  if (/auth|credentials|password/i.test(msg)) return 'Authentication failed';
  // "File exists" is mount_smbfs refusing to mount an already-mounted share.
  // ensureMount tries to reuse one first, so getting here means that lookup
  // missed and the user needs to know it is a mount collision, not a network
  // problem.
  if (/File exists/i.test(msg)) {
    return 'That share is already mounted on this Mac and the existing mount could not be reused';
  }
  // Node's ENOENT text is lowercase ("no such file or directory"), so the old
  // case-sensitive check never fired and a missing folder was reported as a
  // connection failure.
  if (/no such file|does not exist/i.test(msg)) return 'Share or folder not found';
  return 'Connection failed';
}

// Clean up every mount when the process exits so we don't leave dangling
// mounts. Adopted mounts are left alone: they belong to whoever mounted them,
// and in dev the server exits on every file change, which would otherwise
// unmount the user's Finder shares repeatedly.
process.on('exit', () => {
  for (const entry of mounts.values()) {
    if (entry.adopted) continue;
    try { execFileSync('umount', [entry.mountDir]); } catch { /* ignore */ }
    try { fs.rmdirSync(entry.mountDir); } catch { /* ignore */ }
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
    await teardownMount(profileKey(settings));
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
    await teardownMount(profileKey(settings));
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
    await teardownMount(profileKey(settings));
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

  // Plain startsWith(BASE_PATH) has no trailing-separator boundary check, so
  // a sibling folder named e.g. "MyWorks_evil" (or "MyWorksEvil") would also
  // pass — the prefix matches but the path is not actually inside BASE_PATH.
  if (smbPath !== BASE_PATH && !smbPath.startsWith(BASE_PATH + '/')) {
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
    await teardownMount(profileKey(settings));
    throw new Error(`SMB connection failed: ${extractMountReason(err)}`);
  }
}
