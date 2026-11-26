/**
 * The meridian flip in a planned imaging block.
 *
 * A German equatorial mount has to turn the telescope over when the target crosses the meridian (hour angle 0,
 * upper culmination), or the tube runs into the pier. The capture stops for the flip: slew, re-centre, restart
 * guiding. This module finds that moment in a block and what it costs, so the planner can mark it and suggest a
 * block that stays on one side.
 *
 * Only custom rigs can flip: a SeeStar or a Dwarf is an alt-az smart telescope. An ASIAIR is assumed to drive an
 * equatorial mount until the owner says otherwise; any other rig is assumed not to, until the owner says it does.
 */
import { lstHours } from './altaz';
import type { TelescopeProfile } from './api/telescopes';

export const DEFAULT_FLIP_PAUSE_MINUTES = 10;
/** A side of the flip shorter than this is not worth the flip: the block would be better on the other side only. */
export const SHORT_SIDE_MINUTES = 30;

/** Mean solar milliseconds in one sidereal hour. */
const SIDEREAL_HOUR_MS = 3_600_000 * 0.9972695663;

/**
 * The instants in (start, end) when a target at right ascension `raHours` crosses the meridian above the pole, for an
 * observer at east longitude `lonDeg`. Usually zero or one; two only for a block longer than a sidereal day.
 */
export function meridianTransits(raHours: number, lonDeg: number, start: Date, end: Date): Date[] {
  if (!(end.getTime() > start.getTime())) return [];
  const ha = ((lstHours(start, lonDeg) - raHours) % 24 + 24) % 24;
  // Sidereal hours until the hour angle next reaches 24 (= 0).
  const untilHours = ha === 0 ? 24 : 24 - ha;
  const out: Date[] = [];
  for (let t = start.getTime() + untilHours * SIDEREAL_HOUR_MS; t < end.getTime(); t += 24 * SIDEREAL_HOUR_MS) {
    out.push(new Date(t));
  }
  return out;
}

/** Which mount settings a telescope profile flips with, or null when it does not flip. */
export function flipSettingsFor(profile: Pick<TelescopeProfile, 'kind' | 'rig'> | null | undefined): { pauseMinutes: number } | null {
  if (!profile || (profile.kind !== 'asiair' && profile.kind !== 'other')) return null;
  const mount = profile.rig?.mount ?? null;
  const equatorial = mount === 'equatorial' || (mount === null && profile.kind === 'asiair');
  if (!equatorial) return null;
  return { pauseMinutes: profile.rig?.flipPauseMinutes ?? DEFAULT_FLIP_PAUSE_MINUTES };
}

export interface BlockFlip {
  /** When the target crosses the meridian. */
  at: Date;
  pauseMinutes: number;
  /** Block length minus the pause: what is left to capture. */
  imagingMinutes: number;
  /**
   * Set when one side of the flip is short: `endAtFlip` means ending the block at the flip keeps nearly all of it,
   * `startAfterFlip` means starting it once the flip is done does. Null when both sides are worth keeping.
   */
  suggestion: { kind: 'endAtFlip'; at: Date } | { kind: 'startAfterFlip'; at: Date } | null;
}

/** The first flip inside a block, or null when the target does not cross the meridian during it. */
export function flipInBlock(raHours: number, lonDeg: number, start: Date, end: Date, pauseMinutes: number): BlockFlip | null {
  const [at] = meridianTransits(raHours, lonDeg, start, end);
  if (!at) return null;
  const totalMinutes = (end.getTime() - start.getTime()) / 60_000;
  const beforeMinutes = (at.getTime() - start.getTime()) / 60_000;
  const afterMinutes = Math.max(0, totalMinutes - beforeMinutes - pauseMinutes);
  let suggestion: BlockFlip['suggestion'] = null;
  if (Math.min(beforeMinutes, afterMinutes) < SHORT_SIDE_MINUTES) {
    suggestion = afterMinutes <= beforeMinutes
      ? { kind: 'endAtFlip', at }
      : { kind: 'startAfterFlip', at: new Date(at.getTime() + pauseMinutes * 60_000) };
  }
  return { at, pauseMinutes, imagingMinutes: Math.max(0, totalMinutes - pauseMinutes), suggestion };
}
