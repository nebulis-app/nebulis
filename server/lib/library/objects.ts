/**
 * Library — core object domain.
 *
 * Owns the shared SQLite prepared statements (`stmts`), database migrations,
 * library-wide constants, and object-level CRUD/query helpers used across the
 * other library/* modules.
 */
import fs from 'fs';
import path from 'path';
import { getLibraryDir, withTimeout, LIBRARY_IO_TIMEOUT_MS } from '../libraryPath.js';
import db from '../db.js';
import { getSettingsData } from '../telescopes.js';
import type { TransportKind } from '../telescopeTransports.js';
import {
  parseFilename,
  normalizeCatalogId,
  isRealFile,
  sessionNightFor,
} from '../telescopeFiles.js';
import { resolveCanonicalId, expandSearchAliases, getAliasesForCanonical } from '../catalogAliases.js';
import { getCatalogEntry } from '../../data/catalog.js';
import { SOLAR_SYSTEM_LOOKUP_KEYS } from '../../data/solar-system-catalog.js';
import { parseFitsHeader } from '../fitsParser.js';
import { log } from '../logger.js';
import { fetchWikipediaSummary } from '../wikipedia.js';
import { getCuratedDescription } from '../curatedDescriptions.js';
import { getLibraryObjectFilterTags } from './objectFilters.js';
import { isEnrichmentCoolingDown } from './enrichmentCooldown.js';
import { isReservedLibraryDir } from './archiveFolders.js';
import {
  resolverFor,
  deleteLibraryFileRow,
  deleteLibraryFileRowsForObject,
  writeObjectManifest,
} from './libraryFiles.js';
import { listObjectFiles, getObjectLayout } from './libraryLayout.js';
import { rekeyLibraryObject } from './libraryRekey.js';
import { deleteCaptureInfoForObject } from './captureInfo.js';
import { getStartrailsObjectId, patchStartrailsObjectMeta } from './dwarfStartrails.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LibraryIndex {
  version: number;
  objects: Record<string, LibraryObjectMeta>;
  lastImport: string | null;
}

export interface LibraryObjectMeta {
  folderName: string;
  sessions: string[];      // YYYY-MM-DD array
  fileCount: number;
  lastImport: string;      // ISO date
  deleted?: boolean;
  deletedAt?: string;      // ISO date
  deletedSessions?: string[];  // YYYY-MM-DD dates that must never be re-imported
}

// Row shape for libraryObjects after all migrations are applied. SQL trust
// boundary: columns are enforced by the CREATE TABLE + ALTER TABLE statements
// that run at module load (see migrationColumns below).
export interface LibraryObjectRow {
  objectId: string;
  folderName: string;
  fileCount: number;
  lastImport: string;
  deleted: number;
  deletedAt: string | null;
  galleryImage: string | null;
  galleryImageUserSet: number;
  catalogId: string | null;
  objectName: string | null;
  objectType: string | null;
  constellation: string | null;
  description: string | null;
  magnitude: number | null;
  ra: string | null;
  dec: string | null;
  distanceLy: number | null;
  wikiUrl: string | null;
  sizeArcmin: string | null;
  primaryTelescopeId: string | null;
}

export interface LibrarySessionRow {
  objectId: string;
  date: string;
  telescopeId: string | null;
  temperature: number | null;
  cloudCover: number | null;
  humidity: number | null;
  windSpeed: number | null;
  dewPoint: number | null;
  visibility: number | null;
  precipProb: number | null;
  sessionImage: string | null;
  /** Which observing site this session was captured from. NULL = not explicitly
   *  tagged, in which case the location comes from the capture files and only
   *  then from the default site. See server/lib/library/sessionLocation.ts. */
  siteId: string | null;
  /** Where the cached weather above was fetched. NULL predates the columns. */
  weatherLat: number | null;
  weatherLon: number | null;
}

export interface LibraryMetaRow {
  id: number;
  version: number;
  lastImport: string | null;
  importRunning: number;
  importStartedAt: string | null;
}

/** 'dwarf-restack' rows come from an auto-imported Dwarf RESTACKED (MegaStack)
 *  file — see server/lib/library/dwarfRestack.ts. Everything else is a user
 *  upload. */
export type ProcessedImageSource = 'user' | 'dwarf-restack';

export interface ProcessedImageRow {
  id: string;
  objectId: string;
  /** NULL for an image not tied to any single observing night (currently
   *  only Dwarf RESTACKED auto-imports — see the table comment above its
   *  CREATE TABLE). */
  date: string | null;
  filename: string;
  originalName: string;
  title: string;
  notes: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
  runId: string | null;
  source: ProcessedImageSource;
}

export interface ImportHistoryRow {
  id: number;
  startedAt: string;
  finishedAt: string;
  objectsTotal: number;
  filesTotal: number;
  newFiles: number;
  bytesTotal: number;
  bytesNew: number;
  error: string | null;
  files: string | null;
  telescopeId: string | null;
  telescopeName: string | null;
  transportKind: TransportKind | null;
  /** JSON-serialized ImportSkipSummary[], or NULL when nothing was skipped. */
  skipped: string | null;
  /** 1 if the user explicitly triggered this run, 0 for a scheduled auto-import tick. */
  manual: number;
  /** 1 when `error` describes a user-requested cancellation rather than a
   *  genuine failure, 0 (including rows written before this column existed)
   *  otherwise. */
  cancelled: number;
  /** JSON-serialized TouchedObject[], or NULL when nothing was tracked (rows
   *  written before this was added, or a run that added no files). */
  objectsTouched: string | null;
  /** JSON-serialized TouchedSession[], same NULL rule as objectsTouched. */
  sessionsTouched: string | null;
}

// ─── Constants ──────────────────────────────────────────────────────────────

export const LIBRARY_API_BASE = '/api/v1/library';

// ─── Migrations ─────────────────────────────────────────────────────────────

// Add columns introduced after the initial schema.
// Each migration is idempotent: SELECT to check, ALTER if missing.
const migrationColumns: Array<{ column: string; sql: string }> = [
  { column: 'galleryImage', sql: 'ALTER TABLE libraryObjects ADD COLUMN galleryImage TEXT' },
  { column: 'catalogId',    sql: 'ALTER TABLE libraryObjects ADD COLUMN catalogId TEXT' },
  { column: 'objectName',   sql: 'ALTER TABLE libraryObjects ADD COLUMN objectName TEXT' },
  { column: 'objectType',   sql: 'ALTER TABLE libraryObjects ADD COLUMN objectType TEXT' },
  { column: 'constellation',sql: 'ALTER TABLE libraryObjects ADD COLUMN constellation TEXT' },
  { column: 'description',  sql: 'ALTER TABLE libraryObjects ADD COLUMN description TEXT' },
  { column: 'magnitude',    sql: 'ALTER TABLE libraryObjects ADD COLUMN magnitude REAL' },
  { column: 'ra',           sql: 'ALTER TABLE libraryObjects ADD COLUMN ra TEXT' },
  { column: 'dec',          sql: 'ALTER TABLE libraryObjects ADD COLUMN dec TEXT' },
  { column: 'distanceLy',  sql: 'ALTER TABLE libraryObjects ADD COLUMN distanceLy REAL' },
  { column: 'wikiUrl',            sql: 'ALTER TABLE libraryObjects ADD COLUMN wikiUrl TEXT' },
  { column: 'sizeArcmin',        sql: 'ALTER TABLE libraryObjects ADD COLUMN sizeArcmin TEXT' },
  { column: 'galleryImageUserSet', sql: 'ALTER TABLE libraryObjects ADD COLUMN galleryImageUserSet INTEGER NOT NULL DEFAULT 0' },
  // Negative cache for catalog enrichment. Without these, "needs enrichment" is
  // the *absence* of a result, so an object Wikipedia and SIMBAD cannot resolve
  // matches forever and is re-queried on every server start and every import.
  // See shouldSkipEnrichment.
  { column: 'enrichmentAttemptedAt', sql: 'ALTER TABLE libraryObjects ADD COLUMN enrichmentAttemptedAt TEXT' },
  { column: 'enrichmentAttempts', sql: 'ALTER TABLE libraryObjects ADD COLUMN enrichmentAttempts INTEGER NOT NULL DEFAULT 0' },
];
const sessionMigrations: Array<{ column: string; sql: string }> = [
  { column: 'temperature',  sql: 'ALTER TABLE librarySessions ADD COLUMN temperature REAL' },
  { column: 'cloudCover',   sql: 'ALTER TABLE librarySessions ADD COLUMN cloudCover REAL' },
  { column: 'humidity',     sql: 'ALTER TABLE librarySessions ADD COLUMN humidity REAL' },
  { column: 'windSpeed',    sql: 'ALTER TABLE librarySessions ADD COLUMN windSpeed REAL' },
  { column: 'dewPoint',     sql: 'ALTER TABLE librarySessions ADD COLUMN dewPoint REAL' },
  { column: 'visibility',   sql: 'ALTER TABLE librarySessions ADD COLUMN visibility REAL' },
  { column: 'precipProb',   sql: 'ALTER TABLE librarySessions ADD COLUMN precipProb REAL' },
  { column: 'sessionImage', sql: 'ALTER TABLE librarySessions ADD COLUMN sessionImage TEXT' },
];
for (const m of migrationColumns) {
  try { db.prepare(`SELECT ${m.column} FROM libraryObjects LIMIT 0`).run(); }
  catch { db.prepare(m.sql).run(); }
}
for (const m of sessionMigrations) {
  try { db.prepare(`SELECT ${m.column} FROM librarySessions LIMIT 0`).run(); }
  catch { db.prepare(m.sql).run(); }
}

// Migrations for libraryMeta table
try { db.prepare('SELECT importRunning FROM libraryMeta LIMIT 0').run(); }
catch { db.prepare('ALTER TABLE libraryMeta ADD COLUMN importRunning INTEGER NOT NULL DEFAULT 0').run(); }
try { db.prepare('SELECT importStartedAt FROM libraryMeta LIMIT 0').run(); }
catch { db.prepare('ALTER TABLE libraryMeta ADD COLUMN importStartedAt TEXT').run(); }

// Migration for libraryDeletedSessions: when a session was tombstoned, so the
// trash view can sort and show it. Rows written before this column existed
// carry NULL, which the trash view is written to tolerate rather than backfill
// with a fabricated date.
try { db.prepare('SELECT deletedAt FROM libraryDeletedSessions LIMIT 0').run(); }
catch { db.prepare('ALTER TABLE libraryDeletedSessions ADD COLUMN deletedAt TEXT').run(); }

// Ensure importHistory table exists (added after initial schema)
db.prepare(`CREATE TABLE IF NOT EXISTS importHistory (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  startedAt   TEXT NOT NULL,
  finishedAt  TEXT NOT NULL,
  objectsTotal INTEGER NOT NULL DEFAULT 0,
  filesTotal  INTEGER NOT NULL DEFAULT 0,
  newFiles    INTEGER NOT NULL DEFAULT 0,
  bytesTotal  INTEGER NOT NULL DEFAULT 0,
  bytesNew    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  files       TEXT
)`).run();
try { db.prepare('SELECT 1 FROM importHistory LIMIT 0').run(); } catch { /* table exists */ }
db.prepare('CREATE INDEX IF NOT EXISTS idx_importHistory_finished ON importHistory(finishedAt DESC)').run();

