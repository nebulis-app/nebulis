/**
 * Folder-import wizard — phase 1: scan (dry run).
 *
 * Walks a folder the server can read and produces a *plan*: which objects it
 * found, the catalog match for each, and the sessions each object's files
 * derive into (plus an "unsorted" bucket for files with no derivable date).
 * Copies nothing. The user reviews and edits the plan, then phase 2
 * (commitFolderImport in import.ts) applies it.
 *
 * The folder-walking + per-file date derivation here is shared with commit so
 * the two phases agree exactly: scan shows what commit will do.
 */
import fs from 'fs';
import path from 'path';
import {
  isObjectFolder,
  isSubFolder,
  getObjectFromSubFolder,
  normalizeCatalogId,
  isRealFile,
  observingNightDate,
} from '../telescopeFiles.js';
import { getCatalogEntry } from '../../data/catalog.js';
import {
  classifyImportFile,
  countSkip,
  summarizeSkips,
  type ImportSkipSummary,
  type SkipTally,
} from './importFilter.js';
import { planObjectFolder, groupByTarget, targetFromFileName, isNonObjectFolder } from './objectDiscovery.js';
import { deriveFileDate, confidenceForSource, type DerivedDate, type DateSource } from './dateDerivation.js';
import { isStartrailsFolder, STARTRAILS_TARGET_NAME } from './dwarfStartrails.js';
import { isDwarfSessionFolder, extractTargetFromSessionFolder, getWalkerConfig } from '../walkers/index.js';
import type { TelescopeKind } from '../telescopes.js';
import { log } from '../logger.js';

/** A source object discovered under the scan root: one library object built
 *  from one top-level folder (plus its `_sub` companion), or the root's own
 *  loose files. */
export interface ObjectSource {
  /** Folder name (or scan-root basename for loose files). Default target. */
  folderName: string;
  /** Directories whose files belong to this object (object dir + `_sub`). */
  sourceDirs: string[];
  /** When true, only top-level files of sourceDirs[0] are taken (used for the
   *  loose-files-at-root object so it doesn't swallow the object subfolders). */
  topLevelOnly: boolean;
  /** When set, only files whose basename is in this set are included. Used when
   *  a flat folder is split into per-target sources by filename parsing. */
  fileNames?: Set<string>;
}

/** What `collectObjectSources` found under a scan root. */
export interface CollectedSources {
  sources: ObjectSource[];
  /** Directory names left out because they hold no observations, so callers can
   *  tell the user instead of silently returning a shorter list. Relative to
   *  `resolvedRoot`, not to the root the caller passed in. */
  excludedFolders: string[];
  /** The directory the object level was actually found in: the given root, or
   *  the vendor base path below it when one was detected. Excluded folders are
   *  children of *this*, so archive mode needs it to locate them on disk. */
  resolvedRoot: string;
  /** Set when a known telescope's vendor base path (e.g. "Astronomy" for
   *  Dwarf) was found as a direct child of the given root and the scan
   *  descended into it instead of treating the root's own children as
   *  objects. Lets the caller tell the user why: pointing the wizard at a
   *  Dwarf volume root instead of its Astronomy/ folder used to collapse
   *  every target into one pseudo-object named after the base path. */
  basePathDetected: string | null;
}

export interface WalkedFile {
  absPath: string;
  /** Path relative to its source dir, posix-style (for the folder-date hint). */
  relPath: string;
  name: string;
  size: number;
  derived: DerivedDate;
  /** True when the file was found under a `_sub` directory. The walk already
   *  knows this (it is what gates classifyImportFile); carrying it on the file
   *  lets the commit record the same directory-wins role in libraryFiles
   *  instead of re-guessing sub-frame-ness from the name. */
  fromSubFolder: boolean;
}

export interface CatalogMatch {
  /** Normalized catalog id, e.g. "M31" — also the resulting library objectId. */
  objectId: string;
  name: string;
  type: string;
  constellation: string | null;
  magnitude: number | null;
}

export interface ScannedSession {
  date: string;
  fileCount: number;
  bytes: number;
  source: DateSource;
  confidence: 'high' | 'medium' | 'low' | 'none';
}

