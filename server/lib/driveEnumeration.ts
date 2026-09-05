/**
 * Generic mounted-drive detection for telescope eMMC volumes (Seestar and
 * Dwarf). Mirrors dwarfMounts.ts but returns a richer shape so the UI can
 * surface "Looks like a Seestar" badges and "Already added as <name>" pills.
 *
 * Seestar detection: the device exposes its share root with `MyWorks/` at
 * the top. Same convention SMB uses, so the heuristic doubles as the path
 * the walker will read.
 *
 * Dwarf detection: reuses the folder hints from dwarfMounts (Astronomy/,
 * DWARF_DATA/, etc.).
 *
 * Windows enumeration uses `Win32_LogicalDisk` via CIM — session-agnostic,
 * unlike `Get-PSDrive`. See the dwarfMounts header for the NSSM rationale.
 */
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { debugLog } from './debugLogger.js';
import db from './db.js';

const execFileAsync = promisify(execFile);

export interface DetectedDrive {
  /** Absolute path to the volume root (e.g. /Volumes/SEESTAR or D:\). */
  mountPath: string;
  /** Volume basename, suitable for the UI. */
  volumeName: string;
  /** True when root contains `MyWorks/`. */
  looksLikeSeestar: boolean;
  /** True when root contains a Dwarf hallmark folder. */
  looksLikeDwarf: boolean;
  /** True when root looks like ASIAIR removable storage. */
  looksLikeAsiair: boolean;
  /** Set when the ASIAIR tree sits under an `ASIAir/` folder rather than at the
   *  volume root, so the caller can point a `local` transport at the right
   *  directory instead of the mount point. */
  asiairSubPath?: string;
  /** Best-guess Dwarf model from session folder fingerprints. Seestar can't be
   *  distinguished S50 vs S30 from the filesystem alone. */
  detectedDwarfModel?: 'dwarf-2' | 'dwarf-3' | 'dwarf-mini';
  /** Populated when a `.nebulis.dat` is present at the root. */
  alreadyKnownDeviceId: string | null;
  /** Populated when alreadyKnownDeviceId matches a telescopeProfiles row. */
  alreadyKnownProfileId: string | null;
  /** Profile name (when known), for the "Already added as <name>" pill. */
  alreadyKnownProfileName: string | null;
}

const SEESTAR_HALLMARK_DIR = 'MyWorks';
/** ASIAIR's capture-mode folders. Any one of them at a volume root (or inside
 *  the `ASIAir/` folder the device writes on removable media) identifies the
 *  storage. `Live` is included so a Live-only user's stick is still detected. */
const ASIAIR_HALLMARK_DIRS = ['Autorun', 'Plan', 'Live'];
const ASIAIR_USB_ROOT_DIR = 'ASIAir';
const DWARF_FOLDER_HINTS = ['Astronomy', 'DWARF_DATA', 'DWARF3_DATA', 'DCIM'];
const DWARF_MODEL_FINGERPRINTS: Record<'dwarf-2' | 'dwarf-3', string[]> = {
  'dwarf-3': ['DWARF3_RAW_', 'DWARF3_'],
  'dwarf-2': ['DWARF_RAW_', 'DWARF_'],
};

const profileByDeviceIdStmt = db.prepare<[string], { id: string; name: string }>(
  'SELECT id, name FROM telescopeProfiles WHERE deviceId = ?',
);

