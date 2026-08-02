/**
 * Telescope I/O dispatcher. Routes to a platform-native SMB backend per call:
 *   - Windows      → UNC paths via Node fs (smb.win) — no binary, guest works
 *   - macOS        → mount_smbfs, built into macOS (smb.mac)
 *   - Linux/Docker → the smbclient CLI (smb.posix)
 *   - connectionType 'local' → direct filesystem reads (USB mounts)
 *   - connectionType 'ftp'   → anonymous FTP (Dwarf's only network interface)
 *
 * History: the in-process @marsaud/smb2 client (smb.node) was tried to avoid an
 * external binary, but it mishandles the SeeStar's SMB2 async interim responses
 * (STATUS_PENDING) and downloads fail. The OS clients above are the proven path
 * and are used again here. smb.node is kept in the tree but no longer wired in.
 *
 * Callers don't change: the function signatures here match the SMB surface.
 */
export * from './smb.shared.js';

import * as win from './smb.win.js';
import * as mac from './smb.mac.js';
import * as posix from './smb.posix.js';
import * as local from './smb.local.js';
import * as ftp from './smb.ftp.js';
import { loadSettings } from './smb.shared.js';
import { ensureSmbReachable, recordSmbOpResult } from './smbReachability.js';
import { debugLog, isDebugLoggingEnabled } from './debugLogger.js';
import type { TelescopeProfile } from './telescopes.js';
import type { SmbEntry } from './smb.shared.js';

// Pick the native backend once at load. mount_smbfs is built into macOS; UNC is
// native on Windows; everything else (Linux, Docker) uses the smbclient CLI.
const smbImpl =
  process.platform === 'win32' ? win :
  process.platform === 'darwin' ? mac :
  posix;

type AnyProfile = Partial<Pick<TelescopeProfile, 'connectionType' | 'localPath' | 'hostname' | 'shareName' | 'username' | 'password'>> | null | undefined;

function isLocal(profile: AnyProfile): boolean {
  return profile?.connectionType === 'local';
}

function isFtp(profile: AnyProfile): boolean {
  return profile?.connectionType === 'ftp';
}

// Fail fast when the telescope isn't on the network. Without this, an offline
// host stalls the native SMB client (mount_smbfs / smbclient / net use) on every
// call; a TCP-445 preflight rejects in milliseconds. Skipped for local (USB)
// connections, which are plain filesystem reads, and when no hostname is set
// (the backend then surfaces its own "no hostname configured" error).
async function preflight(profile: AnyProfile): Promise<void> {
  const { hostname } = loadSettings(profile);
  if (!hostname) return;
  try {
    await ensureSmbReachable(hostname);
  } catch (err) {
    if (isDebugLoggingEnabled()) {
      debugLog('smb', `Preflight failed: ${hostname} not reachable on port 445 — ${err instanceof Error ? err.message : err}`);
    }
    throw err;
  }
}

// Never include credentials — only host/share identity, which op ran, timing,
// and outcome (entry/byte count or the error message).
function connectionLabel(profile: AnyProfile): string {
  if (isLocal(profile)) return `local:${profile?.localPath ?? '?'}`;
  const { hostname, shareName } = loadSettings(profile);
  if (isFtp(profile)) return `ftp://${hostname ?? '?'}`;
  return `smb://${hostname ?? '?'}/${shareName ?? '?'}`;
}

async function withDebugLog<T>(op: string, path: string, profile: AnyProfile, fn: () => Promise<T>, describe?: (result: T) => string): Promise<T> {
  // Skip building labels/timings entirely when capture is off — this wraps
  // every telescope I/O call, some of which (directory walks) are hot paths.
  if (!isDebugLoggingEnabled()) return fn();
  const start = Date.now();
  const conn = connectionLabel(profile);
  try {
    const result = await fn();
    const ms = Date.now() - start;
    debugLog('smb', `${op} ${conn} "${path}" ok in ${ms}ms${describe ? ` — ${describe(result)}` : ''}`);
    return result;
  } catch (err) {
    const ms = Date.now() - start;
    debugLog('smb', `${op} ${conn} "${path}" FAILED in ${ms}ms — ${err instanceof Error ? err.message : err}`);
    throw err;
  }
}