export interface ScannedObject {
  folderName: string;
  fileCount: number;
  bytes: number;
  sessions: ScannedSession[];
  unsortedCount: number;
  unsortedBytes: number;
  catalogMatch: CatalogMatch | null;
}

/** One reason files under the scan root will not be imported, and how many.
 *  Alias of the shared shape so the wizard and the telescope import can't
 *  drift into reporting the same skip two different ways. */
export type ScanSkip = ImportSkipSummary;

export interface ScanResult {
  rootPath: string;
  objects: ScannedObject[];
  totals: {
    objects: number;
    files: number;
    sessions: number;
    unsorted: number;
    bytes: number;
  };
  /** Files found but not importable, grouped by why, largest group first. Lets
   *  the review screen account for the gap between what the user picked and
   *  what will land, instead of just showing a shorter list. */
  skipped: ScanSkip[];
  /** Names of the top-level folders left out because they hold no observations
   *  (CALI_FRAME, RESTACKED, ...). The `non-observation-folder` skip line only
   *  carries a count, and a count with no names reads as a bug rather than a
   *  decision: the user knows exactly which folders they pointed us at. */
  excludedFolders: string[];
  /** True when the file cap was hit and the scan is incomplete. */
  truncated: boolean;
  /** Set when the scan detected the given root was a device volume root and
   *  descended into the telescope's vendor base path (e.g. "Astronomy") to
   *  find objects. Null when no descent happened, including when no
   *  telescope kind was supplied. */
  basePathDetected: string | null;
}

/** One object's decisions in the edited plan the user sends back to commit.
 *  Identified by `folderName`, which commit re-matches against the sources it
 *  re-derives from the root (the client's paths are never trusted). */
export interface CommitObjectPlan {
  folderName: string;
  /** Exclude this object entirely. */
  skip?: boolean;
  /** Library objectId to store under (a catalog id like "M31", or a name).
   *  Sanitized + normalized server-side. */
  targetObjectId: string;
  /** Display/folder name for the library object. Sanitized server-side. */
  targetFolderName: string;
  /** Maps each derived session date (or the literal "unknown" bucket) to a
   *  final date, or null to drop those files. Dates absent from the map keep
   *  their derived date; "unknown" defaults to dropped. Merging two sessions
   *  is expressed by pointing both at the same final date. */
  sessionMap: Record<string, string | null>;
}

export interface CommitPlan {
  rootPath: string;
  objects: CommitObjectPlan[];
  /** Per-import override for the importSubFrames app setting. */
  importSubFrames?: boolean;
  /** Per-import override for the importFits app setting. */
  importFits?: boolean;
  /** Per-import override for archive mode: keep files Nebulis has no use for,
   *  so the imported folder can be a complete copy. See classifyImportFile. */
  archiveAllFiles?: boolean;
  /** Telescope to stamp every session created by this import with, or null/
   *  absent to leave sessions untagged. */
  telescopeId?: string | null;
}

/** Key used for the unsorted (no-derivable-date) bucket in a sessionMap. */
export const UNSORTED_KEY = 'unknown';

// Bounds so a user pointed at a huge tree (or a symlink loop) can't hang the
// server or exhaust memory. A real astrophotography library is well under this.
const MAX_FILES_PER_OBJECT = 50_000;
const MAX_DEPTH = 8;

/** Top-level real filenames in a directory, or none if it cannot be read. */
function readRealFileNames(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(e => e.isFile() && isRealFile(e.name))
      .map(e => e.name);
  } catch {
    return [];
  }
}

/** Priority order used to pick the dominant date source for a session. */
const SOURCE_RANK: Record<DateSource, number> = {
  fits: 4, filename: 3, folder: 2, mtime: 1, none: 0,
};

