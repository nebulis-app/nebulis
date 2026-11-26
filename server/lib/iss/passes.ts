/**
 * ISS passes over an observing site, from a TLE (SGP4, satellite.js).
 *
 * A pass is the stretch the station spends above a floor (10° by default: lower is lost in haze and trees). Inside it,
 * the part you can see is where two things hold at once: the sky is dark enough (the Sun more than 6° below the
 * horizon, civil twilight over) and the station is still in sunlight, which it is for a while after dark because it is
 * 400 km up. A pass seen after dusk often ends before it sets: the station runs into Earth's shadow and fades out
 * overhead (`endsInShadow`).
 *
 * Times are found by bisection to a tenth of a second, so the precision is the TLE's, not the search's. The tests hold
 * the rise, peak and set times to a Skyfield computation of the same TLE (tests/fixtures/iss).
 *
 * Elevations are geometric (no refraction), like Skyfield's and Heavens-Above's tables.
 */
import * as satellite from 'satellite.js';
import SunCalc from 'suncalc';
import { isRecord } from '../typeGuards.js';

export const ISS_NORAD_ID = 25544;
/** Default floor for a pass, degrees. */
export const DEFAULT_MIN_ALTITUDE = 10;
/** The sky is dark enough to see the station once the Sun is this far below the horizon. */
export const SUN_DARK_ENOUGH_DEG = -6;
/** The ISS standard magnitude: at 1000 km and half lit (McCants' convention). */
const ISS_STANDARD_MAGNITUDE = -1.8;
const EARTH_RADIUS_KM = 6378.137;
const AU_KM = 149_597_870.7;
/** Coarse search step: a pass above 10° lasts at least a minute, so 20 s never steps over one. */
const SCAN_STEP_MS = 20_000;
/** Precision of every boundary. */
const TOLERANCE_MS = 100;

export interface PassPoint {
  /** ISO instant, UTC. */
  t: string;
  /** Degrees from north, through east. */
  az: number;
  /** Degrees above the horizon (geometric). */
  alt: number;
}

export interface IssPass {
  /** Above the floor. */
  rise: PassPoint;
  peak: PassPoint;
  set: PassPoint;
  /** The part you can see (dark sky, station sunlit), or null for a pass in daylight or entirely in Earth's shadow. */
  visible: { start: PassPoint; end: PassPoint; peak: PassPoint } | null;
  /** Estimated magnitude at its brightest while visible (lower is brighter), or null when not visible. */
  magnitude: number | null;
  /** The visible part ends because the station enters Earth's shadow, not because it sets. */
  endsInShadow: boolean;
  /** The visible part starts because the station leaves Earth's shadow (a morning pass). */
  startsInShadow: boolean;
}

export interface PassSite {
  latitude: number;
  longitude: number;
  elevationM?: number | null;
}

type Vec3 = { x: number; y: number; z: number };

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const norm = (a: Vec3) => Math.sqrt(dot(a, a));

/**
 * The Sun's position in the equatorial frame of date, km (the Astronomical Almanac's low-precision formula: about
 * 0.01°, which moves a shadow entry by well under a second).
 */
export function sunPositionKm(date: Date): Vec3 {
  const n = date.getTime() / 86_400_000 + 2440587.5 - 2451545.0;
  const rad = Math.PI / 180;
  const L = (280.460 + 0.9856474 * n) * rad;
  const g = (357.528 + 0.9856003 * n) * rad;
  const lambda = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
  const epsilon = (23.439 - 0.0000004 * n) * rad;
  const r = (1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g)) * AU_KM;
  return {
    x: r * Math.cos(lambda),
    y: r * Math.cos(epsilon) * Math.sin(lambda),
    z: r * Math.sin(epsilon) * Math.sin(lambda),
  };
}

