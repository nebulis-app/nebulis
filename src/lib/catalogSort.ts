/**
 * The filter/sort vocabulary of a catalog board.
 *
 * Kept out of CatalogToolbar.tsx so the component file exports only its
 * component (Fast Refresh requirement), and so the `<select>` handler can
 * narrow its raw DOM string through isSortKey instead of asserting it.
 */
import { isOneOf } from './typeGuards';

export const STATUS_FILTERS = ['all', 'imaged', 'remaining'] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const SORT_KEYS = ['catalog', 'name', 'magnitude', 'constellation'] as const;
export type SortKey = (typeof SORT_KEYS)[number];

/** Narrows the raw string a `<select>` hands back to a SortKey. */
export function isSortKey(v: string): v is SortKey {
  return isOneOf(SORT_KEYS, v);
}
