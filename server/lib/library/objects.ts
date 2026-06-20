/**
 * Library — core object domain.
 *
 * Owns the shared SQLite prepared statements (`stmts`), database migrations,
 * library-wide constants, and object-level CRUD/query helpers used across the
 * other library/* modules.
 */
import fs from 'fs';
import path from 'path';
import { getLibraryDir } from '../libraryPath.js';
import db from '../db.js';
import { getSettingsData } from '../telescopes.js';
import {
  parseFilename,
  normalizeCatalogId,
  isRealFile,
} from '../telescopeFiles.js';
import { resolveCanonicalId, expandSearchAliases, getAliasesForCanonical } from '../catalogAliases.js';
import { getCatalogEntry } from '../../data/catalog.js';
import { SOLAR_SYSTEM_LOOKUP_KEYS } from '../../data/solar-system-catalog.js';
import { parseFitsHeader } from '../fitsParser.js';
import { log } from '../logger.js';
import { fetchWikipediaSummary } from '../wikipedia.js';
import { getLibraryObjectFilterTags } from './objectFilters.js';

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
}

export interface LibraryMetaRow {
  id: number;
  version: number;
  lastImport: string | null;
  importRunning: number;
  importStartedAt: string | null;
}

export interface ProcessedImageRow {
  id: string;
  objectId: string;
  date: string;
  filename: string;
  originalName: string;
  title: string;
  notes: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
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
  transportKind: 'smb' | 'local' | null;
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
    // 'smb' | 'local' | NULL (no transport context).
    db.prepare('ALTER TABLE importHistory ADD COLUMN transportKind TEXT').run();
  }
}