/**
 * Discover the object sources under `rootPath`:
 *   - each top-level folder that looks like an object (M31, NGC7000, ...),
 *     merged with its `_sub` companion folder;
 *   - any `_sub` folder with no sibling object folder, as its own object;
 *   - the root's own loose files as a single object named after the root.
 *
 * Sources are deliberately generous: they say which files *belong* to an
 * object, not which will be imported. That is why this takes no settings —
 * classifyImportFile makes the keep/drop call during the walk, so the two can
 * never disagree and the scan can report what it skipped and why.
 *
 * When `telescopeKind` is known, this first checks whether the given root is
 * actually the *device's* root (e.g. a Dwarf volume mount) rather than the
 * folder that directly contains object folders — recognisable because the
 * vendor's base path (`Astronomy` for every Dwarf model) exists as a direct
 * child. If so, it descends into that child before classifying anything as
 * an object folder. Without this, pointing the wizard at a Dwarf volume root
 * finds one child ("Astronomy"), which passes as a single object folder and
 * swallows every target's every session into one pseudo-object. Omitting
 * `telescopeKind` (the wizard's "Not sure / mixed sources" case) preserves
 * the previous behaviour exactly: the given root's direct children are
 * always the object level.
 */
/** Case-insensitive child-directory lookup. ASIAIR's own casing is consistent,
 *  but a tree copied through a case-preserving share or restored from a backup
 *  may not be. Returns the real on-disk name. */
function findChildDir(dirPath: string, name: string): string | null {
  try {
    const hit = fs.readdirSync(dirPath, { withFileTypes: true })
      .find(e => e.isDirectory() && e.name.toLowerCase() === name.toLowerCase());
    return hit ? hit.name : null;
  } catch {
    return null;
  }
}

function readChildDirs(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}

/**
 * ASIAIR layout, for the folder-import wizard.
 *
 *   <root>/Autorun/Light/<Target>/     frames
 *   <root>/Plan/Light/<Target>/        frames
 *   <root>/Live/<Target>/              live-stacked output
 *   <root>/Autorun|Plan/Dark|Flat|Bias calibration, excluded
 *
 * One target appearing in several of those is one object, so its directories
 * are grouped into a single ObjectSource. That is the same mechanism the Dwarf
 * pass uses to merge two nights of one target, just seeded from a different
 * shape of tree.
 *
 * Returns null when the tree has none of the ASIAIR capture-mode folders, so a
 * caller can fall back to ordinary folder handling.
 */
function collectAsiairObjectSources(rootPath: string): CollectedSources | null {
  // Removable media nests everything under `ASIAir/`; an SMB share is already
  // inside. Only descend when the child actually holds the capture-mode
  // folders, so a user folder that happens to be named "ASIAir" cannot
  // silently redirect the scan.
  let resolvedRoot = rootPath;
  let basePathDetected: string | null = null;
  const usbRoot = findChildDir(rootPath, 'ASIAir');
  if (usbRoot) {
    const inner = path.join(rootPath, usbRoot);
    if (['Autorun', 'Plan', 'Live'].some(n => findChildDir(inner, n))) {
      resolvedRoot = inner;
      basePathDetected = usbRoot;
    }
  }

  const modeDirs = ['Autorun', 'Plan']
    .map(name => findChildDir(resolvedRoot, name))
    .filter((n): n is string => n !== null);
  const liveDir = findChildDir(resolvedRoot, 'Live');
  if (modeDirs.length === 0 && !liveDir) return null;

  /** space-stripped lowercase target -> raw display name + its directories */
  const groups = new Map<string, { raw: string; dirs: string[] }>();
  const addDir = (raw: string, dir: string): void => {
    const key = raw.replace(/\s+/g, '').toLowerCase();
    const group = groups.get(key) ?? { raw, dirs: [] };
    group.dirs.push(dir);
    groups.set(key, group);
  };

  const excludedFolders: string[] = [];
  const sources: ObjectSource[] = [];

  for (const mode of modeDirs) {
    const modePath = path.join(resolvedRoot, mode);
    for (const child of readChildDirs(modePath)) {
      // Dark/Flat/Bias carry no target and are never observations. They are
      // reported as excluded so the user is told, and archive mode picks them
      // up from resolvedRoot by that same relative name.
      if (isNonObjectFolder(child)) excludedFolders.push(`${mode}/${child}`);
    }
    const lightDir = findChildDir(modePath, 'Light');
    if (!lightDir) continue;
    const lightPath = path.join(modePath, lightDir);

    for (const target of readChildDirs(lightPath)) {
      if (!isObjectFolder(target) || isNonObjectFolder(target)) continue;
      addDir(target, path.join(lightPath, target));
    }

    // Older firmware wrote frames straight into Light/ with no target folder.
    // The filename still carries the target, so group by that rather than
    // dropping them or creating one object literally named "Light".
    const loose = readRealFileNames(lightPath);
    if (loose.length > 0) {
      const byTarget = new Map<string, string[]>();
      for (const name of loose) {
        const target = targetFromFileName(name);
        if (!target) continue;
        const bucket = byTarget.get(target) ?? [];
        bucket.push(name);
        byTarget.set(target, bucket);
      }
      for (const [target, fileNames] of byTarget) {
        sources.push({
          folderName: target,
          sourceDirs: [lightPath],
          topLevelOnly: true,
          fileNames: new Set(fileNames),
        });
      }
    }
  }

  if (liveDir) {
    const livePath = path.join(resolvedRoot, liveDir);
    for (const target of readChildDirs(livePath)) {
      if (!isObjectFolder(target) || isNonObjectFolder(target)) continue;
      addDir(target, path.join(livePath, target));
    }
  }

  for (const child of readChildDirs(resolvedRoot)) {
    if (isNonObjectFolder(child)) excludedFolders.push(child);
  }

  for (const { raw, dirs } of groups.values()) {
    sources.push({ folderName: raw, sourceDirs: dirs, topLevelOnly: false });
  }

  if (sources.length === 0 && excludedFolders.length === 0) return null;
  return { sources, excludedFolders: excludedFolders.sort(), resolvedRoot, basePathDetected };
}

