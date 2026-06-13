/**
 * Detect mounted Dwarf USB storage. Both Dwarf II and Dwarf 3 expose their
 * internal storage as a USB mass-storage volume when plugged in via cable.
 * Volume names vary by firmware version, so we match loosely.
 *
 * macOS:   probes /Volumes/* and inspects each volume's root for hallmark
 *          Dwarf directories (Astronomy/, DWARF_DATA/, etc.).
 * Windows: enumerates drive letters via `wmic logicaldisk` (or PowerShell on
 *          stripped-down installs) and inspects roots the same way.
 * Linux:   probes /media/<user>/* and /mnt/*.
 *
 * Returns an empty list if nothing matches. Never throws — callers get an
 * authoritative "no Dwarf detected" rather than a stack trace.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { debugLog } from './debugLogger.js';

const execFileAsync = promisify(execFile);

export interface DwarfMount {
  /** Absolute path to the volume root (e.g. /Volumes/DWARF_3 or D:\). */
  path: string;
  /** Human-readable label shown in the UI dropdown. */
  label: string;
  /** Model detected from filesystem fingerprints; undefined when inconclusive. */
  detectedModel?: 'dwarf-2' | 'dwarf-3' | 'dwarf-mini';
}

/** Folder names whose presence at the volume root indicates a Dwarf storage. */
const DWARF_FOLDER_HINTS = ['Astronomy', 'DWARF_DATA', 'DWARF3_DATA', 'DCIM'];

/** Session-folder prefixes used to fingerprint Dwarf 3 vs Dwarf II/Mini. */
const MODEL_FINGERPRINTS: Record<'dwarf-2' | 'dwarf-3', string[]> = {
  'dwarf-3': ['DWARF3_RAW_', 'DWARF3_'],
  'dwarf-2': ['DWARF_RAW_', 'DWARF_'],
};

/**
 * Inspect a single candidate root. Returns a DwarfMount when the directory
 * actually looks like a Dwarf volume, else undefined. We deliberately check
 * for *folder* hallmarks rather than just the volume label — labels can be
 * renamed by users and aren't reliable.
 */
async function inspectRoot(root: string): Promise<DwarfMount | undefined> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    debugLog('disks:dwarf', `Cannot read ${root} — skipped`);
    return undefined;
  }

  const hasHallmark = entries.some(e => DWARF_FOLDER_HINTS.includes(e));
  if (!hasHallmark) {
    debugLog('disks:dwarf', `${root} — no Dwarf hallmarks found`);
    return undefined;
  }

  // Try to fingerprint the model from session-folder prefixes inside Astronomy/.
  // Count matches per model and pick the majority — a single Dwarf-3 folder on
  // a drive otherwise full of Dwarf-2 sessions used to mis-identify the whole
  // volume because `Object.entries` runs dwarf-3 first and we stopped on the
  // first match.
  //
  // DWARF Mini uses DWARF_RAW_ session folders (same as Dwarf II). Distinguish
  // them by the presence of CALI_FRAME/ at the volume root: Dwarf Mini and
  // Dwarf 3 have it; Dwarf II has DWARF_DARK/ instead.
  let detectedModel: DwarfMount['detectedModel'];
  const hasCaliFrame = entries.includes('CALI_FRAME');
  const astronomyDir = path.join(root, 'Astronomy');
  try {
    const sessionFolders = await fs.readdir(astronomyDir);
    const counts: Record<'dwarf-2' | 'dwarf-3', number> = { 'dwarf-2': 0, 'dwarf-3': 0 };
    for (const name of sessionFolders) {
      // Dwarf-3 prefixes are tested first because they're more specific
      // (DWARF3_RAW_ also matches DWARF_ as a substring search would).
      if (MODEL_FINGERPRINTS['dwarf-3'].some(p => name.startsWith(p))) {
        counts['dwarf-3']++;
      } else if (MODEL_FINGERPRINTS['dwarf-2'].some(p => name.startsWith(p))) {
        counts['dwarf-2']++;
      }
    }
    if (counts['dwarf-3'] > 0 || counts['dwarf-2'] > 0) {
      if (counts['dwarf-3'] >= counts['dwarf-2']) {
        detectedModel = 'dwarf-3';
      } else {
        // DWARF_RAW_ sessions could be Dwarf II or Dwarf Mini. CALI_FRAME
        // is present on Dwarf Mini (and Dwarf 3) but not on Dwarf II.
        detectedModel = hasCaliFrame ? 'dwarf-mini' : 'dwarf-2';
      }
    }
  } catch {
    // Astronomy/ may not exist on a fresh device. Hallmark still counts.
  }

  const mount: DwarfMount = {
    path: root,
    label: path.basename(root) || root,
    detectedModel,
  };
  debugLog('disks:dwarf', `${root} — Dwarf volume detected${detectedModel ? ` (${detectedModel})` : ' (model unknown)'}`);
  return mount;
}

