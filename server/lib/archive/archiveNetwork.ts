/**
 * Network share (UNC/SMB) access for the archive destination.
 *
 * A sibling to `server/lib/libraryNetwork.ts`, and deliberately a separate module
 * for the same reason that one is separate from the telescope SMB code: an archive
 * bug must not be able to regress the library's share, and the two can point at
 * different servers at the same time. They also need different mount points, since
 * one fixed mount directory cannot hold two shares.
 *
 * Platform support is identical to the library's, and for the same reasons:
 *
 *   - Windows: the destination is the UNC path itself (`\\host\share\sub`), and
 *     `net use` authenticates the session for a password-protected share.
 *   - macOS: the app runs as a per-user LaunchAgent, so it can mount into a session
 *     with `/Volumes` access. The share is mounted to a fixed directory under
 *     `DATA_DIR` rather than a temp directory, so the resolved path survives a
 *     restart.
 *   - Linux/Docker: not supported. A share is mounted at the host level and the
 *     mounted folder is configured as a local destination instead.
 *
 * **The resolved root is inside `DATA_DIR` on macOS, and that is the whole hazard.**
 * When the share is not mounted, the mount directory is an ordinary empty folder, so
 * "does the root exist" is true and the marker reads as absent. Anything that treats
 * that as an unadopted archive would write a marker into a local folder and then
 * copy the library onto the app's own disk. `isArchiveShareMounted()` and the
 * readiness check built on it exist for that; nothing in this module may be used to
 * conclude the destination is usable without them.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { DATA_DIR } from '../paths.js';
import { sanitizePath, validatePathNoTraversal } from '../smb.shared.js';
import { tcpProbe, SMB_PORT } from '../smbReachability.js';
import { log } from '../logger.js';
import { trimTrailing } from '../trimTrailing.js';
import { isWithinRoot } from './archivePath.js';
import type { ArchiveNetworkConfig, ArchiveNetworkCredentials } from './archiveConfig.js';

/**
 * The share address, without either secret or derived field.
 *
 * Both shapes the rest of the module deals with satisfy it: `ArchiveNetworkConfig`
 * carries `hasPassword` and `ArchiveNetworkCredentials` carries the password, and
 * neither is needed to build a path, a mount URL, or a key. Taking this instead
 * means a caller never has to strip or invent a field to call one of these.
 */
export type ShareAddress = Pick<ArchiveNetworkConfig, 'host' | 'share' | 'domain' | 'username' | 'subpath'>;

const execFileAsync = promisify(execFile);

/** Where a macOS share is mounted. Fixed, and under `DATA_DIR`, so the resolved
 *  path is stable across restarts. Never the same directory as the library's mount
 *  (`lib/libraryNetwork.ts`'s `NETWORK_MOUNT_DIR`): they are different shares. */
export const ARCHIVE_NETWORK_MOUNT_DIR = path.join(DATA_DIR, 'network-archive-mount');

/** Why a network destination could not be resolved. Stable strings, so the route
 *  layer can pick a message rather than parsing prose. */
export type NetworkRootRejection =
  | 'incomplete'
  | 'invalid-subpath'
  | 'escapes-mount';

export type NetworkRootResult =
  | { ok: true; root: string; kind: 'mount' | 'unc' }
  | { ok: false; reason: NetworkRootRejection };

/** Whether this platform can mount a share in-process. Mirrors the library's rule
 *  (`server/lib/libraryPath.ts`'s `networkLibrarySupported`). */
export function networkArchiveSupported(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin';
}

/** The share's own root as a UNC string, used for display on every platform and as
 *  the usable destination on Windows. */
export function uncRootOf(network: ShareAddress): string {
  return `\\\\${network.host.trim()}\\${network.share.trim()}`;
}