// Per-history-row telescope + transport context. Added after initial schema
// so old rows are NULL; new rows get the telescope name + transport kind
// captured at the moment of the run. NULL means "no telescope context"
// (folder import or drag-and-drop upload).
{
  const ihCols = db.prepare<[], { name: string }>('PRAGMA table_info(importHistory)').all();
  if (!ihCols.some(c => c.name === 'telescopeId')) {
    db.prepare('ALTER TABLE importHistory ADD COLUMN telescopeId TEXT').run();
  }
  if (!ihCols.some(c => c.name === 'telescopeName')) {
    // Snapshotted at run time so a profile rename later doesn't rewrite
    // history. Same approach librarySessions uses for telescopeId.
    db.prepare('ALTER TABLE importHistory ADD COLUMN telescopeName TEXT').run();
  }
  if (!ihCols.some(c => c.name === 'transportKind')) {
    // 'smb' | 'local' | 'ftp' | NULL (no transport context).
    db.prepare('ALTER TABLE importHistory ADD COLUMN transportKind TEXT').run();
  }
  if (!ihCols.some(c => c.name === 'skipped')) {
    // JSON-serialized ImportSkipSummary[]: what the run found but did not
    // import, and why. NULL on rows written before this existed and on runs
    // that skipped nothing, so a NULL never means "we skipped things and lost
    // track of what they were".
    db.prepare('ALTER TABLE importHistory ADD COLUMN skipped TEXT').run();
  }
  if (!ihCols.some(c => c.name === 'manual')) {
    // 1 when the user explicitly triggered this run (Sync Now button, a
    // per-object/session sync), 0 for the scheduled auto-import tick. Lets
    // getHistory surface a zero-new-file run when the user asked for it
    // directly, while still hiding the routine "nothing changed" noise a
    // background tick produces every interval.
    db.prepare('ALTER TABLE importHistory ADD COLUMN manual INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!ihCols.some(c => c.name === 'cancelled')) {
    // 1 when the run stopped because the user clicked Cancel, 0 for a
    // genuine failure. Lets Sync History show "Cancelled" instead of
    // "Failed" without guessing from the error text.
    db.prepare('ALTER TABLE importHistory ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!ihCols.some(c => c.name === 'objectsTouched')) {
    // JSON-serialized TouchedObject[]: which catalog objects this run added
    // files to, and whether the run created the object. NULL on rows written
    // before this existed and on runs that added no files, same rule as
    // `skipped` above.
    db.prepare('ALTER TABLE importHistory ADD COLUMN objectsTouched TEXT').run();
  }
  if (!ihCols.some(c => c.name === 'sessionsTouched')) {
    // JSON-serialized TouchedSession[]: which observation nights this run
    // added files to, and whether the run created the night. Same NULL rule.
    db.prepare('ALTER TABLE importHistory ADD COLUMN sessionsTouched TEXT').run();
  }
}

// Ensure sessionProcessedImages table exists (added after initial schema).
// `date` is nullable: a Dwarf RESTACKED auto-import (see dwarfRestack.ts) is
// tied to an object but not to any single observing night, and NULL is what
// lets `getProcessedImages`'s `WHERE date = ?` keep excluding it from every
// per-session view for free, with no per-caller sentinel to remember.
// `source` distinguishes that auto-import from a user upload.
db.prepare(`CREATE TABLE IF NOT EXISTS sessionProcessedImages (
  id           TEXT PRIMARY KEY,
  objectId     TEXT NOT NULL,
  date         TEXT,
  filename     TEXT NOT NULL,
  originalName TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  notes        TEXT NOT NULL DEFAULT '',
  size         INTEGER NOT NULL DEFAULT 0,
  mimeType     TEXT NOT NULL DEFAULT '',
  uploadedAt   TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'user'
)`).run();
db.prepare('CREATE INDEX IF NOT EXISTS idx_sessionProcessedImages_session ON sessionProcessedImages(objectId, date)').run();

// A processing run records which nights a processed image actually combines
// (a "day 1+2+3 stack" needs to say so), separate from `sessionProcessedImages.date`
// which stays the single anchor session the row is filed under for the
// existing per-session list endpoint.
db.prepare(`CREATE TABLE IF NOT EXISTS processingRuns (
  id        TEXT PRIMARY KEY,
  objectId  TEXT NOT NULL,
  title     TEXT NOT NULL DEFAULT '',
  notes     TEXT NOT NULL DEFAULT '',
  software  TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL
)`).run();
db.prepare('CREATE INDEX IF NOT EXISTS idx_processingRuns_object ON processingRuns(objectId)').run();

db.prepare(`CREATE TABLE IF NOT EXISTS processingRunSessions (
  runId TEXT NOT NULL REFERENCES processingRuns(id) ON DELETE CASCADE,
  date  TEXT NOT NULL,
  PRIMARY KEY (runId, date)
)`).run();

// sessionProcessedImages.runId — added after initial schema. NULL means the
// image predates processing runs; backfilled below into one-session runs so
// every processed image ends up with a run and "which nights" is uniform.
{
  const spiCols = db.prepare<[], { name: string }>('PRAGMA table_info(sessionProcessedImages)').all();
  if (!spiCols.some(c => c.name === 'runId')) {
    db.prepare('ALTER TABLE sessionProcessedImages ADD COLUMN runId TEXT').run();
  }
}
{
  // `date IS NOT NULL`: a Dwarf RESTACKED image (source: 'dwarf-restack') is
  // deliberately not anchored to a single observing night, and
  // sessionProcessedImages.date is nullable specifically for it (see the
  // rebuild below). processingRunSessions.date is NOT NULL — it exists to
  // record which nights a run combines, and "no nights" isn't a row it can
  // hold. Leaving these with runId NULL forever is correct, not a gap:
  // getRunDates(null) already returns null, the state every other read path
  // treats as "no run" for exactly this case.
  const orphaned = db
    .prepare<[], { objectId: string; date: string }>(
      'SELECT DISTINCT objectId, date FROM sessionProcessedImages WHERE runId IS NULL AND date IS NOT NULL',
    )
    .all();
  if (orphaned.length > 0) {
    const insertRun = db.prepare(
      `INSERT INTO processingRuns (id, objectId, title, notes, software, createdAt) VALUES (?, ?, '', '', '', ?)`,
    );
    const insertRunSession = db.prepare(
      'INSERT INTO processingRunSessions (runId, date) VALUES (?, ?)',
    );
    const setRunId = db.prepare(
      'UPDATE sessionProcessedImages SET runId = ? WHERE objectId = ? AND date = ? AND runId IS NULL',
    );
    const backfillRuns = db.transaction(() => {
      for (const { objectId, date } of orphaned) {
        const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        insertRun.run(runId, objectId, new Date().toISOString());
        insertRunSession.run(runId, date);
        setRunId.run(runId, objectId, date);
      }
    });
    backfillRuns();
  }
}

// sessionProcessedImages: relax `date` to nullable and add `source`, for
// databases created before Dwarf RESTACKED auto-import existed. SQLite can't
// drop a NOT NULL constraint with ALTER TABLE, so this is a one-time rebuild,
// guarded on the absence of `source` (added in the same rebuild, so its
// absence is a reliable "old schema" signal — safe to run this block on
// every boot since it becomes a no-op the moment the rebuild has happened
// once).
{
  const spiCols = db.prepare<[], { name: string }>('PRAGMA table_info(sessionProcessedImages)').all();
  if (!spiCols.some(c => c.name === 'source')) {
    db.transaction(() => {
      db.prepare(`CREATE TABLE sessionProcessedImages_new (
        id           TEXT PRIMARY KEY,
        objectId     TEXT NOT NULL,
        date         TEXT,
        filename     TEXT NOT NULL,
        originalName TEXT NOT NULL,
        title        TEXT NOT NULL DEFAULT '',
        notes        TEXT NOT NULL DEFAULT '',
        size         INTEGER NOT NULL DEFAULT 0,
        mimeType     TEXT NOT NULL DEFAULT '',
        uploadedAt   TEXT NOT NULL,
        runId        TEXT,
        source       TEXT NOT NULL DEFAULT 'user'
      )`).run();
      db.prepare(`INSERT INTO sessionProcessedImages_new
        (id, objectId, date, filename, originalName, title, notes, size, mimeType, uploadedAt, runId, source)
        SELECT id, objectId, date, filename, originalName, title, notes, size, mimeType, uploadedAt, runId, 'user'
        FROM sessionProcessedImages`).run();
      db.prepare('DROP TABLE sessionProcessedImages').run();
      db.prepare('ALTER TABLE sessionProcessedImages_new RENAME TO sessionProcessedImages').run();
      db.prepare('CREATE INDEX idx_sessionProcessedImages_session ON sessionProcessedImages(objectId, date)').run();
    })();
  }
}

// Migrate: strip spaces from objectIds ("M 16" → "M16", "IC 1318" → "IC1318")
{
  const spacedCountRow = db
    .prepare<[], { n: number }>(`SELECT COUNT(*) as n FROM libraryObjects WHERE instr(objectId, ' ') > 0`)
    .get();
  const spacedCount = spacedCountRow?.n ?? 0;
  if (spacedCount > 0) {
    console.log(`[library] Migrating ${spacedCount} object(s): normalizing objectIds (stripping spaces)...`);
    db.pragma('foreign_keys = OFF');
    const migrateIds = db.transaction(() => {
      const spaced = db
        .prepare<[], { objectId: string }>(`SELECT objectId FROM libraryObjects WHERE instr(objectId, ' ') > 0`)
        .all();
      for (const { objectId } of spaced) {
        const normalized = objectId.replace(/ /g, '');
        // Preserve folderName = original spaced name (if it matches objectId, meaning it was never explicitly set)
        db.prepare(`UPDATE libraryObjects SET folderName = ? WHERE objectId = ? AND (folderName = objectId OR folderName IS NULL OR folderName = '')`).run(objectId, objectId);
        // One helper moves the id across every table (incl. libraryFiles) and
        // carries every libraryObjects column (incl. layout). See libraryRekey.
        rekeyLibraryObject(objectId, normalized, { skipManifest: true });
      }
    });
    migrateIds();
    db.pragma('foreign_keys = ON');
    console.log(`[library] objectId normalization complete`);
  }
}

// Migrate: resolve catalog aliases to canonical IDs (e.g. "C30" → "NGC7331")
// DB operations only — file repair is handled separately by repairAliasDirectories().
{
  const allIds = db.prepare<[], { objectId: string }>('SELECT objectId FROM libraryObjects').all();
  const aliasRows = allIds.filter(({ objectId }) => resolveCanonicalId(objectId) !== objectId);

  if (aliasRows.length > 0) {
    console.log(`[library] Migrating ${aliasRows.length} object(s): resolving catalog aliases to canonical IDs...`);
    db.pragma('foreign_keys = OFF');
    const migrateAliases = db.transaction(() => {
      for (const { objectId } of aliasRows) {
        const canonical = resolveCanonicalId(objectId);
        // Preserve folderName = the original id, so disk access still resolves
        // (repairAliasDirectories moves the physical files separately).
        db.prepare(`UPDATE libraryObjects SET folderName = ? WHERE objectId = ? AND (folderName = objectId OR folderName IS NULL OR folderName = '')`).run(objectId, objectId);
        // One helper moves the id across every table (incl. libraryFiles) and,
        // on a simple rename, carries every libraryObjects column (incl.
        // layout); on a merge it folds fileCount/recency into the canonical row.
        rekeyLibraryObject(objectId, canonical, { skipManifest: true });
      }
    });
    migrateAliases();
    db.pragma('foreign_keys = ON');
    console.log(`[library] catalog alias normalization complete`);
  }
}

// Repair: undo objectId corruption from an earlier version of the two
// migrations above, which used a PREFIX designation match. "M31_mosaic",
// "NGC2244SatelliteCluster", "VdB126", "C2023A3(Tsuchinshan-ATLAS)" all merely
// start like a designation, so the whole string was uppercased ("M31_mosaic" →
// "M31_MOSAIC") and the object was recreated under the mangled id — WITHOUT its
// `layout` column and WITHOUT moving its `libraryFiles` rows. Every session of
// an affected (nested) object then read as empty. A related bug accreted "SH2-"
// prefixes ("SH2-108" → "SH2-2-2-...-108").
//
// `folderName` was preserved through every bad migration, and it is the real
// pre-corruption id, so it is the recovery source. Only rows whose id is
// provably a normalization artifact of `folderName` are touched; a legitimate
// fold ("C30" kept as folderName, row id "NGC7331") fails the canonical check
// and is left alone. Idempotent, and a no-op on a DB that never hit the bug.
{
  const collapseUpper = (s: string) => s.toUpperCase().replace(/\s+/g, '');
  const isSh2Accretion = (id: string, folder: string) =>
    /^SH2(?:-2)+-\d+$/.test(id) && id.replace(/^SH2(?:-2)+-/, 'SH2-') === folder;

  const candidates = db
    .prepare<[], { objectId: string; folderName: string }>(
      'SELECT objectId, folderName FROM libraryObjects WHERE folderName IS NOT NULL AND folderName != objectId',
    )
    .all()
    .filter(({ objectId, folderName }) =>
      resolveCanonicalId(folderName) === folderName &&
      (collapseUpper(folderName) === objectId || isSh2Accretion(objectId, folderName)));

  if (candidates.length > 0) {
    console.log(`[library] Repairing ${candidates.length} object(s) with a corrupted objectId (restoring from folderName)...`);
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      for (const { objectId, folderName } of candidates) {
        const mode = rekeyLibraryObject(objectId, folderName);
        console.log(`[library]   ${objectId} → ${folderName} (${mode})`);
      }
    })();
    db.pragma('foreign_keys = ON');
    console.log('[library] objectId corruption repair complete');
  }
}

