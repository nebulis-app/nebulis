/**
 * FTP implementation of the smb.ts I/O surface. Used when a telescope
 * transport sets kind = 'ftp' — the DWARFLAB devices (Dwarf II / Dwarf 3 /
 * Dwarf Mini) expose their storage over an anonymous FTP server and offer no
 * SMB share at all, so FTP is their only wireless path into the app.
 *
 * Mirrors smbListDir / smbGetFile / smbCopyFileTo / smbPutFile / smbDelete so
 * smb.ts can dispatch here without any caller changing.
 *
 * Device facts this module encodes (from DWARFLAB's own docs and the dwarfAlp
 * Alpaca driver's FTP client):
 *   - Host is 192.168.88.1 when the telescope runs its own AP; in STA mode it
 *     is whatever address the router handed it.
 *   - Port 21, passive mode, anonymous login (username "Anonymous", empty
 *     password). The firmware accepts any username.
 *   - The storage root differs per model. Dwarf 3 serves "Astronomy" at the
 *     FTP root; Dwarf II serves "/DWARF_II/Astronomy" and Dwarf Mini serves
 *     "/DWARF_mini/Astronomy". Rather than make the user pick, we probe the
 *     known prefixes once per host and cache the answer (resolveRemoteRoot).
 *
 * Connection handling: an FTP control connection is stateful and costs a TCP
 * handshake plus a login round-trip, so we keep one per transport target and
 * reuse it. Operations are serialised per target because a single control
 * socket cannot interleave commands, and the import pipeline issues them
 * concurrently. A client that errors is discarded rather than reused.
 */

import fs from 'fs/promises';
import { Readable, Writable } from 'stream';
import { Client, type FileInfo } from 'basic-ftp';
import type { SmbEntry } from './smb.shared.js';
import type { TelescopeProfile } from './telescopes.js';
import { debugLog } from './debugLogger.js';
import { tcpProbe } from './smbReachability.js';

/** DWARFLAB firmware serves FTP on the standard port. Kept as a constant so
 *  the reachability preflight and the client agree on one value. */
export const FTP_PORT = 21;

/** The device's address when it runs its own access point. UI default. */
export const DWARF_AP_HOST = '192.168.88.1';

type ProfileArg = Partial<
  Pick<TelescopeProfile, 'hostname' | 'username' | 'password'>
> | null | undefined;

interface FtpTarget {
  host: string;
  port: number;
  user: string;
  password: string;
}

/**
 * Split an optional `:port` suffix off a configured address. Almost every user
 * leaves the port alone, but the transport table has no port column and some
 * firmware builds (and every test harness) need a non-standard one, so the
 * address field accepts `host:port`. Bracketed IPv6 literals are honoured;
 * a bare IPv6 address has too many colons to disambiguate and is left whole.
 */
export function parseFtpHost(address: string): { host: string; port: number } {
  const trimmed = address.trim();
  const bracketed = /^\[(.+)\]:(\d+)$/.exec(trimmed);
  if (bracketed) return { host: bracketed[1], port: Number(bracketed[2]) };
  const idx = trimmed.lastIndexOf(':');
  if (idx > 0 && trimmed.indexOf(':') === idx) {
    const port = Number(trimmed.slice(idx + 1));
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      return { host: trimmed.slice(0, idx), port };
    }
  }
  return { host: trimmed, port: FTP_PORT };
}

/** Anonymous is the documented login. An empty username means the user never
 *  customised it, so fill in the anonymous default.
 *
 *  Note there is deliberately no per-profile "remote root" field: `shareName`
 *  carries the SMB default ("EMMC Images") on every profile and would be
 *  misread as a path here. The storage root is auto-detected instead, which
 *  covers all three Dwarf layouts without asking the user anything. */
function toTarget(profile: ProfileArg): FtpTarget {
  const address = profile?.hostname?.trim() ?? '';
  if (!address) throw new Error('FTP telescope has no hostname configured.');
  const { host, port } = parseFtpHost(address);
  return {
    host,
    port,
    user: profile?.username?.trim() || 'Anonymous',
    password: profile?.password ?? '',
  };
}

function targetKey(t: FtpTarget): string {
  return `${t.user}@${t.host}:${t.port}`;
}

/** Collapse a caller path into a POSIX remote path with no leading or
 *  trailing slash. Windows separators arrive here because the walkers build
 *  paths with path.join, which is backslash-flavoured on Windows hosts. */
function normalizeRemotePath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

/** Reject traversal and control characters before a path reaches the wire.
 *  CR/LF would let a crafted path inject a second command onto the FTP control
 *  channel; `..` would escape the device's storage root. Callers never
 *  legitimately need either. */