// Ensure sessionProcessedImages table exists (added after initial schema)
db.prepare(`CREATE TABLE IF NOT EXISTS sessionProcessedImages (
  id           TEXT PRIMARY KEY,
  objectId     TEXT NOT NULL,
  date         TEXT NOT NULL,
  filename     TEXT NOT NULL,
  originalName TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  notes        TEXT NOT NULL DEFAULT '',
  size         INTEGER NOT NULL DEFAULT 0,
  mimeType     TEXT NOT NULL DEFAULT '',
  uploadedAt   TEXT NOT NULL
)`).run();
db.prepare('CREATE INDEX IF NOT EXISTS idx_sessionProcessedImages_session ON sessionProcessedImages(objectId, date)').run();

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
        // Update non-PK tables
        db.prepare(`UPDATE notes SET objectId = ? WHERE objectId = ?`).run(normalized, objectId);
        db.prepare(`DELETE FROM wishlist WHERE objectId = ?`).run(normalized);
        db.prepare(`UPDATE wishlist SET objectId = ? WHERE objectId = ?`).run(normalized, objectId);
        db.prepare(`DELETE FROM favorites WHERE objectId = ?`).run(normalized);
        db.prepare(`UPDATE favorites SET objectId = ? WHERE objectId = ?`).run(normalized, objectId);
        // Sessions: compound PK so use INSERT+DELETE
        db.prepare(`INSERT OR IGNORE INTO librarySessions (objectId, date, temperature, cloudCover, humidity, windSpeed, dewPoint, visibility, precipProb, sessionImage) SELECT ?, date, temperature, cloudCover, humidity, windSpeed, dewPoint, visibility, precipProb, sessionImage FROM librarySessions WHERE objectId = ?`).run(normalized, objectId);
        db.prepare(`DELETE FROM librarySessions WHERE objectId = ?`).run(objectId);
        db.prepare(`INSERT OR IGNORE INTO libraryDeletedSessions (objectId, date) SELECT ?, date FROM libraryDeletedSessions WHERE objectId = ?`).run(normalized, objectId);
        db.prepare(`DELETE FROM libraryDeletedSessions WHERE objectId = ?`).run(objectId);
        db.prepare(`UPDATE sessionProcessedImages SET objectId = ? WHERE objectId = ?`).run(normalized, objectId);
        // libraryObjects PK: INSERT new row, DELETE old
        db.prepare(`INSERT OR IGNORE INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted, deletedAt, galleryImage, catalogId, objectName, objectType, constellation, description, magnitude, ra, dec, distanceLy, wikiUrl, sizeArcmin) SELECT ?, folderName, fileCount, lastImport, deleted, deletedAt, galleryImage, catalogId, objectName, objectType, constellation, description, magnitude, ra, dec, distanceLy, wikiUrl, sizeArcmin FROM libraryObjects WHERE objectId = ?`).run(normalized, objectId);
        db.prepare(`DELETE FROM libraryObjects WHERE objectId = ?`).run(objectId);
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
        const canonicalExists = db.prepare<[string], { objectId: string }>('SELECT objectId FROM libraryObjects WHERE objectId = ?').get(canonical);

        if (!canonicalExists) {
          // Simple rename: update objectId, preserve folderName for disk access
          db.prepare(`UPDATE libraryObjects SET folderName = ? WHERE objectId = ? AND (folderName = objectId OR folderName IS NULL OR folderName = '')`).run(objectId, objectId);
          db.prepare(`UPDATE notes SET objectId = ? WHERE objectId = ?`).run(canonical, objectId);
          db.prepare(`DELETE FROM wishlist WHERE objectId = ?`).run(canonical);
          db.prepare(`UPDATE wishlist SET objectId = ? WHERE objectId = ?`).run(canonical, objectId);
          db.prepare(`DELETE FROM favorites WHERE objectId = ?`).run(canonical);
          db.prepare(`UPDATE favorites SET objectId = ? WHERE objectId = ?`).run(canonical, objectId);
          db.prepare(`INSERT OR IGNORE INTO librarySessions (objectId, date, telescopeId, temperature, cloudCover, humidity, windSpeed, dewPoint, visibility, precipProb, sessionImage) SELECT ?, date, telescopeId, temperature, cloudCover, humidity, windSpeed, dewPoint, visibility, precipProb, sessionImage FROM librarySessions WHERE objectId = ?`).run(canonical, objectId);
          db.prepare(`DELETE FROM librarySessions WHERE objectId = ?`).run(objectId);
          db.prepare(`INSERT OR IGNORE INTO libraryDeletedSessions (objectId, date) SELECT ?, date FROM libraryDeletedSessions WHERE objectId = ?`).run(canonical, objectId);
          db.prepare(`DELETE FROM libraryDeletedSessions WHERE objectId = ?`).run(objectId);
          db.prepare(`UPDATE sessionProcessedImages SET objectId = ? WHERE objectId = ?`).run(canonical, objectId);
          db.prepare(`INSERT OR IGNORE INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted, deletedAt, galleryImage, catalogId, objectName, objectType, constellation, description, magnitude, ra, dec, distanceLy, wikiUrl, sizeArcmin) SELECT ?, folderName, fileCount, lastImport, deleted, deletedAt, galleryImage, catalogId, objectName, objectType, constellation, description, magnitude, ra, dec, distanceLy, wikiUrl, sizeArcmin FROM libraryObjects WHERE objectId = ?`).run(canonical, objectId);
          db.prepare(`DELETE FROM libraryObjects WHERE objectId = ?`).run(objectId);
        } else {
          // Merge: fold alias sessions into the canonical row, then drop the alias
          db.prepare(`INSERT OR IGNORE INTO librarySessions (objectId, date, telescopeId, temperature, cloudCover, humidity, windSpeed, dewPoint, visibility, precipProb, sessionImage) SELECT ?, date, telescopeId, temperature, cloudCover, humidity, windSpeed, dewPoint, visibility, precipProb, sessionImage FROM librarySessions WHERE objectId = ?`).run(canonical, objectId);
          db.prepare(`DELETE FROM librarySessions WHERE objectId = ?`).run(objectId);
          db.prepare(`INSERT OR IGNORE INTO libraryDeletedSessions (objectId, date) SELECT ?, date FROM libraryDeletedSessions WHERE objectId = ?`).run(canonical, objectId);
          db.prepare(`DELETE FROM libraryDeletedSessions WHERE objectId = ?`).run(objectId);
          db.prepare(`UPDATE sessionProcessedImages SET objectId = ? WHERE objectId = ?`).run(canonical, objectId);
          db.prepare(`UPDATE notes SET objectId = ? WHERE objectId = ?`).run(canonical, objectId);
          db.prepare(`DELETE FROM wishlist WHERE objectId = ?`).run(canonical);
          db.prepare(`UPDATE wishlist SET objectId = ? WHERE objectId = ?`).run(canonical, objectId);
          db.prepare(`DELETE FROM favorites WHERE objectId = ?`).run(canonical);
          db.prepare(`UPDATE favorites SET objectId = ? WHERE objectId = ?`).run(canonical, objectId);
          // Sum file counts and take the most recent lastImport
          db.prepare(`
            UPDATE libraryObjects SET
              fileCount  = fileCount + (SELECT fileCount FROM libraryObjects WHERE objectId = ?),
              lastImport = MAX(lastImport, (SELECT lastImport FROM libraryObjects WHERE objectId = ?))
            WHERE objectId = ?
          `).run(objectId, objectId, canonical);
          db.prepare(`DELETE FROM libraryObjects WHERE objectId = ?`).run(objectId);
        }
      }
    });
    migrateAliases();
    db.pragma('foreign_keys = ON');
    console.log(`[library] catalog alias normalization complete`);
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
      if (!fs.existsSync(dst)) fs.renameSync(src, dst);
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
     ON CONFLICT(objectId) DO UPDATE SET folderName = excluded.folderName, fileCount = excluded.fileCount,
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
  setSessionWeather: db.prepare(
    `UPDATE librarySessions SET temperature=?, cloudCover=?, humidity=?, windSpeed=?, dewPoint=?, visibility=?, precipProb=?
     WHERE objectId=? AND date=?`
  ),
  removeSession: db.prepare('DELETE FROM librarySessions WHERE objectId = ? AND date = ?'),
  clearSessions: db.prepare('DELETE FROM librarySessions WHERE objectId = ?'),

  // Deleted session tombstones
  isSessionTombstoned: db.prepare('SELECT 1 FROM libraryDeletedSessions WHERE objectId = ? AND date = ?'),
  addSessionTombstone: db.prepare('INSERT OR IGNORE INTO libraryDeletedSessions (objectId, date) VALUES (?, ?)'),
  getDeletedSessions: db.prepare<[string], { date: string }>('SELECT date FROM libraryDeletedSessions WHERE objectId = ?'),

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

  // Processed images (user-uploaded post-processing results)
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
    `INSERT INTO sessionProcessedImages (id, objectId, date, filename, originalName, title, notes, size, mimeType, uploadedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  deleteProcessedImageRow: db.prepare('DELETE FROM sessionProcessedImages WHERE id = ?'),

  // Import history
  insertHistory: db.prepare(
    `INSERT INTO importHistory (startedAt, finishedAt, objectsTotal, filesTotal, newFiles, bytesTotal, bytesNew, error, files, telescopeId, telescopeName, transportKind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  getHistory: db.prepare<[number, number], ImportHistoryRow>(
    'SELECT * FROM importHistory WHERE newFiles > 0 ORDER BY finishedAt DESC LIMIT ? OFFSET ?',
  ),
  getHistoryCount: db.prepare<[], { count: number }>('SELECT COUNT(*) as count FROM importHistory WHERE newFiles > 0'),
  getLatestHistory: db.prepare<[], Pick<ImportHistoryRow, 'finishedAt'>>('SELECT finishedAt FROM importHistory ORDER BY finishedAt DESC LIMIT 1'),
};