export function collectObjectSources(rootPath: string, telescopeKind?: TelescopeKind): CollectedSources {
  // ASIAIR nests targets two levels down under a capture-mode and frame-type
  // pair, and the same target can appear under several of them at once. That
  // is not something `basePath` can describe, so it gets its own pass. It
  // returns null for a tree that turns out not to be ASIAIR-shaped (a user who
  // picked the kind but pointed at a plain folder of images), which falls
  // through to the ordinary handling below rather than erroring.
  if (telescopeKind === 'asiair') {
    const asiair = collectAsiairObjectSources(rootPath);
    if (asiair) return asiair;
  }

  let basePathDetected: string | null = null;
  if (telescopeKind) {
    const { basePath } = getWalkerConfig(telescopeKind);
    if (basePath) {
      const candidate = path.join(rootPath, basePath);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        rootPath = candidate;
        basePathDetected = basePath;
      }
    }
  }

  // Per-object listings below (readRealFileNames) already tolerate a failed
  // read by treating it as "no files". The root listing can't do that — it
  // has nothing to fall back to — but it also shouldn't abort the whole
  // commit over one transient hiccup (a flaky network-mounted share, a
  // momentary lock on the staged upload dir): commitFolderImport deletes the
  // staged upload on any failure, so losing that over a blip is expensive
  // for the user. One immediate retry before propagating the error.
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootPath, { withFileTypes: true });
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err), rootPath }, '[folder-scan] root listing failed, retrying once');
    entries = fs.readdirSync(rootPath, { withFileTypes: true });
  }
  // Folders that are not observations (CALI_FRAME, RESTACKED, Panoramas, ...)
  // are pulled out before anything else so they can never become library
  // objects. Excluding them here rather than at either call site is what keeps
  // the scan's plan and commit's re-derivation in agreement.
  const allDirs = entries.filter(e => e.isDirectory());
  const candidateDirs = allDirs.filter(e => !isNonObjectFolder(e.name));
  const objectDirs = candidateDirs.filter(e => isObjectFolder(e.name));
  const subDirs = candidateDirs.filter(e => isSubFolder(e.name));

  const sources: ObjectSource[] = [];
  /** `_sub` dirs claimed by an object folder below. Whatever is left over has
   *  no sibling object folder and becomes an object in its own right, rather
   *  than being dropped for lack of a parent. */
  const claimedSubDirs = new Set<string>();

  // Dwarf session folders: extract the target name and group multiple sessions
  // of the same target (e.g. two nights on M31) into one ObjectSource.
  const dwarfGroups = new Map<string, string[]>();
  const nonDwarfDirs: fs.Dirent[] = [];

  // STARTRAILS: not itself a Dwarf session folder (isNonObjectFolder already
  // excludes it from objectDirs above, same as CALI_FRAME/DWARF_DARK), but
  // each immediate subfolder is one capture with no target of its own. Fold
  // them into the same dwarfGroups map under one fixed synthetic target —
  // this reuses the exact mechanism that already merges multiple session
  // dirs of one real target into one ObjectSource, just seeded from a
  // different directory. An unreadable STARTRAILS folder falls through to
  // being reported as an ordinary excluded folder rather than aborting the
  // scan.
  let startrailsFolded = false;
  const startrailsDir = allDirs.find(e => isStartrailsFolder(e.name));
  if (startrailsDir) {
    try {
      const startrailsPath = path.join(rootPath, startrailsDir.name);
      const captures = fs.readdirSync(startrailsPath, { withFileTypes: true }).filter(e => e.isDirectory());
      if (captures.length > 0) {
        dwarfGroups.set(STARTRAILS_TARGET_NAME, captures.map(c => path.join(startrailsPath, c.name)));
        startrailsFolded = true;
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err), folder: startrailsDir.name }, '[folder-scan] STARTRAILS folder unreadable — leaving it excluded');
    }
  }

  const excludedFolders = allDirs
    .filter(e => isNonObjectFolder(e.name))
    .filter(e => !(startrailsFolded && isStartrailsFolder(e.name)))
    .map(e => e.name).sort();

  for (const dir of objectDirs) {
    if (isDwarfSessionFolder(dir.name)) {
      const parsedTarget = extractTargetFromSessionFolder(dir.name);
      if (!parsedTarget) {
        // The folder name matched a known Dwarf session-prefix (that's what
        // isDwarfSessionFolder checked), but the target substring after the
        // prefix didn't parse — a firmware/naming change should be visible,
        // not silently produce a garbage-named object from the raw folder
        // name. Every such folder also gets its own unique "target" (the
        // full folder name, timestamp included), so same-target sessions
        // that would normally group together each become a separate object.
        log.warn(
          { folder: dir.name },
          '[folder-scan] Dwarf session folder matched a known prefix but its target name could not be parsed; using the raw folder name',
        );
      }
      const target = parsedTarget ?? dir.name;
      const group = dwarfGroups.get(target) ?? [];
      group.push(path.join(rootPath, dir.name));
      dwarfGroups.set(target, group);
    } else {
      nonDwarfDirs.push(dir);
    }
  }

  for (const [target, dirs] of dwarfGroups) {
    sources.push({ folderName: target, sourceDirs: dirs, topLevelOnly: false });
  }

  for (const dir of nonDwarfDirs) {
    const dirPath = path.join(rootPath, dir.name);

    // The `_sub` companion belongs to this object folder however its files end
    // up grouped, so resolve it before the split/whole fork rather than inside
    // either arm: a companion only one arm knows how to claim is a companion
    // the other arm silently discards.
    //
    // Attached regardless of the importSubFrames setting: the walk knows it is
    // inside a `_sub` dir and classifyImportFile gates on that, so keeping one
    // authority for the decision beats two that can disagree, and it lets the
    // scan report what it skipped and why.
    const companion = subDirs.find(s => getObjectFromSubFolder(s.name) === dir.name);
    const companionDir = companion ? path.join(rootPath, companion.name) : null;
    if (companion) claimedSubDirs.add(companion.name);

    const plan = planObjectFolder(dir.name, readRealFileNames(dirPath));

    if (plan.kind === 'split') {
      // Split the companion along the same lines. With one target every
      // sub-frame belongs to it whatever its own name parses to (the same rule
      // the loose-file branch below applies to unnamed files); with several,
      // each sub-frame follows its own target.
      const soleTarget = plan.groups.length === 1 ? plan.groups[0].folderName : null;
      const subGroups = new Map<string, string[]>();
      for (const name of companionDir ? readRealFileNames(companionDir) : []) {
        const target = soleTarget ?? targetFromFileName(name) ?? dir.name;
        const group = subGroups.get(target) ?? [];
        group.push(name);
        subGroups.set(target, group);
      }

      for (const group of plan.groups) {
        const subNames = subGroups.get(group.folderName);
        subGroups.delete(group.folderName);
        sources.push({
          folderName: group.folderName,
          sourceDirs: subNames && companionDir ? [dirPath, companionDir] : [dirPath],
          topLevelOnly: true,
          fileNames: new Set(subNames ? [...group.fileNames, ...subNames] : group.fileNames),
        });
      }
      // Sub-frames for a target with no counterpart in the parent folder still
      // get an object rather than being dropped.
      if (companionDir) {
        for (const [target, fileNames] of subGroups) {
          sources.push({ folderName: target, sourceDirs: [companionDir], topLevelOnly: true, fileNames: new Set(fileNames) });
        }
      }
      if (plan.leftover) {
        sources.push({
          folderName: plan.leftover.folderName,
          sourceDirs: [dirPath],
          topLevelOnly: true,
          fileNames: new Set(plan.leftover.fileNames),
        });
      }
      continue;
    }

    const sourceDirs = [dirPath];
    if (companionDir) sourceDirs.push(companionDir);
    sources.push({ folderName: plan.folderName, sourceDirs, topLevelOnly: false });
  }

  // `_sub` dirs with no sibling object folder: the user pointed us at (or
  // uploaded) just the sub-frames. They are still an object.
  for (const sub of subDirs) {
    if (claimedSubDirs.has(sub.name)) continue;
    sources.push({
      folderName: getObjectFromSubFolder(sub.name),
      sourceDirs: [path.join(rootPath, sub.name)],
      topLevelOnly: false,
    });
  }

  // Loose real files directly under the root.
  // When filenames embed a target name (e.g. 2026-03-31-194930-Jupiter.jpg from
  // SeeStar planetary sessions), split into one ObjectSource per target instead
  // of lumping everything under the root folder name.
  const looseFiles = entries.filter(e => e.isFile() && isRealFile(e.name));
  if (looseFiles.length > 0) {
    const rootName = path.basename(rootPath.replace(/[\\/]+$/, '')) || 'Imported';
    const { byTarget: targetGroups, unnamed: unnamedFiles } = groupByTarget(looseFiles.map(e => e.name));

    if (targetGroups.size > 0) {
      // When there's exactly one target and some files have no parseable target,
      // merge unnamed files into that group rather than creating a separate object.
      // This handles Dwarf session folders where utility files (stacked.jpg,
      // stacked_thumbnail.jpg, etc.) don't encode the target name.
      if (targetGroups.size === 1 && unnamedFiles.length > 0) {
        const [[target, fileNames]] = Array.from(targetGroups.entries());
        const merged = new Set([...fileNames, ...unnamedFiles]);
        sources.push({ folderName: target, sourceDirs: [rootPath], topLevelOnly: true, fileNames: merged });
      } else {
        for (const [target, fileNames] of targetGroups) {
          sources.push({ folderName: target, sourceDirs: [rootPath], topLevelOnly: true, fileNames: new Set(fileNames) });
        }
        if (unnamedFiles.length > 0) {
          sources.push({ folderName: rootName, sourceDirs: [rootPath], topLevelOnly: true, fileNames: new Set(unnamedFiles) });
        }
      }
    } else {
      sources.push({ folderName: rootName, sourceDirs: [rootPath], topLevelOnly: true });
    }
  }

  // Guarantee a unique folderName per source. Nothing above prevents two
  // independently-discovered sources landing on the same name — e.g. a split
  // target from one folder's filenames colliding with a literal top-level
  // directory of that name, or a loose-file target colliding with an object
  // folder. commitFolderImport's planByFolder keys the user's per-object
  // decisions (targetObjectId, sessionMap, skip) by folderName in a plain
  // Map, so two sources sharing a name used to silently collapse onto one
  // plan entry: both got processed, but only one's session-date decisions
  // applied, and the other's files were session-mapped by a plan that never
  // saw their actual dates (usually landing in date-dropped). Disambiguating
  // here keeps a strict 1:1 between what the scan shows the user and what a
  // commit plan entry can address; the user can still merge them by hand
  // afterward (rename one to the other's target) same as any other alias.
  const nameCounts = new Map<string, number>();
  for (const source of sources) {
    nameCounts.set(source.folderName, (nameCounts.get(source.folderName) ?? 0) + 1);
  }
  const nameSeen = new Map<string, number>();
  for (const source of sources) {
    if ((nameCounts.get(source.folderName) ?? 0) <= 1) continue;
    const seen = (nameSeen.get(source.folderName) ?? 0) + 1;
    nameSeen.set(source.folderName, seen);
    if (seen > 1) source.folderName = `${source.folderName} (${seen})`;
  }

  return { sources, excludedFolders, resolvedRoot: rootPath, basePathDetected };
}

