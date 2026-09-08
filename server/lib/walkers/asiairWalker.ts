/**
 * ZWO ASIAIR folder-layout convention.
 *
 * BEST-EFFORT, UNVERIFIED. Built from ZWO's own image-transfer guide, the
 * `poto-siril` ASIAIR toolchain, and Cloudy Nights / ZWO forum reports. It has
 * not been run against a physical ASIAIR, which is what the "(Beta)" label on
 * the telescope kind is claiming. Validate against a real device before
 * dropping that label.
 *
 *   <root>/
 *     Autorun/                     unattended capture runs
 *       Light/<Target>/*.fit       the frames
 *       Dark/ Flat/ Bias/          calibration, no target folder
 *     Plan/                        same shape, for planned sequences
 *       Light/<Target>/*.fit
 *       Dark/ Flat/ Bias/
 *     Live/<Target>/               live-stacked output, when the user ran Live mode
 *     Preview/ Video/ log/         ignored
 *
 * The per-target folders are documented; the filenames ASIAIR gives its Live
 * output are not, so nothing here parses them. An undated Live file simply
 * lands at object level, the same as an unparseable SeeStar name.
 *
 * Video/ is skipped rather than guessed at: its per-target layout is
 * unconfirmed, and ASIAIR writes .avi/.ser, which Nebulis can only offer as a
 * download today.
 *
 * Two things about this layout drive the rest of the module:
 *
 * 1. **It is frame-type-first, then target** — the inverse of every other
 *    device Nebulis reads. So a single `WalkerConfig.basePath` cannot express
 *    it, and this module supplies its own discover/list/buildPath trio the way
 *    genericWalker.ts does.
 *
 * 2. **There are no session folders.** Frames from many nights sit flat in one
 *    target folder, so nights come from the filename timestamp alone. That is
 *    the same situation as SeeStar, and the import pipeline already derives
 *    nights that way.
 *
 * ASIAIR produces no stacked result unless the user ran Live mode, so
 * `Autorun`/`Plan` light frames are sub-frames (which is what they are) and
 * `Live/` output is the object's final image. Because a device whose entire
 * output is sub-frames would import as nothing under the default settings,
 * ASIAIR profiles are created with `importSubFrames` on (see telescopes.ts).
 */
import path from 'path';
import { smbListDir, type SmbEntry } from '../smb.js';
import { debugLog } from '../debugLogger.js';
import { log } from '../logger.js';
import { isObjectFolder, isRealFile, normalizeObjectId, parseFilename } from '../telescopeFiles.js';
import type { TelescopeProfile } from '../telescopes.js';
import type { DiscoveredObject } from './telescopeWalker.js';

/** Capture-mode folders that hold `Light/<Target>/` trees. */
export const ASIAIR_MODE_FOLDERS = ['Autorun', 'Plan'] as const;

/** Live-stacking output. One folder per target, holding finished stacks. */
export const ASIAIR_LIVE_FOLDER = 'Live';

/** The frame-type folder holding light frames inside a capture-mode folder. */
export const ASIAIR_LIGHT_FOLDER = 'Light';

/**
 * Calibration frame-type folders. These carry no target and are never
 * observations of anything in the sky, so they are archived verbatim rather
 * than registered as library objects — the same treatment Dwarf's
 * CALI_FRAME/DWARF_DARK get. Exported as mode-qualified relative paths because
 * that is the shape `collectRemoteArchiveCandidates` wants, and because the
 * `Autorun/`-vs-`Plan/` prefix is worth preserving in the archive.
 */
export const ASIAIR_CALIBRATION_PATHS: readonly string[] = ASIAIR_MODE_FOLDERS.flatMap(
  mode => ['Dark', 'Flat', 'Bias'].map(type => `${mode}/${type}`),
);

/** Folder the ASIAIR writes at the root of removable storage. ZWO's docs note
 *  the device stops reading the stick if this is renamed, so it is a reliable
 *  marker that we are looking at ASIAIR media rather than a bare share. */
const ASIAIR_USB_ROOT = 'ASIAir';

/** DiscoveredObject augmented with where this target's files actually live.
 *  One target can appear in Autorun, Plan and Live at once; they are one
 *  object to the user, so discovery unions them. */
export interface AsiairDiscoveredObject extends DiscoveredObject {
  /** Path prefix the whole tree sits under: '' or 'ASIAir'. Carried per object
   *  so listing never has to re-probe. */
  _asiairRoot?: string;
  /** Every place this target's frames were found. */
  _asiairSources?: AsiairSource[];
}

