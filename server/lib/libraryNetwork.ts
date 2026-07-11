/**
 * Network share (UNC/SMB) support for the library location — a sibling to the
 * local/USB relocation in `libraryPath.ts`. Reuses the same platform patterns
 * already proven for telescope SMB connections (`smb.win.ts`'s `net use` and
 * `smb.mac.ts`'s `mount_smbfs`) but is a fully independent module: it never
 * touches telescope connectivity, and telescope changes can't regress it.
 *
 * Platform support (see the phase-2 planning conversation, and CLAUDE.md):
 *   - Windows: `getLibraryDir()` returns the UNC path directly (`\\host\share\sub`);
 *     `net use` authenticates the session before every connect attempt (a no-op
 *     for guest shares or an already-authenticated session).
 *   - macOS: the app runs as a per-user LaunchAgent (see MACOS.md), so it can
 *     mount into a session with `/Volumes` access. We mount to a FIXED local
 *     directory (`{DATA_DIR}/network-library-mount`), not a temp dir, so the
 *     resolved path is stable across restarts.
 *   - Linux/Docker: not supported here. The documented path is a host-level
 *     CIFS mount bind-mounted into the container; point the library at that
 *     mounted path as a regular local location instead.
 *
 * Only the connection/path-resolution logic lives here. Credential encryption
 * (secretBox), persistence, and the `getLibraryDir()`/`isLibraryAvailable()`
 * dispatch live in `libraryPath.ts`.
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { DATA_DIR } from './paths.js';
import { sanitizePath, validatePathNoTraversal } from './smb.shared.js';
import { tcpProbe, SMB_PORT } from './smbReachability.js';
import { log } from './logger.js';

const execFileAsync = promisify(execFile);

/** Local, dependency-free timeout race (libraryPath's withTimeout can't be
 *  imported here without a cycle). Abandons the wait; the underlying fs/exec
 *  call keeps running but can no longer block the caller. */
function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      err => { clearTimeout(timer); reject(err); },
    );
  });
}

export interface NetworkLibraryConfig {
  host: string;
  share: string;
  domain: string;
  username: string;
  password: string;
  subpath: string;
}

/** Fixed macOS mount point. Never a temp dir — the resolved library path must
 *  survive restarts since it's what's stored as the effective library dir. */
export const NETWORK_MOUNT_DIR = path.join(DATA_DIR, 'network-library-mount');

// ─── Reachability (fast-fail before any native call) ───────────────────────
// Mirrors smbReachability.ts's TCP-445 preflight and TTL cache, but with
// library-appropriate wording (that module's errors hardcode "Telescope at...").

const REACHABLE_TTL_MS = 5_000;
const UNREACHABLE_TTL_MS = 5_000;
const reachabilityCache = new Map<string, { reachable: boolean; checkedAt: number }>();

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

/** Drop any cached reachability result (e.g. after the user edits the host). */
export function invalidateNetworkLibraryReachability(): void {
  reachabilityCache.clear();
}

function assertSafeConfig(cfg: NetworkLibraryConfig): void {
  sanitizePath(cfg.host);
  sanitizePath(cfg.share);
  if (cfg.domain) sanitizePath(cfg.domain);
  if (cfg.username) sanitizePath(cfg.username);
}

// ─── Path resolution (no I/O — safe to call from getLibraryDir()) ──────────

function uncRoot(cfg: NetworkLibraryConfig): string {
  return `\\\\${cfg.host}\\${cfg.share}`;
}

