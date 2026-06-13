/**
 * POSIX SMB implementation — uses the smbclient CLI (Linux/macOS/Docker).
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
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

type ProfileArg = Pick<TelescopeProfile, 'hostname' | 'shareName' | 'username' | 'password'> | null | undefined;

const execFileAsync = promisify(execFile);

/**
 * Extract a clean, client-safe reason from a raw smbclient error.
 * execFile rejections embed the full command line in err.message — strip that;
 * the useful signal is in err.stderr (NT_STATUS codes, connect failures, etc.).
 */
function extractSmbReason(err: unknown): string {
  if (!(err instanceof Error)) return 'Unknown error';
  const raw: string = (err as { stderr?: string }).stderr ?? err.message;
  const ntStatus = raw.match(/NT_STATUS_\w+/);
  if (ntStatus) return ntStatus[0];
  if (raw.includes('Connection refused')) return 'Connection refused';
  if (raw.includes('timed out') || raw.includes('timeout') || raw.includes('IO_TIMEOUT')) return 'Connection timed out';
  if (err.message.startsWith('No SeeStar')) return err.message;
  return 'Connection failed';
}

function buildSmbArgs(settings: SmbProfile): string[] {
  const share = `//${settings.hostname}/${settings.shareName}`;
  if (settings.password) {
    return [share, '-U', `${settings.username}%${settings.password}`];
  }
  return [share, '-N'];
}

export async function smbListDir(smbPath: string, profile?: ProfileArg): Promise<SmbEntry[]> {
  const settings = loadSettings(profile);
  if (!settings.hostname) {
    throw new Error('No SeeStar hostname configured. Please configure it in Settings.');
  }

  sanitizePath(smbPath);
  validatePathNoTraversal(smbPath);

  const args = [...buildSmbArgs(settings), '-c', `cd "${smbPath}"; ls`];

  try {
    const { stdout } = await execFileAsync('smbclient', args, { timeout: 15000 });
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
    throw new Error(`SMB connection failed: ${extractSmbReason(err)}`);
  }
}

export async function smbGetFile(smbPath: string, maxBytes?: number, profile?: ProfileArg): Promise<Buffer> {
  const settings = loadSettings(profile);
  if (!settings.hostname) {
    throw new Error('No SeeStar hostname configured');
  }

  sanitizePath(smbPath);
  validatePathNoTraversal(smbPath);

  const tmpFile = path.join(os.tmpdir(), `nebulis_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const dir = path.dirname(smbPath);
  const file = path.basename(smbPath);

  const args = [...buildSmbArgs(settings), '-c', `cd "${dir}"; get "${file}" "${tmpFile}"`];

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
    throw new Error(`SMB connection failed: ${extractSmbReason(err)}`);
  }
}

export async function smbPutFile(smbPath: string, data: Buffer, profile?: ProfileArg): Promise<void> {
  const settings = loadSettings(profile);
  if (!settings.hostname) {
    throw new Error('No SeeStar hostname configured');
  }

  sanitizePath(smbPath);
  validatePathNoTraversal(smbPath);

  // Stage the bytes in a temp file so smbclient can `put` them. Pipe-to-stdin
  // isn't reliable across smbclient builds; the temp-file dance mirrors what
  // smbGetFile does in reverse and is portable.
  const tmpFile = path.join(os.tmpdir(), `nebulis_put_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const dir = path.dirname(smbPath);
  // path.dirname returns '.' when the path is a bare filename like '.nebulis.dat'.
  // smbclient treats '.' as the share root, which is exactly what we want.
  const file = path.basename(smbPath);
  fs.writeFileSync(tmpFile, data);

  const args = [...buildSmbArgs(settings), '-c', `cd "${dir}"; put "${tmpFile}" "${file}"`];

  try {
    await execFileAsync('smbclient', args, { timeout: 30000 });
  } catch (err: unknown) {
    throw new Error(`SMB connection failed: ${extractSmbReason(err)}`);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
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

  const dir = path.dirname(smbPath);
  const file = path.basename(smbPath);

  const args = [...buildSmbArgs(settings), '-c', `cd "${dir}"; del "${file}"`];

  try {
    await execFileAsync('smbclient', args, { timeout: 15000 });
  } catch (err: unknown) {
    throw new Error(`SMB connection failed: ${extractSmbReason(err)}`);
  }
}
