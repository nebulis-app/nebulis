/**
 * ISS transits of the Moon and the Sun near an observing site.
 *
 * Seen from somewhere on the ground, the station crosses the disc of the Moon or the Sun when the station and the
 * body's centre line up. Those places form a line on the ground, the centre line: where the line from the body's centre
 * through the station meets the Earth. It sweeps across the ground at several kilometres a second as the station moves,
 * and the transit can be seen within a band either side of it as wide as the body looks from the station's distance:
 * a few kilometres. So the useful answers are: when, where the centre line passes, how far and in which direction to
 * drive to stand on it, how long the transit lasts there (a second or two), and how old the orbital elements are,
 * because a day-old TLE can move the band by kilometres.
 *
 * The Moon's position comes from moon.ts (Meeus, a few arc seconds), the Sun's from passes.ts (0.01°), the station's
 * from SGP4. The tests hold the centre line, the time and the band to a Skyfield/DE421 computation.
 */
import * as satellite from 'satellite.js';
import { isRecord } from '../typeGuards.js';
import { moonPosition } from './moon.js';
import { sunPositionKm } from './passes.js';

export type TransitBody = 'moon' | 'sun';

const WGS84_A = 6378.137;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);
const MOON_RADIUS_KM = 1737.4;
const SUN_RADIUS_KM = 696_000;
const EARTH_MEAN_RADIUS_KM = 6371.0088;
/** Coarse search step: a transit lasts a second or two, but the alignment as seen from the site changes slowly enough. */
const COARSE_STEP_MS = 10_000;
/** Centre-line points kept for the map, this far apart in time. */
const LINE_STEP_MS = 500;

type Vec3 = { x: number; y: number; z: number };

export interface GroundPoint { lat: number; lon: number }

export interface IssTransit {
  body: TransitBody;
  /** The moment the centre line passes closest to the site, ISO UTC to the tenth of a second. */
  time: string;
  /** How long the station takes to cross the disc on the centre line, seconds. */
  durationSec: number;
  /** The centre line's closest point to the site, and how far and which way it is (degrees from north). */
  nearest: GroundPoint & { distanceKm: number; bearingDeg: number };
  /** Half the width of the band where the station is seen against the disc, km. */
  bandHalfWidthKm: number;
  /** The site itself is inside the band. */
  siteInBand: boolean;
  /** Where the body is in the sky from the centre-line point. */
  bodyAltitude: number;
  bodyAzimuth: number;
  /** Station to the centre-line point, km. */
  issRangeKm: number;
  /** Centre-line points around the site, every half second, for the map. */
  centerline: (GroundPoint & { t: string })[];
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: Vec3) => Math.sqrt(dot(a, a));
const RAD = Math.PI / 180;

/** Great-circle distance, km. */
export function distanceKm(a: GroundPoint, b: GroundPoint): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_MEAN_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees from north. */
export function bearingDeg(a: GroundPoint, b: GroundPoint): number {
  const y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD);
  const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lon - a.lon) * RAD);
  return ((Math.atan2(y, x) / RAD) + 360) % 360;
}

/** Earth-fixed (km) to geodetic latitude and longitude, degrees (Bowring's method, iterated). */
function ecfToGeodetic(p: Vec3): GroundPoint {
  const e2 = WGS84_F * (2 - WGS84_F);
  const r = Math.hypot(p.x, p.y);
  let lat = Math.atan2(p.z, r * (1 - e2));
  for (let i = 0; i < 5; i++) {
    const n = WGS84_A / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    lat = Math.atan2(p.z + e2 * n * Math.sin(lat), r);
  }
  return { lat: lat / RAD, lon: Math.atan2(p.y, p.x) / RAD };
}

/** Where a ray from `origin` along `dir` first meets the WGS84 ellipsoid (Earth-fixed, km), or null when it misses. */
function hitEllipsoid(origin: Vec3, dir: Vec3): Vec3 | null {
  const a2 = WGS84_A * WGS84_A;
  const b2 = WGS84_B * WGS84_B;
  const A = (dir.x * dir.x + dir.y * dir.y) / a2 + (dir.z * dir.z) / b2;
  const B = 2 * ((origin.x * dir.x + origin.y * dir.y) / a2 + (origin.z * dir.z) / b2);
  const C = (origin.x * origin.x + origin.y * origin.y) / a2 + (origin.z * origin.z) / b2 - 1;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  const k = (-B - Math.sqrt(disc)) / (2 * A);
  if (k < 0) return null;
  return { x: origin.x + k * dir.x, y: origin.y + k * dir.y, z: origin.z + k * dir.z };
}

