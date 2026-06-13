/**
 * Basic astronomical calculations for the target planner.
 * Converts RA/Dec to altitude/azimuth and computes night windows.
 * No external library needed — pure spherical trig.
 */
import SunCalc from 'suncalc';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

function toRad(deg: number) { return deg * DEG; }
function toDeg(rad: number) { return rad * RAD; }

/**
 * Greenwich Mean Sidereal Time in decimal hours for a given UTC Date.
 * Formula from USNO/IERS.
 */
function gmstHours(date: Date): number {
  const JD = date.getTime() / 86400000 + 2440587.5;
  const T = (JD - 2451545.0) / 36525;
  // In degrees
  const gmstDeg =
    280.46061837 +
    360.98564736629 * (JD - 2451545.0) +
    0.000387933 * T * T -
    (T * T * T) / 38710000;
  return ((gmstDeg % 360) + 360) % 360 / 15;
}

/**
 * Local Sidereal Time in decimal hours.
 * @param lon Observer longitude in decimal degrees (east positive)
 */
function lstHours(date: Date, lon: number): number {
  return (gmstHours(date) + lon / 15 + 24) % 24;
}

export interface AltAz {
  alt: number;   // altitude in degrees (-90 to +90)
  az: number;    // azimuth in degrees (0=N, 90=E, 180=S, 270=W)
}

/**
 * Compute altitude and azimuth of a fixed object.
 * @param ra  RA in decimal hours
 * @param dec Dec in decimal degrees
 * @param lat Observer latitude in decimal degrees
 * @param lon Observer longitude in decimal degrees (east positive)
 * @param date UTC Date
 */
export function altAz(ra: number, dec: number, lat: number, lon: number, date: Date): AltAz {
  const lst = lstHours(date, lon);
  const ha = (lst - ra + 24) % 24;   // hour angle, 0–24 h
  const haRad = toRad(ha * 15);       // convert to degrees then radians
  const decRad = toRad(dec);
  const latRad = toRad(lat);

  const sinAlt = Math.sin(decRad) * Math.sin(latRad) + Math.cos(decRad) * Math.cos(latRad) * Math.cos(haRad);
  const alt = toDeg(Math.asin(Math.max(-1, Math.min(1, sinAlt))));

  const cosAlt = Math.cos(toRad(alt));
  let az = 0;
  if (cosAlt > 1e-10) {
    const cosAz = (Math.sin(decRad) - Math.sin(latRad) * sinAlt) / (Math.cos(latRad) * cosAlt);
    az = toDeg(Math.acos(Math.max(-1, Math.min(1, cosAz))));
    if (Math.sin(haRad) > 0) az = 360 - az;
  }

  return { alt, az };
}


export interface NightWindow {
  nauticalDawn: Date | null;
  astronomicalDawn: Date | null;
  nauticalDusk: Date | null;
  astronomicalDusk: Date | null;
  nightStart: Date | null;   // astronomical dusk
  nightEnd: Date | null;     // astronomical dawn
}

/**
 * Returns the astronomical night window for a given date and location.
 * Uses SunCalc (already in the project) for twilight times.
 *
 * SunCalc.getTimes(date) returns astronomical dawn (nightEnd) for the MORNING of `date`.
 * Tonight's dusk is the EVENING of `date`, and tonight's dawn is the MORNING of `date+1`.
 * So we query the next day for the correct dawn.
 */
export function getNightWindow(date: Date, lat: number, lon: number): NightWindow {
  const times = SunCalc.getTimes(date, lat, lon);
  const nextDay = new Date(date.getTime() + 86400000);
  const nextTimes = SunCalc.getTimes(nextDay, lat, lon);

  function validDate(d: unknown): Date | null {
    return d instanceof Date && !isNaN(d.getTime()) ? d : null;
  }

  return {
    nauticalDawn: validDate(nextTimes.nauticalDawn),
    astronomicalDawn: validDate(nextTimes.nightEnd),
    nauticalDusk: validDate(times.nauticalDusk),
    astronomicalDusk: validDate(times.night),
    nightStart: validDate(times.night),
    nightEnd: validDate(nextTimes.nightEnd),
  };
}

/**
 * Sample the altitude of an object at regular intervals throughout the night.
 * @param ra  RA in decimal hours
 * @param dec Dec in decimal degrees
 * @param lat Observer lat
 * @param lon Observer lon
 * @param nightStart astronomical dusk
 * @param nightEnd astronomical dawn (next day)
 * @param stepMinutes sampling interval
 */
