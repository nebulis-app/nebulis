/**
 * Which kind of filter suits a night, from the Moon alone.
 *
 * Broadband (L/RGB, a colour camera without a filter) needs a dark sky;
 * narrowband (Ha, OIII, SII, dual-band) copes with moonlight. Over the night's
 * dark window:
 *
 *   - a faint Moon (under FAINT_MOON_PERCENT lit), or one up for less than a
 *     tenth of the window, leaves the whole night to broadband;
 *   - a bright Moon up for most of it makes it a narrowband night;
 *   - a bright Moon that rises or sets during it splits the night: broadband
 *     until moonrise, or from moonset.
 *
 * Per-target separation is the block-level check (moonProximity.ts); this is
 * the one-line answer for the night as a whole.
 */
import { moonUpIntervals } from './plannerNight';

export type NightFilterAdvice =
  | { kind: 'broadband' }
  | { kind: 'narrowband' }
  /** Moon rises during the night. */
  | { kind: 'broadbandUntil'; at: Date }
  /** Moon sets during the night. */
  | { kind: 'broadbandFrom'; at: Date };

export const FAINT_MOON_PERCENT = 25;

/** Moon up for less than this share of the window: ignore it. */
const NEGLIGIBLE_UP = 0.1;
/** Moon up for more than this share: the whole night is narrowband. */
const MOSTLY_UP = 0.9;
/** A rise/set this close to the window's edge counts as at the edge. */
const EDGE_MS = 15 * 60_000;

export function nightFilterAdvice(opts: {
  darkStart: Date;
  darkEnd: Date;
  lat: number;
  lon: number;
  moonIllumination: number;
}): NightFilterAdvice {
  const { darkStart, darkEnd, lat, lon, moonIllumination } = opts;
  const span = darkEnd.getTime() - darkStart.getTime();
  if (span <= 0 || moonIllumination < FAINT_MOON_PERCENT) return { kind: 'broadband' };

  const up = moonUpIntervals(darkStart, darkEnd, lat, lon);
  const upMs = up.reduce((n, i) => n + (i.end - i.start), 0);
  if (upMs < span * NEGLIGIBLE_UP) return { kind: 'broadband' };
  if (upMs > span * MOSTLY_UP) return { kind: 'narrowband' };

  const first = up[0];
  const last = up[up.length - 1];
  const upAtStart = first.start - darkStart.getTime() <= EDGE_MS;
  const upAtEnd = darkEnd.getTime() - last.end <= EDGE_MS;
  if (upAtStart && !upAtEnd) return { kind: 'broadbandFrom', at: new Date(last.end) };
  if (!upAtStart && upAtEnd) return { kind: 'broadbandUntil', at: new Date(first.start) };
  // Rises and sets inside the window (or the reverse): no single switch time.
  return { kind: 'narrowband' };
}
