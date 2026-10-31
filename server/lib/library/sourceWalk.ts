/**
 * Linked-library folders — the I/O layer that feeds `treeAttribution.ts`.
 *
 * Walks an arbitrary directory the server can read (a user's own, possibly
 * huge, hand-organised archive) and produces a flat list of real, importable
 * files as posix-style paths relative to the walk root. Bounded and defensive:
 * this runs against trees this codebase has never controlled the shape of.
 *
 * Deliberately does not know about the managed library, `DATA_DIR`, or any
 * database. Refusing to link a root that overlaps either of those is the
 * orchestration layer's job (`librarySources.ts`), not this generic walker's.
 */
import fs from 'fs';
import path from 'path';
import { withDeadline } from '../deadline.js';
import { classifyImportFile, countSkip, summarizeSkips, type ImportSkipSummary, type SkipTally } from './importFilter.js';

// Matches folderScan.ts's existing per-object MAX_DEPTH (8) — a real
// astrophotography library is well under this. This walk has no per-object
// boundary (there is no "object" concept until treeAttribution runs), so the
// cap applies to the whole tree from the chosen root.
const MAX_DEPTH = 8;

// A root-wide file cap, distinct from folderScan.ts's existing
// MAX_FILES_PER_OBJECT (50,000, applied per discovered object). This walk has
// no object boundaries yet, so it needs its own whole-tree cap. 200,000 is
// four times that per-object figure and comfortably above what a real ~300GB
// SeeStar archive plausibly holds: the report this feature is built for had
// per-catalog-group counts of 103, 206, and 104 files across just the sample
// scan in its screenshot, and even a few dozen such groups stays an order of
// magnitude under this cap. See contract Open Question 4.
const MAX_TOTAL_FILES = 200_000;

// A linked archive is often a network share or a USB disk. Each call gets a deadline so a stalled mount ends the walk
// of that directory instead of the whole scan, and the walk gives the event loop back every so often so the API keeps
// answering while a 200,000-file tree is read.
const IO_DEADLINE_MS = 30_000;
const YIELD_EVERY = 200;
const yieldToLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/**
 * A `tick()` to call once per item in a long synchronous loop: every `every` calls it hands the event loop a turn.
 * For the loops that follow the walk (attribution, dates, rows to write), which are plain CPU work over every file.
 * Never call it inside a database transaction.
 */
export function createYielder(every = 500): { tick: () => Promise<void> } {
  let n = 0;
  return { tick: async () => { if (++n >= every) { n = 0; await yieldToLoop(); } } };
}

// Directories that are never real data, regardless of platform: OS/filesystem
// bookkeeping a "link my whole archive drive" scan would otherwise wade into.
const SKIP_DIR_NAMES = new Set([
  '$recycle.bin', 'system volume information', '.trashes', '.trash',
  '@eadir', '#recycle', '.spotlight-v100', '.fseventsd', '.temporaryitems',
]);

function shouldSkipDir(name: string): boolean {
  if (name.startsWith('.')) return true; // dot-dirs: Nebulis bookkeeping and OS hidden dirs alike
  return SKIP_DIR_NAMES.has(name.toLowerCase());
}

export interface WalkedSourceFile {
  /** Posix-style, relative to the walk root — this is what treeAttribution.ts
   *  and, later, `libraryFiles.relPath`'s `@src/<id>/<relPath>` form consume. */
  relPath: string;
  absPath: string;
  size: number;
  mtimeMs: number;
}

export interface SourceWalkResult {
  files: WalkedSourceFile[];
  /** True when MAX_TOTAL_FILES or MAX_DEPTH left part of the tree unread. The
   *  caller must tell the user rather than silently showing a partial library,
   *  and must not read absence as deletion. */
  truncated: boolean;
  /** True when at least one branch was skipped for nesting deeper than
   *  MAX_DEPTH. Its siblings were still walked, unlike the file-count cap. */
  depthLimited: boolean;
  /** Files found but not importable (thumbnails-disabled, unsupported type,
   *  ...), same shape and reasoning as folderScan.ts's ScanResult.skipped. */
  skipped: ImportSkipSummary[];
  /** Directories that could not be read (permission denied, vanished mid-walk),
   *  posix-relative to the root. Reported rather than silently swallowed, same
   *  reasoning as an unreadable object folder elsewhere in the importer. */
  unreadableDirs: string[];
}

