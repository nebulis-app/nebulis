/**
 * Telescope I/O dispatcher. Routes to a platform-native SMB backend per call:
 *   - Windows      → UNC paths via Node fs (smb.win) — no binary, guest works
 *   - macOS        → mount_smbfs, built into macOS (smb.mac)
 *   - Linux/Docker → the smbclient CLI (smb.posix)
 *   - connectionType 'local' → direct filesystem reads (Dwarf USB mounts)
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
import { loadSettings } from './smb.shared.js';
import { ensureSmbReachable } from './smbReachability.js';
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
type AnySmbProfile = Pick<TelescopeProfile, 'hostname' | 'shareName' | 'username' | 'password'>;
type AnyLocalProfile = Pick<TelescopeProfile, 'localPath'>;

function isLocal(profile: AnyProfile): boolean {
  return profile?.connectionType === 'local';
}

// Fail fast when the telescope isn't on the network. Without this, an offline
// host stalls the native SMB client (mount_smbfs / smbclient / net use) on every
// call; a TCP-445 preflight rejects in milliseconds. Skipped for local (USB)
// connections, which are plain filesystem reads, and when no hostname is set
// (the backend then surfaces its own "no hostname configured" error).
async function preflight(profile: AnyProfile): Promise<void> {
  const { hostname } = loadSettings(profile as AnySmbProfile | undefined);
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
  const { hostname, shareName } = loadSettings(profile as AnySmbProfile | undefined);
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
    if (isLocal(profile)) return local.localListDir(path, profile as AnyLocalProfile);
    await preflight(profile);
    return smbImpl.smbListDir(path, profile as AnySmbProfile | undefined);
  }, entries => `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`);
}

export async function smbGetFile(path: string, maxBytes?: number, profile?: AnyProfile): Promise<Buffer> {
  return withDebugLog('getFile', path, profile, async () => {
    if (isLocal(profile)) return local.localGetFile(path, maxBytes, profile as AnyLocalProfile);
    await preflight(profile);
    return smbImpl.smbGetFile(path, maxBytes, profile as AnySmbProfile | undefined);
  }, buf => `${buf.length} bytes`);
}

export async function smbPutFile(path: string, data: Buffer, profile?: AnyProfile): Promise<void> {
  return withDebugLog('putFile', path, profile, async () => {
    if (isLocal(profile)) return local.localPutFile(path, data, profile as AnyLocalProfile);
    await preflight(profile);
    return smbImpl.smbPutFile(path, data, profile as AnySmbProfile | undefined);
  }, () => `${data.length} bytes`);
}

export async function smbDelete(path: string, profile?: AnyProfile): Promise<void> {
  return withDebugLog('delete', path, profile, async () => {
    if (isLocal(profile)) return local.localDelete(path, profile as AnyLocalProfile);
    await preflight(profile);
    return smbImpl.smbDelete(path, profile as AnySmbProfile | undefined);
  });
}
