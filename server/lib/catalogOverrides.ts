/**
 * User-supplied per-field overrides for catalog metadata.
 *
 * These layer on top of the static catalog and the libraryObjects table:
 * any non-null override field wins. NULL means "no override for this field"
 * and the normal source flows through.
 *
 * The overrides apply transparently to every read path that goes through
 * getCatalogEntry(), so consumers (storage, telescope, reports, the web UI)
 * see the merged result without code changes.
 */

import db from './db.js';
import type { CatalogEntry } from './types/catalog.js';

/** Shape of a row in catalogOverrides — every field nullable except objectId. */
interface CatalogOverrideRow {
  objectId: string;
  name: string | null;
  type: string | null;
  constellation: string | null;
  magnitude: number | null;
  description: string | null;
  ra: string | null;
  dec: string | null;
  distanceLy: number | null;
  updatedAt: number;
  updatedBy: string | null;
}

/** Fields a user can override. Mirrors CatalogEntry minus id/wikiUrl. */
export interface CatalogOverride {
  name?: string;
  type?: string;
  constellation?: string;
  magnitude?: number;
  description?: string;
  ra?: string;
  dec?: string;
  distanceLy?: number;
}

// Mirrored on the client at src/lib/api.ts CatalogOverrideRecord — keep in sync.
/** Public shape returned to the UI alongside the override data. */
export interface CatalogOverrideRecord extends CatalogOverride {
  objectId: string;
  updatedAt: number;
  updatedBy: string | null;
}

/**
 * Normalize an object id the same way getCatalogEntry does, so override keys
 * line up with lookup keys regardless of how a caller types them ("M 31",
 * "m31", "NGC 224" all collapse the same way).
 */
export function normalizeOverrideKey(id: string): string {
  return id.toUpperCase().replace(/\s+/g, '');
}

const getStmt = db.prepare<[string], CatalogOverrideRow>(
  `SELECT objectId, name, type, constellation, magnitude, description, ra, dec,
   distanceLy, updatedAt, updatedBy
   FROM catalogOverrides WHERE objectId = ?`,
);

const upsertStmt = db.prepare(
  `INSERT INTO catalogOverrides
     (objectId, name, type, constellation, magnitude, description, ra, dec,
      distanceLy, updatedAt, updatedBy)
   VALUES (@objectId, @name, @type, @constellation, @magnitude, @description,
           @ra, @dec, @distanceLy, @updatedAt, @updatedBy)
   ON CONFLICT(objectId) DO UPDATE SET
     name          = excluded.name,
     type          = excluded.type,
     constellation = excluded.constellation,
     magnitude     = excluded.magnitude,
     description   = excluded.description,
     ra            = excluded.ra,
     dec           = excluded.dec,
     distanceLy    = excluded.distanceLy,
     updatedAt     = excluded.updatedAt,
     updatedBy     = excluded.updatedBy`,
);

const deleteStmt = db.prepare(`DELETE FROM catalogOverrides WHERE objectId = ?`);

/** Fetch the raw override row for an object id (any casing/spacing). */
export function getOverride(id: string): CatalogOverrideRow | undefined {
  return getStmt.get(normalizeOverrideKey(id));
}

/**
 * Apply non-null override fields to a base CatalogEntry. The base is
 * spread first so its fields (including id and wikiUrl) survive when the
 * override has nothing to say about them.
 */
export function mergeOverride(base: CatalogEntry, id: string): CatalogEntry {
  const row = getOverride(id);
  if (!row) return base;

  const merged: CatalogEntry = { ...base };
  if (row.name != null) merged.name = row.name;
  if (row.type != null) merged.type = row.type;
  if (row.constellation != null) merged.constellation = row.constellation;
  if (row.magnitude != null) merged.magnitude = row.magnitude;
  if (row.description != null) merged.description = row.description;
  if (row.ra != null) merged.ra = row.ra;
  if (row.dec != null) merged.dec = row.dec;
  if (row.distanceLy != null) merged.distanceLy = row.distanceLy;
  return merged;
}

/**
 * Build a CatalogEntry purely from an override row. Used when a user wants
 * to add a custom object that isn't in any catalog — the override row is
 * the only source of truth for it.
 */
export function entryFromOverride(id: string): CatalogEntry | undefined {
  const row = getOverride(id);
  if (!row) return undefined;
  return {
    id,
    name: row.name ?? id,
    type: row.type ?? 'Unknown',
    constellation: row.constellation ?? '',
    magnitude: row.magnitude ?? undefined,
    description: row.description ?? '',
    ra: row.ra ?? undefined,
    dec: row.dec ?? undefined,
    distanceLy: row.distanceLy ?? undefined,
  };
}

/**
 * Save an override. Empty strings are treated as null (clears the field) so
 * the UI can use empty inputs to mean "remove this override" without an
 * extra delete-per-field roundtrip.
 */
export function saveOverride(
  id: string,
  patch: CatalogOverride,
  updatedBy: string | null,
): CatalogOverrideRecord {
  const norm = (s: string | undefined): string | null => {
    if (s == null) return null;
    const t = s.trim();
    return t === '' ? null : t;
  };
  const key = normalizeOverrideKey(id);
  const updatedAt = Date.now();
  upsertStmt.run({
    objectId: key,
    name: norm(patch.name),
    type: norm(patch.type),
    constellation: norm(patch.constellation),
    magnitude: patch.magnitude ?? null,
    description: norm(patch.description),
    ra: norm(patch.ra),
    dec: norm(patch.dec),
    distanceLy: patch.distanceLy ?? null,
    updatedAt,
    updatedBy,
  });
  const row = getStmt.get(key);
  if (!row) throw new Error(`[catalogOverrides] saved row vanished for ${key}`);
  return rowToRecord(row);
}

export function deleteOverride(id: string): boolean {
  const result = deleteStmt.run(normalizeOverrideKey(id));
  return result.changes > 0;
}

function rowToRecord(row: CatalogOverrideRow): CatalogOverrideRecord {
  return {
    objectId: row.objectId,
    name: row.name ?? undefined,
    type: row.type ?? undefined,
    constellation: row.constellation ?? undefined,
    magnitude: row.magnitude ?? undefined,
    description: row.description ?? undefined,
    ra: row.ra ?? undefined,
    dec: row.dec ?? undefined,
    distanceLy: row.distanceLy ?? undefined,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

export function getOverrideRecord(id: string): CatalogOverrideRecord | undefined {
  const row = getOverride(id);
  return row ? rowToRecord(row) : undefined;
}