/**
 * How a network destination should be shown to a person.
 *
 * Always the UNC form, whichever platform is running. The macOS mount directory is
 * an implementation detail under `DATA_DIR`, and showing a user
 * `{DATA_DIR}/network-archive-mount/Nebulis-Archive` as their archive path would
 * describe the plumbing rather than the share they configured.
 */
export function networkDisplayPath(network: ShareAddress): string {
  const subpath = normalizedSubpath(network).replace(/\//g, '\\');
  return subpath === '' ? uncRootOf(network) : `${uncRootOf(network)}\\${subpath}`;
}

/** The share's subpath with backslashes normalised and any trailing separator
 *  dropped, or '' for the share root.
 *
 *  A leading separator is deliberately NOT stripped. Stripping it turns `/etc` into
 *  `etc`, which is a valid relative path, so an absolute subpath would be silently
 *  reinterpreted instead of refused. */
function normalizedSubpath(network: ShareAddress): string {
  return trimTrailing(network.subpath.trim().replace(/\\/g, '/'), '/');
}

/**
 * The directory a network destination resolves to, or why it cannot be used.
 *
 * Pure: no I/O beyond the `realpath` inside `isWithinRoot`, no mount, no network.
 * That is what lets `GET /storage/archive` describe a destination that is not
 * currently connected, and it is why the connect step is a separate call.
 *
 * On macOS the result is the mount directory plus the subpath, and it is rejected
 * unless it is still inside that directory once symlinks are resolved: a share may
 * contain a link pointing anywhere, and the archive's retention pass deletes under
 * whatever root it is given.
 *
 * The subpath is validated here as well as at save time. Configuration can be edited
 * in the database by hand, and this is the function that decides what gets written.
 */
export function resolveNetworkArchiveRoot(network: ShareAddress): NetworkRootResult {
  const host = network.host.trim();
  const share = network.share.trim();
  if (host === '' || share === '') return { ok: false, reason: 'incomplete' };

  const subpath = normalizedSubpath(network);
  if (subpath !== '') {
    // Absolute in either platform's spelling. Backslashes are normalised above, so
    // `\Windows` and `C:\Windows` are the posix `/Windows` and `C:/Windows` by this
    // point and one check on each spelling covers all four forms.
    if (path.posix.isAbsolute(subpath) || path.win32.isAbsolute(subpath)) {
      return { ok: false, reason: 'invalid-subpath' };
    }
    try {
      // The same guard the library's macOS mount uses. It rejects `..` and the
      // collapse case where normalisation hides the escape.
      validatePathNoTraversal(subpath);
    } catch {
      return { ok: false, reason: 'invalid-subpath' };
    }
  }

  if (process.platform === 'darwin') {
    const root = subpath === '' ? ARCHIVE_NETWORK_MOUNT_DIR : path.join(ARCHIVE_NETWORK_MOUNT_DIR, subpath);
    if (!isWithinRoot(ARCHIVE_NETWORK_MOUNT_DIR, root)) return { ok: false, reason: 'escapes-mount' };
    return { ok: true, root, kind: 'mount' };
  }

  // Windows uses the UNC path directly. Everywhere else (Linux, which cannot mount
  // in-process) this is a display string: the connect step refuses first, so it is
  // never used for file I/O.
  const root = subpath === '' ? uncRootOf(network) : `${uncRootOf(network)}\\${subpath.replace(/\//g, '\\')}`;
  return { ok: true, root, kind: 'unc' };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Reachability, connect, and mount liveness
 *
 * The shape of all three is copied from `server/lib/libraryNetwork.ts` on purpose.
 * What is *not* copied is the mount directory: a fixed mount point can only hold one
 * share, and the archive can point at a different server than the library, so the
 * two must not share one.
 * ───────────────────────────────────────────────────────────────────────────── */

/** Local, dependency-free timeout race (`libraryPath.ts`'s `withTimeout` cannot be
 *  imported here without a cycle). Abandons the wait; the underlying call keeps
 *  running but can no longer block the caller. */
function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

const REACHABLE_TTL_MS = 5_000;
const UNREACHABLE_TTL_MS = 5_000;
const reachabilityCache = new Map<string, { reachable: boolean; checkedAt: number }>();

/** A cached TCP probe before any native call, so a dead host costs one connect
 *  attempt rather than a hung `mount_smbfs` or `net use`. */
async function isHostReachable(host: string): Promise<boolean> {
  const now = Date.now();
  const cached = reachabilityCache.get(host);
  if (cached && now - cached.checkedAt < (cached.reachable ? REACHABLE_TTL_MS : UNREACHABLE_TTL_MS)) {
    return cached.reachable;
  }
  const latency = await tcpProbe(host, SMB_PORT, 2000);
  const reachable = latency !== null;
  reachabilityCache.set(host, { reachable, checkedAt: now });
  return reachable;
}

/** Drop the cached probe result, e.g. after the user edits the server name. */
export function invalidateArchiveReachability(): void {
  reachabilityCache.clear();
}

/** The fields that reach a command line or a URL. The password is deliberately not
 *  among them: it legitimately contains any character, and `sanitizePath` would reject
 *  good ones. */
function assertSafeCredentials(network: ArchiveNetworkCredentials): void {
  sanitizePath(network.host);
  sanitizePath(network.share);
  if (network.domain) sanitizePath(network.domain);
  if (network.username) sanitizePath(network.username);
}

/**
 * Which field a rejected address came from, in words that say what to do about it.
 *
 * The generic message this replaces ("that address contains characters that cannot be
 * used") was correct and useless: the commonest way to trigger it is pasting
 * `\\192.168.1.12\Nebulis2` into the server field, where the address is fine and the
 * field is wrong. The caller needs to hear which one.
 */
export function unsafeField(network: ArchiveNetworkCredentials): string | null {
  try {
    assertSafeCredentials(network);
    return null;
  } catch {
    // Which one is at fault, without echoing the value back (it may be a credential).
    for (const [field, value] of [
      ['host', network.host],
      ['share', network.share],
      ['domain', network.domain],
      ['username', network.username],
    ] as const) {
      if (value === '') continue;
      try {
        sanitizePath(value);
      } catch {
        if (field !== 'host') return `That ${field} contains characters that cannot be used.`;
        return /[\\/]/.test(value)
          ? 'The server address cannot contain a backslash or a slash. Enter the address on its own, for example 192.168.1.12, and put the share in the next field.'
          : 'The server address contains characters that cannot be used. A name, an IP address, or either with a :port is what this field takes.';
      }
    }
    return 'That address contains characters that cannot be used.';
  }
}

/* ─── Windows: net use ─────────────────────────────────────────────────────── */

async function connectWindowsRaw(network: ArchiveNetworkCredentials): Promise<void> {
  // A guest share is reached over UNC with no session at all, so only a
  // password-protected share needs `net use`.
  if (!network.password) return;
  const userArg = network.domain ? `${network.domain}\\${network.username}` : network.username || 'guest';
  await execFileAsync(
    'net',
    ['use', uncRootOf(network), network.password, `/user:${userArg}`, '/persistent:no'],
    { timeout: 15_000 },
  );
}

/* ─── macOS: mount_smbfs onto a fixed directory ────────────────────────────── */

function buildMountUrl(network: ArchiveNetworkCredentials): string {
  const enc = encodeURIComponent;
  const user = network.username || 'guest';
  const pass = network.password || '';
  // Always include user:pass@ explicitly, even with an empty password: without it
  // mount_smbfs falls back to the session's Kerberos credentials, which most NAS
  // shares reject.
  const auth = network.domain ? `${enc(network.domain)};${enc(user)}:${enc(pass)}` : `${enc(user)}:${enc(pass)}`;
  return `//${auth}@${network.host}/${enc(network.share)}`;
}

async function isMountedAtArchiveDir(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('mount', []);
    return stdout.split('\n').some(line => line.includes(` on ${ARCHIVE_NETWORK_MOUNT_DIR} (`));
  } catch {
    return false;
  }
}

// The config we last connected, so a credential or host change triggers a remount.
// Reset on restart; a mount inherited from a previous run is verified by its share.
let macMountedKey: string | null = null;

function keyOf(network: ShareAddress): string {
  return `${network.host}|${network.share}|${network.domain}|${network.username}`;
}

const MOUNT_LIVENESS_TIMEOUT_MS = 4_000;

/** Whether the mount point answers a bounded call *and* is a directory.
 *
 *  A stat rather than an access check on purpose. `access` succeeds on a plain file,
 *  and the case this function exists for is a path that exists but is not a usable
 *  directory: a stale mount entry whose share is gone, or a mount point that a failed
 *  mount left as something else. Only meaningful once the mount table shows a mount
 *  there. */
async function isMountLive(): Promise<boolean> {
  try {
    const stats = await raceTimeout(fsp.stat(ARCHIVE_NETWORK_MOUNT_DIR), MOUNT_LIVENESS_TIMEOUT_MS);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * The share's own root, which is what a bounded probe can be made against: the
 * configured subpath may legitimately not exist yet, and a missing folder is not a
 * broken share.
 */
function shareRootOf(network: ShareAddress): string {
  return process.platform === 'darwin' ? ARCHIVE_NETWORK_MOUNT_DIR : uncRootOf(network);
}

/** A bounded, asynchronous call against the share root.
 *
 *  Asynchronous because this is the only thing standing between a wedged share and
 *  the synchronous marker and manifest reads that follow: on Windows there is no mount
 *  table at all, so this probe is the entire guard, and a `stat` that hangs would hang
 *  the event loop. Bounded because a share can answer TCP and still never answer I/O. */
async function isShareRootUsable(network: ShareAddress): Promise<boolean> {
  try {
    const stats = await raceTimeout(fsp.stat(shareRootOf(network)), MOUNT_LIVENESS_TIMEOUT_MS);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/** Best-effort check that the mount at our directory points at `network`'s share,
 *  for a mount inherited from a previous process whose key we do not know. A false
 *  negative costs a harmless remount; a false positive is caught later by the
 *  marker check. */
async function mountedShareMatches(network: ShareAddress): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('mount', [], { timeout: 5_000 });
    const marker = ` on ${ARCHIVE_NETWORK_MOUNT_DIR} (`;
    const line = stdout.split('\n').find(l => l.includes(marker));
    if (!line) return false;
    const src = line.slice(0, line.indexOf(marker)).toLowerCase();
    const host = network.host.trim().toLowerCase();
    const share = network.share.trim().toLowerCase();
    const shareEnc = encodeURIComponent(network.share.trim()).toLowerCase();
    const hostOk = src.includes(`@${host}/`) || src.includes(`//${host}/`);
    const shareOk = src.endsWith(`/${share}`) || src.endsWith(`/${shareEnc}`);
    return hostOk && shareOk;
  } catch {
    return false;
  }
}

async function mountBelongsToConfig(network: ShareAddress, key: string): Promise<boolean> {
  if (macMountedKey === key) return true;
  if (macMountedKey !== null) return false;
  return mountedShareMatches(network);
}

/** Force a wedged mount down (`-f` where a plain umount would hang), bounded so a
 *  truly stuck unmount cannot block the caller. Never throws. */
async function forceUnmount(): Promise<void> {
  await execFileAsync('umount', ['-f', ARCHIVE_NETWORK_MOUNT_DIR], { timeout: 10_000 }).catch(() => {});
}

async function connectMacRaw(network: ArchiveNetworkCredentials): Promise<void> {
  fs.mkdirSync(ARCHIVE_NETWORK_MOUNT_DIR, { recursive: true });
  const key = keyOf(network);

  if (await isMountedAtArchiveDir()) {
    const live = await isMountLive();
    if (live && (await mountBelongsToConfig(network, key))) {
      macMountedKey = key;
      return;
    }
    // Tear down before remounting. Force only when the mount is wedged, because a
    // plain umount fails safely on a busy mount and so cannot yank a read out from
    // under an open handle.
    if (live) {
      await execFileAsync('umount', [ARCHIVE_NETWORK_MOUNT_DIR], { timeout: 10_000 });
    } else {
      await forceUnmount();
    }
  }

  await execFileAsync('mount_smbfs', [buildMountUrl(network), ARCHIVE_NETWORK_MOUNT_DIR], { timeout: 15_000 });
  macMountedKey = key;
}

/** Unmount and forget the tracked key, e.g. when the destination changes or the
 *  feature is switched off. Best-effort; never throws. */
export async function disconnectArchiveNetwork(): Promise<void> {
  if (process.platform !== 'darwin') return;
  macMountedKey = null;
  await execFileAsync('umount', [ARCHIVE_NETWORK_MOUNT_DIR], { timeout: 10_000 }).catch(() => {});
}

/**
 * Whether the mount table says a share is mounted on our directory.
 *
 * The table half of readiness, and not sufficient on its own: a dropped share leaves
 * its entry behind. `ensureArchiveShareReady` is the pair that decides, and it is what
 * every caller uses. This is exported because the difference between the two is worth
 * testing directly.
 *
 * On macOS this reads the mount table and never touches the potentially wedged mount
 * itself. On Windows there is no persistent mount, so it returns true and the bounded
 * UNC probe is the real signal.
 */
export async function isArchiveShareMounted(): Promise<boolean> {
  if (process.platform === 'darwin') return isMountedAtArchiveDir();
  return true;
}

/* ─── Public connect (idempotent, never throws) ───────────────────────────── */

/**
 * Best-effort connect. Returns false without a native call when the host fails the
 * reachability probe. Returns true once the host is reachable even if the connect
 * step itself failed: the caller's mount check and marker check are the real signal,
 * exactly as a disconnected USB drive is discovered by its missing marker.
 *
 * Never logs the raw error message. `execFile`'s "Command failed" text embeds the
 * full argv, which contains the plaintext password for both `net use` and
 * `mount_smbfs`.
 */
export async function ensureArchiveNetworkConnected(network: ArchiveNetworkCredentials): Promise<boolean> {
  if (!network.host.trim() || !network.share.trim()) return false;
  if (!networkArchiveSupported()) return false;

  const reachable = await isHostReachable(network.host.trim());
  if (!reachable) return false;

  try {
    assertSafeCredentials(network);
    if (process.platform === 'win32') {
      await connectWindowsRaw(network);
    } else {
      await connectMacRaw(network);
    }
  } catch (err) {
    log.warn(
      { host: network.host, share: network.share, reason: extractReason(err) },
      '[archiveNetwork] connect attempt failed',
    );
  }
  return true;
}

/**
 * Connect and then prove the share is really there.
 *
 * Three checks, because each one alone is insufficient:
 *
 *  - the connect step, so a host that is not on the network costs nothing further;
 *  - the mount table, because a dropped share leaves its entry behind and a directory
 *    that exists is exactly what must never be mistaken for the archive;
 *  - a bounded probe of the share root, because a table entry says a share *was*
 *    mounted there and a wedged share answers TCP while never answering I/O.
 *
 * The last one is also the only guard on Windows, where there is no mount table.
 */
export async function ensureArchiveShareReady(network: ArchiveNetworkCredentials): Promise<boolean> {
  if (!networkArchiveSupported()) return false;
  const reachable = await ensureArchiveNetworkConnected(network);
  if (!reachable) return false;
  if (process.platform === 'darwin' && !(await isMountedAtArchiveDir())) return false;
  return isShareRootUsable(network);
}

/* ─── Test connection (surfaces the real error, for the Settings UI) ──────── */

function stderrOf(err: Error): string {
  if ('stderr' in err && typeof err.stderr === 'string') return err.stderr;
  return '';
}

/** Turn a native failure into something a person can act on, without ever echoing
 *  the command line the password was on. */
function extractReason(err: unknown): string {
  if (!(err instanceof Error)) return 'Unknown error.';
  const msg = `${err.message} ${stderrOf(err)}`;
  // Preparing the mount point is the one failure that is about this machine rather
  // than about the share, and it is checked first because `EACCES: permission denied,
  // mkdir ...` would otherwise be read as an authentication problem.
  if (/mkdir/i.test(msg)) {
    return 'The share could not be mounted: the app could not prepare its own mount point. Check that Nebulis can write to its data folder.';
  }
  if (/connection refused/i.test(msg)) return 'Connection refused.';
  if (/timed out|timeout/i.test(msg)) return 'Connection timed out.';
  if (/auth|credentials|password|logon|denied|access is denied/i.test(msg)) {
    return 'Authentication failed. Check the username, password, and domain.';
  }
  if (/no such file|does not exist|cannot find|network path was not found|share not found/i.test(msg)) {
    return 'Share not found. Check the server address and share name.';
  }
  return 'Connection failed.';
}

export interface ArchiveNetworkTestResult {
  ok: boolean;
  reason?: string;
}

/**
 * One connect attempt against credentials that are not saved yet, for the picker's
 * Test connection button. Persists nothing.
 *
 * Reports what actually went wrong rather than a generic failure, because the whole
 * point of the button is to tell a wrong password apart from an unreachable server
 * or a missing share.
 */
export async function testArchiveNetworkConnection(
  network: ArchiveNetworkCredentials,
): Promise<ArchiveNetworkTestResult> {
  if (!network.host.trim()) return { ok: false, reason: 'Enter a server address.' };
  if (!network.share.trim()) return { ok: false, reason: 'Enter a share name.' };
  if (!networkArchiveSupported()) {
    return {
      ok: false,
      reason:
        'Network shares are not supported on this platform. Mount the share on the host and choose the mounted folder as a regular destination instead.',
    };
  }

  const unsafe = unsafeField(network);
  if (unsafe !== null) return { ok: false, reason: unsafe };

  const reachable = await isHostReachable(network.host.trim());
  if (!reachable) {
    return { ok: false, reason: `${network.host.trim()} is not reachable on the network (port ${SMB_PORT}).` };
  }

  try {
    if (process.platform === 'win32') {
      await connectWindowsRaw(network);
    } else {
      await connectMacRaw(network);
    }
  } catch (err) {
    return { ok: false, reason: extractReason(err) };
  }

  // On macOS, connected is not the same as mounted, and a failed mount is the case
  // a user is most likely to hit, so it is reported rather than assumed away.
  if (!(await isArchiveShareMounted())) {
    return { ok: false, reason: 'The share could not be mounted. Check the server address and share name.' };
  }

  // Verify the resolved directory is readable, falling back to the mount root when
  // the subpath does not exist yet: the folder is created at adopt time, so a
  // missing subpath is not an error here.
  const resolved = resolveNetworkArchiveRoot(network);
  if (!resolved.ok) {
    return { ok: false, reason: 'That folder inside the share is not usable.' };
  }
  try {
    await raceTimeout(fsp.access(resolved.root, fs.constants.R_OK), MOUNT_LIVENESS_TIMEOUT_MS);
    return { ok: true };
  } catch {
    try {
      await raceTimeout(fsp.access(ARCHIVE_NETWORK_MOUNT_DIR, fs.constants.R_OK), MOUNT_LIVENESS_TIMEOUT_MS);
      return { ok: true };
    } catch {
      return {
        ok: false,
        reason: 'The share is mounted but not readable. Check the account\'s permissions on it.',
      };
    }
  }
}
