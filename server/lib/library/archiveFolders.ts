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
import { ILLEGAL_FS_CHARS } from './importNaming.js';
import { isNonObjectFolder } from './objectDiscovery.js';

/**
 * Reserved directory at the library root holding archived non-observation
 * folders. The leading underscore keeps it visually distinct from object
 * folders; `isReservedLibraryDir` is what actually keeps the library's
 * root-level sweeps from treating it as an object directory.
 */
export const ARCHIVE_DIR_NAME = '_archive';

/** Legacy (pre-telescope-scoping) archived folders that predate an assigned
 *  telescope, and the migration target for the flat layout every archive
 *  directory used to have (see migrateLegacyFlatArchiveOnce below). Also
 *  what a folder-import run with no telescope assigned still writes into
 *  today — that case has nothing to scope by, so it keeps this fixed home
 *  rather than inventing a fake id. */
export const ARCHIVE_UNSCOPED_DIR = '_unscoped';

/** Shared, library-root home for Dwarf MegaStack restacks that never matched
 *  a library object — unlike CALI_FRAME/DWARF_DARK, deliberately NOT nested
 *  under ARCHIVE_DIR_NAME or scoped per telescope. These are real images
 *  (or their sidecars — shotsInfo.json, the thumbnail preview), not
 *  calibration bytes, and a user going looking for them by hand shouldn't
 *  have to know which opaque telescope-id folder to open first. Every
 *  restack subfolder name already carries a millisecond timestamp, so two
 *  different telescopes colliding on the same relative path is not a
 *  realistic concern — and resolveArchiveDestination's same-size-skip /
 *  different-size-suffix rule still catches a genuine clash regardless. */
export const RESTACKED_ROOT_DIR_NAME = 'RESTACKED';

/** True for a library-root directory that is bookkeeping rather than an object.
 *  Every sweep over the library root must consult this. */
export function isReservedLibraryDir(name: string): boolean {
  return name === ARCHIVE_DIR_NAME || name === RESTACKED_ROOT_DIR_NAME;
}

/** Library-root folder Dwarf restack leftovers land in. No telescope scoping
 *  and no migration side effect — callers that need existing telescope-scoped
 *  restack data folded in here first call migrateRestackedToSharedRootOnce(). */
export function getRestackArchiveDir(): string {
  return path.join(getLibraryDir(), RESTACKED_ROOT_DIR_NAME);
}

/** Directory-name-safe form of a telescope id. Telescope ids are
 *  server-generated UUIDs, so this never actually strips anything in
 *  practice — it exists so a malformed/foreign id can never be used to
 *  escape the archive root. */
function sanitizeArchiveScope(telescopeId: string): string {
  return telescopeId.replace(ILLEGAL_FS_CHARS, '_').replace(/\.\./g, '_').trim() || ARCHIVE_UNSCOPED_DIR;
}

/** Archive root for one telescope's calibration/restack/etc bytes, or the
 *  shared unscoped root when no telescope is known (a folder-import run with
 *  no telescope assigned). Scoping exists because two Dwarf units can have
 *  distinct CALI_FRAME/DWARF_DARK files — without it, a second telescope's
 *  calibration frames would silently dedupe or clash against the first's by
 *  filename+size. */
export function getArchiveDir(telescopeId?: string | null): string {
  migrateLegacyFlatArchiveOnce();
  const scope = telescopeId ? sanitizeArchiveScope(telescopeId) : ARCHIVE_UNSCOPED_DIR;
  return path.join(getLibraryDir(), ARCHIVE_DIR_NAME, scope);
}

/**
 * One-time migration from the original flat archive layout
 * (`_archive/CALI_FRAME/...`) to the telescope-scoped one
 * (`_archive/<telescopeId>/CALI_FRAME/...`). A pre-existing flat archive has
 * no telescope recorded against it, so its contents move into the shared
 * `_unscoped` bucket rather than being guessed into a specific telescope's —
 * same non-destructive philosophy as the rest of this module: preserve the
 * bytes, don't invent an association the data doesn't support.
 *
 * Runs lazily (from getArchiveDir, so every read and write path is covered)
 * rather than at module load, since it touches the filesystem and
 * getLibraryDir() depends on settings that may not be ready yet at import
 * time. Guarded by a module-level flag so it costs one readdir per process,
 * not per call.
 */
let legacyArchiveMigrationDone = false;
function migrateLegacyFlatArchiveOnce(): void {
  if (legacyArchiveMigrationDone) return;
  legacyArchiveMigrationDone = true;
  const archiveRoot = path.join(getLibraryDir(), ARCHIVE_DIR_NAME);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(archiveRoot, { withFileTypes: true });
  } catch {
    return; // no archive yet — nothing to migrate
  }
  // Only folders whose name is a known non-observation folder (CALI_FRAME,
  // RESTACKED, ...) are legacy flat-layout data. Anything else under
  // _archive/ (including a telescope-id-named directory from a run that
  // already scoped correctly, and _unscoped itself) is left alone.
  const legacyFolders = entries.filter(e => e.isDirectory() && isNonObjectFolder(e.name));
  if (legacyFolders.length === 0) return;
  const unscopedDir = path.join(archiveRoot, ARCHIVE_UNSCOPED_DIR);
  try {
    fs.mkdirSync(unscopedDir, { recursive: true });
    for (const folder of legacyFolders) {
      const from = path.join(archiveRoot, folder.name);
      const to = path.join(unscopedDir, folder.name);
      if (fs.existsSync(to)) continue; // already migrated on a prior boot that crashed mid-way
      fs.renameSync(from, to);
    }
  } catch {
    // Same-volume rename should never fail, but if it does, leave the flat
    // layout in place rather than losing anything — getArchiveDir still
    // works, just without the migration; the next boot tries again.
  }
}

