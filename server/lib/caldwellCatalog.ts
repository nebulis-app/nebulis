/**
 * Caldwell catalog: maps Caldwell C-numbers to their NGC/IC catalog IDs.
 *
 * Derived from the C-number designations on the records in
 * server/data/dso-catalog.json (checked against the Wikipedia Caldwell list by
 * tests/backend/dsoCatalogIntegrity.test.ts), not a second hand-kept table.
 *
 * C9 (Cave Nebula, Sh2-155), C41 (Hyades) and C99 (Coalsack) have no NGC/IC
 * designation, so they are absent here; their records carry the C-number.
 */
import { CALDWELL_NGC } from './dsoCatalogData.js';

/** Maps Caldwell number (1–109) → primary catalog ID string, e.g. "NGC4449". */
export const CALDWELL_TO_NGC: Readonly<Record<number, string>> = CALDWELL_NGC;

/**
 * Coordinates for Caldwell objects that have no NGC/IC designation and therefore
 * no entry in the DSO catalog. Used as a fallback when the image route needs
 * RA/Dec to query DSS2 for an on-demand sky plate.
 *
 * ra is in hours (× 15 → degrees), dec is in degrees.
 * majorAxisArcmin gives the approximate angular extent for FOV selection.
 */
export const CALDWELL_FALLBACK_COORDS: Record<number, { ra: number; dec: number; majorAxisArcmin: number }> = {
  // C99 = Coalsack dark nebula — ~7° across, no NGC designation.
  // RA 12h 52m, Dec -63° 18'.  DSS2 at 3° FOV (capped max) shows the dark patch well.
  99: { ra: 12.873, dec: -63.3, majorAxisArcmin: 420 },
};

/**
 * Given an ID like "C21", return the canonical NGC/IC id ("NGC4449"), or null
 * if this isn't a recognized Caldwell designation.
 */
export function caldwellToNgcId(id: string): string | null {
  const m = id.match(/^C(\d{1,3})$/i);
  if (!m) return null;
  const num = parseInt(m[1], 10);
  return CALDWELL_TO_NGC[num] ?? null;
}

/**
 * Reverse lookup: given a canonical NGC/IC id, return its Caldwell number
 * (1–109), or null if the object is not in the Caldwell catalog.
 */
export function ngcToCaldwell(ngcId: string): number | null {
  const upper = ngcId.toUpperCase();
  for (const [num, id] of Object.entries(CALDWELL_TO_NGC)) {
    if (id === upper) return parseInt(num, 10);
  }
  return null;
}