/** Walk an object's source dirs, gating by import settings and deriving a
 *  session date for every kept file. */
export function walkObjectFiles(
  source: ObjectSource,
  settings: Record<string, unknown>,
): { files: WalkedFile[]; truncated: boolean; skipped: SkipTally } {
  const files: WalkedFile[] = [];
  const skipped: SkipTally = new Map();
  let truncated = false;

  /** `inSub` is sticky: once we are under a `_sub` dir everything below it is a
   *  sub-frame, so a nested layout (M 27/M 27_sub/2025-10-01/...) is gated the
   *  same as a sibling one. */
  const visit = (baseDir: string, current: string, depth: number, inSub: boolean): void => {
    if (truncated) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of dirents) {
      if (files.length >= MAX_FILES_PER_OBJECT) { truncated = true; return; }
      if (ent.name.startsWith('.')) continue;
      const abs = path.join(current, ent.name);
      if (ent.isDirectory()) {
        if (source.topLevelOnly) continue;
        if (depth >= MAX_DEPTH) continue;
        // A `Thumbnail/` directory holds per-frame previews the app has no use
        // for, so it is skipped normally. Archive mode wants a complete copy, so
        // it is walked then.
        if (/^thumbnails?$/i.test(ent.name) && settings.archiveAllFiles !== true) continue;
        visit(baseDir, abs, depth + 1, inSub || isSubFolder(ent.name));
        continue;
      }
      if (!ent.isFile()) continue;
      // fileNames is checked first so a pinned split source doesn't report the
      // *other* target's files as skipped — they aren't skipped, they belong to
      // a different object.
      if (source.fileNames && !source.fileNames.has(ent.name)) continue;
      const decision = classifyImportFile(ent.name, settings, { fromSubFolder: inSub });
      if (!decision.import) {
        // Size the rejection so the report can say how much was left behind,
        // which is what makes "turn on archiving?" an informed choice. A stat
        // on a local file is the same order of cost as the readdir above.
        let skippedBytes = 0;
        try { skippedBytes = fs.statSync(abs).size; } catch { /* size unknown */ }
        countSkip(skipped, decision.reason, 1, skippedBytes,
          [path.relative(baseDir, abs).split(path.sep).join('/')]);
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      const relPath = path.relative(baseDir, abs).split(path.sep).join('/');
      const useMtimeFallback = settings.importMtimeFallback !== false;
      const derived = deriveFileDate(abs, relPath, stat, { useMtimeFallback });
      files.push({ absPath: abs, relPath, name: ent.name, size: stat.size, derived, fromSubFolder: inSub });
    }
  };

  for (const dir of source.sourceDirs) {
    if (truncated) break;
    // For DWARF session folders the observation date is encoded in the folder
    // name (e.g. DWARF_RAW_TELE_Moon_..._2026-04-27-...). Using the parent as
    // baseDir makes the session folder name appear in each file's relPath, so
    // deriveFromPath can extract that date for files like stacked.jpg that have
    // no date in their own name and would otherwise fall through to mtime.
    const baseDir = isDwarfSessionFolder(path.basename(dir)) ? path.dirname(dir) : dir;
    visit(baseDir, dir, 0, isSubFolder(path.basename(dir)));
  }
  return { files, truncated, skipped };
}