function resolveWindowsPath(cfg: NetworkLibraryConfig): string {
  const root = uncRoot(cfg);
  const joined = path.win32.normalize(path.win32.join(root, cfg.subpath.replace(/\//g, '\\')));
  // Defense in depth, mirroring smb.win.ts's toUncPath: a sneaky subpath that
  // slips past validation upstream should never resolve outside \\host\share.
  if (!joined.toLowerCase().startsWith(root.toLowerCase())) {
    throw new Error('Invalid network library path.');
  }
  return joined;
}

function resolveMacPath(cfg: NetworkLibraryConfig): string {
  const sub = cfg.subpath.replace(/\\/g, '/').trim();
  if (!sub) return NETWORK_MOUNT_DIR;
  validatePathNoTraversal(sub);
  return path.join(NETWORK_MOUNT_DIR, sub);
}

/** Builds the resolved library directory path. No I/O — the mount/session
 *  may or may not actually be live; call ensureNetworkLibraryConnected() first
 *  to make that true before trusting reads/writes against this path. */
export function resolveNetworkLibraryPath(cfg: NetworkLibraryConfig): string {
  assertSafeConfig(cfg);
  if (process.platform === 'win32') return resolveWindowsPath(cfg);
  if (process.platform === 'darwin') return resolveMacPath(cfg);
  throw new Error(
    'Network share library locations are not supported on this platform. Mount the share on the host and choose the mounted folder as a regular local location instead.',
  );
}

// ─── Windows: net use ───────────────────────────────────────────────────────

async function connectWindowsRaw(cfg: NetworkLibraryConfig): Promise<void> {
  // Guest/no-auth shares work via UNC through fs with no session at all — only
  // password-protected shares need net use, mirroring smb.win.ts's mountIfNeeded.
  if (!cfg.password) return;
  const userArg = cfg.domain ? `${cfg.domain}\\${cfg.username}` : cfg.username || 'guest';
  await execFileAsync(
    'net',
    ['use', uncRoot(cfg), cfg.password, `/user:${userArg}`, '/persistent:no'],
    { timeout: 15_000 },
  );
}

// ─── macOS: mount_smbfs to a fixed, stable mount point ─────────────────────

function buildMountUrl(cfg: NetworkLibraryConfig): string {
  const enc = encodeURIComponent;
  const user = cfg.username || 'guest';
  const pass = cfg.password || '';
  // Always include user:pass@ explicitly (even empty password) — without it,
  // mount_smbfs falls back to the current session's Kerberos/system
  // credentials, which most NAS shares reject. See smb.mac.ts's buildMountUrl.
  const auth = cfg.domain ? `${enc(cfg.domain)};${enc(user)}:${enc(pass)}` : `${enc(user)}:${enc(pass)}`;
  return `//${auth}@${cfg.host}/${enc(cfg.share)}`;
}

async function isMountedAtMountDir(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('mount', []);
    return stdout.split('\n').some(line => line.includes(` on ${NETWORK_MOUNT_DIR} (`));
  } catch {
    return false;
  }
}

// Tracks the config we last (re)connected, so a mid-run credential/host change
// triggers an unmount+remount. Reset on process restart; a mount inherited
// from a prior run is trusted as-is rather than torn down speculatively.
let macMountedKey: string | null = null;

function keyOf(cfg: NetworkLibraryConfig): string {
  return `${cfg.host}|${cfg.share}|${cfg.domain}|${cfg.username}`;
}

const MOUNT_LIVENESS_TIMEOUT_MS = 4_000;

/** Whether the path at NETWORK_MOUNT_DIR responds to a bounded read. Only
 *  meaningful once isMountedAtMountDir() has confirmed a mount is present: a
 *  healthy mount answers quickly, a wedged/stale one hangs until the timeout
 *  fires (so we treat it as dead and force it down). */
async function isMountLive(): Promise<boolean> {
  try {
    await raceTimeout(fsp.access(NETWORK_MOUNT_DIR, fs.constants.R_OK), MOUNT_LIVENESS_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort check that the mount currently at NETWORK_MOUNT_DIR points at
 *  `cfg`'s share, by parsing the mount table. Used only for a mount inherited
 *  from a prior process (whose key we don't know). A false negative just causes
 *  a harmless remount; a false positive is caught later by the marker check. */
async function mountedShareMatches(cfg: NetworkLibraryConfig): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('mount', [], { timeout: 5_000 });
    const marker = ` on ${NETWORK_MOUNT_DIR} (`;
    const line = stdout.split('\n').find(l => l.includes(marker));
    if (!line) return false;
    const src = line.slice(0, line.indexOf(marker)).toLowerCase(); // e.g. "//user@host/share"
    const host = cfg.host.toLowerCase();
    const share = cfg.share.toLowerCase();
    const shareEnc = encodeURIComponent(cfg.share).toLowerCase();
    const hostOk = src.includes(`@${host}/`) || src.includes(`//${host}/`);
    const shareOk = src.endsWith(`/${share}`) || src.endsWith(`/${shareEnc}`);
    return hostOk && shareOk;
  } catch {
    return false;
  }
}

/** Whether the existing mount can be kept for `cfg` instead of remounting. */
async function mountBelongsToConfig(cfg: NetworkLibraryConfig, key: string): Promise<boolean> {
  if (macMountedKey === key) return true;   // we mounted it this run for this config
  if (macMountedKey !== null) return false; // we mounted a different config this run
  return mountedShareMatches(cfg);          // inherited from a prior run: verify the share
}

/** Force a wedged/stale mount down (`-f` where a plain umount would hang),
 *  bounded so a truly stuck unmount can't block the caller. Never throws. */
async function forceUnmount(): Promise<void> {
  await execFileAsync('umount', ['-f', NETWORK_MOUNT_DIR], { timeout: 10_000 }).catch(() => {});
}

async function connectMacRaw(cfg: NetworkLibraryConfig): Promise<void> {
  fs.mkdirSync(NETWORK_MOUNT_DIR, { recursive: true });
  const key = keyOf(cfg);

  if (await isMountedAtMountDir()) {
    const live = await isMountLive();
    if (live && (await mountBelongsToConfig(cfg, key))) {
      // Healthy mount for the current config (one we made this run, or an
      // inherited one we've confirmed points at the right share).
      macMountedKey = key;
      return;
    }
    // Tear down before remounting. Force only when the mount is wedged (a plain
    // umount hangs on a stale mount). When it's live but for a different config,
    // a gentle umount fails safely if the mount is busy, so an in-flight read is
    // never yanked out from under an open handle.
    if (live) {
      await execFileAsync('umount', [NETWORK_MOUNT_DIR], { timeout: 10_000 });
    } else {
      await forceUnmount();
    }
  }

  await execFileAsync('mount_smbfs', [buildMountUrl(cfg), NETWORK_MOUNT_DIR], { timeout: 15_000 });
  macMountedKey = key;
}

/** Unmount and forget the tracked key, e.g. when switching away from a network
 *  library location entirely. Best-effort; never throws. */
export async function disconnectNetworkLibrary(): Promise<void> {
  if (process.platform !== 'darwin') return;
  macMountedKey = null;
  await execFileAsync('umount', [NETWORK_MOUNT_DIR], { timeout: 10_000 }).catch(() => {});
}

/**
 * Whether the network library is actually connected right now, cheap enough to
 * call before touching the mounted filesystem. On macOS this reads the mount
 * table for our fixed mount point (it never touches a possibly-wedged mount).
 * On Windows there is no persistent mount, so it returns true and callers rely
 * on a bounded UNC access as the real signal.
 */
export async function isNetworkLibraryMounted(): Promise<boolean> {
  if (process.platform === 'darwin') return isMountedAtMountDir();
  return true;
}

// ─── Public connect (idempotent, never throws) ─────────────────────────────

/**
 * Best-effort connect. Returns false (with no native call) when the host isn't
 * reachable, so callers can skip filesystem I/O against a dead share instead of
 * hanging a bounded stat that still ties up a libuv thread. Returns true once
 * the host is reachable even if the connect step itself failed: the caller's
 * subsequent exists+marker check against the resolved path is the real
 * availability signal, same as a disconnected USB drive today.
 */
export async function ensureNetworkLibraryConnected(cfg: NetworkLibraryConfig): Promise<boolean> {
  if (!cfg.host || !cfg.share) return false;
  if (process.platform !== 'win32' && process.platform !== 'darwin') return false;

  const reachable = await isHostReachable(cfg.host);
  if (!reachable) return false;

  try {
    if (process.platform === 'win32') {
      await connectWindowsRaw(cfg);
    } else {
      await connectMacRaw(cfg);
    }
  } catch (err) {
    // Never log err.message directly here: execFile's "Command failed: ..."
    // message includes the full argv, which embeds the plaintext password for
    // both net use and mount_smbfs. Log the sanitized reason instead.
    log.warn({ host: cfg.host, share: cfg.share, reason: extractReason(err) }, '[libraryNetwork] connect attempt failed');
  }
  return true;
}

// ─── Test connection (surfaces the real error, for the Settings UI) ───────

function extractReason(err: unknown): string {
  if (!(err instanceof Error)) return 'Unknown error.';
  const stderr = (err as { stderr?: string }).stderr ?? '';
  const msg = `${err.message} ${stderr}`;
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

export interface NetworkTestResult {
  ok: boolean;
  reason?: string;
}

/** One-off connect attempt against not-yet-saved credentials, for a "Test
 *  connection" UI button. Never persists anything. */
export async function testNetworkLibraryConnection(cfg: NetworkLibraryConfig): Promise<NetworkTestResult> {
  if (!cfg.host.trim()) return { ok: false, reason: 'Enter a server address.' };
  if (!cfg.share.trim()) return { ok: false, reason: 'Enter a share name.' };
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    return {
      ok: false,
      reason: 'Network shares are not supported on this platform. Mount the share on the host and choose the mounted folder as a regular local location instead.',
    };
  }

  try {
    assertSafeConfig(cfg);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'Invalid input.' };
  }

  const reachable = await isHostReachable(cfg.host);
  if (!reachable) return { ok: false, reason: `${cfg.host} is not reachable on the network (port ${SMB_PORT}).` };

  try {
    if (process.platform === 'win32') {
      await connectWindowsRaw(cfg);
    } else {
      await connectMacRaw(cfg);
    }
  } catch (err) {
    return { ok: false, reason: extractReason(err) };
  }

  // Verify we can actually read the share (catches wrong share name / no
  // permission even when auth itself succeeded), falling back to the share
  // root if the configured subpath doesn't exist yet.
  let dir: string;
  try {
    dir = resolveNetworkLibraryPath(cfg);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'Invalid path.' };
  }
  const root = process.platform === 'win32' ? uncRoot(cfg) : NETWORK_MOUNT_DIR;
  try {
    await fsp.access(dir, fs.constants.R_OK);
  } catch {
    try {
      await fsp.access(root, fs.constants.R_OK);
    } catch (err) {
      return { ok: false, reason: extractReason(err) };
    }
    // Share root is readable but the configured subpath doesn't exist yet —
    // that's fine, it will be created when the library is migrated there.
  }
  return { ok: true };
}