export interface AsiairSource {
  /** Directory holding the files, relative to the ASIAIR root:
   *  `Autorun/Light/M42`, `Plan/Light/M42`, or `Live/M42`. For a loose-file
   *  source (older firmware, no target folder) this is the containing
   *  `<mode>/Light` directory and `looseNames` says which files are ours. */
  dir: string;
  /** True for `Live/` output, which is a finished stack rather than a frame. */
  isLive: boolean;
  /** Set only for loose files: the specific basenames in `dir` belonging to
   *  this target. Absent means "every file in dir". */
  looseNames?: string[];
}

/**
 * Locate the ASIAIR tree. Over SMB the share already points at storage, so the
 * capture-mode folders sit at the root; on removable media they sit one level
 * down under `ASIAir/`. Probing rather than configuring keeps one profile
 * working across both of its transports, which is the whole point of the
 * transport layer.
 *
 * Cached per profile for the length of one import run's worth of listings, the
 * same 5-minute window smb.ftp.ts's `resolveRemoteRoot` uses. An unrecognised
 * layout falls back to the root rather than erroring, so a share pointed
 * straight at `Autorun`'s parent still works.
 */
const ROOT_CACHE_MS = 5 * 60 * 1000;
const rootCache = new Map<string, { root: string; at: number }>();

export function clearAsiairRootCache(): void {
  rootCache.clear();
}

export async function resolveAsiairRoot(profile: TelescopeProfile): Promise<string> {
  const key = profile.id;
  const cached = rootCache.get(key);
  if (cached && Date.now() - cached.at < ROOT_CACHE_MS) return cached.root;

  let root = '';
  try {
    const entries = await smbListDir('', profile);
    const usbRoot = entries.find(e => e.type === 'dir' && e.name.toLowerCase() === ASIAIR_USB_ROOT.toLowerCase());
    if (usbRoot) {
      // Only descend if it actually holds the capture-mode folders. A user
      // folder that happens to be called "ASIAir" but contains something else
      // must not silently redirect the whole import.
      const inner = await smbListDir(usbRoot.name, profile);
      const looksRight = inner.some(
        e => e.type === 'dir' && isAsiairTopLevelFolder(e.name),
      );
      if (looksRight) root = usbRoot.name;
    }
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, '[asiair-walker] root probe failed; assuming share root');
  }

  debugLog('walker:asiair', `Root resolved to "${root || '<share root>'}"`);
  rootCache.set(key, { root, at: Date.now() });
  return root;
}

function isAsiairTopLevelFolder(name: string): boolean {
  const lower = name.toLowerCase();
  return (ASIAIR_MODE_FOLDERS as readonly string[]).some(m => m.toLowerCase() === lower)
    || lower === ASIAIR_LIVE_FOLDER.toLowerCase();
}

/** Resolve a folder name case-insensitively against a listing. ASIAIR's own
 *  casing is consistent, but a tree copied through a case-preserving share or
 *  restored from a backup may not be. */
function findDir(entries: SmbEntry[], name: string): string | null {
  const hit = entries.find(e => e.type === 'dir' && e.name.toLowerCase() === name.toLowerCase());
  return hit ? hit.name : null;
}

