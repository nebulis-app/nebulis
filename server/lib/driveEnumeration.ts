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
import { constants as fsConstants } from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { debugLog } from './debugLogger.js';
import { identityRootOf } from './deviceIdentity.js';
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
  /** Size of the volume, in bytes. Both 0 when it cannot be read. */
  totalBytes: number;
  freeBytes: number;
  /** Whether Nebulis can write here. A drive it cannot write to cannot be marked with a device ID. */
  writable: boolean;
  /** A Seestar volume only: how many object folders `MyWorks/` holds, and when the newest one changed (ISO). Lets
   *  someone with two telescopes plugged in tell the drives apart before the first one is marked. */
  objectFolders?: number;
  newestActivity?: string | null;
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

/** The id on the drive a telescope's path points at, wherever in it the file sits (see `identityRootOf`). */
export async function readDeviceIdNear(localPath: string): Promise<string | null> {
  const home = identityRootOf(localPath);
  return (await readDeviceIdAtRoot(home)) ?? (home !== localPath ? await readDeviceIdAtRoot(localPath) : null);
}

export async function readDeviceIdAtRoot(root: string): Promise<string | null> {
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
        const id = parsed.deviceId;
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

async function spaceOf(root: string): Promise<{ totalBytes: number; freeBytes: number }> {
  try {
    const st = await fs.statfs(root);
    return { totalBytes: Number(st.bsize) * Number(st.blocks), freeBytes: Number(st.bsize) * Number(st.bavail) };
  } catch {
    return { totalBytes: 0, freeBytes: 0 };
  }
}

/** Cap on the object folders looked at, so a drive full of targets is still a quick scan. */
const PEEK_LIMIT = 300;

async function peekSeestar(root: string): Promise<{ objectFolders: number; newestActivity: string | null }> {
  try {
    const entries = await fs.readdir(path.join(root, SEESTAR_HALLMARK_DIR), { withFileTypes: true });
    const folders = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));
    let newest = 0;
    for (const f of folders.slice(0, PEEK_LIMIT)) {
      try {
        const st = await fs.stat(path.join(root, SEESTAR_HALLMARK_DIR, f.name));
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch {
        // A folder that vanished mid-scan does not change the picture.
      }
    }
    return { objectFolders: folders.length, newestActivity: newest > 0 ? new Date(newest).toISOString() : null };
  } catch {
    return { objectFolders: 0, newestActivity: null };
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
      const inner = await fs.readdir(path.join(root, usbRoot)).catch((): string[] => []);
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

  // The ID sits where the transport's path points: the volume root, or the `ASIAir/` folder inside it.
  const alreadyKnownDeviceId = (await readDeviceIdAtRoot(root))
    ?? (asiairSubPath ? await readDeviceIdAtRoot(path.join(root, asiairSubPath)) : null);
  let alreadyKnownProfileId: string | null = null;
  let alreadyKnownProfileName: string | null = null;
  if (alreadyKnownDeviceId) {
    const row = profileByDeviceIdStmt.get(alreadyKnownDeviceId);
    if (row) {
      alreadyKnownProfileId = row.id;
      alreadyKnownProfileName = row.name;
    }
  }

  const space = await spaceOf(root);
  const writable = await fs.access(root, fsConstants.W_OK).then(() => true, () => false);
  const peek = looksLikeSeestar ? await peekSeestar(root) : undefined;

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
    ...space,
    writable,
    ...(peek ?? {}),
  };
}

/** How long one volume gets to answer. A dead network mount can block a directory read for good, and must not take the whole list with it. */
const INSPECT_TIMEOUT_MS = 8_000;

async function inspectWithin(root: string): Promise<DetectedDrive | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const slow = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), INSPECT_TIMEOUT_MS); timer.unref(); });
  try {
    return await Promise.race([inspectRoot(root), slow]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function detectMacOS(): Promise<DetectedDrive[]> {
  const volumes = await fs.readdir('/Volumes').catch(() => []);
  const results = await Promise.all(volumes.map(v => inspectWithin(path.join('/Volumes', v))));
  return results.filter((d): d is DetectedDrive => d !== undefined);
}

async function detectLinux(): Promise<DetectedDrive[]> {
  const user = os.userInfo().username;
  const candidates: string[] = [];
  for (const root of [`/media/${user}`, '/media', '/mnt', `/run/media/${user}`]) {
    const entries = await fs.readdir(root).catch(() => []);
    candidates.push(...entries.map(e => path.join(root, e)));
  }
  // `/media` and `/run/media` can be one directory behind a link; one drive must not be listed twice.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const c of candidates) {
    const real = await fs.realpath(c).catch(() => c);
    if (seen.has(real)) continue;
    seen.add(real);
    unique.push(c);
  }
  const results = await Promise.all(unique.map(inspectWithin));
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
  const results = await Promise.all(drives.map(inspectWithin));
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
