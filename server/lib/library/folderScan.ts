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
import { classifyImportFile, SKIP_LABELS, type ImportSkipReason } from './importFilter.js';
import { planObjectFolder, groupByTarget, targetFromFileName } from './objectDiscovery.js';
import { deriveFileDate, confidenceForSource, type DerivedDate, type DateSource } from './dateDerivation.js';
import { isDwarfSessionFolder, extractTargetFromSessionFolder } from '../walkers/dwarfWalker.js';

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

export interface WalkedFile {
  absPath: string;
  /** Path relative to its source dir, posix-style (for the folder-date hint). */
  relPath: string;
  name: string;
  size: number;
  derived: DerivedDate;
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

/** One reason files under the scan root will not be imported, and how many. */
export interface ScanSkip {
  reason: ImportSkipReason;
  /** User-facing wording. Reads as "<count> <label>". */
  label: string;
  count: number;
}

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
  /** True when the file cap was hit and the scan is incomplete. */
  truncated: boolean;
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
 */
export function collectObjectSources(rootPath: string): ObjectSource[] {
  const entries = fs.readdirSync(rootPath, { withFileTypes: true });
  const objectDirs = entries.filter(e => e.isDirectory() && isObjectFolder(e.name));
  const subDirs = entries.filter(e => e.isDirectory() && isSubFolder(e.name));

  const sources: ObjectSource[] = [];
  /** `_sub` dirs claimed by an object folder below. Whatever is left over has
   *  no sibling object folder and becomes an object in its own right, rather
   *  than being dropped for lack of a parent. */
  const claimedSubDirs = new Set<string>();

  // Dwarf session folders: extract the target name and group multiple sessions
  // of the same target (e.g. two nights on M31) into one ObjectSource.
  const dwarfGroups = new Map<string, string[]>();
  const nonDwarfDirs: fs.Dirent[] = [];

  for (const dir of objectDirs) {
    if (isDwarfSessionFolder(dir.name)) {
      const target = extractTargetFromSessionFolder(dir.name) ?? dir.name;
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

  return sources;
}

/** Walk an object's source dirs, gating by import settings and deriving a
 *  session date for every kept file. */
export function walkObjectFiles(
  source: ObjectSource,
  settings: Record<string, unknown>,
): { files: WalkedFile[]; truncated: boolean; skipped: Map<ImportSkipReason, number> } {
  const files: WalkedFile[] = [];
  const skipped = new Map<ImportSkipReason, number>();
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
        if (/^thumbnails?$/i.test(ent.name)) continue;
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
        // Hidden/system junk (.DS_Store, AppleDouble) is noise the user never
        // thinks of as "their files"; counting it would only add confusion.
        if (decision.reason !== 'not-a-real-file') {
          skipped.set(decision.reason, (skipped.get(decision.reason) ?? 0) + 1);
        }
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
      files.push({ absPath: abs, relPath, name: ent.name, size: stat.size, derived });
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
): ScanResult {
  const sources = collectObjectSources(rootPath);
  const objects: ScannedObject[] = [];
  const skipTotals = new Map<ImportSkipReason, number>();
  let truncated = false;

  for (const source of sources) {
    const { files, truncated: t, skipped } = walkObjectFiles(source, settings);
    if (t) truncated = true;
    // Tallied before the empty check: an object that is *entirely* skipped is
    // exactly the case the user most needs explained.
    for (const [reason, n] of skipped) {
      skipTotals.set(reason, (skipTotals.get(reason) ?? 0) + n);
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

  const skipped: ScanSkip[] = Array.from(skipTotals.entries())
    .map(([reason, count]) => ({ reason, label: SKIP_LABELS[reason], count }))
    .sort((a, b) => b.count - a.count);

  return { rootPath, objects, totals, skipped, truncated };
}