function assertSafeRemotePath(remotePath: string): void {
  if (remotePath.split('/').some(seg => seg === '..')) {
    throw new Error(`Path traversal rejected: ${remotePath}`);
  }
  if (/[\r\n\0]/.test(remotePath)) {
    throw new Error(`Invalid characters in path: ${remotePath}`);
  }
}

// ─── Reachability preflight ─────────────────────────────────────────────────
// Same rationale as smbReachability's port-445 probe: a dead host makes the
// FTP client burn its full connect timeout on every file in an import sweep.
// Kept separate from that module's cache so the port and the error wording
// stay FTP-specific.

const REACH_TTL_MS = 5_000;
const reachCache = new Map<string, { reachable: boolean; checkedAt: number }>();
/** Probes in flight, so a burst of concurrent operations against one host
 *  shares a single TCP probe instead of opening one socket each. Without this
 *  the cache only helps *sequential* callers, and an import sweep starting N
 *  downloads at once against a dead host would pay N connect timeouts. */
const reachInFlight = new Map<string, Promise<boolean>>();

async function ensureFtpReachable(host: string, port: number, timeoutMs = 2000): Promise<void> {
  const key = `${host}:${port}`;
  const fail = () => new Error(`Telescope at ${host} is not answering on FTP (port ${port}).`);

  const cached = reachCache.get(key);
  if (cached && Date.now() - cached.checkedAt < REACH_TTL_MS) {
    if (cached.reachable) return;
    throw fail();
  }

  let probe = reachInFlight.get(key);
  if (!probe) {
    probe = tcpProbe(host, port, timeoutMs)
      .then(latency => {
        reachCache.set(key, { reachable: latency !== null, checkedAt: Date.now() });
        return latency !== null;
      })
      .finally(() => reachInFlight.delete(key));
    reachInFlight.set(key, probe);
  }
  if (!(await probe)) throw fail();
}

// ─── Pooled, serialised client access ───────────────────────────────────────

interface Pooled {
  client: Client;
  idleTimer: NodeJS.Timeout | null;
}

/** One live control connection per target. */
const pool = new Map<string, Pooled>();
/** One operation chain per target, so commands never interleave on a socket. */
const queues = new Map<string, Promise<unknown>>();

/** Close an idle control connection after this long. Dwarf firmware drops
 *  sockets on its own schedule, so holding one open forever just means the
 *  next operation finds a dead socket and pays a reconnect anyway. */
const IDLE_CLOSE_MS = 30_000;

/** Ceiling for a single FTP operation. Large FITS subframes over the Dwarf's
 *  own AP are slow, hence the generous value; the reachability preflight is
 *  what makes a *dead* host fail fast. */
const FTP_TIMEOUT_MS = 60_000;

function discard(key: string): void {
  const entry = pool.get(key);
  if (!entry) return;
  pool.delete(key);
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.client.close();
}

function scheduleIdleClose(key: string): void {
  const entry = pool.get(key);
  if (!entry) return;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => discard(key), IDLE_CLOSE_MS);
  // Never hold the process open just to keep an idle FTP socket around.
  entry.idleTimer.unref?.();
}

async function acquire(target: FtpTarget): Promise<Client> {
  const key = targetKey(target);
  const entry = pool.get(key);
  if (entry && !entry.client.closed) {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    return entry.client;
  }
  discard(key);
  const client = new Client(FTP_TIMEOUT_MS);
  // basic-ftp's verbose mode logs the whole command stream, PASS line
  // included. Leave it off; our own debugLog calls carry what we need.
  client.ftp.verbose = false;
  await client.access({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    secure: false,
  });
  pool.set(key, { client, idleTimer: null });
  return client;
}

/** Context handed to each operation. `dispose()` marks the connection as not
 *  reusable — used when an operation deliberately aborts a transfer, which
 *  leaves the control socket in an indeterminate state. */
interface FtpContext {
  client: Client;
  dispose: () => void;
}

/**
 * Run `fn` against a connected client for `target`, serialised behind any
 * other operation on the same target.
 *
 * On failure the pooled connection is discarded (a control socket that errored
 * is not safely reusable) and the operation is retried once on a fresh
 * connection: Dwarf firmware closes idle sockets without notice, and that
 * surfaces as an error on the *next* command rather than at close time.
 */