/** True when the line from the station to the Sun's centre clears the Earth (Skyfield's definition of sunlit). */
export function isSunlit(sat: Vec3, sun: Vec3): boolean {
  const d = sub(sun, sat);
  const len = norm(d);
  const u = { x: d.x / len, y: d.y / len, z: d.z / len };
  // Closest approach of the ray sat + s·u (s ≥ 0) to the Earth's centre.
  const s = -dot(sat, u);
  if (s <= 0) return true; // the Earth is behind the station as seen from the Sun's direction
  const closest = { x: sat.x + s * u.x, y: sat.y + s * u.y, z: sat.z + s * u.z };
  return norm(closest) > EARTH_RADIUS_KM;
}

/** Brightness from range and phase: a diffusely reflecting sphere, scaled to the standard magnitude. */
export function estimateMagnitude(rangeKm: number, phaseAngleRad: number): number {
  const phi = Math.min(Math.PI, Math.max(0, phaseAngleRad));
  const lit = Math.sin(phi) + (Math.PI - phi) * Math.cos(phi); // 1 at half lit, π fully lit
  return ISS_STANDARD_MAGNITUDE + 5 * Math.log10(rangeKm / 1000) - 2.5 * Math.log10(Math.max(lit, 1e-3));
}

interface Sample {
  az: number;
  alt: number;
  rangeKm: number;
  eci: Vec3;
}

function isVec3(v: unknown): v is Vec3 {
  return isRecord(v) && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number';
}

export class PassCalculator {
  private readonly satrec: satellite.SatRec;
  private readonly observerGd: satellite.GeodeticLocation;
  private readonly observerEcf: Vec3;

  constructor(line1: string, line2: string, private readonly site: PassSite) {
    this.satrec = satellite.twoline2satrec(line1.trim(), line2.trim());
    this.observerGd = {
      latitude: satellite.degreesToRadians(site.latitude),
      longitude: satellite.degreesToRadians(site.longitude),
      height: (site.elevationM ?? 0) / 1000,
    };
    this.observerEcf = satellite.geodeticToEcf(this.observerGd);
  }

  sample(t: number): Sample | null {
    const date = new Date(t);
    const posVel: unknown = satellite.propagate(this.satrec, date);
    if (!isRecord(posVel) || !isVec3(posVel.position)) return null;
    const eci = posVel.position;
    const gmst = satellite.gstime(date);
    const look = satellite.ecfToLookAngles(this.observerGd, satellite.eciToEcf(eci, gmst));
    return { az: satellite.radiansToDegrees(look.azimuth), alt: satellite.radiansToDegrees(look.elevation), rangeKm: look.rangeSat, eci };
  }

  private alt(t: number): number {
    return this.sample(t)?.alt ?? -90;
  }

  private point(t: number): PassPoint {
    const s = this.sample(t);
    return { t: new Date(Math.round(t / 100) * 100).toISOString(), az: s ? round2(((s.az % 360) + 360) % 360) : 0, alt: s ? round2(s.alt) : 0 };
  }

