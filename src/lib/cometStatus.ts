/**
 * Words for a comet or asteroid in the planner (src/components/planner/CometsPanel.tsx) and on a library comet's
 * page (src/components/objectDetail/CometPanel.tsx).
 */
import type { TFunction } from 'i18next';
import type { CometEntry } from './api/planner';
import { formatHm } from './timeFormat';
import { formatDate } from './formatLocale';

/** "Thu 27 Nov" in the observer's zone. */
export function dayLabel(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  try {
    return formatDate(d, { weekday: 'short', day: 'numeric', month: 'short', ...(timeZone ? { timeZone } : {}) });
  } catch {
    return formatDate(d, { weekday: 'short', day: 'numeric', month: 'short' });
  }
}

/** The body's page in JPL's Small-Body Database: orbit, ephemeris, discovery. */
export function jplLink(designation: string): string {
  return `https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html#/?sstr=${encodeURIComponent(designation)}`;
}

/** One line for a body: tonight's best, else when it is next up, else why there is nothing to say. */
export function cometStatusLine(entry: CometEntry, t: TFunction<'planner'>, timeZone?: string): string {
  if (entry.status === 'idle') return '';
  if (entry.status === 'not-found') return t('comets.notFound');
  if (entry.status === 'unavailable') return t('comets.unavailable');
  const tonight = entry.nights[0];
  if (entry.target && tonight?.bestTime) {
    const args = { alt: Math.round(tonight.maxAlt ?? 0), time: formatHm(new Date(tonight.bestTime), timeZone) };
    return tonight.magnitude != null
      ? t('comets.tonightMag', { ...args, mag: tonight.magnitude.toFixed(1) })
      : t('comets.tonight', args);
  }
  const next = entry.nights.find(n => n.observable);
  return next ? t('comets.nextUp', { date: dayLabel(next.start, timeZone), alt: Math.round(next.maxAlt ?? 0) }) : t('comets.notUp');
}