async function withClient<T>(target: FtpTarget, fn: (ctx: FtpContext) => Promise<T>): Promise<T> {
  await ensureFtpReachable(target.host, target.port);
  const key = targetKey(target);

  const attempt = async (): Promise<T> => {
    const client = await acquire(target);
    let disposed = false;
    try {
      const result = await fn({ client, dispose: () => { disposed = true; } });
      if (disposed) discard(key);
      else scheduleIdleClose(key);
      return result;
    } catch (err) {
      discard(key);
      throw err;
    }
  };

  // Chain onto whatever is already queued for this target. `.catch` keeps a
  // failed predecessor from poisoning everything queued behind it.
  const prior = queues.get(key) ?? Promise.resolve();
  const task = prior.then(() => attempt(), () => attempt()).catch(async (err: unknown) => {
    debugLog('ftp', `Retrying after error on ${key}: ${err instanceof Error ? err.message : String(err)}`);
    return attempt();
  });
  queues.set(key, task.then(() => undefined, () => undefined));
  return task;
}

// ─── Remote root detection ──────────────────────────────────────────────────

/** Prefixes the Dwarf models serve their storage under. Probed in order; the
 *  first that contains an "Astronomy" directory wins. */
const ROOT_CANDIDATES = ['', 'DWARF_II', 'DWARF_mini', 'DWARF3', 'DWARF_3'];

/** Directory whose presence identifies a Dwarf storage root. Matches
 *  DWARF_BASE_PATH in the Dwarf walker. */
const ROOT_MARKER = 'Astronomy';

const rootCache = new Map<string, { root: string; resolvedAt: number }>();
const ROOT_TTL_MS = 5 * 60_000;

/**
 * Work out which remote prefix holds the device's storage. Returns '' (the FTP
 * root) when no marker is found, so a device with an unfamiliar layout still
 * behaves like a plain FTP server rather than failing outright.
 */
async function resolveRemoteRoot(target: FtpTarget, client: Client): Promise<string> {
  const key = targetKey(target);
  const cached = rootCache.get(key);
  if (cached && Date.now() - cached.resolvedAt < ROOT_TTL_MS) return cached.root;

  for (const candidate of ROOT_CANDIDATES) {
    let listing: FileInfo[];
    try {
      listing = await client.list(candidate === '' ? '/' : `/${candidate}`);
    } catch {
      continue;
    }
    if (listing.some(f => f.isDirectory && f.name === ROOT_MARKER)) {
      rootCache.set(key, { root: candidate, resolvedAt: Date.now() });
      debugLog('ftp', `Resolved remote root for ${key} to "${candidate || '/'}"`);
      return candidate;
    }
  }
  debugLog('ftp', `No Dwarf storage marker found on ${key}; falling back to FTP root`);
  rootCache.set(key, { root: '', resolvedAt: Date.now() });
  return '';
}

/** Drop cached reachability and root detection for an address (or everything
 *  when omitted). Called when the user edits a transport's address so a
 *  corrected typo takes effect at once, and by tests between cases. */
export function invalidateFtpCache(address?: string): void {
  if (address) {
    const { host, port } = parseFtpHost(address);
    reachCache.delete(`${host}:${port}`);
    for (const key of [...rootCache.keys()]) {
      if (key.endsWith(`@${host}:${port}`)) rootCache.delete(key);
    }
  } else {
    reachCache.clear();
    rootCache.clear();
  }
}

/** Join the detected root with a caller's device-relative path. */
function joinRemote(root: string, relPath: string): string {
  const rel = normalizeRemotePath(relPath);
  assertSafeRemotePath(rel);
  const parts = [root, rel].filter(p => p.length > 0);
  return `/${parts.join('/')}`;
}

// ─── SmbEntry mapping ───────────────────────────────────────────────────────

function toEntry(f: FileInfo): SmbEntry | null {
  // Symlinks are the only other type basic-ftp reports. The Dwarf serves none,
  // and following one could escape the storage root, so they are skipped.
  if (!f.isDirectory && !f.isFile) return null;
  return {
    name: f.name,
    type: f.isDirectory ? 'dir' : 'file',
    size: f.isFile ? f.size : undefined,
    mtime: f.modifiedAt ? f.modifiedAt.toISOString() : undefined,
  };
}

function toEntries(listing: FileInfo[]): SmbEntry[] {
  const entries: SmbEntry[] = [];
  for (const f of listing) {
    // "." and ".." appear in some servers' LIST output. They are never real
    // entries and would send the directory walkers in circles.
    if (f.name === '.' || f.name === '..') continue;
    const entry = toEntry(f);
    if (entry) entries.push(entry);
  }
  return entries;
}

// ─── Public surface (mirrors smb.local.ts) ──────────────────────────────────

