/**
 * Linked (non-copied) library sources — scan and commit.
 *
 * A source is a folder the user already has on disk, indexed in place: `scan`
 * walks it and proposes objects, `commit` writes the resulting `librarySources`
 * + `libraryFiles` rows. Neither one ever copies, moves, or renames a file .
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { getCatalogEntry } from '../../data/catalog.js';
import { resolveCatalogMeta, enrichObjectData, stmts as objectStmts } from './objects.js';
import { recordLinkedLibraryFiles, markLinkedFilesMissing, countLibraryFilesForObject, roleForFile, getLibraryFilesForObject, getLibraryFileRow, deleteLibraryFileRow, sessionDateForRow, type LibraryFileRow, type RecordLinkedFileInput } from './libraryFiles.js';
import { walkSource } from './sourceWalk.js';
import { resolveLibraryFile } from './fileResolver.js';
import { attributeFiles, type AttributionOverride } from './treeAttribution.js';
import { getDesignationRedirect } from './designationRedirects.js';
import { getStartrailsObjectId, patchStartrailsObjectMeta, STARTRAILS_OBJECT_TYPE, STARTRAILS_TARGET_NAME } from './dwarfStartrails.js';
import { isNonObjectFolder } from './objectDiscovery.js';
import { STARTRAILS_FOLDER } from '../walkers/dwarfWalker.js';
import { deriveFileDate, confidenceForSource, type DateSource } from './dateDerivation.js';
import { countSkip, summarizeSkips, type ImportSkipSummary, type SkipTally } from './importFilter.js';
import { observingNightDate } from '../telescopeFiles.js';
import { LINKED_SOURCE_DIR_NAME } from './archiveFolders.js';
import { nicknamesFromFolderNames, mergeNicknames } from './nicknames.js';
import { getAliasesForCanonical } from '../catalogAliases.js';
import type { CatalogMatch } from './folderScan.js';
import { log } from '../logger.js';
import { getLibraryDir } from '../libraryPath.js';
import { DATA_DIR } from '../paths.js';
import { getArchiveConfig } from '../archive/archiveConfig.js';
import { resolveArchiveDestination } from '../archive/archiveDestination.js';
import { pathsOverlap } from '../archive/archivePath.js';
import { isRecord, parseJsonRecord } from '../typeGuards.js';
import { errnoCode } from '../errors.js';

export interface LibrarySourceRow {
  id: string;
  label: string;
  rootPath: string;
  fingerprint: string | null;
  enabled: boolean;
  lastScanAt: string | null;
  lastScanStats: string | null;
  createdAt: string;
  /** JSON of the import options this source was linked with; see LinkImportOptions. */
  importOptions: string | null;
  /** JSON of the review screen's per-directory decisions; see serializeOverrides. */
  overrides: string | null;
  /** Minutes between automatic rescans, or null for a one-time link that only rescans when asked. */
  refreshIntervalMin: number | null;
}

interface RawSourceRow {
  id: string; label: string; rootPath: string; fingerprint: string | null;
  enabled: number; lastScanAt: string | null; lastScanStats: string | null; createdAt: string;
  importOptions: string | null;
  /** JSON array of the review screen's per-directory decisions; see serializeOverrides. */
  overrides: string | null;
  refreshIntervalMin: number | null;
}

function toRow(raw: RawSourceRow): LibrarySourceRow {
  return { ...raw, enabled: raw.enabled === 1 };
}

/** The per-link overrides a user chose in the wizard. Stored with the source so
 *  a rescan reads the tree exactly as the link did. */
export interface LinkImportOptions {
  importSubFrames?: boolean;
  importFits?: boolean;
}

function parseImportOptions(raw: string | null): LinkImportOptions {
  if (!raw) return {};
  try {
    const v = parseJsonRecord(raw);
    if (!v) return {};
    const out: LinkImportOptions = {};
    if (typeof v.importSubFrames === 'boolean') out.importSubFrames = v.importSubFrames;
    if (typeof v.importFits === 'boolean') out.importFits = v.importFits;
    return out;
  } catch {
    return {};
  }
}

/** The review screen's per-directory decisions (assign a folder to an object, or ignore it), as stored
 *  with the source. A rescan must attribute the tree exactly as the link did: without these it would
 *  quietly move every hand-assigned folder back to whatever the folder name suggests. */
export function serializeOverrides(overrides: ReadonlyMap<string, AttributionOverride> | undefined): string {
  const rows = Array.from(overrides ?? []).map(([dirPath, o]) =>
    o.action === 'ignore' ? { dirPath, action: 'ignore' as const } : { dirPath, action: 'assign' as const, objectId: o.objectId });
  return JSON.stringify(rows);
}

/** Inverse of serializeOverrides. Anything malformed is dropped rather than thrown: a bad row must never
 *  make a linked folder impossible to rescan. */
export function parseStoredOverrides(raw: string | null): Map<string, AttributionOverride> {
  const out = new Map<string, AttributionOverride>();
  if (!raw) return out;
  let rows: unknown;
  try { rows = JSON.parse(raw); } catch { return out; }
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const { dirPath, action, objectId } = row;
    if (typeof dirPath !== 'string') continue;
    if (action === 'ignore') out.set(dirPath, { action: 'ignore' });
    else if (action === 'assign' && typeof objectId === 'string' && objectId) out.set(dirPath, { action: 'assign', objectId });
  }
  return out;
}

const getSourceStmt = db.prepare<[string], RawSourceRow>('SELECT * FROM librarySources WHERE id = ?');
const listSourcesStmt = db.prepare<[], RawSourceRow>('SELECT * FROM librarySources ORDER BY createdAt ASC');

export function getLibrarySource(id: string): LibrarySourceRow | null {
  const row = getSourceStmt.get(id);
  return row ? toRow(row) : null;
}

export function listLibrarySources(): LibrarySourceRow[] {
  return listSourcesStmt.all().map(toRow);
}

/** The relPath form every linked file uses — see fileResolver.ts. */
function linkedRelPath(sourceId: string, sourcePath: string): string {
  return `${LINKED_SOURCE_DIR_NAME}/${sourceId}/${sourcePath}`;
}

/** One `libraryFiles` row for a walked, attributed file, or null when the file
 *  vanished between the walk and now. Shared by commit and rescan so a file
 *  reads identically whichever path recorded it. */
