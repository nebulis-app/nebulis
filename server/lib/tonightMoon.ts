/**
 * How much the Moon spoils an object for a night, for ranking.
 *
 * The same rule as the per-block check (moonProximity.ts): the Moon must stay
 * outside a threshold that grows with its illumination and is far smaller for
 * narrowband targets. Here it becomes a 0-1 penalty over the stretch the object
 * is actually up, so a nebula that is only close to the Moon for an hour loses
 * less than one beside it all night. The Moon's position is sampled once per
 * night and shared by every object.
 */
import { altAz } from './astroCalc.js';
import { bandForObjectType } from './filterBands.js';
import { moonAltAz, moonThresholdForIllumination, separationFromAltAz } from './moonProximity.js';

const SAMPLE_MINUTES = 30;

export interface MoonTrack {
  lat: number;
  lon: number;
  illumination: number;
  samples: { t: number; alt: number; az: number }[];
}

/** The Moon's place every 30 minutes from `start` to `end`. */
export function buildMoonTrack(lat: number, lon: number, start: Date, end: Date, illumination: number): MoonTrack {
  const samples: MoonTrack['samples'] = [];
  const step = SAMPLE_MINUTES * 60_000;
  for (let t = start.getTime(); t <= end.getTime(); t += step) {
    const m = moonAltAz(new Date(t), lat, lon);
    samples.push({ t, alt: m.alt, az: m.az });
  }
  return { lat, lon, illumination, samples };
}

/**
 * 0 = the Moon never gets close (or is down) while the object is up;
 * 1 = it sits on top of it the whole time. `from`/`to` bound the stretch the
 * object is above the site's floor (the planner's rise and set).
 */
export function moonPenaltyFor(
  track: MoonTrack,
  target: { ra: number; dec: number; type: string },
  from: Date | null,
  to: Date | null,
): number {
  if (!from || track.illumination <= 0) return 0;
  const threshold = moonThresholdForIllumination(track.illumination, bandForObjectType(target.type));
  const lo = from.getTime();
  const hi = to ? to.getTime() : Infinity;
  let sum = 0;
  let n = 0;
  for (const m of track.samples) {
    if (m.t < lo || m.t > hi) continue;
    n++;
    if (m.alt < 0) continue;
    const pos = altAz(target.ra, target.dec, track.lat, track.lon, new Date(m.t));
    const sep = separationFromAltAz(pos.alt, pos.az, m.alt, m.az);
    sum += Math.max(0, Math.min(1, (threshold - sep) / threshold));
  }
  return n === 0 ? 0 : sum / n;
}