// ─── Catalog metadata helpers ───────────────────────────────────────────────

/** Resolve catalog metadata for an object ID and persist it to the DB row. */
export function resolveCatalogMeta(objectId: string): {
  catalogId: string; objectName: string; objectType: string;
  constellation: string; description: string; magnitude: number | null;
  ra: string | null; dec: string | null; distanceLy: number | null;
} {
  const normalized = normalizeCatalogId(objectId);
  const entry = getCatalogEntry(normalized) || getCatalogEntry(objectId);
  return {
    catalogId: normalized,
    objectName: entry?.name || objectId,
    objectType: entry?.type || (/^[CP]-\d{4}/i.test(objectId) ? 'Comet' : 'Unknown'),
    constellation: entry?.constellation || 'Unknown',
    description: entry?.description || '',
    magnitude: entry?.magnitude ?? null,
    ra: entry?.ra ?? null,
    dec: entry?.dec ?? null,
    distanceLy: entry?.distanceLy ?? null,
  };
}

// Backfill: populate catalog columns for any existing rows that have NULL catalogId or distanceLy
{
  const needsBackfill = db
    .prepare<[], { objectId: string }>(
      `SELECT objectId FROM libraryObjects WHERE (catalogId IS NULL OR distanceLy IS NULL) AND deleted = 0`,
    )
    .all();

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
}

