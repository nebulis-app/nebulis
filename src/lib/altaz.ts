/**
 * Client-side spherical-trig alt/az computation for fixed objects.
 * Ported from server/lib/astroCalc.ts — units and formulas must match
 * exactly so the chart agrees with the planner's stored altitudes.
 *
 * Pure functions, no dependencies.
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** Greenwich Mean Sidereal Time in decimal hours (USNO/IERS formula). */
function gmstHours(date: Date): number {
  const JD = date.getTime() / 86400000 + 2440587.5;
  const T = (JD - 2451545.0) / 36525;
  const gmstDeg =
    280.46061837 +
    360.98564736629 * (JD - 2451545.0) +
    0.000387933 * T * T -
    (T * T * T) / 38710000;
  return (((gmstDeg % 360) + 360) % 360) / 15;
}

/** Local Sidereal Time in decimal hours (east longitude positive). */
function lstHours(date: Date, lon: number): number {
  return (gmstHours(date) + lon / 15 + 24) % 24;
}

interface AltAz {
  /** Altitude in degrees, -90 to +90 */
  alt: number;
  /** Azimuth in degrees, 0=N, 90=E, 180=S, 270=W */
  az: number;
}

/**
 * Compute altitude and azimuth of a fixed object for a given observer and time.
 *
 * @param ra  Right ascension in decimal **hours** (0–24)
 * @param dec Declination in decimal degrees (-90 to +90)
 * @param lat Observer latitude in decimal degrees
 * @param lon Observer longitude in decimal degrees (east positive)
 * @param date Timestamp (any Date; UTC used internally)
 */
export function altAz(ra: number, dec: number, lat: number, lon: number, date: Date): AltAz {
  const lst = lstHours(date, lon);
  const ha = (lst - ra + 24) % 24;
  const haRad = ha * 15 * DEG;
  const decRad = dec * DEG;
  const latRad = lat * DEG;

  const sinAlt =
    Math.sin(decRad) * Math.sin(latRad) +
    Math.cos(decRad) * Math.cos(latRad) * Math.cos(haRad);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt))) * RAD;

  const cosAlt = Math.cos(alt * DEG);
  let az = 0;
  if (cosAlt > 1e-10) {
    const cosAz = (Math.sin(decRad) - Math.sin(latRad) * sinAlt) / (Math.cos(latRad) * cosAlt);
    az = Math.acos(Math.max(-1, Math.min(1, cosAz))) * RAD;
    if (Math.sin(haRad) > 0) az = 360 - az;
  }

  return { alt, az };
}

interface CurveSample {
  time: Date;
  alt: number;
  az: number;
}

/**
 * Sample altitude/azimuth across a time window at a fixed cadence.
 *
 * @param stepMinutes Sample spacing. 15 minutes is a good default for
 *                    smooth rendering across a 24h window (96 samples).
 */
export function computeAltitudeCurve(
  ra: number,
  dec: number,
  lat: number,
  lon: number,
  start: Date,
  end: Date,
  stepMinutes = 15,
): CurveSample[] {
  const samples: CurveSample[] = [];
  const stepMs = stepMinutes * 60 * 1000;
  for (let t = start.getTime(); t <= end.getTime(); t += stepMs) {
    const d = new Date(t);
    const { alt, az } = altAz(ra, dec, lat, lon, d);
    samples.push({ time: d, alt, az });
  }
  return samples;
}

/**
 * Build the "tonight" 24h window: the most recent past (or current) local noon
 * through the following local noon. Always contains "now".
 *
 * When `timeZone` (an IANA zone) is given, "noon" means noon in that zone, so a
 * chart with fixed noon-anchored hour ticks stays correct for an observer whose
 * configured location differs from the viewing device's clock. Without it, the
 * window is anchored to the device's local noon (DST-safe via setDate).
 */
export function buildTonightWindow(now: Date = new Date(), timeZone?: string): { start: Date; end: Date } {
  if (!timeZone) {
    const start = new Date(now);
    start.setHours(12, 0, 0, 0);
    if (now.getTime() < start.getTime()) {
      start.setDate(start.getDate() - 1);
    }
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start, end };
  }

  const p = zonedParts(now, timeZone);
  // Before local noon, the current noon-to-noon window opened yesterday.
  const [sy, sm, sd] = p.hour < 12 ? shiftYmd(p.year, p.month, p.day, -1) : [p.year, p.month, p.day];
  const [ey, em, ed] = shiftYmd(sy, sm, sd, 1);
  return {
    start: wallTimeToUtc(sy, sm, sd, 12, timeZone),
    end: wallTimeToUtc(ey, em, ed, 12, timeZone),
  };
}

/** Calendar Y/M/D parts of an instant evaluated in `timeZone`. */
function zonedParts(d: Date, timeZone: string): { year: number; month: number; day: number; hour: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(d);
    const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);
    return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') };
  } catch {
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours() };
  }
}

/** Shift a Y/M/D triple by whole days, normalizing month/year rollover. */
function shiftYmd(year: number, month: number, day: number, days: number): [number, number, number] {
  const u = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return [u.getUTCFullYear(), u.getUTCMonth() + 1, u.getUTCDate()];
}

/** UTC instant for a wall-clock time interpreted in `timeZone`. Solves the
 *  zone offset (incl. DST) by iterative refinement, matching the server's
 *  zonedDateTimeToUtc. */
function wallTimeToUtc(year: number, month: number, day: number, hour: number, timeZone: string): Date {
  const targetWall = Date.UTC(year, month - 1, day, hour, 0, 0);
  let utcMs = targetWall;
  for (let i = 0; i < 4; i++) {
    let actualWall: number;
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(new Date(utcMs));
      const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);
      actualWall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    } catch {
      return new Date(targetWall);
    }
    const delta = targetWall - actualWall;
    if (delta === 0) break;
    utcMs += delta;
  }
  return new Date(utcMs);
}