function buildLinkedInput(
  sourceId: string,
  objectId: string,
  relPath: string,
  walkedFile: { absPath: string; size: number; mtimeMs: number },
  settings: Record<string, unknown>,
): RecordLinkedFileInput | null {
  let stat: fs.Stats;
  try { stat = fs.statSync(walkedFile.absPath); } catch { return null; }
  const derived = deriveFileDate(walkedFile.absPath, relPath, stat, { useMtimeFallback: settings.importMtimeFallback !== false });
  const night = derived.date ? observingNightDate(derived.date, derived.time) : null;
  const fileName = relPath.slice(relPath.lastIndexOf('/') + 1);
  return {
    objectId,
    relPath: linkedRelPath(sourceId, relPath),
    sourceId,
    sourcePath: relPath,
    fileName,
    role: roleForFile(fileName, { fromSubFolder: relPath.includes('_sub/') || relPath.includes('_subs/') }),
    captureDate: night,
    captureTime: derived.time,
    telescopeId: null, // telescope-kind -> profile mapping is a later step; the row still carries no wrong id
    bytes: walkedFile.size,
    mtimeMs: walkedFile.mtimeMs,
  };
}

/** Create or refresh the `libraryObjects` row a linked file's object needs.
 *  Leaves fileCount/lastImport alone: those columns belong to the managed-copy
 *  pipeline's bookkeeping, and a linked object's real counts always come from
 *  libraryFiles. */
function upsertLinkedObject(objectId: string, displayName?: string): void {
  const existing = db.prepare<[string], { objectId: string }>('SELECT objectId FROM libraryObjects WHERE objectId = ?').get(objectId);
  const meta = resolveCatalogMeta(objectId);
  // An uncatalogued object keeps the folder's own spelling as its name.
  if (displayName && meta.objectName === objectId) meta.objectName = displayName;
  if (existing) {
    // An object that already exists keeps its own bookkeeping. `upsertObject`
    // overwrites fileCount and lastImport wholesale, which for a managed object
    // would zero its real count the moment a linked folder added files to it.
    // Only what linking genuinely changes is touched: the row is un-tombstoned
    // (files just arrived for it) and any still-empty catalog fields filled in.
    db.prepare(
      `UPDATE libraryObjects SET deleted = 0, deletedAt = NULL,
         catalogId = COALESCE(catalogId, ?),
         objectName = CASE WHEN objectName IS NULL OR objectName = objectId THEN ? ELSE objectName END,
         objectType = COALESCE(objectType, ?), constellation = COALESCE(constellation, ?),
         description = COALESCE(description, ?), magnitude = COALESCE(magnitude, ?),
         ra = COALESCE(ra, ?), dec = COALESCE(dec, ?), distanceLy = COALESCE(distanceLy, ?)
       WHERE objectId = ?`,
    ).run(
      meta.catalogId, meta.objectName, meta.objectType, meta.constellation,
      meta.description, meta.magnitude, meta.ra, meta.dec, meta.distanceLy, objectId,
    );
    if (objectId === getStartrailsObjectId()) patchStartrailsObjectMeta(objectId);
    return;
  }
  objectStmts.upsertObject.run(
    objectId, objectId, 0, new Date().toISOString(), 0, null,
    meta.catalogId, meta.objectName, meta.objectType, meta.constellation,
    meta.description, meta.magnitude, meta.ra, meta.dec, meta.distanceLy,
  );
  // Star Trails is not a sky object: it gets its own curated name, type and description, and there is
  // nothing to look up for it.
  if (objectId === getStartrailsObjectId()) { patchStartrailsObjectMeta(objectId); return; }
  // Fire-and-forget, matching import.ts's own pattern for a freshly created
  // object: best-effort network enrichment, never blocking the link.
  enrichObjectData(objectId).catch(() => { /* best-effort */ });
}

/**
 * Give every night a linked file belongs to a `librarySessions` row. The
 * Library grid's session count, last-session date, and the observation lists
 * all read that table, not `libraryFiles`, so without these rows a linked-only
 * object shows "0 sessions" and looks like it never arrived. Idempotent.
 */
function ensureLinkedSessions(pairs: Iterable<{ objectId: string; captureDate: string | null }>): void {
  const tx = db.transaction(() => {
    for (const { objectId, captureDate } of pairs) {
      if (captureDate) objectStmts.addSession.run(objectId, captureDate);
    }
  });
  tx();
}

/** Route files through the user's "Reclassify object" corrections. Without
 *  this, a rescan re-reads each folder name and quietly puts reclassified
 *  files back under the object the user moved them off. */
function applyDesignationRedirects(attribution: { files: Array<{ objectId?: string | null }> }): void {
  for (const f of attribution.files) {
    if (f.objectId) f.objectId = getDesignationRedirect(f.objectId) ?? f.objectId;
  }
}

/**
 * A file that is already in the library as a managed COPY is the same file, so linking it too would list
 * it twice: every count doubled and every night showing two copies. Linking a folder that was partly
 * imported earlier is legitimate, so such files are skipped and the rest linked. Only a link that would
 * add nothing at all is refused (see commitSource).
 *
 * Name and size are only the shortlist. Device names repeat across nights and sizes repeat within one
 * (a fixed-size FITS frame, or two stacks that compress to the same length), so a different frame that
 * shares both would be silently dropped from the link. A shortlisted copy counts only when its first and
 * last 64 KB match the linked file's, which is cheap enough for a rescan of a large tree and settles it
 * for any real image. Anything unreadable is treated as "not a copy": listing a file twice is visible and
 * harmless, leaving one out is not.
 */
const managedCopyStmt = db.prepare<[string, string, number], { relPath: string }>(
  'SELECT relPath FROM libraryFiles WHERE objectId = ? AND originalName = ? AND bytes = ? AND sourceId IS NULL',
);
const EDGE_BYTES = 64 * 1024;

