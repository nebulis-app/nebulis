/**
 * Observing sites — the places (and skies) the user observes from.
 *
 * Replaces the single location that used to live only on `appSettings`. An
 * entry bundles coordinates with the sky settings that apply there, so "same
 * garden looking north" and "same garden looking south" are two entries sharing
 * a latitude and longitude.
 *
 * ── The appSettings mirror ──────────────────────────────────────────────────
 * `appSettings.latitude / longitude / locationName / timezone / minAlt /
 * horizonProfile / visibleSkyMap` are kept as a **projection of the default
 * site**. Shipped iOS and Android builds decode those fields off GET /settings
 * and write them back through PUT /settings, so they can never stop reflecting
 * a real site. `syncDefaultSiteToAppSettings()` re-projects after every
 * mutation here; the reverse direction (a legacy PUT landing on the default
 * site) lives in routes/settings.ts.
 *
 * The write is a narrow seven-column UPDATE rather than a call into
 * telescopes.ts's read-merge-write helper: it cannot clobber an unrelated
 * setting, and it keeps this module free of any import that could cycle back
 * here through the settings layer.
 *
 * ── resolveSite is the single seam ──────────────────────────────────────────
 * Everything that used to read `settings.latitude` goes through `resolveSite`
 * or one of the narrower helpers, so there is one place that decides which
 * location a given request computes for.
 */
import { randomUUID } from 'crypto';
import db from './db.js';
import { SKY_MAP_CELLS } from './skyMapConfig.js';

export interface ObservingSite {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  minAlt: number;
  /** Blocked altitude per 10° azimuth bucket. Length 36, or all-zero when unset. */
  horizonProfile: number[];
  /** 36 azimuth slices × 8 elevation bands. Length SKY_MAP_CELLS, or `[]` when
   *  no mask has been drawn (which the visibility check reads as "all visible"). */
  visibleSkyMap: boolean[];
  bortleClass: number | null;
  isDefault: boolean;
  sortOrder: number;
  createdAt: string;
  /** True for the transient site `resolveSite` synthesizes from ad-hoc client
   *  coordinates. Never persisted; callers must not try to update it. */
  isTransient?: boolean;
}

interface ObservingSiteRow {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  minAlt: number;
  horizonProfile: string;
  visibleSkyMap: string;
  bortleClass: number | null;
  isDefault: number;
  sortOrder: number;
  createdAt: string;
}

