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
import dns from 'dns';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import {
  type SmbEntry,
  type SmbProfile,
  parseShareName,
  assertInsideRoot,
  classifySmbError,
  scrubSmbSecrets,
  withSmbGuards,
} from './smb.shared.js';
import type { TelescopeProfile } from './telescopes.js';
import { childProcessOutput } from './errors.js';
import { withDeadline, mapLimit } from './deadline.js';

type ProfileArg = Partial<Pick<TelescopeProfile, 'hostname' | 'shareName' | 'username' | 'password'>> | null | undefined;

const execFileAsync = promisify(execFile);

/** Longest a probe of a mounted share may take. A stale SMB mount makes the kernel block the call for minutes, and each
 *  blocked call holds one libuv thread, which the whole server shares with every async fs, DNS and crypto call. */
const MOUNT_PROBE_TIMEOUT_MS = 5_000;
const LIST_DIR_TIMEOUT_MS = 30_000;
const STAT_TIMEOUT_MS = 10_000;
/** How many file stats one directory listing keeps in flight. */
const STAT_CONCURRENCY = 16;

interface MountEntry {
  mountDir: string;
  /** When the OS mount table last confirmed this mount still points at the share it was made for. */
  verifiedAt?: number;
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

/** Alias of the shared scrubber — mount_smbfs echoes its whole `//user:pass@host`
 *  command line in error messages. */
const scrubUrl = scrubSmbSecrets;

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
  // -f and a deadline: a plain umount of a stale mount waits on the dead server and never returns.
  await execFileAsync('umount', ['-f', entry.mountDir], { timeout: 10_000 }).catch(() => {});
  try { fs.rmdirSync(entry.mountDir); } catch { /* ignore */ }
}

// Check the OS mount table for an existing mount of this share (e.g. left over
// from a dev-server restart). macOS rejects a second mount_smbfs call for the
// same share, so we must reuse the existing mount point instead of creating one.
/** One smbfs row from `mount`. Real format, which is NOT what this code
 *  previously assumed:
 *    //user@host._smb._tcp.local/Seestar on /Volumes/Seestar (smbfs, nodev, ...)
 *  Note there is no password, and the host is whatever name the share was
 *  mounted with, which may be a Bonjour name where we hold an IP. */
export interface MountedShare { user: string; host: string; share: string; mountPoint: string }

export function parseMountLine(line: string): MountedShare | null {
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

export type HostComparison = 'same' | 'different' | 'unknown';
type Resolver = (host: string) => Promise<string[]>;

/** The addresses a host name answers to. `Seestar._smb._tcp.local`, which is how a Finder mount is listed, is looked up as `Seestar.local`. */
async function resolveHost(host: string): Promise<string[]> {
  const name = host.replace('._smb._tcp', '');
  if (/^[\d.]+$/.test(name) || name.includes(':')) return [name];
  try {
    const found = await Promise.race([
      dns.promises.lookup(name, { all: true }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2_000).unref()),
    ]);
    return found.map(a => a.address);
  } catch {
    return [];
  }
}

/**
 * Whether two host names are one machine. 'different' only on positive evidence: both resolve and share no address. A name that
 * will not resolve is 'unknown', never 'different', because the same server is routinely mounted by IP and by Bonjour name.
 */
export async function compareHosts(a: string, b: string, resolve: Resolver = resolveHost): Promise<HostComparison> {
  if (a.toLowerCase() === b.toLowerCase()) return 'same';
  const [ra, rb] = await Promise.all([resolve(a), resolve(b)]);
  if (ra.length === 0 || rb.length === 0) return 'unknown';
  return ra.some(x => rb.includes(x)) ? 'same' : 'different';
}

/**
 * Which of the shares already mounted under this share name and user is the profile's own. Two Seestars both call their share
 * `EMMC Images` and log in as `guest`, so with one open in Finder the other must not take its mount.
 *
 * The mount whose host is the profile's (by name or by address) wins. Failing that, a mount whose host cannot be resolved is taken
 * only if it is the one such mount. A mount that provably belongs to a different machine is never taken.
 */
export async function pickExistingMount(candidates: MountedShare[], hostname: string, resolve: Resolver = resolveHost): Promise<string | null> {
  const verdicts = await Promise.all(candidates.map(async c => ({ c, v: await compareHosts(c.host, hostname, resolve) })));
  const same = verdicts.find(x => x.v === 'same');
  if (same) return same.c.mountPoint;
  const unknown = verdicts.filter(x => x.v === 'unknown');
  return unknown.length === 1 ? unknown[0].c.mountPoint : null;
}

/** How long a mount confirmed against the mount table is trusted. Every directory listing asks `ensureMount`, so this keeps `mount` off the hot path. */
const MOUNT_RECHECK_MS = 10_000;