// Prevents concurrent enrichment calls for the same objectId from firing
// parallel Wikipedia/SIMBAD requests. One fetch runs; others wait or skip.
const enrichInFlight = new Set<string>();

/**
 * Fetch enrichment data from Wikipedia + SIMBAD and store in the DB.
 * Called once during import — results are persisted so pages never need live fetches.
 */
export async function enrichObjectData(objectId: string): Promise<void> {
  if (enrichInFlight.has(objectId)) {
    log.debug({ objectId }, '[enrich] already in flight, skipping');
    return;
  }

  // Typed prepared statement — SQL trust boundary enforced by libraryObjects schema.
  const obj = db
    .prepare<[string], EnrichQueryRow>('SELECT objectName, catalogId, description, wikiUrl, sizeArcmin FROM libraryObjects WHERE objectId = ?')
    .get(objectId);
  if (!obj) {
    log.debug({ objectId }, '[enrich] not in DB yet, skipping');
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
  } finally {
    enrichInFlight.delete(objectId);
  }
}

// Async backfill: enrich objects missing Wikipedia/SIMBAD data (runs in background after startup)
{
  const needsEnrichment = db
    .prepare<[], { objectId: string }>(
      `SELECT objectId FROM libraryObjects WHERE (wikiUrl IS NULL OR sizeArcmin IS NULL OR (description IS NULL AND wikiUrl IS NOT NULL)) AND deleted = 0`,
    )
    .all();

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

// ─── Settings helper ─────────────────────────────────────────────────────────

export function loadSettings(): Record<string, unknown> {
  return getSettingsData();
}

// ─── Index helpers (bridge between old pattern and SQLite) ───────────────────

/** Load index as the old LibraryIndex shape for compatibility with import functions. */
export function loadIndex(): LibraryIndex {
  const meta = stmts.getMeta.get();
  if (!meta) throw new Error('[library] libraryMeta row missing');
  // Typed prepared statement — SQL trust boundary enforced by libraryObjects schema.
  const allObjsStmt = db.prepare<[], LibraryObjectRow>('SELECT * FROM libraryObjects');
  const allObjs = allObjsStmt.all();

  const objects: Record<string, LibraryObjectMeta> = {};
  for (const obj of allObjs) {
    const sessions = stmts.getSessions.all(obj.objectId).map(r => r.date).filter(d => d !== 'unknown');
    const deletedSessions = stmts.getDeletedSessions.all(obj.objectId).map(r => r.date);
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

/**
 * Persist the full index back to SQLite. Used after imports that mutate the
 * in-memory index. `telescopeId` stamps every (objectId, date) row with the
 * importing telescope; pass `null` for non-SMB imports (folder/upload).
 */
export function saveIndex(index: LibraryIndex, telescopeId: string | null = null): void {
  const save = db.transaction(() => {
    for (const [objectId, meta] of Object.entries(index.objects)) {
      const cat = resolveCatalogMeta(objectId);
      stmts.upsertObject.run(
        objectId, meta.folderName, meta.fileCount, meta.lastImport,
        meta.deleted ? 1 : 0, meta.deletedAt || null,
        cat.catalogId, cat.objectName, cat.objectType, cat.constellation,
        cat.description, cat.magnitude, cat.ra, cat.dec, cat.distanceLy
      );
      // Add sessions for this profile. The COALESCE in addSessionStamped
      // preserves attribution for any (objectId, date) row that's already
      // owned by another profile — first-to-import-wins. We do NOT clear
      // existing rows: clearing followed by re-insert would defeat the
      // COALESCE and silently steal attribution from other profiles, and
      // would also drop session rows whose dates have aged off the SMB
      // share but whose local files still exist on disk.
      for (const date of meta.sessions) {
        if (telescopeId) {
          stmts.addSessionStamped.run(objectId, date, telescopeId);
        } else {
          stmts.addSession.run(objectId, date);
        }
      }
      if (telescopeId) {
        stmts.setObjectPrimaryTelescopeIfNull.run(telescopeId, objectId);
      }
      // Sync deleted session tombstones
      if (meta.deletedSessions) {
        for (const date of meta.deletedSessions) {
          stmts.addSessionTombstone.run(objectId, date);
        }
      }
    }
    stmts.updateMetaLastImport.run(index.lastImport);
  });
  save();
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
  const LIBRARY_DIR = getLibraryDir();
  const folderName = getFolderName(objectId);
  const objDir = path.join(LIBRARY_DIR, folderName);
  if (!fs.existsSync(objDir)) return null;

  let thumbnail: string | null = null;
  let stacked: string | null = null;
  let any: string | null = null;

  for (const fname of fs.readdirSync(objDir)) {
    if (!isRealFile(fname)) continue;
    if (fname.startsWith('sky_') || fname.startsWith('gallery_')) continue;
    const parsed = parseFilename(fname);
    const ext = parsed.extension;
    const isViewable = ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.tif' || ext === '.tiff';
    if (!isViewable) continue;
    if (parsed.isThumbnail) {
      if (!thumbnail) thumbnail = fname;
    } else if (parsed.type === 'stacked') {
      if (!stacked) stacked = fname;
    } else if (!any) {
      any = fname;
    }
  }

  const best = stacked ?? any ?? thumbnail;
  return best ? `${folderName}/${best}` : null;
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
  const LIBRARY_DIR = getLibraryDir();
  const objDir = path.join(LIBRARY_DIR, getFolderName(objectId));
  if (!fs.existsSync(objDir)) return null;

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

export function getLocalFile(relativePath: string): { data: Buffer; name: string } | null {
  const LIBRARY_DIR = getLibraryDir();
  // Resolve to an absolute path and confirm it stays inside the library root.
  // path.normalize + ".." check is insufficient — absolute paths like /etc/passwd
  // bypass it. path.resolve is the canonical guard used by the thumbnail handler.
  const fullPath = path.resolve(LIBRARY_DIR, relativePath);
  const libRoot = LIBRARY_DIR.endsWith(path.sep) ? LIBRARY_DIR : LIBRARY_DIR + path.sep;
  if (!fullPath.startsWith(libRoot)) return null;

  const filename = path.basename(fullPath);
  if (!isRealFile(filename)) return null;

  if (!fs.existsSync(fullPath)) return null;

  try {
    return { data: fs.readFileSync(fullPath), name: filename };
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
  const LIBRARY_DIR = getLibraryDir();
  // Update DB FIRST so a crash mid-delete never leaves the DB referencing removed files
  const existing = stmts.getObject.get(objectId);
  if (existing) {
    stmts.markObjectDeleted.run(new Date().toISOString(), objectId);
  } else {
    const cat = resolveCatalogMeta(objectId);
    stmts.upsertObject.run(objectId, objectId, 0, new Date().toISOString(), 1, new Date().toISOString(),
      cat.catalogId, cat.objectName, cat.objectType, cat.constellation,
      cat.description, cat.magnitude, cat.ra, cat.dec, cat.distanceLy);
  }

  // Now safe to remove files
  const objDir = path.join(LIBRARY_DIR, getFolderName(objectId));
  if (fs.existsSync(objDir)) {
    for (const fname of fs.readdirSync(objDir)) {
      try { fs.unlinkSync(path.join(objDir, fname)); } catch { /* ignore */ }
    }
    try { fs.rmdirSync(objDir); } catch { /* ignore non-empty */ }
  }
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
  const LIBRARY_DIR = getLibraryDir();
  const objDir = path.join(LIBRARY_DIR, getFolderName(objectId));
  if (!fs.existsSync(objDir)) {
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
    const dateKey = parsed.date || 'unknown';
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
  try {
    const remaining = fs.readdirSync(objDir);
    const sessionSet = new Set<string>();
    for (const fname of remaining) {
      const parsed = parseFilename(fname);
      if (parsed.date) sessionSet.add(parsed.date);
    }
    stmts.updateObjectFileCount.run(remaining.length, objectId);
    // Rebuild sessions list
    stmts.clearSessions.run(objectId);
    for (const date of sessionSet) {
      stmts.addSession.run(objectId, date);
    }
  } catch { /* ignore */ }
}