/** True when both files, of the same size, agree on their first and last `EDGE_BYTES`. */
function sameEdges(pathA: string, pathB: string, size: number): boolean {
  let fdA: number | null = null;
  let fdB: number | null = null;
  try {
    fdA = fs.openSync(pathA, 'r');
    fdB = fs.openSync(pathB, 'r');
    const len = Math.min(EDGE_BYTES, size);
    const offsets = size > EDGE_BYTES * 2 ? [0, size - len] : [0];
    const readLen = size > EDGE_BYTES * 2 ? len : size;
    const bufA = Buffer.alloc(readLen);
    const bufB = Buffer.alloc(readLen);
    for (const offset of offsets) {
      if (fs.readSync(fdA, bufA, 0, readLen, offset) !== readLen) return false;
      if (fs.readSync(fdB, bufB, 0, readLen, offset) !== readLen) return false;
      if (!bufA.equals(bufB)) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    if (fdA !== null) try { fs.closeSync(fdA); } catch { /* best effort */ }
    if (fdB !== null) try { fs.closeSync(fdB); } catch { /* best effort */ }
  }
}

function isAlreadyImportedCopy(objectId: string, relPath: string, walkedFile: { absPath: string; size: number }): boolean {
  const name = relPath.slice(relPath.lastIndexOf('/') + 1);
  for (const row of managedCopyStmt.all(objectId, name, walkedFile.size)) {
    const managed = resolveLibraryFile(row.relPath);
    if (managed && sameEdges(managed.abs, walkedFile.absPath, walkedFile.size)) return true;
  }
  return false;
}

/** Drop the session rows for nights that no longer have a single file of any
 *  kind, after a link's files went away. A night that still has managed or
 *  other-source files keeps its row. */
function pruneEmptySessions(pairs: Iterable<{ objectId: string; captureDate: string | null }>): void {
  const count = db.prepare<[string, string], { n: number }>('SELECT COUNT(*) AS n FROM libraryFiles WHERE objectId = ? AND captureDate = ?');
  const del = db.prepare('DELETE FROM librarySessions WHERE objectId = ? AND date = ?');
  const seen = new Set<string>();
  for (const { objectId, captureDate } of pairs) {
    if (!captureDate) continue;
    const key = `${objectId}\u0000${captureDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if ((count.get(objectId, captureDate)?.n ?? 0) === 0) del.run(objectId, captureDate);
  }
}

/**
 * Soft-delete each object that no longer has a single `libraryFiles` row of
 * any kind and carries no user data (notes, favourites) — what is left after
 * a source's files are unlinked, per contract Open Question 1. An object that
 * still has any file, managed or from another source, is untouched.
 */
function retireEmptyObjects(objectIds: Iterable<string>): string[] {
  const retired: string[] = [];
  for (const objectId of objectIds) {
    if (countLibraryFilesForObject(objectId) > 0) continue;
    const hasNotes = db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM notes WHERE objectId = ?').get(objectId)?.n ?? 0;
    const hasFavs = db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM favorites WHERE objectId = ?').get(objectId)?.n ?? 0;
    if (hasNotes > 0 || hasFavs > 0) continue;
    objectStmts.markObjectDeleted.run(new Date().toISOString(), objectId);
    retired.push(objectId);
  }
  return retired;
}

// ── Deleting linked files from disk ─────────────────────────────────────────

/** Why a linked file could not be deleted, as a stable code the route can surface. */
export class LinkedDeleteError extends Error {
  constructor(readonly code: 'LINKED_SOURCE_UNAVAILABLE' | 'LINKED_DELETE_FAILED', message: string) {
    super(message);
    this.name = 'LinkedDeleteError';
  }
}

/** The linked rows of one object, or of one of its nights. */
export function getLinkedFileRows(objectId: string, date?: string): LibraryFileRow[] {
  return getLibraryFilesForObject(objectId).filter(row =>
    row.sourceId !== null && (date === undefined || sessionDateForRow(row) === date));
}

/**
 * Delete linked files from the user's own disk, then drop their index rows.
 *
 * This is the one place Nebulis removes a file it did not copy, and it only runs
 * when a route was told the user asked for it explicitly. A file that is already
 * gone counts as deleted (the goal is that it is not there). A source that cannot
 * be reached is refused rather than treated as "gone", so a disconnected drive
 * never erases index rows for files that are still on it. Stops at the first
 * real failure, leaving that file's row and every later one in place.
 */
export function deleteLinkedFilesFromDisk(rows: LibraryFileRow[]): { deleted: number } {
  const removed: LibraryFileRow[] = [];
  try {
    for (const row of rows) {
      if (row.sourceId === null) continue;
      const resolved = resolveLibraryFile(row.relPath);
      const source = db.prepare<[string], { rootPath: string }>('SELECT rootPath FROM librarySources WHERE id = ?').get(row.sourceId);
      if (!resolved || !source || !fs.existsSync(source.rootPath)) {
        throw new LinkedDeleteError('LINKED_SOURCE_UNAVAILABLE', 'The linked folder cannot be reached right now, so nothing was deleted. Reconnect the drive or share and try again.');
      }
      try {
        fs.unlinkSync(resolved.abs);
      } catch (err) {
        if (errnoCode(err) !== 'ENOENT') {
          throw new LinkedDeleteError('LINKED_DELETE_FAILED', `Could not delete "${row.fileName}" from ${source.rootPath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      deleteLibraryFileRow(row.relPath);
      removed.push(row);
    }
  } finally {
    // Runs on a partial failure too, so the rows that did go leave no empty night or object behind.
    // fileCount is left alone: that column belongs to the managed copy (see upsertLinkedObject).
    pruneEmptySessions(removed);
    retireEmptyObjects(new Set(removed.map(r => r.objectId)));
  }
  return { deleted: removed.length };
}

/** What deleting an object or night would take from linked folders: file count, bytes, and folder labels. */
export function summarizeLinkedFiles(objectId: string, date?: string): { files: number; bytes: number; folders: string[] } {
  const rows = getLinkedFileRows(objectId, date);
  const label = db.prepare<[string], { label: string }>('SELECT label FROM librarySources WHERE id = ?');
  const folders = new Set<string>();
  for (const row of rows) {
    const found = row.sourceId ? label.get(row.sourceId) : undefined;
    if (found) folders.add(found.label);
  }
  return { files: rows.length, bytes: rows.reduce((sum, r) => sum + r.bytes, 0), folders: [...folders] };
}

/** One linked file by its relPath, or undefined when it is not a linked row. */
export function getLinkedFileRow(relPath: string): LibraryFileRow | undefined {
  const row = getLibraryFileRow(relPath);
  return row && row.sourceId !== null ? row : undefined;
}

/** Names a set of folders adds for an object, beyond what the catalog gives. */
function nicknamesFor(objectId: string, folderNames: Iterable<string> | undefined): string[] {
  if (!folderNames) return [];
  return nicknamesFromFolderNames(folderNames, objectId, {
    catalogName: resolveCatalogMeta(objectId).objectName,
    aliases: getAliasesForCanonical(objectId),
  });
}

/** Remember names learned from folder labels on the object row. */
function learnNicknames(objectId: string, folderNames: Iterable<string> | undefined): void {
  const found = nicknamesFor(objectId, folderNames);
  if (found.length === 0) return;
  const row = db.prepare<[string], { nicknames: string | null }>('SELECT nicknames FROM libraryObjects WHERE objectId = ?').get(objectId);
  if (!row) return;
  db.prepare('UPDATE libraryObjects SET nicknames = ? WHERE objectId = ?')
    .run(JSON.stringify(mergeNicknames(row.nicknames, found)), objectId);
}

export interface ScannedLinkedSession {
  date: string;
  fileCount: number;
  bytes: number;
  confidence: 'high' | 'medium' | 'low' | 'none';
  /** Where the best of this night's dates came from, so the review screen can say so. */
  source: DateSource;
}

export interface ScannedLinkedObject {
  objectId: string;
  fileCount: number;
  bytes: number;
  sessions: ScannedLinkedSession[];
  unsortedCount: number;
  catalogMatch: CatalogMatch | null;
  /** Other catalog designations for the same object ("C1" for NGC188). */
  aliases: string[];
  /** Names the user's own folder labels add ("Polarissima Cluster"). */
  nicknames: string[];
  /** The folder the object came from, as the user knows it ("C 5", "STARTRAILS"), for the "folder -> object"
   *  line the review screen shows. Not an id: an id has its spaces stripped. */
  sourceName: string;
  /** Every directory (posix, relative to the scan root, '' for loose files in the root) that holds this
   *  object's files. A review-screen decision is keyed by directory, so re-assigning the object means an
   *  assign override for each of these. */
  dirPaths: string[];
  /** False when re-assigning this object's directories would also move another object's files (a directory
   *  or anything beneath it holds a different object). The review screen offers no re-assign then, because
   *  the override could not be limited to this object. */
  reassignable: boolean;
}

export interface ScanSourceResult {
  rootPath: string;
  objects: ScannedLinkedObject[];
  /** Files no folder or filename identified, and that don't belong to a
   *  single-object custom folder either — the review screen's "needs
   *  attention" bucket. Grouped by directory so the user sees where they are,
   *  not a flat file dump. */
  unresolved: Array<{ dirPath: string; fileCount: number; bytes: number }>;
  /** Files found but not linked, and why, largest group first: a setting that leaves thumbnails or videos
   *  out, a processing artifact, a folder that holds no observations. The same accounting the copy import's
   *  review gives, so a file count lower than the folder's reads as a decision rather than lost files. */
  skipped: ImportSkipSummary[];
  /** Folders left out because they hold no observations (CALI_FRAME, RESTACKED...), relative to the scan root. */
  excludedFolders: string[];
  /** Folders holding >=2 distinct objects — informational, matches
   *  treeAttribution's own `containers` output. */
  containerDirs: string[];
  /** Folder says one object, filename says another. Surfaced, never silently
   *  resolved either way beyond the folder-wins default treeAttribution applies. */
  disagreements: Array<{ relPath: string; folderObjectId: string; filenameObjectId: string }>;
  totals: { objects: number; files: number; bytes: number };
  truncated: boolean;
  /** Some folders were nested too deep to read; the rest of the tree was still scanned. */
  depthLimited: boolean;
}

/** Catalog display info for an objectId that treeAttribution already resolved
 *  — a lookup, never a re-derivation from a name. Null for a custom
 *  (uncatalogued) object, which the review screen shows as "no catalog match"
 *  rather than inventing one. */
function catalogMatchFor(objectId: string): CatalogMatch | null {
  // Not a sky object, but not an unidentified one either: the review screen names it rather than calling it
  // "no catalog match".
  if (objectId === getStartrailsObjectId()) {
    return { objectId, name: STARTRAILS_TARGET_NAME, type: STARTRAILS_OBJECT_TYPE, constellation: null, magnitude: null, aliases: [] };
  }
  const entry = getCatalogEntry(objectId);
  if (!entry) return null;
  return {
    objectId,
    name: entry.name,
    type: entry.type,
    constellation: entry.constellation ?? null,
    magnitude: entry.magnitude ?? null,
    aliases: getAliasesForCanonical(objectId),
  };
}

const SOURCE_RANK: Record<string, number> = { fits: 4, filename: 3, folder: 2, mtime: 1, none: 0 };

/** The folder name the user knows an object by. The names that identified it win, then the display name of an
 *  uncatalogued one, then the folder its files sit in. Star Trails has no such name of its own: its files sit
 *  in capture folders under STARTRAILS, and that is the folder to point at. */
function sourceNameFor(
  objectId: string,
  dirPaths: string[],
  attribution: { folderNames: Map<string, Set<string>>; customNames: Map<string, string> },
): string {
  if (objectId === getStartrailsObjectId()) return STARTRAILS_FOLDER;
  const named = Array.from(attribution.folderNames.get(objectId) ?? []).sort()[0];
  if (named) return named;
  const custom = attribution.customNames.get(objectId);
  if (custom) return custom;
  const dir = dirPaths.find(d => d !== '') ?? '';
  return dir === '' ? objectId : dir.slice(dir.lastIndexOf('/') + 1);
}

/** Stands in for "a file no object claims" when checking who shares a directory. */
const NO_OBJECT = '\0';

function relDirOf(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i === -1 ? '' : relPath.slice(0, i);
}

/** `dir` and every ancestor of it, down to and excluding the root (`''`). */
function dirAndAncestors(dir: string): string[] {
  const out: string[] = [];
  let cur = dir;
  while (cur !== '') {
    out.push(cur);
    const i = cur.lastIndexOf('/');
    cur = i === -1 ? '' : cur.slice(0, i);
  }
  return out;
}

/**
 * Scan `rootPath` and propose the objects it holds. Read-only: no database
 * writes, and — proven by `linkedLibraryScan.test.ts` — no filesystem writes
 * either. `settings` gates which files count as real data, the same import
 * settings `folderScan.ts`'s copy-import scan uses, so the two agree on what
 * "real data" means.
 */
export function scanSource(rootPath: string, settings: Record<string, unknown>): ScanSourceResult {
  const walked = walkSource(rootPath, settings);
  const attribution = attributeFiles(walked.files.map(f => f.relPath));
  const byRelPath = new Map(walked.files.map(f => [f.relPath, f]));

  interface ObjectAcc {
    files: number; bytes: number; unsorted: number;
    sessions: Map<string, { fileCount: number; bytes: number; bestSource: DateSource }>;
    dirs: Set<string>;
  }
  const objects = new Map<string, ObjectAcc>();
  // Who owns what, by directory, so an object is only offered for re-assignment when an override on its
  // directories cannot drag a neighbour along. An override on a directory covers everything beneath it
  // that nothing nearer decides, so the whole subtree has to belong to the one object. The root's own
  // override covers only the files sitting directly in it, so it is judged on those alone.
  const directOccupants = new Map<string, Set<string>>();
  const subtreeOccupants = new Map<string, Set<string>>();
  const addOccupant = (map: Map<string, Set<string>>, dir: string, who: string) => {
    const set = map.get(dir) ?? new Set<string>();
    set.add(who);
    map.set(dir, set);
  };
  const unresolvedByDir = new Map<string, { fileCount: number; bytes: number }>();
  const disagreements: ScanSourceResult['disagreements'] = [];

  for (const file of attribution.files) {
    const walkedFile = byRelPath.get(file.relPath);
    if (!walkedFile || file.excluded) continue;

    if (file.disagreement) {
      disagreements.push({ relPath: file.relPath, ...file.disagreement });
    }

    const fileDir = relDirOf(file.relPath);
    const occupant = file.objectId ?? NO_OBJECT;
    addOccupant(directOccupants, fileDir, occupant);
    for (const dir of dirAndAncestors(fileDir)) addOccupant(subtreeOccupants, dir, occupant);

    if (!file.objectId) {
      const dirPath = file.relPath.includes('/') ? file.relPath.slice(0, file.relPath.lastIndexOf('/')) : '';
      const acc = unresolvedByDir.get(dirPath) ?? { fileCount: 0, bytes: 0 };
      acc.fileCount++; acc.bytes += walkedFile.size;
      unresolvedByDir.set(dirPath, acc);
      continue;
    }

    let obj = objects.get(file.objectId);
    if (!obj) { obj = { files: 0, bytes: 0, unsorted: 0, sessions: new Map(), dirs: new Set() }; objects.set(file.objectId, obj); }
    obj.files++; obj.bytes += walkedFile.size;
    obj.dirs.add(fileDir);

    let stat: fs.Stats;
    try { stat = fs.statSync(walkedFile.absPath); } catch { obj.unsorted++; continue; }
    const derived = deriveFileDate(walkedFile.absPath, file.relPath, stat, { useMtimeFallback: settings.importMtimeFallback !== false });
    if (!derived.date) { obj.unsorted++; continue; }
    const night = observingNightDate(derived.date, derived.time);
    const existing = obj.sessions.get(night);
    if (existing) {
      existing.fileCount++; existing.bytes += walkedFile.size;
      if (SOURCE_RANK[derived.source] > SOURCE_RANK[existing.bestSource]) existing.bestSource = derived.source;
    } else {
      obj.sessions.set(night, { fileCount: 1, bytes: walkedFile.size, bestSource: derived.source });
    }
  }

  const scannedObjects: ScannedLinkedObject[] = Array.from(objects.entries())
    .map(([objectId, acc]) => ({
      objectId,
      fileCount: acc.files,
      bytes: acc.bytes,
      unsortedCount: acc.unsorted,
      sessions: Array.from(acc.sessions.entries())
        .map(([date, s]) => ({ date, fileCount: s.fileCount, bytes: s.bytes, confidence: confidenceForSource(s.bestSource), source: s.bestSource }))
        .sort((a, b) => b.date.localeCompare(a.date)),
      catalogMatch: catalogMatchFor(objectId),
      aliases: getAliasesForCanonical(objectId),
      nicknames: nicknamesFor(objectId, attribution.folderNames.get(objectId)),
      sourceName: sourceNameFor(objectId, Array.from(acc.dirs).sort(), attribution),
      dirPaths: Array.from(acc.dirs).sort(),
      reassignable: Array.from(acc.dirs).every(dir => {
        const who = dir === '' ? directOccupants.get('') : subtreeOccupants.get(dir);
        return !!who && who.size === 1 && who.has(objectId);
      }),
    }))
    .sort((a, b) => a.objectId.localeCompare(b.objectId));

  const totals = scannedObjects.reduce(
    (acc, o) => ({ objects: acc.objects + 1, files: acc.files + o.fileCount, bytes: acc.bytes + o.bytes }),
    { objects: 0, files: 0, bytes: 0 },
  );

  // Folders attribution left out for holding no observations, named by the first such folder on each path.
  const excluded = new Set<string>();
  for (const file of attribution.files) {
    if (!file.excluded) continue;
    const segments = file.relPath.split('/');
    const at = segments.slice(0, -1).findIndex(isNonObjectFolder);
    if (at >= 0) excluded.add(segments.slice(0, at + 1).join('/'));
  }
  const excludedFolders = Array.from(excluded).sort();
  const skipTally: SkipTally = new Map();
  for (const item of walked.skipped) countSkip(skipTally, item.reason, item.count, item.bytes, item.samples);
  countSkip(skipTally, 'non-observation-folder', excludedFolders.length, 0, excludedFolders);

  return {
    rootPath,
    objects: scannedObjects,
    skipped: summarizeSkips(skipTally),
    excludedFolders,
    unresolved: Array.from(unresolvedByDir.entries()).map(([dirPath, v]) => ({ dirPath, ...v })),
    containerDirs: Array.from(attribution.containers),
    disagreements,
    totals,
    truncated: walked.truncated,
    depthLimited: walked.depthLimited,
  };
}

/** The automatic-refresh choices a linked folder offers, in minutes. Mirrors `src/lib/linkRefresh.ts`. */
export const REFRESH_INTERVALS_MIN = [60, 360, 1440, 10080] as const;

export function isValidRefreshInterval(v: unknown): v is number {
  return typeof v === 'number' && REFRESH_INTERVALS_MIN.some((entry) => entry === v);
}

export interface CommitSourceOptions {
  label: string;
  /** Minutes between automatic rescans. Omitted or null is a one-time link. */
  refreshIntervalMin?: number | null;
  /** Stored on the source and re-applied by every rescan. */
  importOptions?: LinkImportOptions;
  /** Per-directory decisions from the review screen, applied on top of the
   *  same attribution the scan produced. Stored with the source, so every
   *  rescan applies them again. */
  overrides?: ReadonlyMap<string, AttributionOverride>;
}

export interface CommitSourceResult {
  sourceId: string;
  objectsLinked: number;
  filesLinked: number;
  /** Files left unlinked because the library already holds a copy of them. */
  filesAlreadyInLibrary: number;
}

/**
 * Write a linked source: a `librarySources` row and one `libraryFiles` row per
 * real file, no bytes copied. Re-derives everything from `rootPath` rather
 * than trusting a client-supplied file list, the same reasoning
 * `commitFolderImport` documents for the copy wizard.
 */
export function commitSource(rootPath: string, settings: Record<string, unknown>, options: CommitSourceOptions): CommitSourceResult {
  assertLinkableRoot(rootPath);
  const sourceId = `src_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const walked = walkSource(rootPath, settings);
  const attribution = attributeFiles(walked.files.map(f => f.relPath), { overrides: options.overrides });
  applyDesignationRedirects(attribution);
  const byRelPath = new Map(walked.files.map(f => [f.relPath, f]));

  const inputsByObject = new Map<string, RecordLinkedFileInput[]>();
  let alreadyInLibrary = 0;
  for (const file of attribution.files) {
    if (file.excluded || !file.objectId) continue;
    const walkedFile = byRelPath.get(file.relPath);
    if (!walkedFile) continue;

    if (isAlreadyImportedCopy(file.objectId, file.relPath, walkedFile)) { alreadyInLibrary++; continue; }
    const input = buildLinkedInput(sourceId, file.objectId, file.relPath, walkedFile, settings);
    if (!input) continue;
    const list = inputsByObject.get(file.objectId) ?? [];
    list.push(input);
    inputsByObject.set(file.objectId, list);
  }

  if (inputsByObject.size === 0 && alreadyInLibrary > 0) {
    throw new LinkSourceError(
      'ALREADY_IMPORTED',
      'Every file in this folder is already in your library as a copy. Linking it would list each file twice.',
    );
  }

  db.prepare(
    `INSERT INTO librarySources (id, label, rootPath, fingerprint, enabled, createdAt, importOptions, overrides, refreshIntervalMin) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  ).run(
    sourceId, options.label, rootPath, computeRootFingerprint(rootPath), new Date().toISOString(),
    JSON.stringify(options.importOptions ?? {}), serializeOverrides(options.overrides),
    options.refreshIntervalMin ?? null,
  );

  let filesLinked = 0;
  for (const [objectId, inputs] of inputsByObject) {
    recordLinkedLibraryFiles(inputs);
    filesLinked += inputs.length;

    // Object first: a session row references it.
    upsertLinkedObject(objectId, attribution.customNames.get(objectId));
    learnNicknames(objectId, attribution.folderNames.get(objectId));
    ensureLinkedSessions(inputs);
  }

  db.prepare('UPDATE librarySources SET lastScanAt = ?, lastScanStats = ? WHERE id = ?').run(
    new Date().toISOString(),
    JSON.stringify({ files: filesLinked, objects: inputsByObject.size, bytes: walked.files.reduce((s, f) => s + f.size, 0) }),
    sourceId,
  );

  log.info({ sourceId, rootPath, objects: inputsByObject.size, files: filesLinked }, '[library-sources] linked');

  return { sourceId, objectsLinked: inputsByObject.size, filesLinked, filesAlreadyInLibrary: alreadyInLibrary };
}


