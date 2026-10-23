/**
 * POSIX SMB implementation — uses the smbclient CLI (Linux/macOS/Docker).
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  type SmbEntry,
  type SmbProfile,
  parseShareName,
  scrubSmbSecrets,
  classifySmbError,
  withSmbGuards,
} from './smb.shared.js';
import type { TelescopeProfile } from './telescopes.js';
import { childProcessOutput } from './errors.js';
import { debugLog, isDebugLoggingEnabled } from './debugLogger.js';

type ProfileArg = Partial<Pick<TelescopeProfile, 'hostname' | 'shareName' | 'username' | 'password'>> | null | undefined;

const execFileAsync = promisify(execFile);

/** @deprecated use `scrubSmbSecrets` from smb.shared.ts. Kept as the name the
 *  tests and older imports use. */
export const scrubSmbArgs = scrubSmbSecrets;

/** smbclient-specific wrapper around the shared classifier. */
export function extractSmbReason(err: unknown): string {
  return classifySmbError(err, 'smbclient');
}

// Rate-limit the server.log line: a flaky share or a sleeping device can fail
// on every file in an import, and one raw dump per failure would bury the log.
// The debug-import log (below) is unthrottled — it only runs when a user has
// explicitly turned capture on to reproduce a problem.
/** `smbclient ls` output is parsed from stdout in one piece, and Node's
 *  default child-stdout cap is 1 MiB (roughly 10k entries). A larger
 *  directory aborted the child with ERR_CHILD_PROCESS_STDIO_MAXBUFFER,
 *  which the error classifier reduced to a generic "SMB connection
 *  failed" message, so discovery silently found nothing and an import
 *  reported an empty device. Generous but bounded: the app targets
 *  hundreds of thousands of files, and a 200k-entry listing is about
 *  20 MB. */
const SMB_LIST_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

const lastWarnByKey = new Map<string, number>();
const WARN_DEDUPE_MS = 60_000;

/** Build the Error thrown for a failed smbclient run, and record the raw
 *  (credential-scrubbed) smbclient output so the reason is recoverable:
 *
 *   - the debug-import log gets the full output whenever capture is on (this is
 *     the artifact users export and paste into bug reports);
 *   - server.log gets a concise, deduped line so a normal flaky run doesn't
 *     spam it. Mirrors the `console.warn` in smb.mac.ts.
 *
 *  The Error message itself stays the short classified summary. */
function smbFailure(err: unknown, op: string, conn: string): Error {
  const combined = scrubSmbArgs(`${childProcessOutput(err, 'stderr') ?? ''} ${childProcessOutput(err, 'stdout') ?? ''}`.trim())
    || (err instanceof Error ? scrubSmbArgs(err.message) : String(err));
  const oneLine = combined.replace(/\s+/g, ' ').trim().slice(0, 800);
  const reason = extractSmbReason(err);

  if (isDebugLoggingEnabled()) {
    debugLog('smb', `${op} ${conn} failed — ${reason}${oneLine ? ` | smbclient: ${oneLine}` : ''}`);
  }

  const warnKey = `${op}\u0000${conn}`;
  const now = Date.now();
  if ((lastWarnByKey.get(warnKey) ?? 0) + WARN_DEDUPE_MS < now) {
    lastWarnByKey.set(warnKey, now);
    console.warn(`[smb] smbclient ${op} ${conn} failed: ${reason}${oneLine ? ` — ${oneLine.slice(0, 300)}` : ''}`);
  }

  return new Error(`SMB connection failed: ${reason}`);
}

/** Prefix a path inside the share with the configured subpath. smbclient's
 *  service argument takes `//server/share` and nothing more, so a folder
 *  inside the share has to be reached by `cd` once connected. */
function remoteDir(settings: SmbProfile, dir: string): string {
  const { subpath } = parseShareName(settings.shareName);
  if (!subpath) return dir;
  if (!dir || dir === '.') return subpath;
  return `${subpath}/${dir}`;
}

/** Host/share identity for a log line. Never includes credentials. */
function connLabel(settings: SmbProfile): string {
  let share = settings.shareName;
  try { share = parseShareName(settings.shareName).share; } catch { /* keep raw */ }
  return `//${settings.hostname}/${share}`;
}

function buildSmbArgs(settings: SmbProfile): string[] {
  const share = `//${settings.hostname}/${parseShareName(settings.shareName).share}`;
  if (settings.password) {
    return [share, '-U', `${settings.username}%${settings.password}`];
  }
  return [share, '-N'];
}

