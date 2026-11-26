/**
 * Asteroids and comets in a picture, from IMCCE's SkyBoT cone search
 * (https://ssp.imcce.fr/webservices/skybot/): where every known solar-system body stood at the moment the picture
 * was taken. People find asteroids they captured without knowing.
 *
 * SkyBoT is a third-party service, so this is opt-in (Settings), runs only when the layer is turned on in the viewer,
 * never in a bulk or background pass, and its answer is kept per picture: the bodies a picture shows do not change.
 *
 * Two things the service does that the parser has to know:
 *  - an internal failure still answers HTTP 200, as `{ flag: -1, message }` (seen on 2026-11-26);
 *  - a field near the ecliptic holds dozens of bodies, most of them magnitude 22 to 25, far below an amateur
 *    picture: they are left out under `LIMIT_MAGNITUDE` and counted instead.
 *
 * The observer is the geocentre (`-observer=500`): SkyBoT takes an IAU observatory code, not a latitude and
 * longitude. That is exact enough for the main belt; a near-Earth asteroid can be off by its parallax.
 */
import db from '../db.js';
import { pixelScaleArcsec, pixelToSky, skyToPixel, type Wcs } from './wcs.js';
import type { FrameAnnotation } from './catalogQuery.js';

export const SKYBOT_URL = 'https://ssp.imcce.fr/webservices/skybot/api/conesearch.php';
/** Bodies fainter than this are left out of the picture's marks (and counted). */
export const LIMIT_MAGNITUDE = 20;
const TIMEOUT_MS = 20_000;
/** After a failure, the service is left alone this long, whatever picture asks. */
const BACKOFF_MS = 10 * 60_000;
const USER_AGENT = 'Nebulis (https://nebulis.app)';
const POINT_RING_FRACTION = 0.012;
/** Bumped when what is stored changes, so older answers are asked again. */
const CACHE_VERSION = 1;

export class SkybotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkybotError';
  }
}

/** One body as SkyBoT reports it. */
export interface SkybotBody {
  number: number | null;
  name: string;
  bodyClass: string;
  raDeg: number;
  decDeg: number;
  vmag: number | null;
  errorArcsec: number | null;
  motionArcsecPerHour: number | null;
  distanceAu: number | null;
  link: string | null;
}

