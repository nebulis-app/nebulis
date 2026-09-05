/**
 * Golden-snapshot helper for the import pipeline (CORE-PIPELINE-REMEDIATION
 * Phase 2). `snapshotLibraryState()` dumps every observable effect an import
 * run has — files on disk, the four library tables, the latest history row,
 * and the pruned run status — in a stable, sorted, path-relative form so a
 * behaviour-preserving refactor can be proven byte-identical.
 *
 * Anything time-based or environment-dependent (row ids, `importedAt`,
 * `startedAt`, weather columns) is stripped: those are not behaviour.
 */
import fs from 'fs';
import path from 'path';
import { LIBRARY_DIR } from '../../../server/lib/paths';
import db from '../../../server/lib/db';
import { getImportStatus } from '../../../server/lib/library/import';

/** Columns dropped from each table dump because they are not behaviour. */
const DROP_COLUMNS: Record<string, ReadonlySet<string>> = {
  libraryFiles: new Set(['id', 'importedAt']),
  librarySessions: new Set([
    'temperature', 'cloudCover', 'humidity', 'windSpeed', 'dewPoint',
    'visibility', 'precipProb', 'weatherLat', 'weatherLon',
  ]),
  libraryObjects: new Set([
    'lastImport', 'deletedAt', 'galleryImage',
    // Network-enrichment bookkeeping, not import behaviour (and timestamped).
    'enrichmentAttemptedAt', 'enrichmentAttempts',
  ]),
  importHistory: new Set(['id', 'startedAt', 'finishedAt']),
};

/** Sort a JSON-encoded `string[]` column in place; pass through anything else. */
function sortJsonStringArray(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every(v => typeof v === 'string')) {
      return JSON.stringify([...(parsed as string[])].sort());
    }
  } catch { /* not JSON — leave it */ }
  return value;
}

/** Sort the `samples` array inside each entry of a JSON-encoded skip summary. */
function sortSkipSamples(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      const sorted = parsed.map(entry => {
        if (entry && typeof entry === 'object' && Array.isArray((entry as { samples?: unknown }).samples)) {
          return { ...entry, samples: [...(entry as { samples: string[] }).samples].sort() };
        }
        return entry;
      });
      return JSON.stringify(sorted);
    }
  } catch { /* not JSON — leave it */ }
  return value;
}

function tableColumns(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name);
}

function dumpTable(
  table: string,
  orderBy: string,
  where?: { column: string; ids: string[] },
): Array<Record<string, unknown>> {
  const drop = DROP_COLUMNS[table] ?? new Set<string>();
  const keep = tableColumns(table).filter(c => !drop.has(c));
  let sql = `SELECT ${keep.map(c => `"${c}"`).join(', ')} FROM ${table}`;
  const params: string[] = [];
  if (where && where.ids.length > 0) {
    sql += ` WHERE "${where.column}" IN (${where.ids.map(() => '?').join(', ')})`;
    params.push(...where.ids);
  } else if (where) {
    return []; // an explicit empty id list means "nothing"
  }
  sql += ` ORDER BY ${orderBy}`;
  return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
}

/** Every file under `dir`, as `{ relPath, bytes }` relative to LIBRARY_DIR, sorted. */
function walkLibraryFiles(dir: string): Array<{ relPath: string; bytes: number }> {
  const out: Array<{ relPath: string; bytes: number }> = [];
  const visit = (abs: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Skip dot entries: `.thumbs/` holds sharp-rendered JPEGs whose byte size
      // tracks the libvips version, and `.nebulis-files.json` embeds
      // timestamps. Neither is import behaviour; the DB tables carry the
      // per-file truth.
      if (entry.name.startsWith('.')) continue;
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        visit(child);
      } else if (entry.isFile()) {
        out.push({
          relPath: path.relative(LIBRARY_DIR, child).split(path.sep).join('/'),
          bytes: fs.statSync(child).size,
        });
      }
    }
  };
  visit(dir);
  return out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
}

export interface ImportSnapshot {
  files: Array<{ relPath: string; bytes: number }>;
  libraryFiles: Array<Record<string, unknown>>;
  librarySessions: Array<Record<string, unknown>>;
  libraryDeletedSessions: Array<Record<string, unknown>>;
  libraryObjects: Array<Record<string, unknown>>;
  latestHistory: Record<string, unknown> | null;
  status: Record<string, unknown>;
}

/**
 * Snapshot the whole library, or just the objects in `objectIds`.
 *
 * When `objectIds` is given, the on-disk file list is narrowed to those
 * objects' folders (looked up from `libraryObjects.folderName`) plus nothing
 * else, so unrelated fixtures in the same test file don't bleed in.
 */
export function snapshotLibraryState(objectIds?: string[]): ImportSnapshot {
  const idFilter = objectIds ? { column: 'objectId', ids: [...objectIds].sort() } : undefined;

  let files: Array<{ relPath: string; bytes: number }>;
  if (objectIds) {
    const folders = objectIds
      .map(id => (db.prepare('SELECT folderName FROM libraryObjects WHERE objectId = ?').get(id) as { folderName?: string } | undefined)?.folderName)
      .filter((f): f is string => typeof f === 'string');
    files = folders.flatMap(f => walkLibraryFiles(path.join(LIBRARY_DIR, f)))
      .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  } else {
    files = walkLibraryFiles(LIBRARY_DIR);
  }

  const latestHistoryId = (db.prepare('SELECT MAX(id) AS id FROM importHistory').get() as { id: number | null }).id;
  const latestHistory = latestHistoryId == null
    ? null
    : (() => {
        const keep = tableColumns('importHistory').filter(c => !DROP_COLUMNS.importHistory.has(c));
        const row = db.prepare(`SELECT ${keep.map(c => `"${c}"`).join(', ')} FROM importHistory WHERE id = ?`).get(latestHistoryId) as Record<string, unknown>;
        // `files` and the skip samples are appended in download-completion
        // order, which the concurrent worker pool makes non-deterministic.
        // Sort them so the snapshot compares content, not race timing.
        row.files = sortJsonStringArray(row.files);
        row.skipped = sortSkipSamples(row.skipped);
        return row;
      })();

  const rawStatus = getImportStatus() as unknown as Record<string, unknown>;
  const status: Record<string, unknown> = { ...rawStatus };
  for (const k of ['startedAt', 'lastRun', 'runId']) delete status[k];
  if (Array.isArray(status.skipped)) {
    status.skipped = (status.skipped as Array<Record<string, unknown>>).map(s => ({
      ...s,
      samples: Array.isArray(s.samples) ? [...(s.samples as string[])].sort() : s.samples,
    }));
  }

  return {
    files,
    libraryFiles: dumpTable('libraryFiles', 'relPath', idFilter),
    librarySessions: dumpTable('librarySessions', 'objectId, date', idFilter),
    libraryDeletedSessions: dumpTable('libraryDeletedSessions', 'objectId, date', idFilter),
    libraryObjects: dumpTable('libraryObjects', 'objectId', idFilter),
    latestHistory,
    status,
  };
}