let restackMigrationDone = false;

/**
 * One-time migration of existing telescope-scoped RESTACKED archive data
 * (`_archive/<scope>/RESTACKED/...`, from before restacks got a shared root)
 * into the new shared `RESTACKED/` folder at the library root.
 *
 * Async, unlike migrateLegacyFlatArchiveOnce above: merging content from
 * potentially several different telescope scopes into one shared folder is
 * exactly the situation resolveArchiveDestination's same-size-skip /
 * different-size-suffix rule exists for, not a bare exists-check. Reuses
 * copyToArchive itself rather than re-implementing that rule here.
 *
 * Runs lazily from the RESTACKED archive pass (not from getRestackArchiveDir
 * itself, so a caller that only wants the path is never forced through this),
 * guarded by a module flag so it costs one directory walk per process.
 */
export async function migrateRestackedToSharedRootOnce(): Promise<void> {
  if (restackMigrationDone) return;
  restackMigrationDone = true;
  const archiveRoot = path.join(getLibraryDir(), ARCHIVE_DIR_NAME);
  let scopeEntries: fs.Dirent[];
  try {
    scopeEntries = fs.readdirSync(archiveRoot, { withFileTypes: true });
  } catch {
    return; // no archive yet — nothing to migrate
  }
  for (const scope of scopeEntries) {
    if (!scope.isDirectory()) continue;
    const scopeDir = path.join(archiveRoot, scope.name);
    // relPath comes back prefixed "RESTACKED/...", which is already the
    // right shape to land under the library root directly.
    const candidates = collectArchiveCandidates(scopeDir, [RESTACKED_ROOT_DIR_NAME]);
    if (candidates.length === 0) continue;
    try {
      const result = await copyToArchive(candidates, getLibraryDir(), { deleteSourceAfterCopy: true });
      // copyToArchive already deletes each source file once IT lands
      // (deleteSourceAfterCopy), so a failed file is simply left behind in
      // scopeDir. Removing the whole directory tree here regardless would
      // take that still-present file with it. Only safe to remove once
      // nothing failed — a partial run leaves the leftovers for the next
      // boot's migration pass to retry, same as the outer catch below.
      if (result.failed === 0) {
        fs.rmSync(path.join(scopeDir, RESTACKED_ROOT_DIR_NAME), { recursive: true, force: true });
      }
    } catch {
      // Leave whatever didn't move in place rather than losing anything —
      // the next boot's migration pass tries again for what's left.
    }
  }
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
 * Decide where one candidate file lands inside an archive directory,
 * applying the re-run-safe dedup rule: a destination that already exists at
 * the same size is treated as the same file (caller skips copying it), and a
 * same-name file of a *different* size is a genuine clash (two telescopes'
 * calibration frames sharing a naming scheme) that gets a numeric suffix
 * rather than being overwritten. Shared by the local-fs copy below and
 * remoteArchive.ts's transport-based equivalent, so a live sync and a
 * folder-import wizard run treat a repeat exactly the same way.
 */
export async function resolveArchiveDestination(
  archiveDir: string,
  relPath: string,
  size: number,
): Promise<{ destPath: string; alreadyPresent: boolean }> {
  const destPath = path.join(archiveDir, ...relPath.split('/'));
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const existing = await statOrNull(destPath);
  if (existing?.isFile() && existing.size === size) {
    return { destPath, alreadyPresent: true };
  }
  return { destPath: existing ? uniquePath(destPath) : destPath, alreadyPresent: false };
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
  archiveDir: string,
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

  for (const candidate of candidates) {
    if (opts.shouldCancel?.()) break;
    try {
      const { destPath, alreadyPresent } = await resolveArchiveDestination(archiveDir, candidate.relPath, candidate.size);
      if (alreadyPresent) {
        result.alreadyPresent++;
        if (opts.deleteSourceAfterCopy) {
          try { await fs.promises.unlink(candidate.absPath); } catch { /* swept later */ }
        }
        opts.onFile?.(candidate.size);
        continue;
      }
      await fs.promises.copyFile(candidate.absPath, destPath);
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

/** What is currently in one telescope's archive scope, as a plain directory
 *  listing. This needs no object model and no database: that is the point of
 *  it. Omit telescopeId for the shared unscoped bucket. */
export function listArchivedFolders(telescopeId?: string | null): ArchivedFolder[] {
  const archiveDir = getArchiveDir(telescopeId);
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

/** Every scope (telescope id, or null for the shared unscoped bucket) that
 *  currently has archived data, so a caller can find out what exists without
 *  probing every telescope individually. */
export function listArchiveScopes(): Array<string | null> {
  migrateLegacyFlatArchiveOnce();
  const archiveRoot = path.join(getLibraryDir(), ARCHIVE_DIR_NAME);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(archiveRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => (e.name === ARCHIVE_UNSCOPED_DIR ? null : e.name));
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
