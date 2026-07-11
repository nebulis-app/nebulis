/**
 * Moon-proximity warning for scheduled imaging blocks.
 *
 * The threshold for "the moon is going to wreck this shot" depends on the
 * moon's illumination. A 10% crescent at 30° away is fine; a 90% gibbous at
 * 30° is a glow-fest. We sample the block, find the smallest angular
 * separation, and compare against a phase-scaled threshold.
 *
 * Threshold heuristic (degrees, by illumination):
 *
 *     New (0%)       25°
 *     Crescent (25%) 40°
 *     Quarter (50%)  55°
 *     Gibbous (75%)  70°
 *     Full (100%)    85°
 *
 * = 25 + (illum × 0.6). Matches common DSO imaging guidance.
 *
 * Verdicts:
 *   ok       — min separation ≥ threshold, OR moon below horizon the whole block
 *   caution  — within 15° of threshold (yellow)
 *   warning  — more than 15° below threshold (red)
 */
import SunCalc from 'suncalc';
import { altAz } from './altaz';
import { formatHm } from './timeFormat';

export type MoonVerdict = 'ok' | 'caution' | 'warning';

export interface MoonProximityResult {
  verdict: MoonVerdict;
  /** Smallest angular separation (degrees) between the target and the moon
   *  during the block, sampled at `stepMinutes`. Set to Infinity when the
   *  moon never rose during the block. */
  minSeparation: number;
  /** Threshold the separation was checked against (degrees). */
  threshold: number;
  /** Time of the worst (closest) separation, or null if moon never up. */
  worstAt: Date | null;
  /** Moon altitude (degrees) at the worst sample. */
  moonAltAtWorst: number;
  /** Plain-English explanation, empty when verdict is 'ok'. */
  reason: string;
}

export function moonThresholdForIllumination(illumPercent: number): number {
  return 25 + Math.max(0, Math.min(100, illumPercent)) * 0.6;
}

/**
 * Angular separation between two points on the celestial sphere, both given
 * as alt/az pairs (degrees). The choice of azimuth origin does not matter
 * here as long as both inputs use the same convention — only the difference
 * (az1 - az2) is consumed.
 */
function separationFromAltAz(alt1: number, az1: number, alt2: number, az2: number): number {
  const DEG = Math.PI / 180;
  const sinA = Math.sin(alt1 * DEG) * Math.sin(alt2 * DEG);
  const cosA = Math.cos(alt1 * DEG) * Math.cos(alt2 * DEG) * Math.cos((az1 - az2) * DEG);
  const cosD = Math.max(-1, Math.min(1, sinA + cosA));
  return Math.acos(cosD) / DEG;
}

/**
 * Get the moon's alt/az in the *standard* convention (0° = North, 90° = East),
 * matching `src/lib/altaz.ts`. SunCalc internally measures azimuth from south
 * (0 = S, +π/2 = W); we add 180° to convert.
 */
function moonAltAz(when: Date, lat: number, lon: number): { alt: number; az: number } {
  const m = SunCalc.getMoonPosition(when, lat, lon);
  const altDeg = (m.altitude * 180) / Math.PI;
  const azDeg = (((m.azimuth * 180) / Math.PI) + 180 + 360) % 360;
  return { alt: altDeg, az: azDeg };
}

/**
 * Check moon proximity for a single scheduled block.
 *
 * @param ra   Target right ascension in decimal hours.
 * @param dec  Target declination in decimal degrees.
 * @param lat  Observer latitude (degrees).
 * @param lon  Observer longitude (degrees, east positive).
 * @param start  Start of the block.
 * @param end    End of the block.
 * @param illumPercent  Tonight's moon illumination (0–100).
 * @param stepMinutes   Sample cadence. 5 minutes is enough — moon moves
 *                      ~13°/24h, so within a 30-min block the worst-case
 *                      separation change is ~0.3°.
 */
export function checkMoonProximity(
  ra: number,
  dec: number,
  lat: number,
  lon: number,
  start: Date,
  end: Date,
  illumPercent: number,
  stepMinutes = 5,
  /** Observer's IANA timezone, used to render the reason string's time-of-day
   *  in the observer's local time rather than the viewing device's. */
  timeZone?: string,
): MoonProximityResult {
  const threshold = moonThresholdForIllumination(illumPercent);
  const stepMs = Math.max(1, stepMinutes) * 60_000;

  let minSep = Infinity;
  let worstAt: Date | null = null;
  let moonAltAtWorst = -90;
  let moonEverUp = false;

  for (let t = start.getTime(); t <= end.getTime(); t += stepMs) {
    const when = new Date(t);
    const moon = moonAltAz(when, lat, lon);
    if (moon.alt < 0) continue; // moon under the horizon — no glare
    moonEverUp = true;
    const target = altAz(ra, dec, lat, lon, when);
    const sep = separationFromAltAz(target.alt, target.az, moon.alt, moon.az);
    if (sep < minSep) {
      minSep = sep;
      worstAt = when;
      moonAltAtWorst = moon.alt;
    }
  }

  if (!moonEverUp) {
    return { verdict: 'ok', minSeparation: Infinity, threshold, worstAt: null, moonAltAtWorst: 0, reason: '' };
  }

  let verdict: MoonVerdict;
  if (minSep >= threshold) verdict = 'ok';
  else if (minSep >= threshold - 15) verdict = 'caution';
  else verdict = 'warning';

  const reason =
    verdict === 'ok'
      ? ''
      : `Moon ${Math.round(minSep)}° away at ${formatHm(worstAt!, timeZone)} (recommended ≥ ${Math.round(threshold)}° at ${Math.round(illumPercent)}% illumination)`;

  return { verdict, minSeparation: minSep, threshold, worstAt, moonAltAtWorst, reason };
}