export async function ftpListDir(relPath: string, profile?: ProfileArg): Promise<SmbEntry[]> {
  const target = toTarget(profile);
  return withClient(target, async ({ client }) => {
    const root = await resolveRemoteRoot(target, client);
    const remote = joinRemote(root, relPath);
    try {
      return toEntries(await client.list(remote));
    } catch (err) {
      // Match SMB and local semantics: a missing directory lists empty rather
      // than throwing, so discovery can probe optional folders freely.
      if (isNotFound(err)) return [];
      throw err;
    }
  });
}

export async function ftpGetFile(relPath: string, maxBytes?: number, profile?: ProfileArg): Promise<Buffer> {
  const target = toTarget(profile);
  const cap = maxBytes !== undefined && maxBytes > 0 ? maxBytes : null;
  return withClient(target, async ({ client, dispose }) => {
    const root = await resolveRemoteRoot(target, client);
    const remote = joinRemote(root, relPath);
    const chunks: Buffer[] = [];
    let received = 0;
    let aborted = false;

    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        chunks.push(chunk);
        received += chunk.length;
        // Header-only reads (FITS parsing, thumbnails) cap with maxBytes. FTP
        // has no ranged read, so the only way to stop early is to kill the
        // data socket. That leaves the control connection in an indeterminate
        // state, so dispose() keeps it out of the pool.
        if (cap !== null && received >= cap && !aborted) {
          aborted = true;
          dispose();
          client.ftp.dataSocket?.destroy();
        }
        cb();
      },
    });

    try {
      await client.downloadTo(sink, remote);
    } catch (err) {
      // A deliberate early stop surfaces as a transfer error. We have the bytes
      // we asked for, so it is not a failure.
      if (aborted) return Buffer.concat(chunks).subarray(0, cap ?? undefined);
      if (isNotFound(err)) throw new Error(`File not found on telescope: ${relPath}`);
      throw err;
    }
    const buf = Buffer.concat(chunks);
    return cap !== null ? buf.subarray(0, cap) : buf;
  });
}

/** Stream a remote file straight to a local destination without buffering the
 *  whole thing in memory. The import pipeline uses this for FITS and video
 *  files, which routinely run to hundreds of megabytes. */
export async function ftpCopyFileTo(relPath: string, destPath: string, profile?: ProfileArg): Promise<void> {
  const target = toTarget(profile);
  return withClient(target, async ({ client }) => {
    const root = await resolveRemoteRoot(target, client);
    const remote = joinRemote(root, relPath);
    try {
      await client.downloadTo(destPath, remote);
    } catch (err) {
      // A partial file left on disk is indistinguishable from a good import.
      await fs.rm(destPath, { force: true }).catch(() => undefined);
      if (isNotFound(err)) throw new Error(`File not found on telescope: ${relPath}`);
      throw err;
    }
  });
}

export async function ftpPutFile(relPath: string, data: Buffer, profile?: ProfileArg): Promise<void> {
  const target = toTarget(profile);
  return withClient(target, async ({ client }) => {
    const root = await resolveRemoteRoot(target, client);
    const remote = joinRemote(root, relPath);
    await client.uploadFrom(Readable.from(data), remote);
  });
}

export async function ftpDelete(relPath: string, profile?: ProfileArg): Promise<void> {
  const target = toTarget(profile);
  return withClient(target, async ({ client }) => {
    const root = await resolveRemoteRoot(target, client);
    const remote = joinRemote(root, relPath);
    try {
      await client.remove(remote);
    } catch (err) {
      // Already gone is success — matches SMB and local delete semantics.
      if (isNotFound(err)) return;
      throw err;
    }
  });
}

/**
 * Verify a device answers FTP and return what sits under `basePath`. Backs the
 * Add/Edit modal's "Test Connection" button for Dwarf profiles. Also reports
 * the detected remote root so the UI can tell the user which layout was found.
 */
export async function ftpTestConnection(
  profile: ProfileArg,
  basePath: string,
): Promise<{ entries: SmbEntry[]; remoteRoot: string }> {
  const target = toTarget(profile);
  return withClient(target, async ({ client }) => {
    const root = await resolveRemoteRoot(target, client);
    const remote = joinRemote(root, basePath);
    return { entries: toEntries(await client.list(remote)), remoteRoot: root };
  });
}

/** Close every pooled connection. Used by tests and shutdown paths so a
 *  lingering control socket doesn't keep the event loop alive. */
export function closeAllFtpConnections(): void {
  for (const key of [...pool.keys()]) discard(key);
}

/** basic-ftp surfaces server replies as errors carrying the numeric FTP code.
 *  550 covers "not found" and "not accessible"; 450 is a transient variant. */
function isNotFound(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (code === 550 || code === 450 || code === '550' || code === '450') return true;
  }
  const message = err instanceof Error ? err.message : '';
  return /no such file|not found|\b550\b/i.test(message);
}
