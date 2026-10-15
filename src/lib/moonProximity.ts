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
 * That is the broadband (L/RGB, one-shot colour without a filter) threshold.
 * Narrowband filters (Ha, OIII, SII, dual/tri-band) pass a few nanometres
 * around the emission lines and reject most of the moonlight, so they hold up
 * much closer to the Moon:
 *
 *     New (0%) 15°   Quarter (50%) 27.5°   Full (100%) 40°
 *
 * = 15 + (illum × 0.25). Conservative for 3 nm mono filters, about right for
 * the 7 nm dual-band filters used on colour cameras.
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
  /** Filter type the verdict was computed for (server verdicts only). */
  band?: FilterBand;
  /** The same closest approach against the narrowband tolerance (server
   *  verdicts only), so an unset or broadband block can say narrowband
   *  would be fine. */
  narrowbandVerdict?: MoonVerdict;
}

/** What a block is shot through. */
export type FilterBand = 'broadband' | 'narrowband';

export function moonThresholdForIllumination(illumPercent: number, band: FilterBand = 'broadband'): number {
  const illum = Math.max(0, Math.min(100, illumPercent));
  return band === 'narrowband' ? 15 + illum * 0.25 : 25 + illum * 0.6;
}

/** Verdict for a separation against a threshold (bands described above). */
export function moonVerdictFor(minSeparation: number, threshold: number): MoonVerdict {
  if (minSeparation >= threshold) return 'ok';
  return minSeparation >= threshold - 15 ? 'caution' : 'warning';
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
  /** Filter type of the block; decides the threshold. */
  band: FilterBand = 'broadband',
): MoonProximityResult {
  const threshold = moonThresholdForIllumination(illumPercent, band);
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

  const verdict = moonVerdictFor(minSep, threshold);

  const reason =
    verdict === 'ok'
      ? ''
      : `Moon ${Math.round(minSep)}° away at ${formatHm(worstAt!, timeZone)} (recommended ≥ ${Math.round(threshold)}° at ${Math.round(illumPercent)}% illumination${band === 'narrowband' ? ', narrowband' : ''})`;

  return { verdict, minSeparation: minSep, threshold, worstAt, moonAltAtWorst, reason };
}

export interface MoonInterferenceSample {
  time: Date;
  /** Angular separation to the moon (degrees). Null while the moon is below
   *  the horizon, when there is nothing to be close to. */
  separation: number | null;
  /** 'ok' also covers "moon is down" — there's no reason to flag a span
   *  where it can't be interfering at all. */
  verdict: MoonVerdict;
}

/**
 * Per-sample moon-proximity trace across a window, for a continuous strip
 * (e.g. drawn alongside an altitude curve) rather than the single worst-case
 * verdict `checkMoonProximity` returns. Same threshold heuristic and verdict
 * bands, just without collapsing the timeline down to one number.
 */
export function computeMoonInterferenceCurve(
  ra: number,
  dec: number,
  lat: number,
  lon: number,
  start: Date,
  end: Date,
  illumPercent: number,
  stepMinutes = 15,
): MoonInterferenceSample[] {
  const threshold = moonThresholdForIllumination(illumPercent);
  const stepMs = Math.max(1, stepMinutes) * 60_000;
  const out: MoonInterferenceSample[] = [];

  for (let t = start.getTime(); t <= end.getTime(); t += stepMs) {
    const when = new Date(t);
    const moon = moonAltAz(when, lat, lon);
    if (moon.alt < 0) {
      out.push({ time: when, separation: null, verdict: 'ok' });
      continue;
    }
    const target = altAz(ra, dec, lat, lon, when);
    const sep = separationFromAltAz(target.alt, target.az, moon.alt, moon.az);
    const verdict: MoonVerdict = sep >= threshold ? 'ok' : sep >= threshold - 15 ? 'caution' : 'warning';
    out.push({ time: when, separation: sep, verdict });
  }

  return out;
}
