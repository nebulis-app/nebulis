/**
 * Archive mode at the folder level.
 *
 * `classifyImportFile` promises that archive mode keeps EVERYTHING the device
 * holds, "a hard override, not a relaxation of a few rules". It could not
 * deliver that: folder exclusion happens in `collectObjectSources`, upstream of
 * every file-level setting, so CALI_FRAME, DWARF_DARK, RESTACKED and the
 * daytime capture folders were dropped before `settings` was ever consulted. A
 * user who ticked "archive everything" and still lost their calibration frames
 * had been told something untrue.
 *
 * The fix turns on a distinction the original wording did not make: archive
 * mode's stated goal is that *the library folder is a complete copy*, which is
 * a claim about bytes on disk, not about the object model. So when archive mode
 * is on, these folders are copied verbatim into a reserved directory and are
 * **not registered as library objects**. Completeness is satisfied, and none of
 * the per-object machinery (enrichment, quality scoring, trail detection, sky
 * map placement) fires on data it cannot interpret. A dark frame is not an
 * observation of anything in the sky, and that is the one objection to
 * object-hood here that no amount of code can fix.
 *
 * Under-modelling is deliberate and reversible: bytes already in the library can
 * be promoted into a real calibration-frame feature later as a migration over
 * data we hold, rather than asking the user to re-import.
 */
import fs from 'fs';
import path from 'path';
import { isHiddenOrSystemFile } from '../telescopeFiles.js';
import { getLibraryDir } from '../libraryPath.js';

/**
 * Reserved directory at the library root holding archived non-observation
 * folders. The leading underscore keeps it visually distinct from object
 * folders; `isReservedLibraryDir` is what actually keeps the library's
 * root-level sweeps out of it, since several of them would otherwise treat it
 * as an object directory and one (`purgeSubFramePreviews`) would delete files
 * out of it.
 */
export const ARCHIVE_DIR_NAME = '_archive';

/** True for a library-root directory that is bookkeeping rather than an object.
 *  Every sweep over the library root must consult this. */
export function isReservedLibraryDir(name: string): boolean {
  return name === ARCHIVE_DIR_NAME;
}

export function getArchiveDir(): string {
  return path.join(getLibraryDir(), ARCHIVE_DIR_NAME);
}

/** Same bounds the object walk uses, so a symlink loop or a pathological tree
 *  cannot hang the import here either. */
const MAX_DEPTH = 12;
const MAX_FILES = 200_000;

export interface ArchiveCandidate {
  absPath: string;
  /** Path relative to the archive root, posix-style: `CALI_FRAME/dark_001.fits`. */
  relPath: string;
  size: number;
}

/**
 * Enumerate every file inside the given excluded folders, as archive-relative
 * destinations.
 *
 * Enumerated up front rather than copied as they are found because the import's
 * free-space preflight has to know the whole run's size before the first write.
 * Archiving a Dwarf's calibration folders is not small, and discovering ENOSPC
 * halfway through is exactly the failure the preflight exists to prevent.
 */