async function listDirSafe(dir: string, profile: TelescopeProfile, context: string): Promise<SmbEntry[]> {
  try {
    return await smbListDir(dir, profile);
  } catch (err) {
    debugLog('walker:asiair', `${context}: listing "${dir}" failed — ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Discover one object per target across `Autorun/Light`, `Plan/Light` and
 * `Live`. A target present in several of those is one object, keyed on its
 * space-stripped name so `M 42` from Autorun and `M42` from Plan converge.
 * The first raw spelling seen wins as the display name, matching how the
 * SeeStar path treats folder names.
 */
export async function discoverAsiairObjects(profile: TelescopeProfile): Promise<AsiairDiscoveredObject[]> {
  const root = await resolveAsiairRoot(profile);
  const rootEntries = await listDirSafe(root, profile, 'discover');

  /** normalized target key -> object being assembled */
  const byTarget = new Map<string, AsiairDiscoveredObject>();

  const addSource = (rawName: string, source: AsiairSource): void => {
    const key = normalizeObjectId(rawName).toLowerCase();
    let obj = byTarget.get(key);
    if (!obj) {
      obj = { folderName: rawName, subFolderName: null, _asiairRoot: root, _asiairSources: [] };
      byTarget.set(key, obj);
    }
    obj._asiairSources!.push(source);
  };

  for (const mode of ASIAIR_MODE_FOLDERS) {
    const modeDir = findDir(rootEntries, mode);
    if (!modeDir) continue;
    const modeEntries = await listDirSafe(path.posix.join(root, modeDir), profile, 'discover');
    const lightDir = findDir(modeEntries, ASIAIR_LIGHT_FOLDER);
    if (!lightDir) continue;

    const lightPath = path.posix.join(root, modeDir, lightDir);
    const lightEntries = await listDirSafe(lightPath, profile, 'discover');

    for (const entry of lightEntries) {
      if (entry.type === 'dir' && isObjectFolder(entry.name)) {
        addSource(entry.name, { dir: path.posix.join(lightPath, entry.name), isLive: false });
      }
    }

    // Older firmware wrote light frames straight into Light/ with no target
    // folder. The filename still carries the target, so group by that rather
    // than dropping the frames.
    const looseByTarget = new Map<string, { raw: string; names: string[] }>();
    for (const entry of lightEntries) {
      if (entry.type !== 'file' || !isRealFile(entry.name)) continue;
      const target = parseFilename(entry.name).target;
      if (!target) continue;
      const key = normalizeObjectId(target).toLowerCase();
      const bucket = looseByTarget.get(key) ?? { raw: target, names: [] };
      bucket.names.push(entry.name);
      looseByTarget.set(key, bucket);
    }
    for (const bucket of looseByTarget.values()) {
      debugLog('walker:asiair', `${modeDir}/${lightDir}: ${bucket.names.length} loose file(s) grouped under "${bucket.raw}"`);
      addSource(bucket.raw, { dir: lightPath, isLive: false, looseNames: bucket.names });
    }
  }

  const liveDir = findDir(rootEntries, ASIAIR_LIVE_FOLDER);
  if (liveDir) {
    const livePath = path.posix.join(root, liveDir);
    for (const entry of await listDirSafe(livePath, profile, 'discover')) {
      if (entry.type === 'dir' && isObjectFolder(entry.name)) {
        addSource(entry.name, { dir: path.posix.join(livePath, entry.name), isLive: true });
      }
    }
  }

  const result = [...byTarget.values()];
  debugLog('walker:asiair', `${result.length} object(s) discovered under "${root || '<share root>'}"`);
  return result;
}

/**
 * List every file for one object across all its sources.
 *
 * `Live/` output goes into `files` (a finished stack is the object's image);
 * `Autorun`/`Plan` light frames go into `subFiles`. Entries are tagged with
 * their path relative to the ASIAIR root, so `buildAsiairFilePath` can rebuild
 * the remote path — the same tagging `listGenericObjectFiles` uses.
 */
export async function listAsiairObjectFiles(
  profile: TelescopeProfile,
  object: AsiairDiscoveredObject,
): Promise<{ files: SmbEntry[]; subFiles: SmbEntry[] }> {
  const files: SmbEntry[] = [];
  const subFiles: SmbEntry[] = [];

  for (const source of object._asiairSources ?? []) {
    const entries = await listDirSafe(source.dir, profile, 'list');
    const wanted = source.looseNames ? new Set(source.looseNames) : null;

    for (const entry of entries) {
      if (entry.type !== 'file') continue;
      if (wanted && !wanted.has(entry.name)) continue;
      // Tag with the source directory so the path can be rebuilt. The name the
      // file lands under locally is recovered from the basename in
      // import.ts — ASIAIR files keep their original names.
      const tagged: SmbEntry = { ...entry, name: `${source.dir}/${entry.name}` };
      if (source.isLive) files.push(tagged);
      else subFiles.push(tagged);
    }
  }

  debugLog('walker:asiair', `"${object.folderName}": ${files.length} live file(s), ${subFiles.length} frame(s) across ${object._asiairSources?.length ?? 0} source(s)`);
  return { files, subFiles };
}

/** `fileName` already comes back from listAsiairObjectFiles as a full path
 *  relative to the share (it includes the resolved root), so there is nothing
 *  left to prepend. Kept as a named function so the import pipeline's three
 *  walkers read the same way at the call site. */
export function buildAsiairFilePath(fileName: string): string {
  return fileName;
}

/** Strip the tagged directory prefix back off, giving the name the file keeps
 *  on disk. ASIAIR files are never renamed: they land flat in the object
 *  folder under their original basename, exactly as SeeStar's do. */
export function asiairLocalName(taggedName: string): string {
  return path.posix.basename(taggedName);
}