/**
 * Normalize library directories that contain spaces in their names by merging
 * them into their space-free equivalents (e.g. "NGC 7331/" → "NGC7331/").
 *
 * This is needed because:
 *  - SeeStar sometimes names folders with spaces ("NGC 7331")
 *  - The space-stripping DB migration preserved folderName with spaces to avoid
 *    breaking file access, but never renamed the physical directory
 *  - repairAliasDirectories creates canonical dirs (no spaces) when it moves
 *    alias files, leaving two directories for the same object
 *
 * Run before repairAliasDirectories so alias repair always finds the right target.
 * Safe to run on every startup — idempotent once space dirs are gone.
 */
export function repairSpaceDirectories(): void {
  try {
    const LIBRARY_DIR = getLibraryDir();
    if (!fs.existsSync(LIBRARY_DIR)) return;

    for (const entry of fs.readdirSync(LIBRARY_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (isReservedLibraryDir(entry.name)) continue;
      const noSpaceName = entry.name.replace(/\s+/g, '');
      if (noSpaceName === entry.name) continue; // no spaces — nothing to do

      const spaceDir = path.join(LIBRARY_DIR, entry.name);
      const canonDir = path.join(LIBRARY_DIR, noSpaceName);

      try {
        if (!fs.existsSync(canonDir)) {
          // No canonical dir yet: atomic rename (fast path, no file-by-file copy).
          fs.renameSync(spaceDir, canonDir);
          console.log(`[library] SpaceRepair: renamed "${entry.name}/" → "${noSpaceName}/"`);
        } else {
          // Both dirs exist (e.g. "NGC 7331" + "NGC7331"): merge space dir into
          // canonical dir, then remove the now-empty space dir.
          _mergeIntoDir(spaceDir, canonDir);
          try {
            if (fs.readdirSync(spaceDir).length === 0) fs.rmdirSync(spaceDir);
          } catch { /* ignore — non-empty means some files couldn't be moved */ }
          console.log(`[library] SpaceRepair: merged "${entry.name}/" into "${noSpaceName}/"`);
        }

        // Update DB: find row by old folderName (space) or by objectId (no-space)
        // and normalise folderName + recount files.
        const row =
          db.prepare<[string], { objectId: string }>(
            'SELECT objectId FROM libraryObjects WHERE folderName = ?'
          ).get(entry.name) ??
          db.prepare<[string], { objectId: string }>(
            'SELECT objectId FROM libraryObjects WHERE objectId = ?'
          ).get(noSpaceName);

        if (row) {
          const fileCount = _countFiles(canonDir);
          db.prepare('UPDATE libraryObjects SET folderName = ?, fileCount = ? WHERE objectId = ?')
            .run(noSpaceName, fileCount, row.objectId);
        }
      } catch (err) {
        console.warn(`[library] SpaceRepair: "${entry.name}":`, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.warn('[library] repairSpaceDirectories failed:', err instanceof Error ? err.message : err);
  }
}

function _mergeIntoDir(from: string, to: string): void {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isFile()) {
      if (!fs.existsSync(dst)) {
        fs.renameSync(src, dst);
      } else {
        // Destination already has this file — the source copy is a duplicate.
        // Delete it so the space directory can be fully emptied and removed.
        fs.unlinkSync(src);
      }
    } else if (entry.isDirectory()) {
      if (!fs.existsSync(dst)) {
        fs.renameSync(src, dst); // subdir doesn't exist in target — move whole thing
      } else {
        _mergeIntoDir(src, dst);
        try { fs.rmdirSync(src); } catch { /* non-empty, leave it */ }
      }
    }
  }
}

function _countFiles(dir: string): number {
  return fs.readdirSync(dir).filter(f => {
    try { return fs.statSync(path.join(dir, f)).isFile(); } catch { return false; }
  }).length;
}

/**
 * Scan the library directory for subdirectories whose names are catalog aliases
 * (e.g. "C30") and move their files into the canonical object's directory.
 *
 * The target directory is always the one the DB's existing folderName points to —
 * never the raw canonical ID string. This prevents creating a new directory when
 * the object's files live in a folder with a different format (e.g. "NGC 7331"
 * with a space). folderName is never modified here; only fileCount is updated.
 */
export function repairAliasDirectories(): void {
  try {
    const LIBRARY_DIR = getLibraryDir();
    if (!fs.existsSync(LIBRARY_DIR)) return;
    const entries = fs.readdirSync(LIBRARY_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (isReservedLibraryDir(entry.name)) continue;
      const canonical = resolveCanonicalId(entry.name);
      if (canonical === entry.name) continue;

      const canonRow = db.prepare<[string], { folderName: string }>(
        'SELECT folderName FROM libraryObjects WHERE objectId = ?'
      ).get(canonical);
      if (!canonRow) continue;

      const aliasDir  = path.join(LIBRARY_DIR, entry.name);
      const targetDir = path.join(LIBRARY_DIR, canonRow.folderName);
      if (path.resolve(aliasDir) === path.resolve(targetDir)) continue;

      try {
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        let moved = 0;
        for (const fname of fs.readdirSync(aliasDir)) {
          const src = path.join(aliasDir, fname);
          if (!fs.statSync(src).isFile()) continue;
          const dst = path.join(targetDir, fname);
          if (!fs.existsSync(dst)) {
            fs.renameSync(src, dst);
            moved++;
          }
        }
        // Remove alias dir if now empty
        const remaining = fs.readdirSync(aliasDir).filter(f => {
          try { return fs.statSync(path.join(aliasDir, f)).isFile(); } catch { return false; }
        });
        if (remaining.length === 0) try { fs.rmdirSync(aliasDir); } catch { /* in use */ }

        if (moved > 0) {
          const fileCount = fs.readdirSync(targetDir).filter(f => {
            try { return fs.statSync(path.join(targetDir, f)).isFile(); } catch { return false; }
          }).length;
          db.prepare('UPDATE libraryObjects SET fileCount = ? WHERE objectId = ?')
            .run(fileCount, canonical);
          console.log(`[library] Repair: moved ${moved} file(s) from "${entry.name}/" to "${canonRow.folderName}/"`);
        }
      } catch (err) {
        console.warn(`[library] Repair: could not process "${entry.name}":`, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.warn('[library] repairAliasDirectories failed:', err instanceof Error ? err.message : err);
  }
}

// Remove any .tmp files left behind by a previously crashed import so they don't
// block future downloads (the existsSync check would otherwise skip them forever).
try {
  const removeTmp = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) removeTmp(path.join(dir, entry.name));
      else if (entry.name.endsWith('.tmp')) {
        try { fs.unlinkSync(path.join(dir, entry.name)); } catch { /* ignore */ }
      }
    }
  };
  const libraryDir = getLibraryDir();
  if (fs.existsSync(libraryDir)) removeTmp(libraryDir);
} catch { /* best-effort */ }

// Clear ALL auto-set gallery images on startup so they are re-evaluated on next load.
// This self-heals any stale fallbacks (e.g. a telescope sky_ file that was auto-set
// before a Hubble/catalog image was downloaded). User-chosen images are preserved.
const clearedStacked = db.prepare(`UPDATE libraryObjects SET galleryImage = NULL WHERE galleryImageUserSet = 0 AND galleryImage IS NOT NULL`).run();

// Note: auto-set stacked gallery images were previously backfilled here with
// a per-object live CDS fetch. That's been removed — the library card now
// falls back to `/api/catalog/:id/image` which serves from the catalog
// download cache. Users run the "Offline Catalog Data" download in Settings
// to populate survey imagery for every imported object in one pass.
if (clearedStacked.changes > 0) {
  console.log(`[library] Cleared ${clearedStacked.changes} auto-set gallery images — will re-evaluate on next load to pick up any newly downloaded catalog images.`);
}

// ─── Prepared statements (shared) ───────────────────────────────────────────

export const stmts = {
  // Library objects
  getObject: db.prepare<[string], LibraryObjectRow>('SELECT * FROM libraryObjects WHERE objectId = ?'),
  getObjectByFolderName: db.prepare<[string], { objectId: string; folderName: string }>(
    'SELECT objectId, folderName FROM libraryObjects WHERE folderName = ?',
  ),
  // Used by getLibraryObjectCoords below — the pre-canonicalization id (e.g. a
  // Caldwell number) and the canonical id can each match a different stored
  // row, so both are checked.
  getObjectCoords: db.prepare<[string, string], { ra: string | null; dec: string | null }>(
    'SELECT ra, dec FROM libraryObjects WHERE (objectId = ? OR objectId = ?) AND deleted = 0 LIMIT 1',
  ),
  // Used by getObjectInfo below — server/routes/catalog.ts's GET /:id/info.
  getObjectInfo: db.prepare<[string], {
    objectName: string | null; objectType: string | null; constellation: string | null;
    magnitude: number | null; description: string | null; ra: string | null; dec: string | null;
    distanceLy: number | null; wikiUrl: string | null; sizeArcmin: string | null;
  }>(
    `SELECT objectName, objectType, constellation, magnitude, description, ra, dec,
     distanceLy, wikiUrl, sizeArcmin FROM libraryObjects WHERE objectId = ? AND deleted = 0`,
  ),
  // Used by getObjectCatalogFallback below — server/routes/catalog.ts's
  // GET /:id fallback for objects with no static catalog entry.
  getObjectCatalogFallback: db.prepare<[string], {
    objectId: string; objectName: string | null; objectType: string | null;
    constellation: string | null; magnitude: number | null; ra: string | null;
    dec: string | null; distanceLy: number | null; sizeArcmin: string | null;
    description: string | null;
  }>(
    `SELECT objectId, objectName, objectType, constellation, magnitude, ra, dec, distanceLy, sizeArcmin, description
     FROM libraryObjects WHERE objectId = ? AND deleted = 0 LIMIT 1`,
  ),
  // Used by getLibraryObjectNames below — server/routes/storage.ts's
  // computeLibraryStats maps disk folder names to their display name.
  // Selects only these 3 columns (not `getAllObjects`'s `SELECT *`) since
  // this runs on every library-stats recompute over the whole library.
  getObjectNames: db.prepare<[], { objectId: string; folderName: string; objectName: string | null }>(
    'SELECT objectId, folderName, objectName FROM libraryObjects WHERE deleted = 0',
  ),
  getAllObjects: db.prepare<[], LibraryObjectRow>('SELECT * FROM libraryObjects WHERE deleted = 0'),
  searchObjects: db.prepare<[string, string, string], LibraryObjectRow>(
    `SELECT * FROM libraryObjects WHERE deleted = 0 AND (
       objectName LIKE ? OR objectId LIKE ? OR catalogId LIKE ?
     )`,
  ),
  upsertObject: db.prepare(
    `INSERT INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted, deletedAt,
       catalogId, objectName, objectType, constellation, description, magnitude, ra, dec, distanceLy)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(objectId) DO UPDATE SET folderName = COALESCE(libraryObjects.folderName, excluded.folderName), fileCount = excluded.fileCount,
     lastImport = excluded.lastImport, deleted = excluded.deleted, deletedAt = excluded.deletedAt,
     catalogId = COALESCE(catalogId, excluded.catalogId),
     objectName = COALESCE(objectName, excluded.objectName),
     objectType = COALESCE(objectType, excluded.objectType),
     constellation = COALESCE(constellation, excluded.constellation),
     description = COALESCE(description, excluded.description),
     magnitude = COALESCE(magnitude, excluded.magnitude),
     ra = COALESCE(ra, excluded.ra),
     dec = COALESCE(dec, excluded.dec),
     distanceLy = COALESCE(distanceLy, excluded.distanceLy)`
  ),
  markObjectDeleted: db.prepare(
    'UPDATE libraryObjects SET deleted = 1, deletedAt = ? WHERE objectId = ?'
  ),
  // Un-tombstones an object: re-eligible for sync, and visible again in
  // getLocalObjects. Does not touch fileCount or folderName — the local files
  // were already removed at delete time and are not restored by this. See
  // restoreLocalObject.
  restoreObject: db.prepare(
    'UPDATE libraryObjects SET deleted = 0, deletedAt = NULL WHERE objectId = ?'
  ),
  getDeletedObjectRows: db.prepare<[], LibraryObjectRow>(
    'SELECT * FROM libraryObjects WHERE deleted = 1 ORDER BY deletedAt DESC'
  ),
  updateObjectFileCount: db.prepare(
    'UPDATE libraryObjects SET fileCount = ? WHERE objectId = ?'
  ),

  // Sessions
  getSessions: db.prepare<[string], LibrarySessionRow>('SELECT * FROM librarySessions WHERE objectId = ? ORDER BY date ASC'),
  // Bulk variant used by `getLocalObjects` to avoid N+1: returns every
  // librarySessions row in a single query, ordered so callers can group by
  // objectId without re-sorting per group. (Audit 4.1.)
  getAllSessions: db.prepare<[], LibrarySessionRow>('SELECT * FROM librarySessions ORDER BY objectId ASC, date ASC'),
  getSession: db.prepare<[string, string], LibrarySessionRow>('SELECT * FROM librarySessions WHERE objectId = ? AND date = ?'),
  addSession: db.prepare('INSERT OR IGNORE INTO librarySessions (objectId, date) VALUES (?, ?)'),
  addSessionStamped: db.prepare(
    `INSERT INTO librarySessions (objectId, date, telescopeId) VALUES (?, ?, ?)
     ON CONFLICT(objectId, date) DO UPDATE SET telescopeId = COALESCE(librarySessions.telescopeId, excluded.telescopeId)`,
  ),
  // Unconditional variant. Only safe where the caller has already verified
  // this exact (objectId, date) genuinely received new files from this
  // telescope THIS run (commitFolderImport's stampedDates gate) — otherwise
  // use addSessionStamped, whose COALESCE protects dates this run never
  // touched from being reattributed (see setObjectPrimaryTelescopeIfNull
  // comment below for the incident that pattern guards against).
  addSessionStampedForce: db.prepare(
    `INSERT INTO librarySessions (objectId, date, telescopeId) VALUES (?, ?, ?)
     ON CONFLICT(objectId, date) DO UPDATE SET telescopeId = excluded.telescopeId`,
  ),
  // Sets the per-object color/attribution telescope, but only if the object
  // hasn't been claimed yet. Re-imports from a different profile must NOT
  // overwrite this — that's what caused the cross-profile clobber where the
  // last-running auto-import rewrote attribution for the entire library.
  setObjectPrimaryTelescopeIfNull: db.prepare(
    'UPDATE libraryObjects SET primaryTelescopeId = ? WHERE objectId = ? AND primaryTelescopeId IS NULL',
  ),
  // Unconditional variant — used only by explicit user-driven reassignment
  // (per-session reassign, bulk move). Imports must not call this directly.
  setObjectPrimaryTelescope: db.prepare(
    'UPDATE libraryObjects SET primaryTelescopeId = ? WHERE objectId = ?',
  ),
  insertSessionImportLog: db.prepare(
    `INSERT INTO sessionImportLog (telescopeId, remotePath, importedAt, objectId, sessionDate, outcome, message, deviceId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  // weatherLat/weatherLon record where this fetch happened, so a session that
  // later resolves to a different location re-fetches instead of showing another
  // place's conditions. See weatherIsStale in observations.ts.
  setSessionWeather: db.prepare(
    `UPDATE librarySessions SET temperature=?, cloudCover=?, humidity=?, windSpeed=?, dewPoint=?, visibility=?, precipProb=?,
       weatherLat=?, weatherLon=?
     WHERE objectId=? AND date=?`
  ),
  removeSession: db.prepare('DELETE FROM librarySessions WHERE objectId = ? AND date = ?'),
  clearSessions: db.prepare('DELETE FROM librarySessions WHERE objectId = ?'),

  // Deleted session tombstones
  isSessionTombstoned: db.prepare('SELECT 1 FROM libraryDeletedSessions WHERE objectId = ? AND date = ?'),
  // deletedAt is IGNOREd on conflict along with the rest of the row, so
  // reconciliation call sites that re-assert an already-known tombstone from
  // the JSON index (import.ts) never clobber the original delete time with
  // "now" — only a genuinely new tombstone gets today's timestamp.
  addSessionTombstone: db.prepare('INSERT OR IGNORE INTO libraryDeletedSessions (objectId, date, deletedAt) VALUES (?, ?, ?)'),
  removeSessionTombstone: db.prepare('DELETE FROM libraryDeletedSessions WHERE objectId = ? AND date = ?'),
  getDeletedSessions: db.prepare<[string], { date: string }>('SELECT date FROM libraryDeletedSessions WHERE objectId = ?'),
  getAllDeletedSessions: db.prepare<[], { objectId: string; date: string }>('SELECT objectId, date FROM libraryDeletedSessions'),
  // Joined with libraryObjects for display (folder/object name) and filtered to
  // objects that are not themselves fully tombstoned — those already show up
  // whole in the object trash, and listing their individual sessions too would
  // be a confusing duplicate of the same restore action.
  getDeletedSessionRows: db.prepare<[], { objectId: string; date: string; deletedAt: string | null; folderName: string; objectName: string | null }>(
    `SELECT ds.objectId, ds.date, ds.deletedAt, lo.folderName, lo.objectName
     FROM libraryDeletedSessions ds
     JOIN libraryObjects lo ON lo.objectId = ds.objectId
     WHERE lo.deleted = 0
     ORDER BY ds.deletedAt DESC`,
  ),

  // Library metadata
  getMeta: db.prepare<[], LibraryMetaRow>('SELECT * FROM libraryMeta WHERE id = 1'),
  updateMetaLastImport: db.prepare('UPDATE libraryMeta SET lastImport = ? WHERE id = 1'),
  setImportRunning: db.prepare('UPDATE libraryMeta SET importRunning = ?, importStartedAt = ? WHERE id = 1'),
  getImportMeta: db.prepare<[], { importRunning: number; importStartedAt: string | null }>(
    'SELECT importRunning, importStartedAt FROM libraryMeta WHERE id = 1'
  ),

  // Favorites (per-user; userId='' is the open-access sentinel)
  getAllFavorites: db.prepare<[string], { objectId: string }>('SELECT objectId FROM favorites WHERE userId = ?'),
  isFavorite: db.prepare<[string, string], unknown>('SELECT 1 FROM favorites WHERE objectId = ? AND userId = ?'),
  addFavorite: db.prepare('INSERT OR IGNORE INTO favorites (objectId, userId) VALUES (?, ?)'),
  removeFavorite: db.prepare('DELETE FROM favorites WHERE objectId = ? AND userId = ?'),

  // Image favorites (per-user)
  getAllImageFavorites: db.prepare<[string], { imagePath: string }>('SELECT imagePath FROM imageFavorites WHERE userId = ?'),
  addImageFavorite: db.prepare('INSERT OR IGNORE INTO imageFavorites (imagePath, userId) VALUES (?, ?)'),
  removeImageFavorite: db.prepare('DELETE FROM imageFavorites WHERE imagePath = ? AND userId = ?'),

  // Gallery image
  getGalleryImage: db.prepare<[string], { galleryImage: string | null; galleryImageUserSet: number }>(
    'SELECT galleryImage, galleryImageUserSet FROM libraryObjects WHERE objectId = ?',
  ),
  setGalleryImage:         db.prepare('UPDATE libraryObjects SET galleryImage = ?, galleryImageUserSet = 0 WHERE objectId = ?'),
  setGalleryImageUserSet:  db.prepare('UPDATE libraryObjects SET galleryImage = ?, galleryImageUserSet = 1 WHERE objectId = ?'),

  // Session image (designated raw telescope image per session)
  getSessionImage: db.prepare<[string, string], { sessionImage: string | null }>(
    'SELECT sessionImage FROM librarySessions WHERE objectId = ? AND date = ?',
  ),
  setSessionImage: db.prepare('UPDATE librarySessions SET sessionImage = ? WHERE objectId = ? AND date = ?'),

  // Processed images (user-uploaded post-processing results, plus Dwarf
  // RESTACKED auto-imports — see ProcessedImageSource)
  getProcessedImages: db.prepare<[string, string], ProcessedImageRow>(
    'SELECT * FROM sessionProcessedImages WHERE objectId = ? AND date = ? ORDER BY uploadedAt DESC',
  ),
  getAllProcessedImagesForObject: db.prepare<[string], ProcessedImageRow>(
    'SELECT * FROM sessionProcessedImages WHERE objectId = ? ORDER BY date DESC, uploadedAt DESC',
  ),
  getProcessedImage: db.prepare<[string], ProcessedImageRow>(
    'SELECT * FROM sessionProcessedImages WHERE id = ?',
  ),
  insertProcessedImage: db.prepare(
    `INSERT INTO sessionProcessedImages (id, objectId, date, filename, originalName, title, notes, size, mimeType, uploadedAt, runId, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  deleteProcessedImageRow: db.prepare('DELETE FROM sessionProcessedImages WHERE id = ?'),
  // Point an existing row at freshly-overwritten file bytes (image editor
  // "Save" in place). Identity columns (objectId, date, title, notes, runId)
  // are deliberately left alone.
  updateProcessedImageFile: db.prepare(
    `UPDATE sessionProcessedImages
       SET filename = ?, originalName = ?, size = ?, mimeType = ?, uploadedAt = ?
     WHERE id = ?`,
  ),
  // Dedup guard for a re-synced Dwarf RESTACKED file: same object, same
  // original filename, same auto-import source. Deliberately not keyed on
  // date (there isn't one) or size (a legitimately re-processed MegaStack of
  // the same name should still land once per import run, not accumulate).
  getRestackedImageByName: db.prepare<[string, string], { id: string }>(
    `SELECT id FROM sessionProcessedImages WHERE objectId = ? AND originalName = ? AND source = 'dwarf-restack' LIMIT 1`,
  ),

  // Import history
  insertHistory: db.prepare(
    `INSERT INTO importHistory (startedAt, finishedAt, objectsTotal, filesTotal, newFiles, bytesTotal, bytesNew, error, files, telescopeId, telescopeName, transportKind, skipped, manual, cancelled, objectsTouched, sessionsTouched)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  // A run is worth surfacing when it actually did something (newFiles > 0),
  // failed (error is always actionable regardless of file count), or the
  // user explicitly asked for it (manual = 1) — the last clause is what lets
  // "I clicked Sync Now and it found nothing new" show up as a real, visible
  // entry instead of vanishing identically to a routine scheduled tick that
  // (correctly, silently) found nothing.
  getHistory: db.prepare<[number, number], ImportHistoryRow>(
    'SELECT * FROM importHistory WHERE newFiles > 0 OR error IS NOT NULL OR manual = 1 ORDER BY finishedAt DESC LIMIT ? OFFSET ?',
  ),
  getHistoryCount: db.prepare<[], { count: number }>(
    'SELECT COUNT(*) as count FROM importHistory WHERE newFiles > 0 OR error IS NOT NULL OR manual = 1',
  ),
  getLatestHistory: db.prepare<[], Pick<ImportHistoryRow, 'finishedAt'>>('SELECT finishedAt FROM importHistory ORDER BY finishedAt DESC LIMIT 1'),
};

/** RA/dec for a library object, checked against both the canonical id and a
 *  pre-canonicalization id (e.g. an object imported under its Caldwell
 *  number before canonicalization was added). Used by the catalog routes'
 *  coordinate-resolution fallback when the DSO catalog itself has no
 *  RA/dec for the object. */
export function getLibraryObjectCoords(id: string, rawId: string): { ra: string | null; dec: string | null } | undefined {
  return stmts.getObjectCoords.get(id, rawId);
}

/** Enriched object info as stored during import — the library DB is checked
 *  before the static catalog in GET /catalog/:id/info. */
export function getObjectInfo(objectId: string) {
  return stmts.getObjectInfo.get(objectId);
}

/** Fallback object info for GET /catalog/:id when there is no static catalog
 *  entry — covers Caldwell/custom objects the user has imported. */
export function getObjectCatalogFallback(objectId: string) {
  return stmts.getObjectCatalogFallback.get(objectId);
}

/** objectId/folderName/objectName for every non-deleted library object, for
 *  mapping disk folder names to display names (server/routes/storage.ts). */
export function getLibraryObjectNames() {
  return stmts.getObjectNames.all();
}

// ─── Catalog metadata helpers ───────────────────────────────────────────────

/** Resolve catalog metadata for an object ID and persist it to the DB row. */
export function resolveCatalogMeta(objectId: string): {
  catalogId: string; objectName: string; objectType: string;
  constellation: string; description: string; magnitude: number | null;
  ra: string | null; dec: string | null; distanceLy: number | null;
} {
  const normalized = normalizeCatalogId(objectId);
  const entry = getCatalogEntry(normalized) || getCatalogEntry(objectId);

  // getCatalogEntry walks solar system -> catalog-curated.json -> Caldwell
  // alias -> OpenNGC -> Messier, but never curated-descriptions.json, which is
  // only read by the /catalog/* routes. An object whose only curated text
  // lives there (e.g. IC 342's description, keyed "C5") would import with a
  // blank description and stay blank on offline hubs where the Wikipedia
  // enrichment never runs. Fall back to that file here so every import call
  // site inherits the fix from one chokepoint. A user override still wins:
  // getCatalogEntry merges catalogOverrides above.
  let description = entry?.description || '';
  if (!description) {
    const curated = getCuratedDescription(normalized) || getCuratedDescription(objectId);
    if (curated) description = curated.extract;
  }

  return {
    catalogId: normalized,
    objectName: entry?.name || objectId,
    objectType: entry?.type || (/^[CP]-\d{4}/i.test(objectId) ? 'Comet' : 'Unknown'),
    constellation: entry?.constellation || 'Unknown',
    description,
    magnitude: entry?.magnitude ?? null,
    ra: entry?.ra ?? null,
    dec: entry?.dec ?? null,
    distanceLy: entry?.distanceLy ?? null,
  };
}

/**
 * Re-resolve an object's catalog columns on `libraryObjects` and write them
 * back. Call after anything that changes what the catalog says about an object,
 * which today means a user editing its details (`catalogOverrides`).
 *
 * The override merges into `getCatalogEntry` at read time, so object detail
 * picked a correction up immediately, but the library grid, the type filter
 * chips and `filterTags` all read the denormalized `libraryObjects` columns and
 * kept showing the old value until the next import happened to re-resolve them.
 * That is why correcting a type looked like it did nothing.
 *
 * `description` is only written when the catalog actually has one: enrichment
 * stores the Wikipedia extract in the same column, and an object whose catalog
 * entry carries no description must not have that blanked.
 *
 * Returns false when the id is not in the library (a pure catalog object).
 */
export function applyCatalogMetaToLibraryObject(objectId: string): boolean {
  const exists = db
    .prepare<[string], { objectId: string }>('SELECT objectId FROM libraryObjects WHERE objectId = ?')
    .get(objectId);
  if (!exists) return false;

  const meta = resolveCatalogMeta(objectId);
  db.prepare(
    `UPDATE libraryObjects SET catalogId=?, objectName=?, objectType=?, constellation=?,
     description=COALESCE(?, description), magnitude=?, ra=?, dec=?, distanceLy=?
     WHERE objectId=?`,
  ).run(
    meta.catalogId, meta.objectName, meta.objectType, meta.constellation,
    meta.description || null, meta.magnitude, meta.ra, meta.dec, meta.distanceLy,
    objectId,
  );
  return true;
}

// Backfill: populate catalog columns for any existing rows that have NULL catalogId or distanceLy
{
  // Excludes the synthetic Star Trails object: it has no catalog entry by
  // design, so catalogId/distanceLy are permanently null for it and it would
  // otherwise match this query on *every* boot forever, and resolveCatalogMeta
  // returns the same generic 'Unknown'/empty placeholders for any id it
  // doesn't recognize -- unconditionally overwriting the curated values
  // patchStartrailsObjectMeta just applied below, undoing the self-heal on
  // every single restart. This bit a real deploy: the boot-time self-heal
  // call ran and its UPDATE visibly took effect when tested standalone, but
  // moments later this block silently clobbered it back to 'Unknown' before
  // the object was ever read, because module top-level code runs in file
  // order and this block used to sit after it.
  const needsBackfill = db
    .prepare<[string], { objectId: string }>(
      `SELECT objectId FROM libraryObjects WHERE (catalogId IS NULL OR distanceLy IS NULL) AND deleted = 0 AND objectId != ?`,
    )
    .all(getStartrailsObjectId());

  if (needsBackfill.length > 0) {
    const update = db.prepare(
      `UPDATE libraryObjects SET catalogId=?, objectName=?, objectType=?, constellation=?,
       description=?, magnitude=?, ra=?, dec=?, distanceLy=? WHERE objectId=?`
    );
    const backfill = db.transaction(() => {
      for (const row of needsBackfill) {
        const meta = resolveCatalogMeta(row.objectId);
        update.run(meta.catalogId, meta.objectName, meta.objectType, meta.constellation,
          meta.description, meta.magnitude, meta.ra, meta.dec, meta.distanceLy, row.objectId);
      }
    });
    backfill();
    console.log(`[library] Backfilled catalog metadata for ${needsBackfill.length} objects`);
  }
}

// Refresh object names for rows whose stored objectName is still just the bare
// catalog id. Two ways a row ends up like that: an import done before this
// codebase resolved common names at all, or an import done before a given
// catalog entry gained one (IC1795 was a bare "IC1795" until it became the
// "Fish Head Nebula"). upsertObject's COALESCE never revisits objectName once
// set, so those rows stay stale. getCatalogEntry already merges the better
// name at read time on the object-detail page, but the library grid, the type
// filter chips and the observation lists read this denormalized column.
// A user override still wins: resolveCatalogMeta resolves through
// getCatalogEntry, which merges catalogOverrides.
{
  const bareNameRows = db
    .prepare<[string], { objectId: string }>(
      `SELECT objectId FROM libraryObjects
       WHERE deleted = 0 AND objectId != ?
         AND (objectName = objectId
              OR objectName = catalogId
              OR REPLACE(objectName, ' ', '') = catalogId)`,
    )
    .all(getStartrailsObjectId());

  if (bareNameRows.length > 0) {
    const update = db.prepare(
      'UPDATE libraryObjects SET objectName = ? WHERE objectId = ? AND objectName != ?',
    );
    let renamed = 0;
    const run = db.transaction(() => {
      for (const row of bareNameRows) {
        const meta = resolveCatalogMeta(row.objectId);
        renamed += update.run(meta.objectName, row.objectId, meta.objectName).changes;
      }
    });
    run();
    if (renamed > 0) console.log(`[library] Refreshed catalog names for ${renamed} objects`);
  }
}

// Apply the Star Trails object's curated name/type/constellation/description
// (see patchStartrailsObjectMeta) once per boot, after every other migration
// above -- in particular after the catalog backfill immediately above, which
// would otherwise overwrite it right back (see the comment on that block).
// This used to only get (re)applied when an import run actually touched the
// object, so a device that hasn't synced since the patch was added -- or a
// row created before it existed -- could sit stale indefinitely with
// objectType 'Unknown', which is also what the frontend keys its "hide
// Plan/Compare/Combine, no constellation" behavior on (see
// src/lib/dwarfStartrails.ts), so a stale row silently got the full
// normal-object UI instead. Harmless no-op when the row doesn't exist yet.
patchStartrailsObjectMeta(getStartrailsObjectId());

// ─── Enrichment: fetch external data and store in DB ────────────────────────
// Note: enrichStmt is lazily prepared after migrations run.
let _enrichStmt: ReturnType<typeof db.prepare> | null = null;
function getEnrichStmt() {
  if (!_enrichStmt) {
    _enrichStmt = db.prepare(
      `UPDATE libraryObjects SET description = COALESCE(?, description), wikiUrl = COALESCE(?, wikiUrl),
       sizeArcmin = COALESCE(?, sizeArcmin) WHERE objectId = ?`
    );
  }
  return _enrichStmt;
}

interface EnrichQueryRow {
  objectName: string | null;
  catalogId: string | null;
  description: string | null;
  wikiUrl: string | null;
  sizeArcmin: string | null;
  enrichmentAttemptedAt: string | null;
  enrichmentAttempts: number | null;
}

let _enrichAttemptStmt: ReturnType<typeof db.prepare> | null = null;
function getEnrichAttemptStmt() {
  if (!_enrichAttemptStmt) {
    _enrichAttemptStmt = db.prepare(
      `UPDATE libraryObjects SET enrichmentAttemptedAt = ?,
       enrichmentAttempts = COALESCE(enrichmentAttempts, 0) + 1 WHERE objectId = ?`,
    );
  }
  return _enrichAttemptStmt;
}

/** Clear the negative cache for one object so the next enrichment call runs a
 *  fresh lookup. For when the object's identity changed (a corrected name),
 *  which is the one thing that can turn a permanent miss into a hit. */
export function resetEnrichmentCooldown(objectId: string): void {
  db.prepare('UPDATE libraryObjects SET enrichmentAttemptedAt = NULL, enrichmentAttempts = 0 WHERE objectId = ?')
    .run(objectId);
}

// Prevents concurrent enrichment calls for the same objectId from firing
// parallel Wikipedia/SIMBAD requests. One fetch runs; others wait or skip.
const enrichInFlight = new Set<string>();

/**
 * Fetch enrichment data from Wikipedia + SIMBAD and store in the DB.
 * Called once during import — results are persisted so pages never need live fetches.
 *
 * Objects that came back empty recently are skipped (see ENRICHMENT_RETRY_DAYS).
 * Pass `{ force: true }` to look up regardless, which is what a user-triggered
 * retry does.
 */
export async function enrichObjectData(objectId: string, opts: { force?: boolean } = {}): Promise<void> {
  if (enrichInFlight.has(objectId)) {
    log.debug({ objectId }, '[enrich] already in flight, skipping');
    return;
  }

  // Typed prepared statement — SQL trust boundary enforced by libraryObjects schema.
  const obj = db
    .prepare<[string], EnrichQueryRow>(
      `SELECT objectName, catalogId, description, wikiUrl, sizeArcmin,
              enrichmentAttemptedAt, enrichmentAttempts
       FROM libraryObjects WHERE objectId = ?`,
    )
    .get(objectId);
  if (!obj) {
    log.debug({ objectId }, '[enrich] not in DB yet, skipping');
    return;
  }

  if (!opts.force && isEnrichmentCoolingDown(obj.enrichmentAttemptedAt, obj.enrichmentAttempts)) {
    log.debug(
      { objectId, attemptedAt: obj.enrichmentAttemptedAt, attempts: obj.enrichmentAttempts },
      '[enrich] looked up recently with no result, skipping until the cooldown expires',
    );
    return;
  }

  // Skip if already fully enriched.
  // Solar-system objects never get SIMBAD size data (it varies continuously
  // with distance), so only require wikiUrl + description for those.
  const isSolarSystem = SOLAR_SYSTEM_LOOKUP_KEYS.has(objectId.toLowerCase().replace(/[^a-z]/g, ''));
  const needsWiki = !obj.wikiUrl || !obj.description;
  const needsSimbad = !obj.sizeArcmin && !isSolarSystem;
  if (!needsWiki && !needsSimbad) {
    log.debug({ objectId }, '[enrich] already fully enriched, skipping');
    return;
  }

  enrichInFlight.add(objectId);

  const searchName = obj.objectName || objectId;
  let description: string | null = null;
  let wikiUrl: string | null = null;
  let sizeArcmin: string | null = null;

  // Wikipedia: description + wiki link
  if (needsWiki) {
    const namesToTry: string[] = [];

    if (obj.wikiUrl && !obj.description) {
      // We know the correct page — extract its title from the URL so we fetch
      // the extract directly rather than re-resolving through a redirect.
      const titleMatch = obj.wikiUrl.match(/\/wiki\/(.+)$/);
      if (titleMatch) namesToTry.push(decodeURIComponent(titleMatch[1].replace(/_/g, ' ')));
    }

    if (!namesToTry.length) {
      namesToTry.push(searchName);
      const catId = obj.catalogId || normalizeCatalogId(objectId);
      const messierMatch = catId.match(/^M(\d+)$/i);
      if (messierMatch) {
        namesToTry.push(`Messier ${messierMatch[1]}`);
      } else if (catId !== searchName) {
        namesToTry.push(catId);
      }
      // Wikipedia's summary API can't resolve the un-spaced "NGC4274" / "IC342"
      // form (it errors instead of redirecting to "NGC 4274" / "IC 342"), so
      // add the spaced article-title variant. Mirrors prefetchObjectWiki.
      const spacedMatch = catId.match(/^(NGC|IC)(\d+)$/i);
      if (spacedMatch) namesToTry.push(`${spacedMatch[1].toUpperCase()} ${spacedMatch[2]}`);
    }

    for (const name of namesToTry) {
      try {
        log.debug({ objectId, search: name }, '[enrich] Wikipedia searching');
        // fetchWikipediaSummary uses ?redirect=true so renamed/redirected pages
        // (e.g. "Diphda" → "Beta Ceti") return the target article's extract.
        const summary = await fetchWikipediaSummary(name);
        if (summary) {
          log.debug({ objectId, search: name, chars: summary.extract.length }, '[enrich] Wikipedia hit');
          if (summary.extract.length > (description || obj.description || '').length) {
            description = summary.extract;
          }
          if (!wikiUrl) wikiUrl = summary.wikiUrl;
          if (description && wikiUrl) break;
        } else {
          log.debug({ objectId, search: name }, '[enrich] Wikipedia no result');
        }
      } catch {
        log.debug({ objectId, search: name }, '[enrich] Wikipedia fetch failed');
      }
    }

    // Fall back to the bundled curated description when the live lookup came
    // back empty. Wikipedia is tried first because it is longer and stays
    // current, but an offline hub (or an object Wikipedia's summary API can't
    // resolve) would otherwise show no description even though we ship one.
    if (!description && !obj.description) {
      const curated = getCuratedDescription(obj.catalogId || objectId);
      if (curated) {
        description = curated.extract;
        if (!wikiUrl && !obj.wikiUrl) wikiUrl = curated.wikiUrl;
        log.debug({ objectId }, '[enrich] used curated description fallback');
      }
    }
  }

  // SIMBAD: angular size — skip for solar system objects (their angular size
  // varies continuously with distance; SIMBAD has no useful fixed value for them)
  if (needsSimbad) {
    log.debug({ objectId, searchName }, '[enrich] SIMBAD size lookup');
    try {
      const simbadUrl = `https://simbad.cds.unistra.fr/simbad/sim-id?output.format=votable&output.params=main_id,otype,dim_majaxis,dim_minaxis&Ident=${encodeURIComponent(searchName)}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => { log.debug({ objectId }, '[enrich] SIMBAD timeout after 5s'); ctrl.abort(); }, 5000);
      const resp = await fetch(simbadUrl, { signal: ctrl.signal });
      clearTimeout(timer);
      if (resp.ok) {
        const text = await resp.text();
        const majMatch = text.match(/<TD[^>]*>([\d.]+)<\/TD>\s*<TD[^>]*>([\d.]+)<\/TD>/);
        if (majMatch) {
          const maj = parseFloat(majMatch[1]);
          const min = parseFloat(majMatch[2]);
          if (maj > 0) {
            sizeArcmin = min > 0 ? `${maj.toFixed(1)}' x ${min.toFixed(1)}'` : `${maj.toFixed(1)}'`;
            log.debug({ objectId, sizeArcmin }, '[enrich] SIMBAD size found');
          }
        } else {
          log.debug({ objectId }, '[enrich] SIMBAD no size data');
        }
      } else {
        log.debug({ objectId, status: resp.status }, '[enrich] SIMBAD HTTP error');
      }
    } catch {
      log.debug({ objectId }, '[enrich] SIMBAD fetch failed');
    }
  }

  try {
    if (description || wikiUrl || sizeArcmin) {
      getEnrichStmt().run([description, wikiUrl, sizeArcmin, objectId]);
    }
    // Stamped whether or not anything came back. A hit stops matching the
    // "missing data" selection on its own, so this only ever matters for a
    // miss, which is precisely the case that used to repeat forever.
    getEnrichAttemptStmt().run([new Date().toISOString(), objectId]);
  } finally {
    enrichInFlight.delete(objectId);
  }
}

// One-time curated-description backfill (no network). resolveCatalogMeta now
// fills a curated description at import time, but rows imported before a given
// batch of descriptions was added to the catalog store still carry a blank
// one. Fill those straight from the store, ignoring the enrichment cooldown
// since there is no lookup to rate-limit. Gated on a version marker so it runs
// once; bump CURATED_DESCRIPTION_BACKFILL_VERSION to re-run it after the
// curated layer grows.
const CURATED_DESCRIPTION_BACKFILL_VERSION = 1;
{
  const marker = db
    .prepare<[], { curatedDescriptionBackfillVersion: number }>(
      'SELECT curatedDescriptionBackfillVersion FROM appSettings WHERE id = 1',
    )
    .get();
  const applied = marker?.curatedDescriptionBackfillVersion ?? 0;

  if (applied < CURATED_DESCRIPTION_BACKFILL_VERSION) {
    const missingDescription = db
      .prepare<[], { objectId: string; catalogId: string | null }>(
        `SELECT objectId, catalogId FROM libraryObjects
         WHERE (description IS NULL OR description = '') AND deleted = 0`,
      )
      .all();

    let filled = 0;
    for (const row of missingDescription) {
      const curated = getCuratedDescription(row.catalogId || row.objectId);
      if (!curated) continue;
      getEnrichStmt().run([curated.extract, curated.wikiUrl, null, row.objectId]);
      filled++;
    }
    db.prepare('UPDATE appSettings SET curatedDescriptionBackfillVersion = ? WHERE id = 1').run(
      CURATED_DESCRIPTION_BACKFILL_VERSION,
    );
    if (filled > 0) {
      console.log(`[library] Backfilled ${filled} curated object description(s)`);
    }
  }
}

// Async backfill: enrich objects missing Wikipedia/SIMBAD data (runs in background after startup)
{
  // The cooldown is applied here as well as inside enrichObjectData, so the
  // count we log is the number of lookups that will actually happen rather than
  // the number of rows that merely still lack data.
  const needsEnrichment = db
    .prepare<[], { objectId: string; enrichmentAttemptedAt: string | null; enrichmentAttempts: number | null }>(
      `SELECT objectId, enrichmentAttemptedAt, enrichmentAttempts FROM libraryObjects
       WHERE (wikiUrl IS NULL OR sizeArcmin IS NULL OR (description IS NULL AND wikiUrl IS NOT NULL)) AND deleted = 0`,
    )
    .all()
    .filter(row => !isEnrichmentCoolingDown(row.enrichmentAttemptedAt, row.enrichmentAttempts));

  if (needsEnrichment.length > 0) {
    console.log(`[library] Enriching ${needsEnrichment.length} objects with Wikipedia/SIMBAD data...`);
    (async () => {
      for (const row of needsEnrichment) {
        try { await enrichObjectData(row.objectId); } catch { /* best-effort */ }
      }
      console.log(`[library] Enrichment backfill complete`);
    })();
  }
}

// ─── Ensure directories ──────────────────────────────────────────────────────

export function ensureLibraryDir(): void {
  const LIBRARY_DIR = getLibraryDir();
  if (!fs.existsSync(LIBRARY_DIR)) {
    fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  }
}

// ─── Folder-name helpers ──────────────────────────────────────────────────────

/** Return the raw filesystem folder name for an objectId ("M16" → "M 16").
 *  Falls back to objectId itself if the object is not in the DB (new/unknown). */
export function getFolderName(objectId: string): string {
  const row = stmts.getObject.get(objectId);
  return row?.folderName ?? objectId;
}

/** Public variant for use in route handlers that need the folder name. */
export function getObjectFolderName(objectId: string): string {
  return getFolderName(objectId);
}

/** Resolve `<LIBRARY_DIR>/<folder for objectId>[/...extra]`, or null if the
 *  result would escape LIBRARY_DIR. getFolderName falls back to the raw
 *  objectId on a DB miss, so a crafted objectId with traversal tokens would
 *  otherwise reach every caller that joins it onto LIBRARY_DIR unchecked. */
export function resolveContainedObjectDir(objectId: string, ...extra: string[]): string | null {
  const LIBRARY_DIR = getLibraryDir();
  const dir = path.resolve(LIBRARY_DIR, getFolderName(objectId), ...extra);
  if (dir !== LIBRARY_DIR && !dir.startsWith(LIBRARY_DIR + path.sep)) return null;
  return dir;
}

// ─── Settings helper ─────────────────────────────────────────────────────────

export function loadSettings(): Record<string, unknown> {
  return getSettingsData();
}

// ─── Index helpers (bridge between old pattern and SQLite) ───────────────────

/** Load index as the old LibraryIndex shape for compatibility with import functions. */
export function loadIndex(): LibraryIndex {
  const meta = stmts.getMeta.get();
  if (!meta) throw new Error('[library] libraryMeta row missing');
  const allObjs = db.prepare<[], LibraryObjectRow>('SELECT * FROM libraryObjects').all();

  // Batch both session queries — replaces 2N per-object lookups with 2 total queries.
  const sessionsByObj = new Map<string, string[]>();
  for (const row of stmts.getAllSessions.all()) {
    if (row.date === 'unknown') continue;
    const list = sessionsByObj.get(row.objectId) ?? [];
    list.push(row.date);
    sessionsByObj.set(row.objectId, list);
  }
  const deletedByObj = new Map<string, string[]>();
  for (const row of stmts.getAllDeletedSessions.all()) {
    const list = deletedByObj.get(row.objectId) ?? [];
    list.push(row.date);
    deletedByObj.set(row.objectId, list);
  }

  const objects: Record<string, LibraryObjectMeta> = {};
  for (const obj of allObjs) {
    const sessions = sessionsByObj.get(obj.objectId) ?? [];
    const deletedSessions = deletedByObj.get(obj.objectId) ?? [];
    objects[obj.objectId] = {
      folderName: obj.folderName,
      sessions,
      fileCount: obj.fileCount,
      lastImport: obj.lastImport,
      deleted: Boolean(obj.deleted),
      deletedAt: obj.deletedAt || undefined,
      deletedSessions: deletedSessions.length > 0 ? deletedSessions : undefined,
    };
  }

  return { version: meta.version, objects, lastImport: meta.lastImport };
}

// ─── Object queries ─────────────────────────────────────────────────────────

/**
 * Find the best on-disk observation image to use as a gallery fallback
 * when no cached catalog/sky image exists. Scans the object's library
 * folder and returns a `<folder>/<file>` path (relative to LIBRARY_DIR),
 * or null if the folder is empty. Priority: stacked → any → thumbnail
 * (thumbnails are small low-quality previews, used only as last resort).
 * Excludes `sky_` and `gallery_` prefixed files so we don't loop on a
 * previous fallback.
 */
export function findFallbackObservationImage(objectId: string): string | null {
  const objDir = resolveContainedObjectDir(objectId);
  if (!objDir || !fs.existsSync(objDir)) return null;

  let thumbnail: string | null = null;
  let stacked: string | null = null;
  let any: string | null = null;
  // Second-choice buckets for formats that are viewable but expensive: a Dwarf's
  // `img_stacked_all.tif` is a ~100 MB 32-bit float image, so featuring it means
  // a 100 MB sharp decode every time this object's card misses the thumbnail
  // cache. Used only when there is no JPEG/PNG alternative.
  let costlyStacked: string | null = null;
  let costlyAny: string | null = null;

  // Layout-aware: a nested object keeps its files in per-session directories, so
  // an object-level readdir would find no image at all and every card would fall
  // back to the sky survey.
  for (const entry of listObjectFiles(objDir, getObjectLayout(objectId))) {
    const fname = entry.fileName;
    if (!isRealFile(fname)) continue;
    if (fname.startsWith('sky_') || fname.startsWith('gallery_')) continue;
    const parsed = parseFilename(fname);
    const ext = parsed.extension;
    const isViewable = ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.tif' || ext === '.tiff';
    if (!isViewable) continue;
    const cheap = ext === '.jpg' || ext === '.jpeg';
    if (parsed.isThumbnail) {
      if (!thumbnail) thumbnail = entry.relPath;
    } else if (parsed.type === 'stacked') {
      if (cheap) { if (!stacked) stacked = entry.relPath; }
      else if (!costlyStacked) costlyStacked = entry.relPath;
    } else if (cheap) {
      if (!any) any = entry.relPath;
    } else if (!costlyAny) {
      costlyAny = entry.relPath;
    }
  }

  const best = stacked ?? any ?? thumbnail ?? costlyStacked ?? costlyAny;
  return best ? `${path.basename(objDir)}/${best}` : null;
}

// Negative cache for the fallback-image scan. An object with no resolvable
// on-disk image otherwise `readdirSync`s its folder on every `getLocalObjects`
// call — cheap on a local SSD, but seconds across a whole library on a network
// or external drive. We remember the miss keyed on the object's `lastImport`:
// a fresh import (the only way an auto-resolvable image appears for an object
// that has none) changes `lastImport` and re-triggers the scan. Custom and
// processed images set `galleryImage` directly, so they never reach this path.
// A TTL backstop covers any out-of-band file additions.
const fallbackMissCache = new Map<string, { lastImport: string | null; at: number }>();
const FALLBACK_MISS_TTL_MS = 5 * 60 * 1000;

export function getLocalObjects(userId = '', search = '') {
  const LIBRARY_DIR = getLibraryDir();
  ensureLibraryDir();
  const objects = search.trim()
    ? (() => {
        const terms = expandSearchAliases(search.trim());
        if (terms.length === 1) {
          const t = `%${terms[0]}%`;
          return stmts.searchObjects.all(t, t, t);
        }
        const conds = terms.map(() => `(objectName LIKE ? OR objectId LIKE ? OR catalogId LIKE ?)`).join(' OR ');
        const params = terms.flatMap(t => [`%${t}%`, `%${t}%`, `%${t}%`]);
        return db.prepare<unknown[], LibraryObjectRow>(
          `SELECT * FROM libraryObjects WHERE deleted = 0 AND (${conds})`
        ).all(...params);
      })()
    : stmts.getAllObjects.all();

  const settings = getSettingsData();
  const preferSkySurvey = typeof settings.galleryImageSource === 'string'
    ? settings.galleryImageSource !== 'telescope'
    : true;
  // `preferSkySurvey` is reserved for future use in this shape — the per-object
  // fallback logic in resolveObjectImagePath already respects the setting.
  void preferSkySurvey;

  // Audit 4.1: batch what was an N+1 pair of `getSessions` + `isFavorite`
  // queries (one per object) into two bulk fetches indexed by objectId.
  // Response shape is identical; only the SQL round-trip count changes.
  const sessionsByObject = new Map<string, LibrarySessionRow[]>();
  for (const row of stmts.getAllSessions.all()) {
    const list = sessionsByObject.get(row.objectId);
    if (list) list.push(row);
    else sessionsByObject.set(row.objectId, [row]);
  }
  const favoriteSet = new Set<string>(
    stmts.getAllFavorites.all(userId).map(r => r.objectId),
  );

  return objects.map(obj => {
    const sessionRows = sessionsByObject.get(obj.objectId) ?? [];
    const sessions = sessionRows.map(r => r.date);
    // Distinct telescope ids that have ever captured this object, ordered
    // by recency (most recent first) so the UI can render a stable badge stack.
    const telescopeIds: string[] = [];
    const seenTelescopes = new Set<string>();
    for (const row of [...sessionRows].reverse()) {
      if (row.telescopeId && !seenTelescopes.has(row.telescopeId)) {
        telescopeIds.push(row.telescopeId);
        seenTelescopes.add(row.telescopeId);
      }
    }
    const isFavorite = favoriteSet.has(obj.objectId);

    // Lazily resolve a fallback gallery image for objects that don't have one set.
    // Persists to DB so subsequent list calls are fast (no filesystem scan).
    // A negative-result cache (keyed on lastImport) avoids re-scanning the folder
    // on every load for objects that have no resolvable image yet.
    let galleryImage = obj.galleryImage || null;
    if (!galleryImage) {
      const miss = fallbackMissCache.get(obj.objectId);
      const missStillValid =
        miss != null &&
        miss.lastImport === (obj.lastImport ?? null) &&
        Date.now() - miss.at < FALLBACK_MISS_TTL_MS;
      if (!missStillValid) {
        const fallback = findFallbackObservationImage(obj.objectId);
        if (fallback) {
          stmts.setGalleryImage.run(fallback, obj.objectId);
          galleryImage = fallback;
          fallbackMissCache.delete(obj.objectId);
        } else {
          fallbackMissCache.set(obj.objectId, { lastImport: obj.lastImport ?? null, at: Date.now() });
        }
      }
    }

    const exposedGalleryImage = galleryImage;

    // Cache-buster version: combines galleryImage with the source file's mtime
    // when it points at a real on-disk file. Re-uploading a custom gallery
    // image to the same gallery_<id>.jpg path keeps galleryImage identical, so
    // without mtime here the client URL would never change and the browser
    // would keep serving its cached tile for up to 24h.
    //
    // Only user-set images are overwritten in place, so only they need the
    // per-object `statSync`. Auto-resolved observation images get new filenames
    // on each capture (never overwritten), so a bare path is already a stable,
    // correct cache key — and skipping the stat avoids N blocking filesystem
    // calls per list load on telescope-preferred libraries (especially on
    // network/external drives). The thumbnail endpoint still keys its own disk
    // cache on the source mtime, so server-side regeneration is unaffected.
    let galleryImageVersion: string | null = exposedGalleryImage;
    if (
      exposedGalleryImage &&
      obj.galleryImageUserSet &&
      !exposedGalleryImage.startsWith('catalog-source:')
    ) {
      try {
        const abs = path.join(LIBRARY_DIR, exposedGalleryImage);
        const mtimeMs = fs.statSync(abs).mtimeMs;
        galleryImageVersion = `${exposedGalleryImage}@${mtimeMs}`;
      } catch { /* file missing — fall back to the bare path */ }
    }

    const objectType = obj.objectType || 'Unknown';

    return {
      id: obj.objectId,
      catalogId: obj.catalogId || normalizeCatalogId(obj.objectId),
      folderName: obj.folderName,
      name: obj.objectName || obj.objectId,
      type: objectType,
      filterTags: getLibraryObjectFilterTags(objectType),
      constellation: obj.constellation || 'Unknown',
      description: obj.description || '',
      magnitude: obj.magnitude || null,
      ra: obj.ra || null,
      dec: obj.dec || null,
      distanceLy: obj.distanceLy || null,
      wikiUrl: obj.wikiUrl || null,
      sizeArcmin: obj.sizeArcmin || null,
      hasSubFrames: false,
      thumbnailUrl: `${LIBRARY_API_BASE}/objects/${encodeURIComponent(obj.objectId)}/thumbnail`,
      sessionsUrl: `${LIBRARY_API_BASE}/objects/${encodeURIComponent(obj.objectId)}/sessions`,
      filesUrl: `${LIBRARY_API_BASE}/objects/${encodeURIComponent(obj.objectId)}/files`,
      subFramesUrl: null,
      sessionCount: sessions.length,
      lastSessionDate: sessions.filter(d => d && d !== 'unknown').sort().at(-1) ?? null,
      lastImport: obj.lastImport,
      source: 'local' as const, // `as const` is a type-preserving literal widening — not a type assertion.
      isFavorite,
      galleryImage: exposedGalleryImage,
      galleryImageUserSet: Boolean(obj.galleryImageUserSet),
      galleryImageVersion,
      primaryTelescopeId: obj.primaryTelescopeId ?? null,
      telescopeIds,
      aliases: getAliasesForCanonical(obj.objectId),
    };
  });
}

export function getLocalThumbnail(objectId: string): Buffer | null {
  const objDir = resolveContainedObjectDir(objectId);
  if (!objDir || !fs.existsSync(objDir)) return null;

  const files = fs.readdirSync(objDir).filter(isRealFile);

  const isViewable = (f: string) => /\.(jpe?g|png|tiff?)$/i.test(f);

  const thn = files.find(f => f.includes('_thn.') && isViewable(f));
  if (thn) {
    try { return fs.readFileSync(path.join(objDir, thn)); } catch { /* ignore */ }
  }

  const stacked = files.find(f => f.startsWith('Stacked_') && isViewable(f) && !f.includes('_thn.'));
  if (stacked) {
    try { return fs.readFileSync(path.join(objDir, stacked)); } catch { /* ignore */ }
  }

  const any = files.find(f => isViewable(f));
  if (any) {
    try { return fs.readFileSync(path.join(objDir, any)); } catch { /* ignore */ }
  }

  return null;
}

export async function getLocalFile(relativePath: string): Promise<{ data: Buffer; name: string } | null> {
  const LIBRARY_DIR = getLibraryDir();
  // Resolve to an absolute path and confirm it stays inside the library root.
  // path.normalize + ".." check is insufficient — absolute paths like /etc/passwd
  // bypass it. path.resolve is the canonical guard used by the thumbnail handler.
  const fullPath = path.resolve(LIBRARY_DIR, relativePath);
  const libRoot = LIBRARY_DIR.endsWith(path.sep) ? LIBRARY_DIR : LIBRARY_DIR + path.sep;
  if (!fullPath.startsWith(libRoot)) return null;

  const filename = path.basename(fullPath);
  if (!isRealFile(filename)) return null;

  // Async + timeout-bounded (rather than fs.existsSync/readFileSync) since this
  // serves the /file route directly: a stale network-mounted library would
  // otherwise block the whole event loop for as long as the OS's SMB client
  // takes to give up, on every raw file view/download.
  try {
    const data = await withTimeout(fs.promises.readFile(fullPath), LIBRARY_IO_TIMEOUT_MS);
    return { data, name: filename };
  } catch {
    return null;
  }
}

// ─── Tombstone deletes ────────────────────────────────────────────────────────

/**
 * Delete all local files for an object and mark it as deleted in the DB.
 * The tombstone prevents any future re-import from the telescope.
 */
export function deleteLocalObject(objectId: string): void {
  // Update DB FIRST so a crash mid-delete never leaves the DB referencing
  // removed files — and all three statements run in one transaction, so a
  // crash between them can't leave the object tombstoned while its
  // libraryFiles/captureInfo rows still linger, or those rows gone while the
  // object was never actually marked deleted.
  const existing = stmts.getObject.get(objectId);
  const cat = existing ? null : resolveCatalogMeta(objectId);
  const tombstoneAndPurgeRows = db.transaction(() => {
    if (existing) {
      stmts.markObjectDeleted.run(new Date().toISOString(), objectId);
    } else if (cat) {
      stmts.upsertObject.run(objectId, objectId, 0, new Date().toISOString(), 1, new Date().toISOString(),
        cat.catalogId, cat.objectName, cat.objectType, cat.constellation,
        cat.description, cat.magnitude, cat.ra, cat.dec, cat.distanceLy);
    }
    // The per-file rows go with them — the manifest is deleted along with
    // the directory below, so there is nothing left to rebuild this object
    // from.
    deleteLibraryFileRowsForObject(objectId);
    deleteCaptureInfoForObject(objectId);
  });
  tombstoneAndPurgeRows();

  // Now safe to remove files.
  const objDir = resolveContainedObjectDir(objectId);
  if (objDir && fs.existsSync(objDir)) {
    try { fs.rmSync(objDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Un-tombstone a deleted object so it becomes eligible for sync again.
 *
 * This is the one thing a delete's `deletedAt` timestamp was recorded for and
 * had no way to use: the local files removed by `deleteLocalObject` are gone
 * and this does not bring them back, only the next sync from the telescope
 * does that. What it restores is the *decision*, not the data.
 *
 * Returns false when the object does not exist or was not deleted, so the
 * route can tell "already restored" from "nothing happened".
 */
export function restoreLocalObject(objectId: string): boolean {
  const existing = stmts.getObject.get(objectId);
  if (!existing || !existing.deleted) return false;
  stmts.restoreObject.run(objectId);
  return true;
}

export interface DeletedObjectSummary {
  objectId: string;
  folderName: string;
  objectName: string | null;
  deletedAt: string | null;
}

/** Every currently-tombstoned object, most recently deleted first. Backs the
 *  Settings trash view. */
export function listDeletedObjects(): DeletedObjectSummary[] {
  return stmts.getDeletedObjectRows.all().map(row => ({
    objectId: row.objectId,
    folderName: row.folderName,
    objectName: row.objectName ?? null,
    deletedAt: row.deletedAt ?? null,
  }));
}

// ─── Integration stats (local files only) ────────────────────────────────────

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function getLocalIntegrationStats(objectId: string) {
  const objDir = resolveContainedObjectDir(objectId);
  if (!objDir || !fs.existsSync(objDir)) {
    return { objectId, totalFrames: 0, totalExposureSec: 0, totalFormatted: '0s', sessions: [] };
  }

  const fitsFiles = fs.readdirSync(objDir).filter(fname => {
    if (!/\.(fit|fits)$/i.test(fname)) return false;
    const parsed = parseFilename(fname);
    return parsed.type === 'sub';
  });

  const sessionMap = new Map<string, { frames: number; exposureSec: number }>();
  let totalExposureSec = 0;

  for (const fname of fitsFiles) {
    const parsed = parseFilename(fname);
    const dateKey = sessionNightFor(parsed) || 'unknown';
    const fullPath = path.join(objDir, fname);
    try {
      const fd = fs.openSync(fullPath, 'r');
      const buf = Buffer.alloc(2880);
      fs.readSync(fd, buf, 0, 2880, 0);
      fs.closeSync(fd);
      const header = parseFitsHeader(buf);
      const exptime = header.values['EXPTIME'] ?? header.values['EXPOSURE'];
      const exp = exptime ? parseFloat(String(exptime)) : 10;
      const session = sessionMap.get(dateKey) ?? { frames: 0, exposureSec: 0 };
      session.frames++;
      session.exposureSec += exp;
      sessionMap.set(dateKey, session);
      totalExposureSec += exp;
    } catch { /* skip */ }
  }

  const sessions = Array.from(sessionMap.entries())
    .map(([date, s]) => ({ date, ...s }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    objectId,
    totalFrames: fitsFiles.length,
    totalExposureSec: Math.round(totalExposureSec),
    totalFormatted: formatDuration(totalExposureSec),
    sessions,
  };
}

// ─── FITS header (local file) ─────────────────────────────────────────────────

export function getLocalFitsHeader(relativePath: string) {
  const LIBRARY_DIR = getLibraryDir();
  const normalized = path.normalize(relativePath);
  if (normalized.includes('..')) return null;
  const fullPath = path.join(LIBRARY_DIR, normalized);
  if (!fs.existsSync(fullPath)) return null;
  try {
    const fd = fs.openSync(fullPath, 'r');
    const buf = Buffer.alloc(28800);
    fs.readSync(fd, buf, 0, 28800, 0);
    fs.closeSync(fd);
    return parseFitsHeader(buf);
  } catch {
    return null;
  }
}

// ─── Delete local file ────────────────────────────────────────────────────────

export function deleteLocalFile(relativePath: string): void {
  const LIBRARY_DIR = getLibraryDir();
  // Resolve and assert containment inside LIBRARY_DIR. Avoids the
  // `MyWorks/foo/../../etc/passwd` style bypass where normalize collapses the
  // traversal tokens before the substring check.
  const normalized = path.normalize(relativePath);
  if (normalized.includes('..') || path.isAbsolute(normalized) || normalized.startsWith('/') || normalized.startsWith('\\')) {
    throw new Error('Invalid path');
  }
  const fullPath = path.resolve(LIBRARY_DIR, normalized);
  if (fullPath !== LIBRARY_DIR && !fullPath.startsWith(LIBRARY_DIR + path.sep)) {
    throw new Error('Invalid path');
  }
  if (!fs.existsSync(fullPath)) throw new Error('File not found');

  fs.unlinkSync(fullPath);

  // Update DB for the affected object — first segment is the folderName (may have spaces)
  const firstSegment = normalized.split(path.sep)[0];
  const objectId = stmts.getObjectByFolderName.get(firstSegment)?.objectId ?? firstSegment;
  const objDir = path.join(LIBRARY_DIR, firstSegment);
  // Drop the row before rebuilding sessions below, so the resolver doesn't
  // still report a night for the file we just unlinked.
  deleteLibraryFileRow(normalized.split(path.sep).join('/'));
  try {
    // Layout-aware: a nested object's files live one level down in
    // per-session folders, so a top-level readdir would see directory names
    // (not files), derive no session from any of them via identity.session,
    // and the clearSessions/addSession rebuild below would then wipe every
    // session row for the object after deleting a single file.
    const layout = getObjectLayout(objectId);
    const remaining = fs.existsSync(objDir)
      ? listObjectFiles(objDir, layout).filter(e => isRealFile(e.fileName))
      : [];
    const identity = resolverFor(objectId);
    const sessionSet = new Set<string>();
    for (const entry of remaining) {
      const night = identity.session(entry.relPath);
      if (night) sessionSet.add(night);
    }
    stmts.updateObjectFileCount.run(remaining.length, objectId);
    // Rebuild sessions list
    stmts.clearSessions.run(objectId);
    for (const date of sessionSet) {
      stmts.addSession.run(objectId, date);
    }
    writeObjectManifest(objectId, firstSegment);
  } catch { /* ignore */ }
}