// ── Validation ──────────────────────────────────────────────────────────────

export type LinkErrorCode =
  | 'NOT_A_DIRECTORY'
  | 'OVERLAPS_LIBRARY'
  | 'OVERLAPS_ARCHIVE'
  | 'ALREADY_LINKED'
  | 'ALREADY_IMPORTED'
  | 'SOURCE_NOT_FOUND'
  | 'INVALID_LABEL'
  | 'INVALID_REFRESH';

export class LinkSourceError extends Error {
  constructor(public readonly code: LinkErrorCode, message: string) {
    super(message);
    this.name = 'LinkSourceError';
  }
}

function realOrResolved(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/** True when `inner` is `outer` or lives beneath it. Case-insensitive on the
 *  platforms whose filesystems are (Windows, macOS default), matching how a
 *  user would perceive "the same folder". */
function isSameOrInside(inner: string, outer: string): boolean {
  const fold = process.platform === 'win32' || process.platform === 'darwin'
    ? (v: string) => v.toLowerCase()
    : (v: string) => v;
  const rel = path.relative(fold(outer), fold(inner));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Refuse a root that cannot be linked safely: not a folder, overlapping the
 * managed library or Nebulis's own data directory (linking it would index
 * Nebulis's files as "yours"), or overlapping a folder that is already linked
 * (the same file would be indexed twice). `ignoreSourceId` lets a rescan skip
 * its own row.
 */
export function assertLinkableRoot(rootPath: string, ignoreSourceId?: string): void {
  let isDir = false;
  try { isDir = fs.statSync(rootPath).isDirectory(); } catch { /* falls through */ }
  if (!isDir) throw new LinkSourceError('NOT_A_DIRECTORY', `Folder not found or not a directory: ${rootPath}`);

  const real = realOrResolved(rootPath);
  const protectedDirs = [realOrResolved(getLibraryDir()), realOrResolved(DATA_DIR)];
  for (const dir of protectedDirs) {
    if (isSameOrInside(real, dir) || isSameOrInside(dir, real)) {
      throw new LinkSourceError(
        'OVERLAPS_LIBRARY',
        'That folder overlaps Nebulis\'s own library or data folder. Choose the folder that holds your captures instead.',
      );
    }
  }
  // The archive's root is checked as it resolves today, so a destination saved before
  // this folder existed still blocks it. Linking a folder that holds the archive would
  // index the archive's copies as the user's originals, and the archive's pruning
  // would then delete files the user manages.
  const archiveRoot = resolveArchiveDestination(getArchiveConfig());
  // A share's root is only comparable when it is a real path on this machine; on Linux it is a
  // display string that never touches a local disk.
  if (archiveRoot.ok && path.isAbsolute(archiveRoot.root) && pathsOverlap(rootPath, archiveRoot.root)) {
    throw new LinkSourceError(
      'OVERLAPS_ARCHIVE',
      'That folder overlaps your archive destination. Choose the folder that holds your captures instead.',
    );
  }
  for (const source of listLibrarySources()) {
    if (source.id === ignoreSourceId) continue;
    const other = realOrResolved(source.rootPath);
    if (isSameOrInside(real, other) || isSameOrInside(other, real)) {
      throw new LinkSourceError('ALREADY_LINKED', `That folder overlaps one that is already linked: ${source.label}.`);
    }
  }
}

// ── Rename ──────────────────────────────────────────────────────────────────

export function renameSource(id: string, label: string): LibrarySourceRow {
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > 120) {
    throw new LinkSourceError('INVALID_LABEL', 'A linked folder\'s name must be 1-120 characters.');
  }
  const info = db.prepare('UPDATE librarySources SET label = ? WHERE id = ?').run(trimmed, id);
  const row = info.changes > 0 ? getLibrarySource(id) : null;
  if (!row) throw new LinkSourceError('SOURCE_NOT_FOUND', 'That linked folder no longer exists.');
  return row;
}

/** Change how often a source refreshes itself. Null turns automatic refresh off (rescan by hand only). */
export function setRefreshInterval(id: string, minutes: number | null): LibrarySourceRow {
  if (minutes !== null && !isValidRefreshInterval(minutes)) {
    throw new LinkSourceError('INVALID_REFRESH', 'Pick one of the listed refresh intervals.');
  }
  const info = db.prepare('UPDATE librarySources SET refreshIntervalMin = ? WHERE id = ?').run(minutes, id);
  const row = info.changes > 0 ? getLibrarySource(id) : null;
  if (!row) throw new LinkSourceError('SOURCE_NOT_FOUND', 'That linked folder no longer exists.');
  return row;
}

export interface SourceUpdate {
  label?: string;
  /** Minutes between automatic rescans; null switches the source to one-time. */
  refreshIntervalMin?: number | null;
}

/** Apply a name and/or schedule change as one unit: an invalid half leaves the source untouched. */
export function updateSource(id: string, update: SourceUpdate): LibrarySourceRow {
  return db.transaction(() => {
    let row = getLibrarySource(id);
    if (!row) throw new LinkSourceError('SOURCE_NOT_FOUND', 'That linked folder no longer exists.');
    if (update.label !== undefined) row = renameSource(id, update.label);
    if (update.refreshIntervalMin !== undefined) row = setRefreshInterval(id, update.refreshIntervalMin);
    return row;
  })();
}

/** Sources whose automatic refresh has come round. A source never scanned is due at once. `lastScanAt` is
 *  stamped by an offline attempt too, so an unplugged drive is retried once per interval, not every tick. */
export function listDueSources(now: number = Date.now()): LibrarySourceRow[] {
  return listLibrarySources().filter(s => {
    if (!s.enabled || s.refreshIntervalMin === null) return false;
    if (!s.lastScanAt) return true;
    const last = Date.parse(s.lastScanAt);
    return Number.isNaN(last) || now - last >= s.refreshIntervalMin * 60_000;
  });
}

// ── Fingerprint ─────────────────────────────────────────────────────────────

const FINGERPRINT_NAMES = 25;
/** A row must stay missing this long, across at least two scans, before it is
 *  deleted. The row is only an index entry, so keeping it a day longer costs
 *  nothing, while a scheduled rescan that hit a half-mounted drive twice in an
 *  hour would otherwise drop it. */
export const LINKED_ROW_GRACE_MS = 24 * 60 * 60 * 1000;

function topLevelNames(rootPath: string): string[] | null {
  try {
    return fs.readdirSync(rootPath).filter(n => !n.startsWith('.')).sort();
  } catch {
    return null;
  }
}

/**
 * A sample of the root's top-level names, stored at link time. It is what tells a
 * drive that came back from an empty mount point or a different disk mounted at
 * the same path: both are readable directories, so "the root exists" cannot. It is
 * content-based rather than a device id because device ids change across remounts
 * and reboots, which would strand a healthy source as offline.
 */
export function computeRootFingerprint(rootPath: string): string | null {
  const names = topLevelNames(rootPath);
  return names === null ? null : JSON.stringify(names.slice(0, FINGERPRINT_NAMES));
}

/** False when the root is readable but holds none of the names it had at link time. */
function fingerprintMatches(stored: string | null, rootPath: string): boolean {
  if (!stored) return true; // Linked before fingerprints existed: nothing to compare.
  let expected: unknown;
  try { expected = JSON.parse(stored); } catch { return true; }
  if (!Array.isArray(expected) || expected.length === 0) return true;
  const current = topLevelNames(rootPath);
  if (current === null) return false;
  const present = new Set(current);
  return expected.some(name => typeof name === 'string' && present.has(name));
}

// ── Rescan ──────────────────────────────────────────────────────────────────

export interface RescanSourceResult {
  sourceId: string;
  /** rootPath unreadable at rescan time: nothing was touched. */
  offline: boolean;
  added: number;
  updated: number;
  unchanged: number;
  /** First miss: kept, flagged missing, and restored if the file reappears. */
  missing: number;
  /** Second consecutive miss: the row was removed (the file on disk never is). */
  removed: number;
  /** The walk hit a cap, so absent files were NOT treated as missing. */
  truncated: boolean;
  /** Some folders were nested too deep to read; their files were not treated as missing. */
  depthLimited: boolean;
  objects: number;
}

interface StoredLinkedRow {
  relPath: string; objectId: string; sourcePath: string | null;
  bytes: number; mtimeMs: number | null; missingSince: string | null; captureDate: string | null;
}

/**
 * Re-read a linked folder and reconcile it with what was indexed. A file that
 * is new or whose size/mtime changed is re-attributed; a file that has
 * disappeared is flagged on the first rescan that misses it and its row is
 * removed on the second (contract Open Question 2's two-strikes rule), so a
 * drive that was merely unplugged for one scan loses nothing. If the root
 * itself is unreadable the source is reported offline and no row is touched.
 * Nothing on the user's disk is ever written.
 */
export function rescanSource(id: string, baseSettings: Record<string, unknown>): RescanSourceResult {
  const source = getLibrarySource(id);
  if (!source) throw new LinkSourceError('SOURCE_NOT_FOUND', 'That linked folder no longer exists.');
  // Read the tree with the options the link used, not whatever the app-wide
  // setting happens to be today.
  const settings = { ...baseSettings, ...parseImportOptions(source.importOptions) };

  const result: RescanSourceResult = {
    sourceId: id, offline: false, added: 0, updated: 0, unchanged: 0, missing: 0, removed: 0, truncated: false, depthLimited: false, objects: 0,
  };
  const now = new Date().toISOString();

  // Nothing is touched: the source is only marked as not reachable right now.
  const goOffline = (): RescanSourceResult => {
    result.offline = true;
    db.prepare('UPDATE librarySources SET lastScanAt = ?, lastScanStats = ? WHERE id = ?').run(
      now, JSON.stringify({ ...safeStats(source.lastScanStats), offline: true }), id,
    );
    return result;
  };

  let rootIsDir = false;
  try { rootIsDir = fs.statSync(source.rootPath).isDirectory(); } catch { /* offline */ }
  if (!rootIsDir) return goOffline();

  const walked = walkSource(source.rootPath, settings);
  result.truncated = walked.truncated;
  result.depthLimited = walked.depthLimited;

  // The root exists, which does not mean it is the drive that was linked. An
  // unmounted volume leaves an empty directory behind, and a walk of that finds
  // nothing, which would read as "every file was deleted".
  if (walked.unreadableDirs.includes('')) return goOffline();
  if (!fingerprintMatches(source.fingerprint, source.rootPath)) return goOffline();
  const storedCount = db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM libraryFiles WHERE sourceId = ?').get(id)?.n ?? 0;
  if (walked.files.length === 0 && storedCount > 0) return goOffline();

  const attribution = attributeFiles(walked.files.map(f => f.relPath), { overrides: parseStoredOverrides(source.overrides) });
  applyDesignationRedirects(attribution);
  const byRelPath = new Map(walked.files.map(f => [f.relPath, f]));

  const stored = db.prepare<[string], StoredLinkedRow>(
    'SELECT relPath, objectId, sourcePath, bytes, mtimeMs, missingSince, captureDate FROM libraryFiles WHERE sourceId = ?',
  ).all(id);
  const storedByPath = new Map<string, StoredLinkedRow>();
  for (const r of stored) if (r.sourcePath) storedByPath.set(r.sourcePath, r);

  const toRecord: RecordLinkedFileInput[] = [];
  const stillPresent = new Set<string>();
  const touchedObjects = new Set<string>();
  const reassigned: Array<{ objectId: string; captureDate: string | null }> = [];

  for (const file of attribution.files) {
    if (file.excluded || !file.objectId) continue;
    const walkedFile = byRelPath.get(file.relPath);
    if (!walkedFile) continue;
    stillPresent.add(file.relPath);

    const prior = storedByPath.get(file.relPath);
    const same = prior
      && prior.objectId === file.objectId
      && prior.bytes === walkedFile.size
      && prior.mtimeMs === walkedFile.mtimeMs
      && prior.missingSince === null;
    if (same) { result.unchanged++; continue; }

    // A file new to this link that the library already holds as a copy is not linked (see isAlreadyImportedCopy).
    if (!prior && isAlreadyImportedCopy(file.objectId, file.relPath, walkedFile)) continue;
    const input = buildLinkedInput(id, file.objectId, file.relPath, walkedFile, settings);
    if (!input) continue;
    toRecord.push(input);
    touchedObjects.add(file.objectId);
    if (prior) {
      result.updated++;
      // Re-attributed to a different object (a rule improved, or a folder was
      // moved): the old object may now be empty.
      if (prior.objectId !== file.objectId) reassigned.push({ objectId: prior.objectId, captureDate: prior.captureDate });
    } else {
      result.added++;
    }
  }

  recordLinkedLibraryFiles(toRecord);
  // Every object this source still owns, not just the ones whose files changed:
  // it also un-deletes an object left tombstoned by an earlier run and refreshes
  // a display name, so a rescan repairs a link instead of only extending it.
  const liveObjects = new Set(touchedObjects);
  for (const r of db.prepare<[string], { objectId: string }>(
    'SELECT DISTINCT objectId FROM libraryFiles WHERE sourceId = ? AND missingSince IS NULL',
  ).all(id)) liveObjects.add(r.objectId);
  for (const objectId of liveObjects) {
    upsertLinkedObject(objectId, attribution.customNames.get(objectId));
    learnNicknames(objectId, attribution.folderNames.get(objectId));
  }
  pruneEmptySessions(reassigned);
  retireEmptyObjects(new Set(reassigned.map(r => r.objectId)));
  // Also heals a link made before session rows were written for linked files.
  ensureLinkedSessions(db.prepare<[string], { objectId: string; captureDate: string | null }>(
    'SELECT DISTINCT objectId, captureDate FROM libraryFiles WHERE sourceId = ? AND captureDate IS NOT NULL AND missingSince IS NULL',
  ).all(id));

  // A truncated walk saw only part of the tree, so absence proves nothing. Neither
  // does absence under a directory the walk could not read.
  if (!walked.truncated) {
    const isUnderUnreadable = (rel: string): boolean =>
      walked.unreadableDirs.some(dir => rel === dir || rel.startsWith(`${dir}/`));
    const gone = stored.filter(r => r.sourcePath && !stillPresent.has(r.sourcePath) && !isUnderUnreadable(r.sourcePath));
    // A file already flagged that is *still* gone, and has been for the grace
    // period, is the second strike; one that was flagged and has come back was
    // un-flagged by the upsert above.
    const { markedMissing, deleted } = markLinkedFilesMissing(gone.map(r => r.relPath), LINKED_ROW_GRACE_MS);
    result.missing = markedMissing.length;
    result.removed = deleted.length;
    const removedRows = gone.filter(r => deleted.includes(r.relPath));
    pruneEmptySessions(removedRows);
    retireEmptyObjects(new Set(removedRows.map(r => r.objectId)));
  }

  const totals = db.prepare<[string], { files: number; objects: number; bytes: number }>(
    'SELECT COUNT(*) AS files, COUNT(DISTINCT objectId) AS objects, COALESCE(SUM(bytes), 0) AS bytes FROM libraryFiles WHERE sourceId = ?',
  ).get(id) ?? { files: 0, objects: 0, bytes: 0 };
  result.objects = totals.objects;
  // Refreshed on every clean scan, so a top level that is reorganised bit by bit
  // never drifts far enough from the sample to look like a different drive.
  db.prepare('UPDATE librarySources SET lastScanAt = ?, lastScanStats = ?, fingerprint = COALESCE(?, fingerprint) WHERE id = ?').run(
    now, JSON.stringify({ ...totals, missing: result.missing }), computeRootFingerprint(source.rootPath), id,
  );

  log.info({ ...result }, '[library-sources] rescanned');
  return result;
}

function safeStats(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  return parseJsonRecord(raw) ?? {};
}

// ── Remove ──────────────────────────────────────────────────────────────────

export interface DeleteSourceResult {
  filesUnlinked: number;
  objectsRetired: string[];
}

/**
 * Unlink a folder: drop its index rows, never its files. An object left with
 * no files of any kind and no notes/favourites is soft-deleted (restorable);
 * an object with a note, a favourite, or files from another source stays.
 */
export function deleteSource(id: string): DeleteSourceResult {
  if (!getLibrarySource(id)) throw new LinkSourceError('SOURCE_NOT_FOUND', 'That linked folder no longer exists.');
  const nights = db.prepare<[string], { objectId: string; captureDate: string | null }>(
    'SELECT DISTINCT objectId, captureDate FROM libraryFiles WHERE sourceId = ?',
  ).all(id);
  const objectIds = [...new Set(nights.map(r => r.objectId))];

  const tx = db.transaction(() => {
    const info = db.prepare('DELETE FROM libraryFiles WHERE sourceId = ?').run(id);
    db.prepare('DELETE FROM librarySources WHERE id = ?').run(id);
    return info.changes;
  });
  const filesUnlinked = tx();
  pruneEmptySessions(nights);
  const objectsRetired = retireEmptyObjects(objectIds);
  log.info({ sourceId: id, filesUnlinked, objectsRetired: objectsRetired.length }, '[library-sources] unlinked');
  return { filesUnlinked, objectsRetired };
}

/** Sources with live per-source counts, for the Settings list. `offline` is
 *  checked live rather than stored, so it is right the moment a drive returns. */
export interface LinkedSourceSummary extends LibrarySourceRow {
  fileCount: number;
  objectCount: number;
  bytes: number;
  missingCount: number;
  offline: boolean;
}

export function summarizeSources(): LinkedSourceSummary[] {
  const counts = db.prepare<[], { sourceId: string; files: number; objects: number; bytes: number; missing: number }>(
    `SELECT sourceId, COUNT(*) AS files, COUNT(DISTINCT objectId) AS objects,
            COALESCE(SUM(bytes), 0) AS bytes,
            SUM(CASE WHEN missingSince IS NOT NULL THEN 1 ELSE 0 END) AS missing
       FROM libraryFiles WHERE sourceId IS NOT NULL GROUP BY sourceId`,
  ).all();
  const bySource = new Map(counts.map(c => [c.sourceId, c]));
  return listLibrarySources().map(s => {
    const c = bySource.get(s.id);
    let offline = true;
    try { offline = !fs.statSync(s.rootPath).isDirectory(); } catch { /* unreadable */ }
    return {
      ...s,
      fileCount: c?.files ?? 0,
      objectCount: c?.objects ?? 0,
      bytes: c?.bytes ?? 0,
      missingCount: c?.missing ?? 0,
      offline,
    };
  });
}
