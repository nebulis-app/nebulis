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
  parseFilename,
} from '../telescopeFiles.js';
import { getCatalogEntry } from '../../data/catalog.js';
import { shouldImportFile } from './importFilter.js';
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
}

/** Key used for the unsorted (no-derivable-date) bucket in a sessionMap. */
export const UNSORTED_KEY = 'unknown';

// Bounds so a user pointed at a huge tree (or a symlink loop) can't hang the
// server or exhaust memory. A real astrophotography library is well under this.
const MAX_FILES_PER_OBJECT = 50_000;
const MAX_DEPTH = 8;

/** Priority order used to pick the dominant date source for a session. */
const SOURCE_RANK: Record<DateSource, number> = {
  fits: 4, filename: 3, folder: 2, mtime: 1, none: 0,
};

/**
 * Discover the object sources under `rootPath`:
 *   - each top-level folder that looks like an object (M31, NGC7000, ...),
 *     merged with its `_sub` companion folder when sub-frames are enabled;
 *   - the root's own loose files as a single object named after the root.
 */
export function collectObjectSources(
  rootPath: string,
  settings: Record<string, unknown>,
): ObjectSource[] {
  const entries = fs.readdirSync(rootPath, { withFileTypes: true });
  const objectDirs = entries.filter(e => e.isDirectory() && isObjectFolder(e.name));
  const subDirs = entries.filter(e => e.isDirectory() && isSubFolder(e.name));
  const importSubs = settings.importSubFrames === true;

  const sources: ObjectSource[] = [];

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

  // Folders that are purely containers: SeeStar dumps all planetary images here
  // regardless of which planet was imaged. They must never appear as library
  // objects — always expand into individual per-planet objects.
  const CONTAINER_FOLDERS = new Set(['planetary_photo', 'planetary_photos']);

  for (const dir of nonDwarfDirs) {
    const dirPath = path.join(rootPath, dir.name);
    const isContainer = CONTAINER_FOLDERS.has(dir.name.toLowerCase());

    // Peek at the folder's top-level files. When the folder is a known
    // container (e.g. Planetary_photo/) or when multiple distinct targets
    // appear, split into one ObjectSource per target.
    let topEntries: fs.Dirent[] = [];
    try { topEntries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { /* skip */ }
    const topFiles = topEntries.filter(e => e.isFile() && isRealFile(e.name));

    if (topFiles.length > 0) {
      const targetGroups = new Map<string, string[]>();
      const unnamedFiles: string[] = [];
      for (const f of topFiles) {
        const parsed = parseFilename(f.name);
        if (parsed.target && parsed.target !== f.name) {
          const target = parsed.target.replace(/_thn$/i, '');
          const group = targetGroups.get(target) ?? [];
          group.push(f.name);
          targetGroups.set(target, group);
        } else {
          unnamedFiles.push(f.name);
        }
      }

      const shouldSplit = isContainer || targetGroups.size > 1 || (targetGroups.size === 1 && unnamedFiles.length === 0);
      if (shouldSplit) {
        for (const [target, fileNames] of targetGroups) {
          sources.push({ folderName: target, sourceDirs: [dirPath], topLevelOnly: true, fileNames: new Set(fileNames) });
        }
        // Unnamed files in a container folder are ignored; in mixed folders they
        // fall back to the folder name so nothing is silently lost.
        if (!isContainer && unnamedFiles.length > 0) {
          sources.push({ folderName: dir.name, sourceDirs: [dirPath], topLevelOnly: true, fileNames: new Set(unnamedFiles) });
        }
        continue;
      }
    }

    const sourceDirs = [dirPath];
    if (importSubs) {
      const companion = subDirs.find(s => getObjectFromSubFolder(s.name) === dir.name);
      if (companion) sourceDirs.push(path.join(rootPath, companion.name));
    }
    sources.push({ folderName: dir.name, sourceDirs, topLevelOnly: false });
  }

  // Loose real files directly under the root.
  // When filenames embed a target name (e.g. 2026-03-31-194930-Jupiter.jpg from
  // SeeStar planetary sessions), split into one ObjectSource per target instead
  // of lumping everything under the root folder name.
  const looseFiles = entries.filter(e => e.isFile() && isRealFile(e.name));
  if (looseFiles.length > 0) {
    const rootName = path.basename(rootPath.replace(/[\\/]+$/, '')) || 'Imported';
    const targetGroups = new Map<string, string[]>();
    const unnamedFiles: string[] = [];

    for (const f of looseFiles) {
      const parsed = parseFilename(f.name);
      // parsed.target falls back to the full filename when nothing matches — skip those.
      if (parsed.target && parsed.target !== f.name) {
        // Strip _thn suffix so thumbnails group with their companion image.
        const target = parsed.target.replace(/_thn$/i, '');
        const group = targetGroups.get(target) ?? [];
        group.push(f.name);
        targetGroups.set(target, group);
      } else {
        unnamedFiles.push(f.name);
      }
    }

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
): { files: WalkedFile[]; truncated: boolean } {
  const files: WalkedFile[] = [];
  let truncated = false;

  const visit = (baseDir: string, current: string, depth: number): void => {
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
        visit(baseDir, abs, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!shouldImportFile(ent.name, settings)) continue;
      if (source.fileNames && !source.fileNames.has(ent.name)) continue;
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
    visit(baseDir, dir, 0);
  }
  return { files, truncated };
}

/** Group walked files into sessions + an unsorted bucket. */
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
    const existing = map.get(file.derived.date);
    if (existing) {
      existing.fileCount++;
      existing.bytes += file.size;
      if (SOURCE_RANK[file.derived.source] > SOURCE_RANK[existing.bestSource]) {
        existing.bestSource = file.derived.source;
      }
    } else {
      map.set(file.derived.date, { fileCount: 1, bytes: file.size, bestSource: file.derived.source });
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
  const sources = collectObjectSources(rootPath, settings);
  const objects: ScannedObject[] = [];
  let truncated = false;

  for (const source of sources) {
    const { files, truncated: t } = walkObjectFiles(source, settings);
    if (t) truncated = true;
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

  return { rootPath, objects, totals, truncated };
}
