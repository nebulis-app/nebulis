/**
 * Comet and asteroid positions from JPL Horizons (https://ssd.jpl.nasa.gov/horizons/), for the planner.
 *
 * Comets are not in any deep-sky catalog and they move, so the planner can only suggest one with an ephemeris: where
 * it is, hour by hour, from the observing site, and how bright it is predicted to be. Horizons gives all of it in one
 * request per object (RA/Dec, azimuth/elevation from the site, magnitude).
 *
 * A third-party service, so: off until switched on (Settings), asked once per object, day and site and kept, a short
 * timeout, and a pause after a failure. Positions are astrometric J2000 (ICRF), the frame of the planner's catalog.
 *
 * What the service does that the parser has to know (seen on 2026-11-26):
 *  - an unknown designation is still HTTP 200, with "No matches found" and no ephemeris block;
 *  - a comet's magnitude column is `T-mag` (total), an asteroid's is `APmag`;
 *  - a magnitude Horizons cannot predict is `n.a.`.
 */
import db from './db.js';

export const HORIZONS_URL = 'https://ssd.jpl.nasa.gov/api/horizons.api';
const TIMEOUT_MS = 30_000;
const BACKOFF_MS = 10 * 60_000;
const USER_AGENT = 'Nebulis (https://nebulis.app)';
/** Bumped when what is stored changes, so older answers are asked again. */
const CACHE_VERSION = 1;
/** Nights the planner looks ahead for a comet's windows. */
export const EPHEMERIS_DAYS = 15;

export type SmallBodyKind = 'comet' | 'asteroid';

export class HorizonsError extends Error {
  constructor(message: string, readonly code: 'not-found' | 'unavailable' = 'unavailable') {
    super(message);
    this.name = 'HorizonsError';
  }
}

/** One hourly position from the site. */
export interface EphemerisRow {
  /** ISO instant, UTC. */
  t: string;
  /** Right ascension in decimal hours, J2000. */
  ra: number;
  /** Declination in degrees, J2000. */
  dec: number;
  /** Azimuth and elevation from the site, degrees (refraction included). */
  az: number;
  alt: number;
  /** Predicted magnitude (total for a comet, apparent for an asteroid), or null when Horizons has none. */
  mag: number | null;
}

/** How Horizons is told which body: a comet by designation (latest apparition, no fragments), an asteroid by number or name. */
export function horizonsCommand(designation: string, kind: SmallBodyKind): string {
  const d = designation.trim();
  return kind === 'comet' ? `'DES=${d};CAP;NOFRAG'` : `'${d};'`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function horizonsTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function horizonsQueryUrl(
  designation: string,
  kind: SmallBodyKind,
  site: { latitude: number; longitude: number; elevationM?: number | null },
  start: Date,
  stop: Date,
): string {
  const params = new URLSearchParams({
    format: 'json',
    COMMAND: horizonsCommand(designation, kind),
    OBJ_DATA: "'NO'",
    MAKE_EPHEM: "'YES'",
    EPHEM_TYPE: "'OBSERVER'",
    CENTER: "'coord@399'",
    COORD_TYPE: "'GEODETIC'",
    // East longitude, latitude, altitude in km.
    SITE_COORD: `'${site.longitude.toFixed(4)},${site.latitude.toFixed(4)},${((site.elevationM ?? 0) / 1000).toFixed(3)}'`,
    START_TIME: `'${horizonsTime(start)}'`,
    STOP_TIME: `'${horizonsTime(stop)}'`,
    STEP_SIZE: "'1 h'",
    // 1: astrometric RA/Dec, 4: apparent azimuth/elevation, 9: magnitude.
    QUANTITIES: "'1,4,9'",
    ANG_FORMAT: "'DEG'",
    CSV_FORMAT: "'YES'",
  });
  return `${HORIZONS_URL}?${params.toString()}`;
}

/** "2024-Oct-14 18:00" (UTC) as a Date. */
function parseHorizonsDate(text: string): Date | null {
  const m = /^(\d{4})-([A-Z][a-z]{2})-(\d{2}) (\d{2}):(\d{2})/.exec(text.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]);
  if (month < 0) return null;
  return new Date(Date.UTC(Number(m[1]), month, Number(m[3]), Number(m[4]), Number(m[5])));
}

const num = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const v = Number.parseFloat(s.trim());
  return Number.isFinite(v) ? v : null;
};

