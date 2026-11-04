/**
 * Moonrise and moonset for an observing night.
 *
 * SunCalc.getMoonTimes() without its `inUTC` flag searches from midnight of the HOST's local day, so the same site and
 * night gave different answers on a UTC Docker install and a Mac in Chicago (a moonset a whole day earlier). Searching
 * UTC days is host-independent. The result is the first rise and first set at or after the start of the night, which is
 * the pairing the browser's moonUpSpans() expects: rise before set means the Moon is up between them, set before rise
 * means it is up at dusk until the set and again from the rise.
 */
import SunCalc from 'suncalc';

const DAY_MS = 86400000;

export interface NightMoonTimes {
  rise: Date | null;
  set: Date | null;
}

function validDate(d: Date | undefined): Date | null {
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
}

export function moonTimesForNight(nightStart: Date, lat: number, lon: number): NightMoonTimes {
  const from = nightStart.getTime();
  let rise: Date | null = null;
  let set: Date | null = null;
  // The UTC day before the start catches an event a few hours earlier that a long night is still waiting on; two days
  // ahead covers a Moon that stays up (or down) for more than a day near the poles.
  const dayZero = Math.floor(from / DAY_MS) * DAY_MS;
  for (let offset = -1; offset <= 2; offset++) {
    const times = SunCalc.getMoonTimes(new Date(dayZero + offset * DAY_MS), lat, lon, true);
    const r = validDate(times.rise);
    const s = validDate(times.set);
    if (r && r.getTime() >= from && (!rise || r < rise)) rise = r;
    if (s && s.getTime() >= from && (!set || s < set)) set = s;
  }
  return { rise, set };
}
