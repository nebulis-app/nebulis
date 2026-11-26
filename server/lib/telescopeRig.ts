/**
 * What a telescope shoots with, for planning how many hours a target needs
 * (`src/lib/integrationSuggestion.ts`).
 *
 * Only a custom rig (`other` / `asiair`) carries saved settings: nothing about
 * its camera or filters can be known. A smart telescope (SeeStar, Dwarf) is a
 * colour camera with fixed hardware, so it has no row; the names of the filters
 * it really used are read back from its own frames instead of being written
 * down here, which keeps this file free of per-model hardware claims that would
 * have to be checked against spec sheets.
 */
import db from './db.js';
import { getFilterAliasMap, normalizeFilterName } from './library/integration.js';

export type SensorType = 'color' | 'mono';
export type MountType = 'equatorial' | 'altaz';

export interface TelescopeRig {
  /** Null until the owner says; the panel then asks instead of guessing. */
  sensorType: SensorType | null;
  /** Filter names as the owner calls them, e.g. "Ha", "L-eXtreme". */
  filters: string[];
  /** What the rig rides on, for the planner's meridian flip. Null until the owner says (the planner then assumes an
   *  ASIAIR is on an equatorial mount and another rig is not). */
  mount: MountType | null;
  /** Minutes lost at the flip (slew, re-centre, guiding restart). Null reads as `DEFAULT_FLIP_PAUSE_MINUTES`. */
  flipPauseMinutes: number | null;
}

export const DEFAULT_FLIP_PAUSE_MINUTES = 10;
export const MAX_FLIP_PAUSE_MINUTES = 60;

export const MAX_RIG_FILTERS = 16;
export const MAX_RIG_FILTER_LENGTH = 64;

const EMPTY_RIG: TelescopeRig = { sensorType: null, filters: [], mount: null, flipPauseMinutes: null };

const stmts = {
  get: db.prepare<[string], { sensorType: string | null; filtersJson: string; mount: string | null; flipPauseMinutes: number | null }>(
    'SELECT sensorType, filtersJson, mount, flipPauseMinutes FROM telescopeRigSettings WHERE profileId = ?',
  ),
  upsert: db.prepare(
    `INSERT INTO telescopeRigSettings (profileId, sensorType, filtersJson, mount, flipPauseMinutes, updatedAt) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(profileId) DO UPDATE SET sensorType = excluded.sensorType, filtersJson = excluded.filtersJson,
       mount = excluded.mount, flipPauseMinutes = excluded.flipPauseMinutes, updatedAt = excluded.updatedAt`,
  ),
  usedFilters: db.prepare<[string], { filter: string; n: number }>(
    `SELECT ci.filter AS filter, COUNT(*) AS n
       FROM captureInfo ci
       JOIN librarySessions ls ON ls.objectId = ci.objectId AND ls.date = ci.sessionDate
      WHERE ls.telescopeId = ? AND ci.filter IS NOT NULL AND TRIM(ci.filter) <> ''
      GROUP BY ci.filter`,
  ),
};

/** Trim, drop blanks and case-insensitive duplicates, and cap the list. Throws RangeError past the limits. */
export function cleanRigFilters(filters: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of filters) {
    const name = raw.replace(/\s+/g, ' ').trim();
    if (!name) continue;
    if (name.length > MAX_RIG_FILTER_LENGTH) {
      throw new RangeError(`Filter names are limited to ${MAX_RIG_FILTER_LENGTH} characters`);
    }
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  if (out.length > MAX_RIG_FILTERS) throw new RangeError(`At most ${MAX_RIG_FILTERS} filters`);
  return out;
}

export function getRig(profileId: string): TelescopeRig {
  const row = stmts.get.get(profileId);
  if (!row) return { ...EMPTY_RIG, filters: [] };
  const mount = row.mount === 'equatorial' || row.mount === 'altaz' ? row.mount : null;
  const pause = typeof row.flipPauseMinutes === 'number' && Number.isFinite(row.flipPauseMinutes) ? row.flipPauseMinutes : null;
  let filters: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.filtersJson);
    if (Array.isArray(parsed)) filters = parsed.filter((x): x is string => typeof x === 'string');
  } catch { /* a damaged value reads as no filters */ }
  return { sensorType: row.sensorType === 'color' || row.sensorType === 'mono' ? row.sensorType : null, filters, mount, flipPauseMinutes: pause };
}

/**
 * Saves the rig. `mount` and `flipPauseMinutes` are optional so a caller that only edits the camera and filters
 * (an older client, say) keeps what was saved for the mount.
 */
export function setRig(
  profileId: string,
  rig: Pick<TelescopeRig, 'sensorType' | 'filters'> & Partial<Pick<TelescopeRig, 'mount' | 'flipPauseMinutes'>>,
): TelescopeRig {
  const filters = cleanRigFilters(rig.filters);
  const before = getRig(profileId);
  const mount = rig.mount !== undefined ? rig.mount : before.mount;
  const pause = rig.flipPauseMinutes !== undefined ? rig.flipPauseMinutes : before.flipPauseMinutes;
  if (pause !== null && (!Number.isInteger(pause) || pause < 0 || pause > MAX_FLIP_PAUSE_MINUTES)) {
    throw new RangeError(`The flip pause is a whole number of minutes from 0 to ${MAX_FLIP_PAUSE_MINUTES}`);
  }
  stmts.upsert.run(profileId, rig.sensorType, JSON.stringify(filters), mount, pause, new Date().toISOString());
  return { sensorType: rig.sensorType, filters, mount, flipPauseMinutes: pause };
}

/**
 * Filter names this telescope has really shot through, most used first,
 * normalised like the library's own filter rows so a goal set on one lands on
 * the other. Read from the sidecar record of each session; empty for a
 * telescope with nothing imported yet.
 */
export function getUsedFilterNames(profileId: string, limit = 6): string[] {
  const aliases = getFilterAliasMap();
  const counts = new Map<string, number>();
  for (const { filter, n } of stmts.usedFilters.all(profileId)) {
    const name = normalizeFilterName(filter, aliases);
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + n);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([name]) => name);
}
