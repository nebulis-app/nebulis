import type { ObservationSummary } from './api/observations';
import { cleanCatalogId } from './utils';

/**
 * What an observation's "Object" label should read: the common name, falling
 * back to the catalog id when the API has no distinct common name (otherwise
 * a display and a catalog column would repeat the same string).
 *
 * Shared between ObservationsList's table and its "share this list" export
 * card (built in ObservationsCalendar) so the two can never drift — one
 * source of truth for what an observation is called.
 */
export function resolveObjectLabel(obs: ObservationSummary): { display: string; catalog: string } {
  const catalog = cleanCatalogId(obs.catalogId || obs.objectId);
  const common = (obs.objectName || '').trim();
  const hasCommonName = common.length > 0 && cleanCatalogId(common).toUpperCase() !== catalog.toUpperCase();
  return { display: hasCommonName ? common : catalog, catalog };
}

/** `YYYY-MM-DD` rendered in the viewer's locale, without a timezone shift. */
export function formatObservationDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  // Constructed as a local date, not parsed from the ISO string: `new
  // Date('2024-03-15')` is UTC midnight and renders as the 14th west of
  // Greenwich, which would show the wrong night.
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

/** Right ascension in decimal hours (how OpenNGC stores it) as sexagesimal.
 *  A value that already arrived formatted, e.g. "05h 34m 31.94s", is returned
 *  unchanged. */
export function formatRa(ra: string): string {
  if (/\d+h/i.test(ra)) return ra;
  const h = parseFloat(ra);
  if (isNaN(h)) return ra;
  const hh = Math.floor(h);
  const mFrac = (h - hh) * 60;
  const m = Math.floor(mFrac);
  const s = (mFrac - m) * 60;
  return `${hh.toString().padStart(2, '0')}h ${m.toString().padStart(2, '0')}m ${s.toFixed(1).padStart(4, '0')}s`;
}

/**
 * The inverse of `formatRa`: right ascension in decimal HOURS, whatever form it
 * arrived in. Mirrors `raToHours` in server/lib/astroCalc.ts, including its rule
 * that a bare decimal string is hours (which is how OpenNGC and libraryObjects
 * both store it), not degrees. Returns null rather than 0 for anything
 * unparseable, so a caller can tell "no coordinates" from "RA 00h".
 */
export function parseRaHours(ra: string | number | null | undefined): number | null {
  if (ra == null) return null;
  if (typeof ra === 'number') return Number.isFinite(ra) ? ra : null;
  const m = ra.match(/(\d+)h\s*(\d+)m\s*([\d.]+)s/i);
  if (m) return parseFloat(m[1]) + parseFloat(m[2]) / 60 + parseFloat(m[3]) / 3600;
  const n = parseFloat(ra);
  return Number.isFinite(n) ? n : null;
}

/** The inverse of `formatDec`: declination in decimal DEGREES. Mirrors
 *  `decToDegs` in server/lib/astroCalc.ts. Null when unparseable. */
export function parseDecDegrees(dec: string | number | null | undefined): number | null {
  if (dec == null) return null;
  if (typeof dec === 'number') return Number.isFinite(dec) ? dec : null;
  // The minus may be a typographic one: formatRA-style output uses U+2212.
  const m = dec.match(/([+\-−]?)\s*(\d+)\s*[°]\s*(\d+)\s*[′']\s*([\d.]+)\s*[″"]/);
  if (m) {
    const sign = m[1] === '-' || m[1] === '−' ? -1 : 1;
    return sign * (parseFloat(m[2]) + parseFloat(m[3]) / 60 + parseFloat(m[4]) / 3600);
  }
  const n = parseFloat(dec.replace('−', '-'));
  return Number.isFinite(n) ? n : null;
}

/** Declination in decimal degrees as sexagesimal, sign always shown. An
 *  already-formatted value, e.g. "+22° 00′ 52.2″", is returned unchanged. */
export function formatDec(dec: string): string {
  // Already sexagesimal: return it untouched. Without this, `parseFloat` reads
  // "-05° 23′ 28″" as -5 and the value is reformatted as "-05° 00′ 0.0″",
  // silently dropping the arcminutes and arcseconds. `formatRa` has always had
  // the matching guard.
  if (/[°′″]/.test(dec)) return dec;
  const deg = parseFloat(dec);
  if (isNaN(deg)) return dec;
  const sign = deg >= 0 ? '+' : '-';
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const mFrac = (abs - d) * 60;
  const m = Math.floor(mFrac);
  const s = (mFrac - m) * 60;
  return `${sign}${d.toString().padStart(2, '0')}° ${m.toString().padStart(2, '0')}′ ${s.toFixed(1)}″`;
}

/** Light years, switched to "million ly" once the raw figure stops being
 *  readable as digits. */
export function formatDistanceLy(ly: number): string {
  if (ly >= 1_000_000) {
    const mly = ly / 1_000_000;
    return `${mly % 1 === 0 ? mly.toFixed(0) : mly.toFixed(2)} million ly`;
  }
  return `${ly.toLocaleString('en-US')} ly`;
}