async function readDeviceIdAtRoot(root: string): Promise<string | null> {
  // Best-effort. No writes. Caps the read at 8 KB to avoid pulling in
  // anything large that happens to be named .nebulis.dat.
  try {
    const handle = await fs.open(path.join(root, '.nebulis.dat'), 'r');
    try {
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await handle.read(buf, 0, 8192, 0);
      const text = buf.subarray(0, bytesRead).toString('utf8');
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && 'deviceId' in parsed) {
        const id = (parsed as { deviceId: unknown }).deviceId;
        return typeof id === 'string' && id.length > 0 ? id : null;
      }
      return null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function inspectRoot(root: string): Promise<DetectedDrive | undefined> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    debugLog('disks:detect', `Cannot read ${root} — skipped`);
    return undefined;
  }

  const entrySet = new Set(entries);
  const looksLikeSeestar = entrySet.has(SEESTAR_HALLMARK_DIR);
  const looksLikeDwarf = DWARF_FOLDER_HINTS.some(h => entrySet.has(h));

  // ASIAIR: capture-mode folders either at the volume root or one level down
  // under `ASIAir/`, which is what the device writes on a stick. Checked
  // against the real directory listing rather than a stat of a guessed name so
  // the `ASIAir` casing does not have to be exact.
  let looksLikeAsiair = ASIAIR_HALLMARK_DIRS.some(h => entrySet.has(h));
  let asiairSubPath: string | undefined;
  if (!looksLikeAsiair) {
    const usbRoot = entries.find(e => e.toLowerCase() === ASIAIR_USB_ROOT_DIR.toLowerCase());
    if (usbRoot) {
      const inner = await fs.readdir(path.join(root, usbRoot)).catch(() => [] as string[]);
      if (ASIAIR_HALLMARK_DIRS.some(h => inner.includes(h))) {
        looksLikeAsiair = true;
        asiairSubPath = usbRoot;
      }
    }
  }

  if (!looksLikeSeestar && !looksLikeDwarf && !looksLikeAsiair) return undefined;

  let detectedDwarfModel: DetectedDrive['detectedDwarfModel'];
  if (looksLikeDwarf) {
    // DWARF Mini uses DWARF_RAW_ session folders (same as Dwarf II). Distinguish
    // them by CALI_FRAME/ at the volume root: present on Dwarf Mini and Dwarf 3,
    // absent on Dwarf II (which has DWARF_DARK/ instead).
    const hasCaliFrame = entrySet.has('CALI_FRAME');
    try {
      const sessionFolders = await fs.readdir(path.join(root, 'Astronomy'));
      const counts: Record<'dwarf-2' | 'dwarf-3', number> = { 'dwarf-2': 0, 'dwarf-3': 0 };
      for (const name of sessionFolders) {
        if (DWARF_MODEL_FINGERPRINTS['dwarf-3'].some(p => name.startsWith(p))) counts['dwarf-3']++;
        else if (DWARF_MODEL_FINGERPRINTS['dwarf-2'].some(p => name.startsWith(p))) counts['dwarf-2']++;
      }
      if (counts['dwarf-3'] > 0 || counts['dwarf-2'] > 0) {
        if (counts['dwarf-3'] >= counts['dwarf-2']) {
          detectedDwarfModel = 'dwarf-3';
        } else {
          detectedDwarfModel = hasCaliFrame ? 'dwarf-mini' : 'dwarf-2';
        }
      }
    } catch {
      // Astronomy/ absent on a fresh device. Hallmark folder still counts.
    }
  }

  const alreadyKnownDeviceId = await readDeviceIdAtRoot(root);
  let alreadyKnownProfileId: string | null = null;
  let alreadyKnownProfileName: string | null = null;
  if (alreadyKnownDeviceId) {
    const row = profileByDeviceIdStmt.get(alreadyKnownDeviceId);
    if (row) {
      alreadyKnownProfileId = row.id;
      alreadyKnownProfileName = row.name;
    }
  }

  return {
    mountPath: root,
    volumeName: path.basename(root) || root,
    looksLikeSeestar,
    looksLikeDwarf,
    looksLikeAsiair,
    asiairSubPath,
    detectedDwarfModel,
    alreadyKnownDeviceId,
    alreadyKnownProfileId,
    alreadyKnownProfileName,
  };
}

async function detectMacOS(): Promise<DetectedDrive[]> {
  const volumes = await fs.readdir('/Volumes').catch(() => []);
  const results = await Promise.all(volumes.map(v => inspectRoot(path.join('/Volumes', v))));
  return results.filter((d): d is DetectedDrive => d !== undefined);
}

async function detectLinux(): Promise<DetectedDrive[]> {
  const user = os.userInfo().username;
  const candidates: string[] = [];
  for (const root of [`/media/${user}`, '/media', '/mnt', `/run/media/${user}`]) {
    const entries = await fs.readdir(root).catch(() => []);
    candidates.push(...entries.map(e => path.join(root, e)));
  }
  const results = await Promise.all(candidates.map(inspectRoot));
  return results.filter((d): d is DetectedDrive => d !== undefined);
}

async function detectWindows(): Promise<DetectedDrive[]> {
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
    debugLog('disks:detect', 'Windows: CIM drive enumeration failed, falling back to brute-force probe');
  }
  if (drives.length === 0) {
    drives = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(letter => `${letter}:\\`);
  }
  const results = await Promise.all(drives.map(inspectRoot));
  return results.filter((d): d is DetectedDrive => d !== undefined);
}

export async function detectDrives(): Promise<DetectedDrive[]> {
  try {
    switch (process.platform) {
      case 'darwin': return await detectMacOS();
      case 'win32':  return await detectWindows();
      case 'linux':  return await detectLinux();
      default:       return [];
    }
  } catch {
    debugLog('disks:detect', 'Drive detection threw an unexpected error');
    return [];
  }
}
