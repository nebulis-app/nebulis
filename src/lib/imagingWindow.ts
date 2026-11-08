/**
 * The imaging window of a night, as a site wants it: the browser's copy of server/lib/imagingWindow.ts.
 *
 * By default it is the astronomical night, or the nautical night where the Sun never gets 18 degrees down. A site
 * can start from the nautical night instead and move either end by some minutes. Every client calculation of
 * "tonight" (Planner, best months, up tonight, the Forecast page) goes through `resolveWindow` here, and the server
 * does the same through its own copy. `tests/backend/imagingWindowParity.test.ts` fails if the two differ.
 */

export type DarknessLevel = 'astronomical' | 'nautical';

export interface ImagingWindowPrefs {
  darkness: DarknessLevel;
  /** Minutes after that dusk the window opens; negative opens it before. */
  startOffsetMin: number;
  /** Minutes before that dawn the window closes; negative closes it after. */
  endOffsetMin: number;
}

export const DEFAULT_WINDOW_PREFS: ImagingWindowPrefs = { darkness: 'astronomical', startOffsetMin: 0, endOffsetMin: 0 };

/** How far either end may be moved, in minutes. */
export const WINDOW_OFFSET_MIN = -180;
export const WINDOW_OFFSET_MAX = 360;

export function clampOffset(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
  return Math.min(WINDOW_OFFSET_MAX, Math.max(WINDOW_OFFSET_MIN, n));
}

export interface TwilightDates {
  astronomicalDusk: Date | null;
  astronomicalDawn: Date | null;
  nauticalDusk: Date | null;
  nauticalDawn: Date | null;
}

export interface ResolvedWindow {
  start: Date;
  end: Date;
  /** The twilight actually used: astronomical falls back to nautical where it never gets that dark. */
  darkness: DarknessLevel;
}

/** The window for one night's twilight times. Null when there is no night, or the offsets leave nothing. */
export function resolveWindow(t: TwilightDates, prefs: ImagingWindowPrefs): ResolvedWindow | null {
  let darkness: DarknessLevel = prefs.darkness;
  let dusk = darkness === 'astronomical' ? t.astronomicalDusk : t.nauticalDusk;
  let dawn = darkness === 'astronomical' ? t.astronomicalDawn : t.nauticalDawn;
  if ((!dusk || !dawn || dawn <= dusk) && darkness === 'astronomical') {
    darkness = 'nautical';
    dusk = t.nauticalDusk;
    dawn = t.nauticalDawn;
  }
  if (!dusk || !dawn || dawn <= dusk) return null;
  const start = new Date(dusk.getTime() + clampOffset(prefs.startOffsetMin) * 60_000);
  const end = new Date(dawn.getTime() - clampOffset(prefs.endOffsetMin) * 60_000);
  if (end <= start) return null;
  return { start, end, darkness };
}

/** A site's window settings, defaulting whatever is missing (an older server sends none). */
export function windowPrefsOf(site: { darkness?: DarknessLevel; windowStartOffsetMin?: number; windowEndOffsetMin?: number } | null | undefined): ImagingWindowPrefs {
  return {
    darkness: site?.darkness === 'nautical' ? 'nautical' : 'astronomical',
    startOffsetMin: clampOffset(site?.windowStartOffsetMin),
    endOffsetMin: clampOffset(site?.windowEndOffsetMin),
  };
}