/** Group walked files into sessions + an unsorted bucket.
 *
 *  Buckets by observing night (see `observingNightDate`), not the raw derived
 *  calendar date, so a session that runs past local midnight (e.g. 11pm-1am)
 *  shows as one session instead of two the user would otherwise have to
 *  manually merge. `resolveTargetDate` in import.ts computes the same bucket
 *  for its default (no-override) case, so scan and commit agree. */
export function summarizeSessions(files: WalkedFile[]): {
  sessions: ScannedSession[];
  unsortedCount: number;
  unsortedBytes: number;
} {
  const map = new Map<string, { fileCount: number; bytes: number; bestSource: DateSource }>();
  let unsortedCount = 0;
  let unsortedBytes = 0;

  for (const file of files) {
    if (!file.derived.date) {
      unsortedCount++;
      unsortedBytes += file.size;
      continue;
    }
    const night = observingNightDate(file.derived.date, file.derived.time);
    const existing = map.get(night);
    if (existing) {
      existing.fileCount++;
      existing.bytes += file.size;
      if (SOURCE_RANK[file.derived.source] > SOURCE_RANK[existing.bestSource]) {
        existing.bestSource = file.derived.source;
      }
    } else {
      map.set(night, { fileCount: 1, bytes: file.size, bestSource: file.derived.source });
    }
  }

  const sessions: ScannedSession[] = Array.from(map.entries())
    .map(([date, s]) => ({
      date,
      fileCount: s.fileCount,
      bytes: s.bytes,
      source: s.bestSource,
      confidence: confidenceForSource(s.bestSource),
    }))
    .sort((a, b) => b.date.localeCompare(a.date));

  return { sessions, unsortedCount, unsortedBytes };
}

