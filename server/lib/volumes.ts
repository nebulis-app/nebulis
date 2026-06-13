/**
 * Lists mounted volumes (drives) and their free space so the Storage settings
 * UI can offer a place to put the library, and lets the UI browse and create
 * folders under a chosen path. Unlike driveEnumeration.ts (which only surfaces
 * telescope eMMC volumes), this lists every writable volume.
 *
 * macOS:   entries under /Volumes plus the boot volume.
 * Windows: Win32_LogicalDisk via CIM (session-agnostic under the service).
 * Linux:   common removable-media mount roots (dev convenience only).
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface VolumeInfo {
  /** Absolute path to the volume root (e.g. /Volumes/MyDrive or D:\). */
  path: string;
  /** Display label. */
  label: string;
  totalBytes: number;
  freeBytes: number;
  /** Whether the service account can write here (best-effort probe). */
  writable: boolean;
  /** Removable/external media (USB, SD), as opposed to a fixed internal disk. */
  external: boolean;
}

export interface DirectoryEntry {
  name: string;
  path: string;
}

function spaceAt(p: string): { totalBytes: number; freeBytes: number } {
  try {
    const s = fs.statfsSync(p);
    return { totalBytes: Number(s.bsize) * Number(s.blocks), freeBytes: Number(s.bsize) * Number(s.bavail) };
  } catch {
    return { totalBytes: 0, freeBytes: 0 };
  }
}

function isWritable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// macOS surfaces APFS system volumes and transient disk-image mounts under
// /Volumes alongside real drives. None are useful as an import source or a
// library home, so hide them.
const MAC_SYSTEM_VOLUMES = new Set([
  'recovery', 'preboot', 'vm', 'update', 'xarts', 'iscpreboot', 'hardware',
  'com.apple.timemachine.localsnapshots',
]);

function isHiddenMacVolume(name: string): boolean {
  if (name.startsWith('.')) return true;
  if (MAC_SYSTEM_VOLUMES.has(name.toLowerCase())) return true;
  // Auto-generated mount name for an unnamed disk image, e.g. "dmg.exv6QA".
  if (/^dmg\./i.test(name)) return true;
  return false;
}

async function listMacOS(): Promise<VolumeInfo[]> {
  const names = await fsp.readdir('/Volumes').catch(() => []);
  const vols: VolumeInfo[] = [];
  for (const name of names) {
    if (isHiddenMacVolume(name)) continue;
    const full = path.join('/Volumes', name);
    try {
      const st = await fsp.stat(full);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    const space = spaceAt(full);
    vols.push({
      path: full,
      label: name,
      ...space,
      writable: isWritable(full),
      // The boot volume is symlinked into /Volumes; everything else there is
      // an attached disk or image. Good enough for a chooser.
      external: true,
    });
  }
  return vols;
}

interface WinDisk {
  DeviceID?: string;
  VolumeName?: string;
  FreeSpace?: number | string | null;
  Size?: number | string | null;
  DriveType?: number;
}

async function listWindows(): Promise<VolumeInfo[]> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,FreeSpace,Size,DriveType | ConvertTo-Json -Compress',
      ],
      { timeout: 8000 },
    );
    const parsed: unknown = JSON.parse(stdout);
    const disks: WinDisk[] = Array.isArray(parsed) ? parsed : [parsed as WinDisk];
    // DriveType: 0 unknown, 1 no root dir, 2 removable, 3 fixed, 4 network,
    // 5 optical. Optical/unknown/no-root and recovery partitions are noise.
    const HIDDEN_DRIVE_TYPES = new Set([0, 1, 5]);
    return disks
      .filter(d => typeof d.DeviceID === 'string')
      .filter(d => d.DriveType === undefined || !HIDDEN_DRIVE_TYPES.has(d.DriveType))
      .filter(d => !/recovery/i.test(d.VolumeName ?? ''))
      .map(d => {
        const root = `${d.DeviceID}\\`;
        const total = Number(d.Size ?? 0);
        const free = Number(d.FreeSpace ?? 0);
        return {
          path: root,
          label: d.VolumeName ? `${d.VolumeName} (${d.DeviceID})` : String(d.DeviceID),
          totalBytes: Number.isFinite(total) ? total : 0,
          freeBytes: Number.isFinite(free) ? free : 0,
          writable: isWritable(root),
          external: d.DriveType === 2, // 2 = removable
        };
      });
  } catch {
    return [];
  }
}

async function listLinux(): Promise<VolumeInfo[]> {
  const user = os.userInfo().username;
  const roots = [`/media/${user}`, '/media', '/mnt', `/run/media/${user}`];
  const vols: VolumeInfo[] = [];
  for (const root of roots) {
    const names = await fsp.readdir(root).catch(() => []);
    for (const name of names) {
      const full = path.join(root, name);
      try {
        if (!(await fsp.stat(full)).isDirectory()) continue;
      } catch {
        continue;
      }
      vols.push({ path: full, label: name, ...spaceAt(full), writable: isWritable(full), external: true });
    }
  }
  return vols;
}

export async function listVolumes(): Promise<VolumeInfo[]> {
  switch (process.platform) {
    case 'darwin':
      return listMacOS();
    case 'win32':
      return listWindows();
    case 'linux':
      return listLinux();
    default:
      return [];
  }
}

/** List immediate subdirectories of an existing absolute path. */
export async function listDirectories(parent: string): Promise<DirectoryEntry[]> {
  if (!path.isAbsolute(parent)) throw new Error('Path must be absolute.');
  const entries = await fsp.readdir(parent, { withFileTypes: true });
  const dirs: DirectoryEntry[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue; // hide dotfiles/system folders
    dirs.push({ name: e.name, path: path.join(parent, e.name) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  return dirs;
}
