/**
 * Comets and bright asteroids in the planner.
 *
 * Which bodies: the ones the user added (by designation, number or name), plus every comet already in the library,
 * found by its folder name (movingObject.ts), so a comet once imaged can be planned again without typing anything.
 *
 * For each body, its ephemeris from JPL Horizons (horizons.ts) gives, night by night over the next EPHEMERIS_DAYS
 * nights, how high it gets inside the site's imaging window, when, how bright it should be, and how close the Moon
 * is then. Tonight's night also makes it a planner target like any other, positioned where it will be at its best
 * time; a block placed at another time takes the position at that time (the client reads the hourly rows).
 */
import SunCalc from 'suncalc';
import db from './db.js';
import { checkMoonProximity, type MoonVerdict } from './moonProximity.js';
import { cometKey, looksLikeComet } from './library/movingObject.js';
import type { EphemerisRow, SmallBodyKind } from './horizons.js';

export interface SmallBody {
  /** What Horizons is asked for: "C/2023 A3", "12P", "4", "Vesta". */
  designation: string;
  kind: SmallBodyKind;
  /** The name shown, as the user typed it or the library folder holds it. */
  label: string;
  source: 'watchlist' | 'library';
  /** The library object for a comet already imaged, else null. */
  libraryObjectId: string | null;
}

db.exec(`CREATE TABLE IF NOT EXISTS smallBodyWatchlist (
  kind        TEXT NOT NULL CHECK (kind IN ('comet', 'asteroid')),
  designation TEXT NOT NULL,
  label       TEXT NOT NULL,
  addedAt     TEXT NOT NULL,
  PRIMARY KEY (kind, designation)
)`);

const stmts = {
  list: db.prepare<[], { kind: SmallBodyKind; designation: string; label: string }>(
    'SELECT kind, designation, label FROM smallBodyWatchlist ORDER BY addedAt',
  ),
  insert: db.prepare<[string, string, string, string]>(
    'INSERT OR IGNORE INTO smallBodyWatchlist (kind, designation, label, addedAt) VALUES (?, ?, ?, ?)',
  ),
  remove: db.prepare<[string, string]>('DELETE FROM smallBodyWatchlist WHERE kind = ? AND designation = ?'),
  libraryObjects: db.prepare<[], { objectId: string; objectName: string | null; objectType: string | null }>(
    'SELECT objectId, objectName, objectType FROM libraryObjects WHERE deleted = 0',
  ),
};

export class SmallBodyInputError extends Error {}

export const MAX_WATCHLIST = 30;

/**
 * What the user typed, as a body to ask Horizons about: a comet designation ("C/2023 A3", "12P/Pons-Brooks",
 * "c2023a3"), an asteroid number ("4", "(4) Vesta" keeps the number) or an asteroid name ("Vesta").
 */