/** Best-effort catalog match for a folder name, using the same lookup the
 *  import enrichment uses (so a match here means enrichment will resolve it).
 *  Returns null when nothing matches — the UI then offers a manual search. */
export function matchCatalog(folderName: string): CatalogMatch | null {
  const normalized = normalizeCatalogId(folderName);
  const entry = getCatalogEntry(normalized) || getCatalogEntry(folderName);
  if (!entry) return null;
  return {
    objectId: normalized,
    name: entry.name,
    type: entry.type,
    constellation: entry.constellation ?? null,
    magnitude: entry.magnitude ?? null,
  };
}

/** Scan a folder and produce the import plan. Read-only. */
export function scanImportFolder(
  rootPath: string,
  settings: Record<string, unknown>,
  telescopeKind?: TelescopeKind,
): ScanResult {
  const { sources, excludedFolders, basePathDetected } = collectObjectSources(rootPath, telescopeKind);
  const objects: ScannedObject[] = [];
  const skipTotals: SkipTally = new Map();
  let truncated = false;

  // Counted per folder rather than per file: "3 folders that hold no
  // observations" tells the user more than a raw dark-frame count would, and it
  // avoids walking directories we are going to discard anyway.
  //
  // Not counted at all under archive mode: these folders are copied into the
  // library's archive rather than dropped, so reporting them as skipped would
  // say the opposite of what is about to happen. The wizard reports the archive
  // separately, off `excludedFolders`.
  if (settings.archiveAllFiles !== true) {
    countSkip(skipTotals, 'non-observation-folder', excludedFolders.length, 0, excludedFolders);
  }

  for (const source of sources) {
    const { files, truncated: t, skipped } = walkObjectFiles(source, settings);
    if (t) truncated = true;
    // Tallied before the empty check: an object that is *entirely* skipped is
    // exactly the case the user most needs explained.
    for (const [reason, v] of skipped) {
      countSkip(skipTotals, reason, v.count, v.bytes, v.samples);
    }
    if (files.length === 0) continue;

    const { sessions, unsortedCount, unsortedBytes } = summarizeSessions(files);
    const bytes = files.reduce((sum, f) => sum + f.size, 0);
    objects.push({
      folderName: source.folderName,
      fileCount: files.length,
      bytes,
      sessions,
      unsortedCount,
      unsortedBytes,
      catalogMatch: matchCatalog(source.folderName),
    });
  }

  objects.sort((a, b) => a.folderName.localeCompare(b.folderName));

  const totals = objects.reduce(
    (acc, o) => {
      acc.objects += 1;
      acc.files += o.fileCount;
      acc.sessions += o.sessions.length;
      acc.unsorted += o.unsortedCount;
      acc.bytes += o.bytes;
      return acc;
    },
    { objects: 0, files: 0, sessions: 0, unsorted: 0, bytes: 0 },
  );

  return {
    rootPath,
    objects,
    totals,
    skipped: summarizeSkips(skipTotals),
    excludedFolders,
    truncated,
    basePathDetected,
  };
}