  /** Where between a (false) and b (true) a predicate turns true, to TOLERANCE_MS. */
  private static bisect(a: number, b: number, isTrueAt: (t: number) => boolean): number {
    let lo = a;
    let hi = b;
    while (hi - lo > TOLERANCE_MS) {
      const mid = (lo + hi) / 2;
      if (isTrueAt(mid)) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
  }

  /** The highest point between two instants (golden-section search; a pass has one maximum). */
  private peakBetween(a: number, b: number): number {
    const phi = (Math.sqrt(5) - 1) / 2;
    let lo = a;
    let hi = b;
    while (hi - lo > TOLERANCE_MS) {
      const m1 = hi - phi * (hi - lo);
      const m2 = lo + phi * (hi - lo);
      if (this.alt(m1) < this.alt(m2)) lo = m1; else hi = m2;
    }
    return (lo + hi) / 2;
  }

  /** Dark enough to see it, and the station lit. */
  visibleAt(t: number): boolean {
    const date = new Date(t);
    const sunAlt = SunCalc.getPosition(date, this.site.latitude, this.site.longitude).altitude * 180 / Math.PI;
    if (sunAlt >= SUN_DARK_ENOUGH_DEG) return false;
    const s = this.sample(t);
    return s != null && isSunlit(s.eci, sunPositionKm(date));
  }

  private magnitudeAt(t: number): number | null {
    const s = this.sample(t);
    if (!s) return null;
    const date = new Date(t);
    const gmst = satellite.gstime(date);
    const observerEci = satellite.ecfToEci(this.observerEcf, gmst);
    const toObserver = sub(observerEci, s.eci);
    const toSun = sub(sunPositionKm(date), s.eci);
    const cos = dot(toObserver, toSun) / (norm(toObserver) * norm(toSun));
    return round2(estimateMagnitude(s.rangeKm, Math.acos(Math.max(-1, Math.min(1, cos)))));
  }

  /** Every pass that rises above `minAlt` between two instants. A pass already up at `from` is left out. */
  passes(from: Date, to: Date, minAlt = DEFAULT_MIN_ALTITUDE): IssPass[] {
    const out: IssPass[] = [];
    const end = to.getTime();
    let t = from.getTime();
    let prevAbove = this.alt(t) >= minAlt;
    while (t < end) {
      const next = Math.min(t + SCAN_STEP_MS, end);
      const above = this.alt(next) >= minAlt;
      if (above && !prevAbove) {
        const rise = PassCalculator.bisect(t, next, x => this.alt(x) >= minAlt);
        // Walk to the set, then refine it.
        let u = next;
        while (u < end + 30 * 60_000 && this.alt(u) >= minAlt) u += SCAN_STEP_MS;
        const set = PassCalculator.bisect(u - SCAN_STEP_MS, u, x => this.alt(x) < minAlt);
        out.push(this.describe(rise, set));
        t = u;
        prevAbove = false;
        continue;
      }
      prevAbove = above;
      t = next;
    }
    return out;
  }

  private describe(rise: number, set: number): IssPass {
    const peak = this.peakBetween(rise, set);
    // The visible stretch: sample every 2 s, then refine each edge.
    const step = 2000;
    let first: number | null = null;
    let last: number | null = null;
    for (let x = rise; x <= set; x += step) {
      if (this.visibleAt(x)) {
        if (first === null) first = x;
        last = x;
      }
    }
    let visible: IssPass['visible'] = null;
    let magnitude: number | null = null;
    let endsInShadow = false;
    let startsInShadow = false;
    if (first !== null && last !== null) {
      const start = first > rise ? PassCalculator.bisect(first - step, first, x => this.visibleAt(x)) : rise;
      const stop = last < set ? PassCalculator.bisect(last, Math.min(last + step, set), x => !this.visibleAt(x)) : set;
      const visiblePeak = peak >= start && peak <= stop ? peak : (this.alt(start) >= this.alt(stop) ? start : stop);
      visible = { start: this.point(start), end: this.point(stop), peak: this.point(visiblePeak) };
      // Brightest while visible: the phase and range change along the pass, so look at a few points.
      const candidates = [start, stop, visiblePeak, (start + stop) / 2].map(x => this.magnitudeAt(x)).filter((m): m is number => m !== null);
      magnitude = candidates.length > 0 ? Math.min(...candidates) : null;
      const lit = (x: number) => { const s = this.sample(x); return s != null && isSunlit(s.eci, sunPositionKm(new Date(x))); };
      endsInShadow = stop < set - TOLERANCE_MS && !lit(stop + 1000);
      startsInShadow = start > rise + TOLERANCE_MS && !lit(start - 1000);
    }
    return { rise: this.point(rise), peak: this.point(peak), set: this.point(set), visible, magnitude, endsInShadow, startsInShadow };
  }
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** The TLE's epoch (line 1, columns 19-32: two-digit year and fractional day of year), UTC. */
export function tleEpoch(line1: string): Date | null {
  const m = /^1 .{16}(\d{2})(\d{3}\.\d+)/.exec(line1);
  if (!m) return null;
  const yy = Number(m[1]);
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  const day = Number(m[2]);
  return new Date(Date.UTC(year, 0, 1) + (day - 1) * 86_400_000);
}