function bodyEci(body: TransitBody, date: Date): Vec3 {
  return body === 'moon' ? moonPosition(date) : sunPositionKm(date);
}

function isVec3(v: unknown): v is Vec3 {
  return isRecord(v) && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number';
}

export class TransitFinder {
  private readonly satrec: satellite.SatRec;
  private readonly siteGd: satellite.GeodeticLocation;

  constructor(line1: string, line2: string, private readonly site: GroundPoint & { elevationM?: number | null }) {
    this.satrec = satellite.twoline2satrec(line1.trim(), line2.trim());
    this.siteGd = { latitude: site.lat * RAD, longitude: site.lon * RAD, height: (site.elevationM ?? 0) / 1000 };
  }

  private issEci(t: number): Vec3 | null {
    const pv: unknown = satellite.propagate(this.satrec, new Date(t));
    return isRecord(pv) && isVec3(pv.position) ? pv.position : null;
  }

  /** The centre-line point at an instant, or null when the line from the body through the station misses the Earth. */
  groundPoint(body: TransitBody, t: number): (GroundPoint & { ecf: Vec3; issEcf: Vec3 }) | null {
    const iss = this.issEci(t);
    if (!iss) return null;
    const date = new Date(t);
    const gmst = satellite.gstime(date);
    const issEcf = satellite.eciToEcf(iss, gmst);
    const bodyEcf = satellite.eciToEcf(bodyEci(body, date), gmst);
    const d = sub(issEcf, bodyEcf);
    const n = len(d);
    const hit = hitEllipsoid(issEcf, { x: d.x / n, y: d.y / n, z: d.z / n });
    if (!hit) return null;
    return { ...ecfToGeodetic(hit), ecf: hit, issEcf };
  }

  /** Angle between the station and the body as seen from the site, degrees (the coarse filter). */
  private separationFromSite(body: TransitBody, t: number): number | null {
    const iss = this.issEci(t);
    if (!iss) return null;
    const date = new Date(t);
    const gmst = satellite.gstime(date);
    const siteEcf = satellite.geodeticToEcf(this.siteGd);
    const toIss = sub(satellite.eciToEcf(iss, gmst), siteEcf);
    const toBody = sub(satellite.eciToEcf(bodyEci(body, date), gmst), siteEcf);
    // Both must be above the horizon from the site, roughly.
    const up = { x: siteEcf.x, y: siteEcf.y, z: siteEcf.z };
    if (dot(toIss, up) < 0 || dot(toBody, up) < 0) return null;
    const c = dot(toIss, toBody) / (len(toIss) * len(toBody));
    return Math.acos(Math.max(-1, Math.min(1, c))) / RAD;
  }

  /** Every transit whose centre line passes within `radiusKm` of the site between two instants. */
  find(body: TransitBody, from: Date, to: Date, radiusKm: number): IssTransit[] {
    const out: IssTransit[] = [];
    const end = to.getTime();
    // Seen from the site, the station is lined up with the body from anywhere within radiusKm when they are within
    // roughly atan(radius / range) plus the body's radius; 400 km is about the closest the station ever is.
    const coarseLimitDeg = Math.atan((radiusKm + 20) / 400) / RAD + 0.6;
    let t = from.getTime();
    while (t < end) {
      const sep = this.separationFromSite(body, t);
      if (sep === null || sep > coarseLimitDeg * 4) {
        t += COARSE_STEP_MS;
        continue;
      }
      // Near an alignment: follow the centre line closely through this stretch.
      const windowEnd = Math.min(t + 3 * 60_000, end);
      const found = this.refine(body, t - COARSE_STEP_MS, windowEnd, radiusKm);
      if (found && !out.some(o => Math.abs(Date.parse(o.time) - Date.parse(found.time)) < 60_000)) out.push(found);
      t = windowEnd;
    }
    return out;
  }