/** The ephemeris in a Horizons JSON answer. Throws HorizonsError when there is none. */
export function parseHorizonsResponse(body: unknown): EphemerisRow[] {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  if (typeof record.error === 'string') throw new HorizonsError(`Horizons: ${record.error.split('\n')[0]}`);
  const result = typeof record.result === 'string' ? record.result : '';
  const soe = result.indexOf('$$SOE');
  const eoe = result.indexOf('$$EOE');
  if (soe < 0 || eoe < soe) {
    if (/No matches found/i.test(result)) throw new HorizonsError('Horizons knows no body by that designation', 'not-found');
    if (/Multiple major-bodies match|matching small-bodies/i.test(result) && /Record #|Primary Desig/i.test(result)) {
      throw new HorizonsError('Horizons matched several bodies; use a number or a full designation', 'not-found');
    }
    throw new HorizonsError('Horizons answered without an ephemeris');
  }
  // The column header is the last line starting "Date__" before the data.
  const headerStart = result.lastIndexOf('Date__', soe);
  const header = result.slice(headerStart, result.indexOf('\n', headerStart)).split(',').map(c => c.trim());
  const col = (re: RegExp) => header.findIndex(c => re.test(c));
  const iRa = col(/^R\.A\./);
  const iDec = col(/^DEC/);
  const iAz = col(/^Azi/);
  const iAlt = col(/^Elev/);
  const iMag = col(/^(T-mag|APmag)$/);
  if ([iRa, iDec, iAz, iAlt].some(i => i < 0)) throw new HorizonsError('Horizons answered in an unexpected layout');

  const rows: EphemerisRow[] = [];
  for (const line of result.slice(soe + 5, eoe).split('\n')) {
    if (!line.trim()) continue;
    const cells = line.split(',');
    const t = parseHorizonsDate(cells[0] ?? '');
    const raDeg = num(cells[iRa]);
    const dec = num(cells[iDec]);
    const az = num(cells[iAz]);
    const alt = num(cells[iAlt]);
    if (!t || raDeg === null || dec === null || az === null || alt === null) continue;
    rows.push({ t: t.toISOString(), ra: raDeg / 15, dec, az, alt, mag: iMag >= 0 ? num(cells[iMag]) : null });
  }
  if (rows.length === 0) throw new HorizonsError('Horizons answered without an ephemeris');
  return rows;
}

export type HorizonsFetch = (url: string) => Promise<unknown>;

let backoffUntil = 0;

export const fetchHorizons: HorizonsFetch = async url => {
  if (Date.now() < backoffUntil) throw new HorizonsError('JPL Horizons is resting after a failure; try again in a few minutes');
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new HorizonsError(`JPL Horizons answered HTTP ${res.status}`);
    return (await res.json()) as unknown;
  } catch (err) {
    backoffUntil = Date.now() + BACKOFF_MS;
    throw err instanceof HorizonsError ? err : new HorizonsError(`JPL Horizons could not be reached: ${err instanceof Error ? err.message : String(err)}`);
  }
};

// ─── Kept answers ────────────────────────────────────────────────────────────

db.exec(`CREATE TABLE IF NOT EXISTS ephemerisCache (
  key       TEXT PRIMARY KEY,
  version   INTEGER NOT NULL,
  rowsJson  TEXT NOT NULL,
  fetchedAt TEXT NOT NULL
)`);
const getCached = db.prepare<[string], { version: number; rowsJson: string }>('SELECT version, rowsJson FROM ephemerisCache WHERE key = ?');
const putCached = db.prepare<[string, number, string, string]>(
  `INSERT INTO ephemerisCache (key, version, rowsJson, fetchedAt) VALUES (?, ?, ?, ?)
   ON CONFLICT(key) DO UPDATE SET version = excluded.version, rowsJson = excluded.rowsJson, fetchedAt = excluded.fetchedAt`,
);
/** Kept answers older than this are dropped when a new one is written. */
const pruneOld = db.prepare<[string]>('DELETE FROM ephemerisCache WHERE fetchedAt < ?');

const inFlight = new Map<string, Promise<EphemerisRow[]>>();

/**
 * The ephemeris of a body from the site, hourly, from `from` (the site's noon before the first night, floored to the
 * hour) for EPHEMERIS_DAYS days. Asked once per body, day and site (rounded to 0.1°, a few km), kept, and shared
 * between concurrent asks. Failures are not kept.
 */
export async function ephemerisFor(
  designation: string,
  kind: SmallBodyKind,
  site: { latitude: number; longitude: number; elevationM?: number | null },
  from: Date,
  fetcher: HorizonsFetch = fetchHorizons,
): Promise<EphemerisRow[]> {
  const start = new Date(Math.floor(from.getTime() / 3_600_000) * 3_600_000);
  const key = `${kind}|${designation}|${start.getTime()}|${site.latitude.toFixed(1)}|${site.longitude.toFixed(1)}`;
  const hit = getCached.get(key);
  if (hit && hit.version === CACHE_VERSION) {
    try {
      const rows: unknown = JSON.parse(hit.rowsJson);
      if (Array.isArray(rows)) return rows as EphemerisRow[];
    } catch { /* asked again below */ }
  }
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = (async () => {
    const stop = new Date(start.getTime() + EPHEMERIS_DAYS * 86_400_000);
    const rows = parseHorizonsResponse(await fetcher(horizonsQueryUrl(designation, kind, site, start, stop)));
    const now = new Date();
    putCached.run(key, CACHE_VERSION, JSON.stringify(rows), now.toISOString());
    pruneOld.run(new Date(now.getTime() - 30 * 86_400_000).toISOString());
    return rows;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

/** Position at an instant, linearly between the two hourly rows around it; null outside the rows. */
export function positionAt(rows: EphemerisRow[], at: Date): { ra: number; dec: number } | null {
  const t = at.getTime();
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = new Date(rows[i].t).getTime();
    const b = new Date(rows[i + 1].t).getTime();
    if (t < a || t > b) continue;
    const f = b === a ? 0 : (t - a) / (b - a);
    let dRa = rows[i + 1].ra - rows[i].ra;
    if (dRa > 12) dRa -= 24;
    if (dRa < -12) dRa += 24;
    return { ra: (rows[i].ra + f * dRa + 24) % 24, dec: rows[i].dec + f * (rows[i + 1].dec - rows[i].dec) };
  }
  return null;
}

export function _resetHorizonsForTests(): void {
  backoffUntil = 0;
  inFlight.clear();
}