/** Find Dwarf-shaped volumes on macOS by scanning /Volumes/. */
async function detectMacOS(): Promise<DwarfMount[]> {
  const volumes = await fs.readdir('/Volumes').catch(() => []);
  debugLog('disks:dwarf', `macOS: scanning /Volumes/ — ${volumes.length} volume(s): ${volumes.join(', ') || 'none'}`);
  const results = await Promise.all(volumes.map(v => inspectRoot(path.join('/Volumes', v))));
  return results.filter((m): m is DwarfMount => m !== undefined);
}

/** Find Dwarf-shaped volumes on Linux by scanning common mount roots. */
async function detectLinux(): Promise<DwarfMount[]> {
  const user = os.userInfo().username;
  const candidates: string[] = [];
  for (const root of [`/media/${user}`, '/media', '/mnt', '/run/media/' + user]) {
    const entries = await fs.readdir(root).catch(() => []);
    candidates.push(...entries.map(e => path.join(root, e)));
  }
  debugLog('disks:dwarf', `Linux: scanning ${candidates.length} candidate path(s)`);
  const results = await Promise.all(candidates.map(inspectRoot));
  return results.filter((m): m is DwarfMount => m !== undefined);
}

/** Find Dwarf-shaped volumes on Windows by enumerating drive letters.
 *
 * Uses `Win32_LogicalDisk` via CIM rather than `Get-PSDrive`. `Get-PSDrive`
 * reads the caller's per-session DOS device namespace, so a service running
 * in session 0 (the default for NSSM-installed Nebulis) does not see drive
 * letters mounted by the interactive user, even though direct path access
 * still works. `Win32_LogicalDisk` reads from the kernel and is
 * session-agnostic, so removable drives mounted in any session show up.
 *
 * If CIM enumeration returns nothing (rare; CIM service disabled), fall back
 * to probing C: through Z: directly. Path resolution falls through to the
 * global namespace, so this works from any session.
 */
async function detectWindows(): Promise<DwarfMount[]> {
  let drives: string[] = [];
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-Command', 'Get-CimInstance -ClassName Win32_LogicalDisk | Select-Object -ExpandProperty DeviceID'],
      { timeout: 5000 },
    );
    drives = stdout
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(s => /^[A-Za-z]:$/.test(s))
      .map(s => `${s}\\`);
  } catch {
    debugLog('disks:dwarf', 'Windows: CIM drive enumeration failed, falling back to brute-force probe');
  }
  if (drives.length === 0) {
    drives = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(letter => `${letter}:\\`);
    debugLog('disks:dwarf', `Windows: probing all drive letters C:-Z:`);
  } else {
    debugLog('disks:dwarf', `Windows: checking ${drives.length} drive(s): ${drives.join(', ')}`);
  }
  const results = await Promise.all(drives.map(inspectRoot));
  return results.filter((m): m is DwarfMount => m !== undefined);
}

export async function detectDwarfMounts(): Promise<DwarfMount[]> {
  try {
    debugLog('disks:dwarf', `Detecting Dwarf USB mounts on ${process.platform}`);
    let mounts: DwarfMount[];
    switch (process.platform) {
      case 'darwin': mounts = await detectMacOS(); break;
      case 'win32':  mounts = await detectWindows(); break;
      case 'linux':  mounts = await detectLinux(); break;
      default:       mounts = [];
    }
    if (mounts.length === 0) {
      debugLog('disks:dwarf', 'No Dwarf USB mounts found');
    } else {
      debugLog('disks:dwarf', `Found ${mounts.length} mount(s): ${mounts.map(m => `${m.path} (${m.detectedModel ?? 'unknown'})`).join(', ')}`);
    }
    return mounts;
  } catch {
    debugLog('disks:dwarf', 'Mount detection threw an unexpected error');
    return [];
  }
}