  private refine(body: TransitBody, a: number, b: number, radiusKm: number): IssTransit | null {
    // Closest approach of the centre line to the site, sampled at 0.2 s then narrowed (golden section) to 0.01 s.
    let best: { t: number; d: number } | null = null;
    for (let t = a; t <= b; t += 200) {
      const g = this.groundPoint(body, t);
      if (!g) continue;
      const d = distanceKm(this.site, g);
      if (!best || d < best.d) best = { t, d };
    }
    if (!best || best.d > radiusKm + 5) return null;
    const phi = (Math.sqrt(5) - 1) / 2;
    let lo = best.t - 200;
    let hi = best.t + 200;
    const dist = (t: number) => { const g = this.groundPoint(body, t); return g ? distanceKm(this.site, g) : Infinity; };
    while (hi - lo > 10) {
      const m1 = hi - phi * (hi - lo);
      const m2 = lo + phi * (hi - lo);
      if (dist(m1) < dist(m2)) hi = m2; else lo = m1;
    }
    const tc = (lo + hi) / 2;
    const g = this.groundPoint(body, tc);
    if (!g) return null;
    const d = distanceKm(this.site, g);
    if (d > radiusKm) return null;

    // The body as seen from the centre-line point: it has to be up.
    const date = new Date(tc);
    const gmst = satellite.gstime(date);
    const pointGd = { latitude: g.lat * RAD, longitude: g.lon * RAD, height: 0 };
    const bodyEcf = satellite.eciToEcf(bodyEci(body, date), gmst);
    const bodyLook = satellite.ecfToLookAngles(pointGd, bodyEcf);
    const bodyAltitude = bodyLook.elevation / RAD;
    if (bodyAltitude <= 0) return null;
    const issLook = satellite.ecfToLookAngles(pointGd, g.issEcf);
    const bodyDistance = len(sub(bodyEcf, g.ecf));
    const angularRadius = Math.asin((body === 'moon' ? MOON_RADIUS_KM : SUN_RADIUS_KM) / bodyDistance);
    // How fast the station crosses the sky from there, for the duration: its direction half a second later.
    const later = this.issEci(tc + 500);
    let durationSec = 0;
    if (later) {
      const issLater = satellite.eciToEcf(later, satellite.gstime(new Date(tc + 500)));
      const u = sub(g.issEcf, g.ecf);
      const v = sub(issLater, g.ecf);
      const rate = Math.acos(Math.max(-1, Math.min(1, dot(u, v) / (len(u) * len(v))))) / 0.5; // rad/s
      durationSec = rate > 0 ? (2 * angularRadius) / rate : 0;
    }
    const bandHalfWidthKm = issLook.rangeSat * Math.tan(angularRadius);

    const centerline: IssTransit['centerline'] = [];
    for (let t = tc - 60_000; t <= tc + 60_000; t += LINE_STEP_MS) {
      const p = this.groundPoint(body, t);
      if (p && distanceKm(this.site, p) <= radiusKm * 2 + 20) {
        centerline.push({ t: new Date(t).toISOString(), lat: round5(p.lat), lon: round5(p.lon) });
      }
    }
    return {
      body,
      time: new Date(Math.round(tc / 100) * 100).toISOString(),
      durationSec: Math.round(durationSec * 100) / 100,
      nearest: { lat: round5(g.lat), lon: round5(g.lon), distanceKm: Math.round(d * 1000) / 1000, bearingDeg: Math.round(bearingDeg(this.site, g)) },
      bandHalfWidthKm: Math.round(bandHalfWidthKm * 1000) / 1000,
      siteInBand: d <= bandHalfWidthKm,
      bodyAltitude: Math.round(bodyAltitude * 100) / 100,
      bodyAzimuth: Math.round(((bodyLook.azimuth / RAD) + 360) % 360 * 100) / 100,
      issRangeKm: Math.round(issLook.rangeSat * 10) / 10,
      centerline,
    };
  }
}

const round5 = (v: number) => Math.round(v * 1e5) / 1e5;