export function altitudeCurve(
  ra: number,
  dec: number,
  lat: number,
  lon: number,
  nightStart: Date,
  nightEnd: Date,
  stepMinutes = 30
): Array<{ time: string; alt: number; az: number }> {
  const points: Array<{ time: string; alt: number; az: number }> = [];
  let t = nightStart.getTime();
  const end = nightEnd.getTime();
  while (t <= end) {
    const d = new Date(t);
    const { alt, az } = altAz(ra, dec, lat, lon, d);
    points.push({ time: d.toISOString(), alt: Math.round(alt * 10) / 10, az: Math.round(az * 10) / 10 });
    t += stepMinutes * 60000;
  }
  return points;
}

/**
 * Parse RA to decimal degrees. Accepts decimal degrees (number) or
 * sexagesimal string (e.g. "05h 34m 31.94s").
 */
export function raToDegs(ra: string | number): number {
  if (typeof ra === 'number') return ra;
  const m = ra.match(/(\d+)h\s*(\d+)m\s*([\d.]+)s/i);
  if (!m) return parseFloat(ra) || 0;
  const hours = parseFloat(m[1]) + parseFloat(m[2]) / 60 + parseFloat(m[3]) / 3600;
  return hours * 15; // 1h = 15°
}

/**
 * Parse Dec to decimal degrees. Accepts decimal degrees (number) or
 * sexagesimal string (e.g. "+22° 00′ 52.2″").
 */
export function decToDegs(dec: string | number): number {
  if (typeof dec === 'number') return dec;
  const m = dec.match(/([+-]?)(\d+)[°]\s*(\d+)[′']\s*([\d.]+)[″"]/);
  if (!m) return parseFloat(dec) || 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (parseFloat(m[2]) + parseFloat(m[3]) / 60 + parseFloat(m[4]) / 3600);
}

/**
 * Convert a SunCalc moon illumination phase fraction (0–1) to a human-readable name.
 */
export function moonPhaseName(phase: number): string {
  if (phase < 0.03 || phase > 0.97) return 'New Moon';
  if (phase < 0.22) return 'Waxing Crescent';
  if (phase < 0.28) return 'First Quarter';
  if (phase < 0.47) return 'Waxing Gibbous';
  if (phase < 0.53) return 'Full Moon';
  if (phase < 0.72) return 'Waning Gibbous';
  if (phase < 0.78) return 'Last Quarter';
  return 'Waning Crescent';
}

/**
 * Given an azimuth (degrees, 0=N clockwise) and a 36-element horizon profile
 * (one altitude value per 10° bucket), return the blocked altitude at that azimuth.
 */
function horizonAltAt(az: number, profile: number[]): number {
  const idx = Math.floor(((az % 360) + 360) % 360 / 10) % 36;
  return profile[idx] ?? 0;
}

/**
 * Find the window when an object is above minAlt (and above any horizon profile)
 * during the night. Returns maxAlt as the geometric peak regardless of obstructions.
 *
 * @param horizonProfile  Optional 36-element array: blocked altitude per 10° azimuth bucket (0°–350°)
 */
export function visibilityWindow(
  ra: number,
  dec: number,
  lat: number,
  lon: number,
  nightStart: Date,
  nightEnd: Date,
  minAlt = 20,
  horizonProfile?: number[]
): { rises: Date | null; sets: Date | null; maxAlt: number; maxAltTime: Date | null } {
  let rises: Date | null = null;
  let sets: Date | null = null;
  let maxAlt = -90;
  let maxAltTime: Date | null = null;
  let wasAbove = false;

  let t = nightStart.getTime();
  const end = nightEnd.getTime();
  const step = 5 * 60000; // 5-minute steps

  while (t <= end) {
    const d = new Date(t);
    const { alt, az } = altAz(ra, dec, lat, lon, d);

    // Track geometric peak regardless of obstructions
    if (alt > maxAlt) { maxAlt = alt; maxAltTime = d; }

    // Effective floor is the higher of global minAlt and the profile at this azimuth
    const floor = horizonProfile
      ? Math.max(minAlt, horizonAltAt(az, horizonProfile))
      : minAlt;

    if (alt >= floor && !wasAbove) { rises = d; wasAbove = true; }
    if (alt < floor && wasAbove) { sets = d; wasAbove = false; }
    t += step;
  }

  // Still above at end of night
  if (wasAbove && sets === null) sets = nightEnd;

  // Already above threshold for the entire night
  if (rises === null && maxAlt >= minAlt) rises = nightStart;

  return { rises, sets, maxAlt, maxAltTime };
}