/** `09 54 30.7951` hours, or `+16 21 28.033` / `-0 05 12.1` degrees, as decimal. */
export function sexagesimal(text: string): number | null {
  const m = /^\s*([+-])?\s*(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const value = Number(m[2]) + Number(m[3]) / 60 + Number(m[4]) / 3600;
  return m[1] === '-' ? -value : value;
}

/** JPL's Small-Body Database page, readable by people (SkyBoT's own links are JSON). */
export function jplLink(number: number | null, name: string): string {
  return `https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html#/?sstr=${encodeURIComponent(number !== null ? String(number) : name)}`;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** SkyBoT's JSON answer as bodies. Throws SkybotError when the service reported a failure. */
export function parseSkybotResponse(body: unknown): SkybotBody[] {
  if (!Array.isArray(body)) {
    const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    // No body in the field is an empty array; anything else that is not a list is the service failing.
    const message = typeof record.message === 'string' ? record.message.split('\n')[0].slice(0, 200) : 'unexpected answer';
    throw new SkybotError(`SkyBoT failed: ${message}`);
  }
  const bodies: SkybotBody[] = [];
  for (const entry of body) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.Name === 'string' ? e.Name : null;
    const ra = typeof e['RA (hms)'] === 'string' ? sexagesimal(e['RA (hms)']) : null;
    const dec = typeof e['DEC (dms)'] === 'string' ? sexagesimal(e['DEC (dms)']) : null;
    if (!name || ra === null || dec === null) continue;
    const dRa = num(e['dRA (arcsec/h)']);
    const dDec = num(e['dDEC (arcsec/h)']);
    bodies.push({
      number: num(e.Num),
      name,
      bodyClass: typeof e.Class === 'string' ? e.Class : '',
      raDeg: ra * 15,
      decDeg: dec,
      vmag: num(e['VMag (mag)']),
      errorArcsec: num(e['Err (arcsec)']),
      motionArcsecPerHour: dRa !== null && dDec !== null ? Math.hypot(dRa, dDec) : null,
      distanceAu: num(e['dg (ua)']),
      link: jplLink(num(e.Num), name),
    });
  }
  return bodies;
}

/** Days since noon UT on 1 January 4713 BC: 2440587.5 at the Unix epoch. */
export function julianDate(instant: Date): number {
  return instant.getTime() / 86_400_000 + 2440587.5;
}

/** The cone search for a moment and a circle of sky, every kind of body, JSON. */
export function skybotQueryUrl(epoch: Date, raDeg: number, decDeg: number, radiusDeg: number): string {
  const params = new URLSearchParams({
    // A Julian date: an instant, with no zone to get wrong (SkyBoT also takes ISO dates).
    '-ep': julianDate(epoch).toFixed(6),
    '-ra': raDeg.toFixed(5),
    '-dec': decDeg.toFixed(5),
    '-rd': Math.min(10, radiusDeg).toFixed(4),
    '-mime': 'json',
    '-output': 'basic',
    '-observer': '500',
    '-filter': '120',
    '-objFilter': '111',
    '-refsys': 'EQJ2000',
    '-from': 'Nebulis',
  });
  return `${SKYBOT_URL}?${params.toString()}`;
}

export type SkybotFetch = (url: string) => Promise<unknown>;

let backoffUntil = 0;

/** Asks SkyBoT, with a timeout and a pause after a failure. Throws SkybotError. */
export const fetchSkybot: SkybotFetch = async url => {
  if (Date.now() < backoffUntil) throw new SkybotError('SkyBoT is resting after a failure; try again in a few minutes');
  let lastError: SkybotError | null = null;
  // Its internal failures are intermittent: the same request answered normally on the next try every time it was
  // tried by hand, so one immediate second attempt before giving up.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new SkybotError(`SkyBoT answered HTTP ${res.status}`);
      const body: unknown = await res.json();
      parseSkybotResponse(body); // throws on a reported failure
      return body;
    } catch (err) {
      lastError = err instanceof SkybotError ? err : new SkybotError(`SkyBoT could not be reached: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  backoffUntil = Date.now() + BACKOFF_MS;
  throw lastError ?? new SkybotError('SkyBoT failed');
};

export interface SolarSystemMarks {
  annotations: FrameAnnotation[];
  /** Bodies in the field fainter than LIMIT_MAGNITUDE, left out. */
  fainter: number;
}

/** The bodies inside the picture, as rings of the `solarSystem` layer. */
export function solarSystemMarks(wcs: Wcs, bodies: SkybotBody[]): SolarSystemMarks {
  const { width, height } = wcs;
  const r = Math.max(width, height) * POINT_RING_FRACTION;
  let fainter = 0;
  const annotations: FrameAnnotation[] = [];
  for (const b of bodies) {
    const p = skyToPixel(wcs, b.raDeg, b.decDeg);
    if (!p || p.x < 0 || p.y < 0 || p.x > width || p.y > height) continue;
    if (b.vmag !== null && b.vmag > LIMIT_MAGNITUDE) {
      fainter++;
      continue;
    }
    annotations.push({
      id: `sso:${b.number ?? b.name}`,
      label: b.number !== null ? `(${b.number}) ${b.name}` : b.name,
      designation: null,
      typeCode: b.bodyClass,
      type: b.bodyClass,
      magnitude: b.vmag,
      x: p.x,
      y: p.y,
      r,
      rTrue: r,
      oversized: false,
      isTarget: false,
      layer: 'solarSystem',
      sso: {
        number: b.number,
        bodyClass: b.bodyClass,
        vmag: b.vmag,
        motionArcsecPerHour: b.motionArcsecPerHour,
        distanceAu: b.distanceAu,
        link: b.link,
      },
    });
  }
  annotations.sort((a, b) => (a.magnitude ?? 99) - (b.magnitude ?? 99));
  return { annotations, fainter };
}

/** The sky circle SkyBoT is asked about: the picture's centre and half-diagonal. */
export function fieldCone(wcs: Wcs): { raDeg: number; decDeg: number; radiusDeg: number } | null {
  const arcsecPerPx = pixelScaleArcsec(wcs);
  if (!(arcsecPerPx > 0)) return null;
  const centre = pixelToSky(wcs, wcs.width / 2, wcs.height / 2);
  return { raDeg: centre.raDeg, decDeg: centre.decDeg, radiusDeg: (Math.hypot(wcs.width, wcs.height) / 2) * arcsecPerPx / 3600 };
}

// ─── Kept answers ────────────────────────────────────────────────────────────

db.exec(`CREATE TABLE IF NOT EXISTS solarSystemCache (
  relPath   TEXT PRIMARY KEY,
  mtimeMs   REAL NOT NULL,
  epoch     TEXT NOT NULL,
  version   INTEGER NOT NULL,
  bodies    TEXT NOT NULL,
  fetchedAt TEXT NOT NULL
)`);
const getCached = db.prepare<[string], { mtimeMs: number; epoch: string; version: number; bodies: string }>(
  'SELECT mtimeMs, epoch, version, bodies FROM solarSystemCache WHERE relPath = ?',
);
const putCached = db.prepare<[string, number, string, number, string, string]>(
  `INSERT INTO solarSystemCache (relPath, mtimeMs, epoch, version, bodies, fetchedAt) VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(relPath) DO UPDATE SET mtimeMs = excluded.mtimeMs, epoch = excluded.epoch, version = excluded.version,
     bodies = excluded.bodies, fetchedAt = excluded.fetchedAt`,
);

const inFlight = new Map<string, Promise<SkybotBody[]>>();

/**
 * The bodies in a picture's field at its capture time: from the kept answer when the picture and its time are the
 * same, otherwise asked once (concurrent asks for the same picture share one request) and kept, empty answers too.
 */
export async function bodiesForPicture(
  relPath: string,
  mtimeMs: number,
  epoch: Date,
  cone: { raDeg: number; decDeg: number; radiusDeg: number },
  fetcher: SkybotFetch = fetchSkybot,
): Promise<SkybotBody[]> {
  const epochIso = epoch.toISOString();
  const hit = getCached.get(relPath);
  if (hit && hit.mtimeMs === mtimeMs && hit.epoch === epochIso && hit.version === CACHE_VERSION) {
    try {
      const stored: unknown = JSON.parse(hit.bodies);
      if (Array.isArray(stored)) return stored as SkybotBody[];
    } catch { /* asked again below */ }
  }
  const key = `${relPath}|${mtimeMs}|${epochIso}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = (async () => {
    const bodies = parseSkybotResponse(await fetcher(skybotQueryUrl(epoch, cone.raDeg, cone.decDeg, cone.radiusDeg)));
    putCached.run(relPath, mtimeMs, epochIso, CACHE_VERSION, JSON.stringify(bodies), new Date().toISOString());
    return bodies;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

/** Tests reset the pause after a failure. */
export function _resetSkybotForTests(): void {
  backoffUntil = 0;
  inFlight.clear();
}
