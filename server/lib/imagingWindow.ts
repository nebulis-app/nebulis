/**
 * The imaging window of a night, as the site's owner wants it.
 *
 * By default it is the astronomical night (the Sun 18° below the horizon), or the nautical night (12°) where it
 * never gets that dark. A site can instead start from the nautical night, which narrowband imaging often does
 * (the filters cut most of the twilight glow), and can move either end by a number of minutes: start later than
 * dark, stop before dawn, or the other way round.
 *
 * The forecast page, the clear-night alert and the long-range outlook all read the window from here, so they agree
 * on what "tonight" means for a site.
 */

export const DARKNESS_LEVELS = ['astronomical', 'nautical'] as const;
export type DarknessLevel = (typeof DARKNESS_LEVELS)[number];

export interface ImagingWindowPrefs {
  /** Which twilight the window starts from. */
  darkness: DarknessLevel;
  /** Minutes after that dusk the window opens; negative opens it before. */
  startOffsetMin: number;
  /** Minutes before that dawn the window closes; negative closes it after. */
  endOffsetMin: number;
}

export const DEFAULT_WINDOW_PREFS: ImagingWindowPrefs = { darkness: 'astronomical', startOffsetMin: 0, endOffsetMin: 0 };

/** How far either end may be moved, in minutes. Beyond that the window would no longer be about the night. */
export const WINDOW_OFFSET_MIN = -180;
export const WINDOW_OFFSET_MAX = 360;

export function clampOffset(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
  return Math.min(WINDOW_OFFSET_MAX, Math.max(WINDOW_OFFSET_MIN, n));
}

export function isDarknessLevel(v: unknown): v is DarknessLevel {
  return typeof v === 'string' && (DARKNESS_LEVELS as readonly string[]).includes(v);
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
  /** The twilight actually used: astronomical falls back to nautical where it never gets astronomically dark. */
  darkness: DarknessLevel;
}

/**
 * The window for one night's twilight times. Null when there is no night at that level or the next one down, or when
 * the offsets leave nothing (the end not after the start).
 */
export function resolveWindow(t: TwilightDates, prefs: ImagingWindowPrefs = DEFAULT_WINDOW_PREFS): ResolvedWindow | null {
  let darkness: DarknessLevel = prefs.darkness;
  let dusk = darkness === 'astronomical' ? t.astronomicalDusk : t.nauticalDusk;
  let dawn = darkness === 'astronomical' ? t.astronomicalDawn : t.nauticalDawn;
  if ((!dusk || !dawn) && darkness === 'astronomical') {
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

/** The same from the forecast's ISO twilight strings (empty when the Sun does not get that low). */
export function resolveWindowFromIso(
  t: { astronomicalTwilightEnd?: string | null; astronomicalTwilightStart?: string | null; nauticalTwilightEnd?: string | null; nauticalTwilightStart?: string | null },
  prefs: ImagingWindowPrefs = DEFAULT_WINDOW_PREFS,
): ResolvedWindow | null {
  const d = (s: string | null | undefined): Date | null => {
    if (!s) return null;
    const v = new Date(s);
    return Number.isFinite(v.getTime()) ? v : null;
  };
  return resolveWindow({
    astronomicalDusk: d(t.astronomicalTwilightEnd),
    astronomicalDawn: d(t.astronomicalTwilightStart),
    nauticalDusk: d(t.nauticalTwilightEnd),
    nauticalDawn: d(t.nauticalTwilightStart),
  }, prefs);
}

/** A site's window settings, defaulting whatever is missing or out of range. */
export function windowPrefsOf(site: { darkness?: unknown; windowStartOffsetMin?: unknown; windowEndOffsetMin?: unknown } | null | undefined): ImagingWindowPrefs {
  return {
    darkness: isDarknessLevel(site?.darkness) ? site.darkness : 'astronomical',
    startOffsetMin: clampOffset(site?.windowStartOffsetMin),
    endOffsetMin: clampOffset(site?.windowEndOffsetMin),
  };
}