export function parseSmallBodyInput(input: string): { designation: string; kind: SmallBodyKind; label: string } {
  const label = input.trim().replace(/\s+/g, ' ');
  if (!label || label.length > 80) throw new SmallBodyInputError('Give a comet designation, an asteroid number or an asteroid name');
  const comet = cometKey(label);
  if (comet) return { designation: comet, kind: 'comet', label };
  const numbered = /^\(?(\d{1,7})\)?(?:\s+[A-Za-z].*)?$/.exec(label);
  if (numbered) return { designation: String(Number(numbered[1])), kind: 'asteroid', label };
  if (/^[A-Za-z][A-Za-z' -]{1,40}$/.test(label)) return { designation: label, kind: 'asteroid', label };
  throw new SmallBodyInputError('Give a comet designation, an asteroid number or an asteroid name');
}

export function addToWatchlist(input: string): SmallBody {
  const body = parseSmallBodyInput(input);
  if (stmts.list.all().length >= MAX_WATCHLIST) throw new SmallBodyInputError(`At most ${MAX_WATCHLIST} comets and asteroids`);
  stmts.insert.run(body.kind, body.designation, body.label, new Date().toISOString());
  return { ...body, source: 'watchlist', libraryObjectId: null };
}

export function removeFromWatchlist(kind: SmallBodyKind, designation: string): boolean {
  return stmts.remove.run(kind, designation).changes > 0;
}

/** The watchlist, then the library's comets not already on it. */
export function listSmallBodies(): SmallBody[] {
  const out: SmallBody[] = stmts.list.all().map(r => ({ ...r, source: 'watchlist' as const, libraryObjectId: null }));
  const seen = new Map(out.map(b => [`${b.kind}|${b.designation}`, b]));
  for (const o of stmts.libraryObjects.all()) {
    if (o.objectType !== 'Comet' && !looksLikeComet(o.objectId)) continue;
    const designation = cometKey(o.objectId) ?? (o.objectName ? cometKey(o.objectName) : null);
    if (!designation) continue;
    const already = seen.get(`comet|${designation}`);
    if (already) {
      already.libraryObjectId ??= o.objectId;
      continue;
    }
    const body: SmallBody = { designation, kind: 'comet', label: o.objectName || o.objectId, source: 'library', libraryObjectId: o.objectId };
    seen.set(`comet|${designation}`, body);
    out.push(body);
  }
  return out;
}

export interface BodyNight {
  /** The imaging window of that night. */
  start: string;
  end: string;
  /** Highest elevation inside the window (refraction included), and when. Null when no row falls in the window. */
  maxAlt: number | null;
  bestTime: string | null;
  /** Predicted magnitude at the best time. */
  magnitude: number | null;
  /** Position at the best time, RA in hours. */
  ra: number | null;
  dec: number | null;
  moonIllumination: number;
  /** The Moon check for an hour either side of the best time, judged broadband (a comet is shot broadband). */
  moonVerdict: MoonVerdict | null;
  /** High enough for the site's floor. */
  observable: boolean;
}

/** How a body does each night: the rows inside each imaging window, its best hour, and the Moon then. */
export function bodyNights(
  rows: EphemerisRow[],
  windows: { start: Date; end: Date }[],
  site: { latitude: number; longitude: number },
  minAlt: number,
): BodyNight[] {
  return windows.map(w => {
    const inside = rows.filter(r => {
      const t = new Date(r.t).getTime();
      return t >= w.start.getTime() && t <= w.end.getTime();
    });
    const best = inside.reduce<EphemerisRow | null>((b, r) => (!b || r.alt > b.alt ? r : b), null);
    const middle = new Date((w.start.getTime() + w.end.getTime()) / 2);
    const moonIllumination = Math.round(SunCalc.getMoonIllumination(middle).fraction * 100);
    let moonVerdict: MoonVerdict | null = null;
    if (best && best.alt > 0) {
      const at = new Date(best.t).getTime();
      moonVerdict = checkMoonProximity(
        best.ra, best.dec, site.latitude, site.longitude,
        new Date(Math.max(w.start.getTime(), at - 3_600_000)), new Date(Math.min(w.end.getTime(), at + 3_600_000)),
        moonIllumination, 5, undefined, 'broadband',
      ).verdict;
    }
    return {
      start: w.start.toISOString(),
      end: w.end.toISOString(),
      maxAlt: best ? Math.round(best.alt * 10) / 10 : null,
      bestTime: best?.t ?? null,
      magnitude: best?.mag ?? null,
      ra: best?.ra ?? null,
      dec: best?.dec ?? null,
      moonIllumination,
      moonVerdict,
      observable: best != null && best.alt >= minAlt,
    };
  });
}

/** When it rises above and sets below the floor during a window, from the hourly rows (to the hour). */
export function aboveFloor(rows: EphemerisRow[], window: { start: Date; end: Date }, minAlt: number): { risesAt: string | null; setsAt: string | null } {
  const inside = rows.filter(r => {
    const t = new Date(r.t).getTime();
    return t >= window.start.getTime() && t <= window.end.getTime();
  });
  const up = inside.filter(r => r.alt >= minAlt);
  if (up.length === 0) return { risesAt: null, setsAt: null };
  return { risesAt: up[0].t, setsAt: up[up.length - 1].t };
}