export async function smbListDir(path: string, profile?: AnyProfile): Promise<SmbEntry[]> {
  return withDebugLog('listDir', path, profile, async () => {
    if (isLocal(profile)) return local.localListDir(path, profile);
    if (isFtp(profile)) {
      // smb.ftp runs its own port-21 preflight; the port-445 one would reject
      // every Dwarf. Op health is still recorded so the status pill reflects
      // whether real reads work, not just whether the port answers.
      const { hostname } = loadSettings(profile);
      try {
        const entries = await ftp.ftpListDir(path, profile);
        recordSmbOpResult(hostname, true);
        return entries;
      } catch (err) {
        recordSmbOpResult(hostname, false, err instanceof Error ? err.message : String(err));
        throw err;
      }
    }
    await preflight(profile);
    // Record real-op health from listings: a directory listing succeeding is a
    // clean proxy for "auth + share access work" (it's what import discovery and
    // the settings connection-test both do). Failures here are host-level, so
    // they flip the status pill; per-file get/put/delete failures are too
    // file-specific to treat the same way and only record success below.
    const { hostname } = loadSettings(profile);
    try {
      const entries = await smbImpl.smbListDir(path, profile);
      recordSmbOpResult(hostname, true);
      return entries;
    } catch (err) {
      recordSmbOpResult(hostname, false, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }, entries => `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`);
}

export async function smbGetFile(path: string, maxBytes?: number, profile?: AnyProfile): Promise<Buffer> {
  return withDebugLog('getFile', path, profile, async () => {
    if (isLocal(profile)) return local.localGetFile(path, maxBytes, profile);
    if (isFtp(profile)) {
      const buf = await ftp.ftpGetFile(path, maxBytes, profile);
      recordSmbOpResult(loadSettings(profile).hostname, true);
      return buf;
    }
    await preflight(profile);
    const buf = await smbImpl.smbGetFile(path, maxBytes, profile);
    // Success proves the share is usable; a failed get can be file-specific
    // (missing file, bad path) so it is not recorded as host-level health.
    recordSmbOpResult(loadSettings(profile).hostname, true);
    return buf;
  }, buf => `${buf.length} bytes`);
}

/** Copy a file straight to `destPath` without staging it in memory. Supported
 *  on the local (USB) transport, which is already a filesystem, and on FTP,
 *  where basic-ftp can stream the data socket to a file. Callers must check
 *  `supportsStreamedCopy(profile)` first — the SMB backends go through a
 *  native client that has no such path and must use smbGetFile instead. */
export async function smbCopyFileTo(path: string, destPath: string, profile?: AnyProfile): Promise<void> {
  if (isFtp(profile)) {
    return withDebugLog('copyFileTo', path, profile, () => ftp.ftpCopyFileTo(path, destPath, profile));
  }
  if (!isLocal(profile)) {
    throw new Error('smbCopyFileTo is only supported for local (USB) and FTP transports.');
  }
  return withDebugLog('copyFileTo', path, profile, () => local.localCopyFileTo(path, destPath, profile));
}

/** True when smbCopyFileTo can stream this transport straight to disk. The
 *  import pipeline branches on this to avoid buffering multi-hundred-MB FITS
 *  and video files in memory. */
export function supportsStreamedCopy(profile?: AnyProfile): boolean {
  return isLocal(profile) || isFtp(profile);
}

export async function smbPutFile(path: string, data: Buffer, profile?: AnyProfile): Promise<void> {
  return withDebugLog('putFile', path, profile, async () => {
    if (isLocal(profile)) return local.localPutFile(path, data, profile);
    if (isFtp(profile)) {
      await ftp.ftpPutFile(path, data, profile);
      recordSmbOpResult(loadSettings(profile).hostname, true);
      return;
    }
    await preflight(profile);
    await smbImpl.smbPutFile(path, data, profile);
    // Success proves the share is writable; a failed put can be file-specific
    // (permissions on one path) so it is not recorded as host-level health.
    recordSmbOpResult(loadSettings(profile).hostname, true);
  }, () => `${data.length} bytes`);
}

export async function smbDelete(path: string, profile?: AnyProfile): Promise<void> {
  return withDebugLog('delete', path, profile, async () => {
    if (isLocal(profile)) return local.localDelete(path, profile);
    if (isFtp(profile)) return ftp.ftpDelete(path, profile);
    await preflight(profile);
    return smbImpl.smbDelete(path, profile);
  });
}
