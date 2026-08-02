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