const stmts = {
  getAll: db.prepare<[], ObservingSiteRow>(
    'SELECT * FROM observingSites ORDER BY sortOrder ASC, createdAt ASC',
  ),
  getById: db.prepare<[string], ObservingSiteRow>('SELECT * FROM observingSites WHERE id = ?'),
  getDefault: db.prepare<[], ObservingSiteRow>('SELECT * FROM observingSites WHERE isDefault = 1'),
  getFirst: db.prepare<[], ObservingSiteRow>(
    'SELECT * FROM observingSites ORDER BY sortOrder ASC, createdAt ASC LIMIT 1',
  ),
  count: db.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM observingSites'),
  maxSort: db.prepare<[], { m: number | null }>('SELECT MAX(sortOrder) AS m FROM observingSites'),
  insert: db.prepare(
    `INSERT INTO observingSites
       (id, name, latitude, longitude, timezone, minAlt, horizonProfile,
        visibleSkyMap, bortleClass, isDefault, sortOrder, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  update: db.prepare(
    `UPDATE observingSites
        SET name = ?, latitude = ?, longitude = ?, timezone = ?, minAlt = ?,
            horizonProfile = ?, visibleSkyMap = ?, bortleClass = ?, sortOrder = ?
      WHERE id = ?`,
  ),
  delete: db.prepare('DELETE FROM observingSites WHERE id = ?'),
  clearDefault: db.prepare('UPDATE observingSites SET isDefault = 0 WHERE isDefault = 1'),
  setDefault: db.prepare('UPDATE observingSites SET isDefault = 1 WHERE id = ?'),
  activeSiteId: db.prepare<[], { activeSiteId: string }>(
    'SELECT activeSiteId FROM appSettings WHERE id = 1',
  ),
  setActiveSiteId: db.prepare('UPDATE appSettings SET activeSiteId = ? WHERE id = 1'),
  /** Narrow projection write — see the module doc comment. */
  mirrorToAppSettings: db.prepare(
    `UPDATE appSettings
        SET latitude = ?, longitude = ?, locationName = ?, timezone = ?,
            minAlt = ?, horizonProfile = ?, visibleSkyMap = ?
      WHERE id = 1`,
  ),
};

// ─── Row ↔ domain ───────────────────────────────────────────────────────────

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';

/** Parse a stored horizon profile. Mismatched length or non-numeric entries fall
 *  back to a flat zero horizon rather than propagating a malformed array into
 *  the visibility maths. Mirrors rowToSettings in telescopes.ts. */
export function parseHorizonProfile(raw: string): number[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw || '[]'); } catch { return Array(36).fill(0); }
  return Array.isArray(parsed) && parsed.length === 36 && parsed.every(isFiniteNumber)
    ? parsed
    : Array(36).fill(0);
}

/** Parse a stored sky mask. `[]` is meaningful: it means no mask was ever drawn,
 *  which the visibility check treats as "whole sky visible". */
export function parseVisibleSkyMap(raw: string): boolean[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw || '[]'); } catch { return []; }
  return Array.isArray(parsed) && parsed.length === SKY_MAP_CELLS && parsed.every(isBoolean)
    ? parsed
    : [];
}

function rowToSite(row: ObservingSiteRow): ObservingSite {
  return {
    id: row.id,
    name: row.name,
    latitude: row.latitude,
    longitude: row.longitude,
    timezone: row.timezone,
    minAlt: row.minAlt,
    horizonProfile: parseHorizonProfile(row.horizonProfile),
    visibleSkyMap: parseVisibleSkyMap(row.visibleSkyMap),
    bortleClass: row.bortleClass,
    isDefault: row.isDefault === 1,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
  };
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export function listSites(): ObservingSite[] {
  return stmts.getAll.all().map(rowToSite);
}

export function getSite(id: string): ObservingSite | null {
  if (!id) return null;
  const row = stmts.getById.get(id);
  return row ? rowToSite(row) : null;
}

/**
 * The default site. Self-heals rather than throwing:
 *
 *  - no row flagged default (a hand-edited DB, or a restore that dropped the
 *    flag) → promote the first site by sort order
 *  - no sites at all (the seed could not run because appSettings was missing)
 *    → create an empty "My Location"
 *
 * Callers treat this as infallible, because every location-dependent code path
 * bottoms out here and a throw would take down the planner, the forecast, and
 * the observation list together.
 */
export function getDefaultSite(): ObservingSite {
  const flagged = stmts.getDefault.get();
  if (flagged) return rowToSite(flagged);

  const first = stmts.getFirst.get();
  if (first) {
    stmts.setDefault.run(first.id);
    console.warn(`[sites] No default site was set; promoted "${first.name}" (${first.id}).`);
    return { ...rowToSite(first), isDefault: true };
  }

  console.warn('[sites] No observing sites exist; creating an empty default.');
  return createSite({ name: 'My Location', isDefault: true });
}

/** The site the planner and forecast currently compute for: `activeSiteId` when
 *  it still points at a live row, otherwise the default. */
export function getActiveSite(): ObservingSite {
  const activeId = stmts.activeSiteId.get()?.activeSiteId ?? '';
  if (activeId) {
    const site = getSite(activeId);
    if (site) return site;
    // Stale pointer (the site was deleted out from under it). Clear it so the
    // next read is a plain default lookup instead of another failed indirection.
    stmts.setActiveSiteId.run('');
  }
  return getDefaultSite();
}

export function setActiveSite(id: string | null): void {
  if (id && !getSite(id)) throw new Error(`Unknown observing site: ${id}`);
  stmts.setActiveSiteId.run(id ?? '');
}

/**
 * Decide which site a request computes for. Precedence, highest first:
 *
 *  1. `siteId` — an explicitly named site.
 *  2. `lat` + `lon` — an ad-hoc override (phone GPS while travelling with the
 *     scope). Returns a transient site carrying the active site's sky settings,
 *     since the caller supplied coordinates but no horizon or mask.
 *  3. The active site.
 *  4. The default site.
 *
 * Both `lat` and `lon` must be present for rule 2. A half-supplied pair is
 * ignored rather than mixed with a stored coordinate, which would place the
 * observer somewhere that is neither location. This preserves the guard the
 * planner route already had.
 */
export function resolveSite(opts: {
  siteId?: string | null;
  lat?: number | null;
  lon?: number | null;
} = {}): ObservingSite {
  if (opts.siteId) {
    const site = getSite(opts.siteId);
    if (site) return site;
  }

  if (opts.lat != null && opts.lon != null) {
    const base = getActiveSite();
    return {
      ...base,
      // A distinct, coordinate-derived id. Inheriting `base.id` here would make
      // an ad-hoc GPS request share the active site's planner cache entry, so
      // two observers at different coordinates would see each other's targets
      // for the cache TTL. Keying on the coordinates keeps those entries apart
      // while still letting repeat requests from one place hit the cache.
      id: `transient:${opts.lat},${opts.lon}`,
      latitude: opts.lat,
      longitude: opts.lon,
      // The supplied coordinates may be nowhere near the base site, so its
      // timezone would be wrong. Callers already resolve a timezone from
      // coordinates (observerTimezoneForCoordinates) when this is blank.
      timezone: '',
      name: 'Current location',
      isDefault: false,
      isTransient: true,
    };
  }

  return getActiveSite();
}

// ─── Writes ─────────────────────────────────────────────────────────────────

const clampMinAlt = (v: unknown): number =>
  isFiniteNumber(v) ? Math.min(90, Math.max(0, Math.round(v))) : 20;

const coordOrNull = (v: unknown, limit: number): number | null =>
  isFiniteNumber(v) && Math.abs(v) <= limit ? v : null;

function serializeHorizon(v: unknown): string {
  return JSON.stringify(
    Array.isArray(v) && v.length === 36 && v.every(isFiniteNumber) ? v : [],
  );
}

function serializeSkyMap(v: unknown): string {
  return JSON.stringify(
    Array.isArray(v) && v.length === SKY_MAP_CELLS ? v.map(cell => cell === true) : [],
  );
}

export function createSite(data: Partial<ObservingSite>): ObservingSite {
  const id = randomUUID();
  const isFirst = (stmts.count.get()?.c ?? 0) === 0;
  // The first site is always the default — there has to be one, and the unique
  // partial index would reject a second later anyway.
  const makeDefault = isFirst || data.isDefault === true;
  const sortOrder = isFiniteNumber(data.sortOrder)
    ? data.sortOrder
    : (stmts.maxSort.get()?.m ?? -1) + 1;

  db.transaction(() => {
    if (makeDefault) stmts.clearDefault.run();
    stmts.insert.run(
      id,
      (typeof data.name === 'string' && data.name.trim()) || 'Untitled site',
      coordOrNull(data.latitude, 90),
      coordOrNull(data.longitude, 180),
      typeof data.timezone === 'string' ? data.timezone : '',
      clampMinAlt(data.minAlt),
      serializeHorizon(data.horizonProfile),
      serializeSkyMap(data.visibleSkyMap),
      isFiniteNumber(data.bortleClass) ? Math.round(data.bortleClass) : null,
      makeDefault ? 1 : 0,
      sortOrder,
      new Date().toISOString(),
    );
  })();

  if (makeDefault) syncDefaultSiteToAppSettings();
  const created = getSite(id);
  if (!created) throw new Error('[sites] Insert succeeded but the row is not readable');
  return created;
}

/** Patch a site. Absent keys are left alone. `isDefault` is ignored here —
 *  use `setDefaultSite` so the clear-then-set stays one transaction. */
export function updateSite(id: string, data: Partial<ObservingSite>): ObservingSite | null {
  const current = getSite(id);
  if (!current) return null;
  const merged = { ...current, ...data };

  stmts.update.run(
    (typeof merged.name === 'string' && merged.name.trim()) || current.name,
    coordOrNull(merged.latitude, 90),
    coordOrNull(merged.longitude, 180),
    typeof merged.timezone === 'string' ? merged.timezone : '',
    clampMinAlt(merged.minAlt),
    serializeHorizon(merged.horizonProfile),
    serializeSkyMap(merged.visibleSkyMap),
    isFiniteNumber(merged.bortleClass) ? Math.round(merged.bortleClass) : null,
    isFiniteNumber(merged.sortOrder) ? merged.sortOrder : current.sortOrder,
    id,
  );

  if (current.isDefault) syncDefaultSiteToAppSettings();
  return getSite(id);
}

export function setDefaultSite(id: string): boolean {
  if (!getSite(id)) return false;
  // One transaction: the partial unique index would reject the set before the
  // clear landed if these ran separately.
  db.transaction(() => {
    stmts.clearDefault.run();
    stmts.setDefault.run(id);
  })();
  syncDefaultSiteToAppSettings();
  return true;
}

/**
 * Delete a site. Refuses the last remaining one, because the legacy appSettings
 * mirror has to keep projecting something and every location-dependent path
 * bottoms out at a default site.
 *
 * Sessions tagged to the deleted site keep their now-dangling `siteId` and read
 * back as the default (see sessionLocation.ts), so no observation history is
 * touched. Deleting the default promotes the next site by sort order.
 */
export function deleteSite(id: string): { deleted: boolean; reason?: string } {
  const site = getSite(id);
  if (!site) return { deleted: false, reason: 'not-found' };
  if ((stmts.count.get()?.c ?? 0) <= 1) {
    return { deleted: false, reason: 'last-site' };
  }

  db.transaction(() => {
    stmts.delete.run(id);
    if (site.isDefault) {
      const next = stmts.getFirst.get();
      if (next) stmts.setDefault.run(next.id);
    }
  })();

  // Drop a now-dangling active pointer so getActiveSite doesn't have to.
  if ((stmts.activeSiteId.get()?.activeSiteId ?? '') === id) stmts.setActiveSiteId.run('');
  syncDefaultSiteToAppSettings();
  return { deleted: true };
}

/**
 * Re-project the default site onto the legacy `appSettings` location columns.
 *
 * This is what keeps shipped iOS/Android builds working: they read these fields
 * off GET /settings and know nothing about sites. Call after every mutation
 * that could change which row is default or what it contains.
 *
 * `locationName` projects the site name **only when the site has coordinates**.
 * An unlocated site must project an empty name, because the web UI reads a
 * non-empty `locationName` as "a location is configured"
 * (see LocationSection's `hasLocation`) and would stop prompting for one. The
 * seed names an unconfigured site "My Location" for display purposes, and that
 * placeholder must not leak out as a real location.
 */
export function syncDefaultSiteToAppSettings(): void {
  const site = getDefaultSite();
  const hasCoords = site.latitude != null && site.longitude != null;
  stmts.mirrorToAppSettings.run(
    site.latitude,
    site.longitude,
    hasCoords ? site.name : '',
    site.timezone,
    site.minAlt,
    JSON.stringify(site.horizonProfile),
    JSON.stringify(site.visibleSkyMap),
  );
}