export async function smbListDir(smbPath: string, profile?: ProfileArg): Promise<SmbEntry[]> {
  return withSmbGuards(smbPath, profile, async (settings) => {
  const args = [...buildSmbArgs(settings), '-c', `cd "${remoteDir(settings, smbPath)}"; ls`];

  try {
    const { stdout } = await execFileAsync('smbclient', args, {
      timeout: 15000,
      // See SMB_LIST_MAX_BUFFER_BYTES: the default 1 MiB cap silently
      // truncates discovery on a large flat directory.
      maxBuffer: SMB_LIST_MAX_BUFFER_BYTES,
    });
    const entries: SmbEntry[] = [];

    for (const line of stdout.split('\n')) {
      // smbclient ls format:
      //   M42                      D        0  Sat Mar 29 01:23:45 2026
      //   Stacked_150_M42.jpg      A   123456  Sat Mar 29 01:23:45 2026
      //
      // Earlier regex used the first run of 2+ spaces as the name terminator,
      // which truncated filenames containing internal double spaces (rare on
      // SeeStar firmware, but possible when users rename objects). Anchor on
      // the trailing date token instead and derive the name from the head so
      // internal whitespace is preserved.
      const tailMatch = line.match(/\s+([A-Z]*)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s*$/);
      if (!tailMatch || tailMatch.index === undefined) continue;
      const headPart = line.slice(0, tailMatch.index);
      const headMatch = headPart.match(/^\s{2}(.+?)\s*$/);
      if (!headMatch) continue;
      const name = headMatch[1].trim();
      if (name === '.' || name === '..') continue;
      const attrs = tailMatch[1];
      const sizeStr = tailMatch[2];
      const dateStr = tailMatch[3];
      const isDir = attrs.includes('D');
      let mtime: string | undefined;
      try {
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) mtime = d.toISOString();
      } catch { /* ignore parse failures */ }
      entries.push({
        name,
        type: isDir ? 'dir' : 'file',
        size: parseInt(sizeStr),
        mtime,
      });
    }
    return entries;
  } catch (err: unknown) {
    throw smbFailure(err, 'ls', connLabel(settings));
  }
  });
}

export async function smbGetFile(smbPath: string, maxBytes?: number, profile?: ProfileArg): Promise<Buffer> {
  return withSmbGuards(smbPath, profile, async (settings) => {
  const tmpFile = path.join(os.tmpdir(), `nebulis_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const dir = path.dirname(smbPath);
  const file = path.basename(smbPath);

  const args = [...buildSmbArgs(settings), '-c', `cd "${remoteDir(settings, dir)}"; get "${file}" "${tmpFile}"`];

  try {
    await execFileAsync('smbclient', args, { timeout: 300_000 });
    let data = fs.readFileSync(tmpFile);
    fs.unlinkSync(tmpFile);

    if (maxBytes && data.length > maxBytes) {
      data = data.subarray(0, maxBytes);
    }

    return data;
  } catch (err: unknown) {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    throw smbFailure(err, 'get', connLabel(settings));
  }
  });
}

export async function smbPutFile(smbPath: string, data: Buffer, profile?: ProfileArg): Promise<void> {
  return withSmbGuards(smbPath, profile, async (settings) => {
  // Stage the bytes in a temp file so smbclient can `put` them. Pipe-to-stdin
  // isn't reliable across smbclient builds; the temp-file dance mirrors what
  // smbGetFile does in reverse and is portable.
  const tmpFile = path.join(os.tmpdir(), `nebulis_put_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const dir = path.dirname(smbPath);
  // path.dirname returns '.' when the path is a bare filename like '.nebulis.dat'.
  // smbclient treats '.' as the share root, which is exactly what we want.
  const file = path.basename(smbPath);
  fs.writeFileSync(tmpFile, data);

  const args = [...buildSmbArgs(settings), '-c', `cd "${remoteDir(settings, dir)}"; put "${tmpFile}" "${file}"`];

  try {
    await execFileAsync('smbclient', args, { timeout: 30000 });
  } catch (err: unknown) {
    throw smbFailure(err, 'put', connLabel(settings));
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
  });
}

export async function smbDelete(smbPath: string, profile?: ProfileArg): Promise<void> {
  return withSmbGuards(smbPath, profile, async (settings) => {
  const dir = path.dirname(smbPath);
  const file = path.basename(smbPath);

  const args = [...buildSmbArgs(settings), '-c', `cd "${remoteDir(settings, dir)}"; del "${file}"`];

  try {
    await execFileAsync('smbclient', args, { timeout: 15000 });
  } catch (err: unknown) {
    throw smbFailure(err, 'del', connLabel(settings));
  }
  }, { requireInsideBasePath: true });
}
