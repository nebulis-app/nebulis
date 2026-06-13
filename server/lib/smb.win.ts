/**
 * Windows SMB implementation — uses UNC paths via Node.js fs (no smbclient required).
 *
 * On Windows, SMB shares are accessible as \\hostname\shareName\... natively.
 * For guest/no-auth shares (which the Seestar uses), this works out of the box.
 * For password-protected shares, net use mounts the credential once at startup.
 */
import fs from 'fs/promises';
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

const execFileAsync = promisify(execFile);

type Settings = SmbProfile;
type ProfileArg = Pick<TelescopeProfile, 'hostname' | 'shareName' | 'username' | 'password'> | null | undefined;

function uncRoot(settings: Settings): string {
  return `\\\\${settings.hostname}\\${settings.shareName}`;
}

function toUncPath(settings: Settings, smbPath: string): string {
  const root = uncRoot(settings);
  const joined = path.win32.normalize(path.win32.join(root, smbPath.replace(/\//g, '\\')));
  // Defense in depth: even with sanitizePath/validatePathNoTraversal upstream,
  // assert the resulting UNC path is rooted inside the configured share.
  // path.win32.normalize collapses ".." segments, so a sneaky input that
  // bypasses upstream guards would otherwise escape `\\host\share`.
  if (!joined.toLowerCase().startsWith(root.toLowerCase())) {
    throw new Error('Path traversal detected');
  }
  return joined;
}

async function mountIfNeeded(settings: Settings): Promise<void> {
  if (settings.password) {
    await execFileAsync('net', [
      'use', uncRoot(settings),
      settings.password,
      `/user:${settings.username}`,
      '/persistent:no',
    ]).catch(() => {}); // ignore — already mounted or guest share
  }
}

export async function smbListDir(smbPath: string, profile?: ProfileArg): Promise<SmbEntry[]> {
  const settings = loadSettings(profile);
  if (!settings.hostname) {
    throw new Error('No SeeStar hostname configured. Please configure it in Settings.');
  }

  sanitizePath(smbPath);
  validatePathNoTraversal(smbPath);

  await mountIfNeeded(settings);
  const uncPath = toUncPath(settings, smbPath);

  try {
    const dirents = await fs.readdir(uncPath, { withFileTypes: true });
    const entries = await Promise.all(
      dirents
        .filter(e => e.name !== '.' && e.name !== '..')
        .map(async (e): Promise<SmbEntry> => {
          const stat = await fs.stat(path.win32.join(uncPath, e.name)).catch(() => null);
          return {
            name: e.name,
            type: e.isDirectory() ? 'dir' : 'file',
            size: stat?.size,
            mtime: stat?.mtime.toISOString(),
          };
        })
    );
    return entries;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    throw new Error(`SMB connection failed: ${message}`);
  }
}

export async function smbGetFile(smbPath: string, maxBytes?: number, profile?: ProfileArg): Promise<Buffer> {
  const settings = loadSettings(profile);
  if (!settings.hostname) {
    throw new Error('No SeeStar hostname configured');
  }

  sanitizePath(smbPath);
  validatePathNoTraversal(smbPath);

  await mountIfNeeded(settings);
  const uncPath = toUncPath(settings, smbPath);

  try {
    let data = await fs.readFile(uncPath);
    if (maxBytes && data.length > maxBytes) {
      data = data.subarray(0, maxBytes);
    }
    return data;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    throw new Error(`Failed to get file: ${message}`);
  }
}

export async function smbPutFile(smbPath: string, data: Buffer, profile?: ProfileArg): Promise<void> {
  const settings = loadSettings(profile);
  if (!settings.hostname) {
    throw new Error('No SeeStar hostname configured');
  }

  sanitizePath(smbPath);
  validatePathNoTraversal(smbPath);

  await mountIfNeeded(settings);
  const uncPath = toUncPath(settings, smbPath);

  try {
    await fs.writeFile(uncPath, data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    throw new Error(`Failed to write file: ${message}`);
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

  await mountIfNeeded(settings);
  const uncPath = toUncPath(settings, smbPath);

  try {
    await fs.unlink(uncPath);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    throw new Error(`Failed to delete file: ${message}`);
  }
}