/** Walk `rootPath`, classifying every real file with `classifyImportFile` under
 *  `settings` (the same app import settings folderScan.ts's scan uses, so a
 *  linked source and a copy-import agree on what counts as real data). */
export async function walkSource(rootPath: string, settings: Record<string, unknown>): Promise<SourceWalkResult> {
  const files: WalkedSourceFile[] = [];
  const skipped: SkipTally = new Map();
  const unreadableDirs: string[] = [];
  let truncated = false;
  // Only the file-count cap stops the whole walk. A branch that is too deep is
  // skipped on its own, so one deep folder does not hide everything after it.
  let stopped = false;
  let depthLimited = false;

  // Visited real (device, inode) pairs for directories, so a symlink loop
  // (or two symlinks pointing at the same real directory) is walked at most
  // once rather than recursing forever.
  const visitedDirs = new Set<string>();

  let sinceYield = 0;

  const visit = async (absDir: string, relDir: string, depth: number): Promise<void> => {
    if (stopped) return;

    let real: fs.Stats;
    try {
      real = await withDeadline(fs.promises.stat(absDir), IO_DEADLINE_MS, 'stat'); // follows symlinks
    } catch {
      unreadableDirs.push(relDir);
      return;
    }
    const dirKey = `${real.dev}:${real.ino}`;
    if (visitedDirs.has(dirKey)) return; // loop or duplicate-via-symlink
    visitedDirs.add(dirKey);

    let entries: fs.Dirent[];
    try {
      entries = await withDeadline(fs.promises.readdir(absDir, { withFileTypes: true }), IO_DEADLINE_MS, 'readdir');
    } catch {
      unreadableDirs.push(relDir);
      return;
    }

    for (const entry of entries) {
      if (stopped) return;
      if (++sinceYield >= YIELD_EVERY) { sinceYield = 0; await yieldToLoop(); }
      const absPath = path.join(absDir, entry.name);
      const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;

      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        // Resolve once to learn what it actually points at; a dangling link
        // is neither and is simply skipped.
        try {
          const stat = await withDeadline(fs.promises.stat(absPath), IO_DEADLINE_MS, 'stat');
          isDirectory = stat.isDirectory();
          isFile = stat.isFile();
        } catch {
          continue;
        }
      }

      if (isDirectory) {
        if (shouldSkipDir(entry.name)) continue;
        // A `Thumbnail/` directory holds the device's per-frame previews, which the copy import never walks
        // (folderScan.ts's walkObjectFiles, same rule and same archive-mode exception). Judged by name alone,
        // a Dwarf Star Trails preview (`startrails_10s0_<time>_26C.jpg`) reads as an ordinary picture and would
        // be linked once per frame.
        if (/^thumbnails?$/i.test(entry.name) && settings.archiveAllFiles !== true) continue;
        if (depth >= MAX_DEPTH) { truncated = true; depthLimited = true; continue; }
        await visit(absPath, relPath, depth + 1);
        continue;
      }
      if (!isFile) continue;

      const decision = classifyImportFile(entry.name, settings);
      if (!decision.import) {
        let size = 0;
        try { size = (await withDeadline(fs.promises.stat(absPath), IO_DEADLINE_MS, 'stat')).size; } catch { /* size unknown */ }
        countSkip(skipped, decision.reason, 1, size, [relPath]);
        continue;
      }

      if (files.length >= MAX_TOTAL_FILES) { truncated = true; stopped = true; return; }
      let stat: fs.Stats;
      try {
        stat = await withDeadline(fs.promises.stat(absPath), IO_DEADLINE_MS, 'stat');
      } catch {
        continue;
      }
      files.push({ relPath, absPath, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  };

  await visit(rootPath, '', 0);

  return { files, truncated, depthLimited, skipped: summarizeSkips(skipped), unreadableDirs };
}