/** Whether the OS mount at `entry.mountDir` is still the share this profile asked for. A failed check never condemns a mount that otherwise works. */
async function mountStillMatches(entry: MountEntry, settings: SmbProfile): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('mount', [], { timeout: 5_000 });
    const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
    const here = real(entry.mountDir);
    const row = stdout.split('\n').map(parseMountLine).find(m => m !== null && real(m.mountPoint) === here);
    if (!row) return false;
    return row.share === parseShareName(settings.shareName).share && (await compareHosts(row.host, settings.hostname)) !== 'different';
  } catch {
    return true;
  }
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
    const { stdout } = await execFileAsync('mount', [], { timeout: 5_000 });
    const candidates = stdout
      .split('\n')
      .map(parseMountLine)
      .filter((m): m is MountedShare => m !== null && m.share === share && m.user === user);
    if (candidates.length === 0) return null;
    return await pickExistingMount(candidates, settings.hostname);
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
    // Quick liveness check — if the mount point is gone or disconnected, remount. Now and then also confirm the mount is still the
    // share we made it for: something else can be mounted at the same place, and it would pass the access check.
    try {
      await withDeadline(fs.promises.access(existingEntry.mountDir, fs.constants.R_OK), MOUNT_PROBE_TIMEOUT_MS, 'mount check');
      if (!existingEntry.verifiedAt || Date.now() - existingEntry.verifiedAt > MOUNT_RECHECK_MS) {
        if (!(await mountStillMatches(existingEntry, settings))) throw new Error('the mount is no longer this share');
        existingEntry.verifiedAt = Date.now();
      }
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
  // The raw line is the only breadcrumb when a mount fails; keep logging it
  // (scrubbed) even though classification now lives in smb.shared.ts.
  if (err instanceof Error) {
    const stderr = childProcessOutput(err, 'stderr') ?? '';
    console.warn('[smb] mount_smbfs raw error:', scrubUrl(`${err.message} ${stderr}`));
  }
  return classifySmbError(err, 'mount');
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
  return withSmbGuards(smbPath, profile, async (settings) => {
  let mp: string;
  try {
    mp = await ensureMount(settings);
  } catch (err) {
    throw new Error(`SMB connection failed: ${extractMountReason(err)}`);
  }

  const fullPath = assertInsideRoot(mp, smbPath);
  try {
    const dirents = await withDeadline(fs.promises.readdir(fullPath, { withFileTypes: true }), LIST_DIR_TIMEOUT_MS, 'directory listing');
    // Size and mtime are needed for import progress tracking and size-mismatch
    // checks; directories don't need them. Stats run a bounded number at a time:
    // an unbounded fan-out over a few thousand files queued that many blocking
    // calls on the shared libuv threadpool.
    return await mapLimit(
      dirents.filter(d => d.name !== '.' && d.name !== '..'),
      STAT_CONCURRENCY,
      async (d): Promise<SmbEntry> => {
        const entry: SmbEntry = {
          name: d.name,
          type: d.isDirectory() ? 'dir' : 'file',
        };
        if (d.isFile()) {
          try {
            const stat = await withDeadline(fs.promises.stat(path.join(fullPath, d.name)), STAT_TIMEOUT_MS, 'file stat');
            entry.size = stat.size;
            entry.mtime = stat.mtime.toISOString();
          } catch { /* race: file removed between readdir and stat, or a slow stat: skip size */ }
        }
        return entry;
      },
    );
  } catch (err) {
    await teardownMount(profileKey(settings));
    throw new Error(`SMB connection failed: ${extractMountReason(err)}`);
  }
  });
}

export async function smbGetFile(smbPath: string, maxBytes?: number, profile?: ProfileArg): Promise<Buffer> {
  return withSmbGuards(smbPath, profile, async (settings) => {
  let mp: string;
  try {
    mp = await ensureMount(settings);
  } catch (err) {
    throw new Error(`SMB connection failed: ${extractMountReason(err)}`);
  }

  try {
    let data = await fs.promises.readFile(assertInsideRoot(mp, smbPath));
    if (maxBytes && data.length > maxBytes) {
      data = data.subarray(0, maxBytes);
    }
    return data;
  } catch (err) {
    await teardownMount(profileKey(settings));
    throw new Error(`SMB connection failed: ${extractMountReason(err)}`);
  }
  });
}

export async function smbPutFile(smbPath: string, data: Buffer, profile?: ProfileArg): Promise<void> {
  return withSmbGuards(smbPath, profile, async (settings) => {
  let mp: string;
  try {
    mp = await ensureMount(settings);
  } catch (err) {
    throw new Error(`SMB connection failed: ${extractMountReason(err)}`);
  }

  try {
    await fs.promises.writeFile(assertInsideRoot(mp, smbPath), data);
  } catch (err) {
    await teardownMount(profileKey(settings));
    throw new Error(`SMB connection failed: ${extractMountReason(err)}`);
  }
  });
}

export async function smbDelete(smbPath: string, profile?: ProfileArg): Promise<void> {
  return withSmbGuards(smbPath, profile, async (settings) => {
  let mp: string;
  try {
    mp = await ensureMount(settings);
  } catch (err) {
    throw new Error(`SMB connection failed: ${extractMountReason(err)}`);
  }

  try {
    await fs.promises.unlink(assertInsideRoot(mp, smbPath));
  } catch (err) {
    await teardownMount(profileKey(settings));
    throw new Error(`SMB connection failed: ${extractMountReason(err)}`);
  }
  }, { requireInsideBasePath: true });
}