export function collectArchiveCandidates(
  rootPath: string,
  excludedFolders: readonly string[],
): ArchiveCandidate[] {
  const out: ArchiveCandidate[] = [];

  const visit = (dir: string, relPrefix: string, depth: number): void => {
    if (out.length >= MAX_FILES || depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= MAX_FILES) return;
      if (ent.name.startsWith('.')) continue;
      const abs = path.join(dir, ent.name);
      const rel = `${relPrefix}/${ent.name}`;
      if (ent.isDirectory()) {
        visit(abs, rel, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      // The one thing archive mode already refuses: OS bookkeeping is not the
      // user's data, and copying it is noise rather than completeness.
      if (isHiddenOrSystemFile(ent.name)) continue;
      let size = 0;
      try { size = fs.statSync(abs).size; } catch { continue; }
      out.push({ absPath: abs, relPath: rel, size });
    }
  };

  for (const folder of excludedFolders) {
    const dir = path.join(rootPath, folder);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch { continue; }
    visit(dir, folder, 0);
  }
  return out;
}

export interface ArchiveCopyResult {
  copied: number;
  /** Files already archived byte-for-byte, so nothing was written. */
  alreadyPresent: number;
  failed: number;
  bytesCopied: number;
}

/**
 * Copy candidates into the archive directory.
 *
 * Re-running an import must not duplicate the archive, so a destination that
 * already exists at the same size is treated as the same file and skipped. A
 * same-name file of a *different* size is a genuine clash (two devices whose
 * calibration frames share a naming scheme), and gets a numeric suffix rather
 * than being overwritten: losing the user's bytes is the one outcome this whole
 * feature exists to prevent.
 *
 * `shouldCancel` is polled between files so a cancelled import stops here too,
 * keeping whatever already landed.
 */
export async function copyToArchive(
  candidates: readonly ArchiveCandidate[],
  opts: {
    shouldCancel?: () => boolean;
    onFile?: (bytes: number) => void;
    /** Delete each source file once it has landed. Only ever true for the
     *  upload staging area, which is ours to delete; it is what lets the
     *  import's free-space preflight reserve one file's headroom instead of
     *  the whole run. Never set this for an in-place import of a user folder. */
    deleteSourceAfterCopy?: boolean;
  } = {},
): Promise<ArchiveCopyResult> {
  const result: ArchiveCopyResult = { copied: 0, alreadyPresent: 0, failed: 0, bytesCopied: 0 };
  if (candidates.length === 0) return result;

  const archiveDir = getArchiveDir();
  for (const candidate of candidates) {
    if (opts.shouldCancel?.()) break;
    const destPath = path.join(archiveDir, ...candidate.relPath.split('/'));
    try {
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      const existing = await statOrNull(destPath);
      if (existing?.isFile() && existing.size === candidate.size) {
        result.alreadyPresent++;
        if (opts.deleteSourceAfterCopy) {
          try { await fs.promises.unlink(candidate.absPath); } catch { /* swept later */ }
        }
        opts.onFile?.(candidate.size);
        continue;
      }
      const finalPath = existing ? uniquePath(destPath) : destPath;
      await fs.promises.copyFile(candidate.absPath, finalPath);
      result.copied++;
      result.bytesCopied += candidate.size;
      if (opts.deleteSourceAfterCopy) {
        try { await fs.promises.unlink(candidate.absPath); } catch { /* swept later */ }
      }
      opts.onFile?.(candidate.size);
    } catch {
      result.failed++;
      opts.onFile?.(candidate.size);
    }
  }
  return result;
}

async function statOrNull(p: string): Promise<fs.Stats | null> {
  try { return await fs.promises.stat(p); } catch { return null; }
}

/** `dark_001.fits` → `dark_001 (2).fits`, first free suffix. */
function uniquePath(destPath: string): string {
  const dir = path.dirname(destPath);
  const ext = path.extname(destPath);
  const stem = path.basename(destPath, ext);
  for (let n = 2; n < 1000; n++) {
    const candidate = path.join(dir, `${stem} (${n})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${stem} (${Date.now()})${ext}`);
}

export interface ArchivedFolder {
  /** Top-level folder name as it was on the device, e.g. `CALI_FRAME`. */
  name: string;
  fileCount: number;
  bytes: number;
  /** Absolute path on the server, so the user can point Siril or PixInsight
   *  straight at it. Preserving bytes the user cannot find does not read as
   *  "it worked". */
  path: string;
}

/** What is currently in the archive, as a plain directory listing. This needs
 *  no object model and no database: that is the point of it. */
export function listArchivedFolders(): ArchivedFolder[] {
  const archiveDir = getArchiveDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(archiveDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: ArchivedFolder[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const dir = path.join(archiveDir, ent.name);
    const { fileCount, bytes } = measureTree(dir, 0);
    out.push({ name: ent.name, fileCount, bytes, path: dir });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function measureTree(dir: string, depth: number): { fileCount: number; bytes: number } {
  if (depth > MAX_DEPTH) return { fileCount: 0, bytes: 0 };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { fileCount: 0, bytes: 0 };
  }
  let fileCount = 0;
  let bytes = 0;
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      const sub = measureTree(abs, depth + 1);
      fileCount += sub.fileCount;
      bytes += sub.bytes;
      continue;
    }
    if (!ent.isFile()) continue;
    fileCount++;
    try { bytes += fs.statSync(abs).size; } catch { /* size unknown */ }
  }
  return { fileCount, bytes };
}
