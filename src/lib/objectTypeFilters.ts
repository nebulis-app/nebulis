import type { LibraryObjectFilter } from './api/library';

/** The two always-present, non-customizable filters. */
export const ALL_FILTER_ID = 'all';
export const FAVORITES_FILTER_ID = 'favorites';

/** A granular filter for one exact object type present in the library. */
export interface TypeFilter {
  /** Stable id, e.g. `type:emission nebula` (lower-cased raw type). */
  id: string;
  /** Display label, the raw type string as first seen, e.g. "Emission Nebula". */
  label: string;
  /** How many objects in the library carry this exact type. */
  count: number;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Collision-free id derived from the exact (case-folded) type string. */
export function typeFilterId(rawType: string): string {
  return `type:${normalize(rawType)}`;
}

/**
 * Derive one granular filter per distinct object type present in the list.
 * Case-folds duplicates (keeps first-seen casing as the label), counts
 * occurrences, and skips empty/unknown types. Sorted by count desc, then label.
 *
 * `groups` excludes any type whose label case-insensitively matches a curated
 * group's label (e.g. the raw type "Galaxy" vs the "Galaxy" group, or
 * "Planetary Nebula" vs the "Planetary Nebula" group). Without this, enabling
 * that type chip renders two identically-labeled buttons side by side with
 * nothing visually distinguishing them — indistinguishable from a duplicate.
 */
export function buildTypeFilters(
  types: (string | null | undefined)[],
  groups: LibraryObjectFilter[] = [],
): TypeFilter[] {
  const groupLabels = new Set(groups.map(g => normalize(g.label)));
  const byKey = new Map<string, { label: string; count: number }>();
  for (const raw of types) {
    if (!raw) continue;
    const label = raw.trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (key === 'unknown') continue;
    if (groupLabels.has(key)) continue;
    const entry = byKey.get(key);
    if (entry) entry.count += 1;
    else byKey.set(key, { label, count: 1 });
  }
  return [...byKey.entries()]
    .map(([key, { label, count }]) => ({ id: `type:${key}`, label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** True when a curated group's matchTypes/matchMode covers the given raw type. */
export function groupMatchesType(group: LibraryObjectFilter, rawType: string | null | undefined): boolean {
  const type = normalize(rawType ?? '');
  if (!type) return false;
  return group.matchMode === 'exact'
    ? group.matchTypes.some(mt => normalize(mt) === type)
    : group.matchTypes.some(mt => new RegExp(`(^|\\b)${escapeRegExp(normalize(mt))}(\\b|$)`).test(type));
}

/** The item under test. Library objects also supply precomputed `filterTags`. */
export interface FilterableItem {
  objectType: string | null | undefined;
  filterTags?: string[];
  isFavorite?: boolean;
}

/**
 * Single matcher shared by the Library and Image Gallery. `activeId` is one of
 * `all`, `favorites`, a curated group id, or a `type:*` id. Group matching uses
 * the object's precomputed `filterTags` when present (Library), otherwise falls
 * back to the group's matchTypes/matchMode against the raw type (Image Gallery).
 */
export function matchesFilter(
  activeId: string,
  item: FilterableItem,
  groups: LibraryObjectFilter[],
): boolean {
  if (activeId === ALL_FILTER_ID) return true;
  if (activeId === FAVORITES_FILTER_ID) return Boolean(item.isFavorite);
  if (activeId.startsWith('type:')) {
    return item.objectType != null && typeFilterId(item.objectType) === activeId;
  }
  const group = groups.find(g => g.id === activeId);
  if (!group) return false;
  if (item.filterTags) return item.filterTags.includes(group.id);
  return groupMatchesType(group, item.objectType);
}

/** Default enabled chips = every curated group except the special `all`. */
export function defaultEnabledIds(groups: LibraryObjectFilter[]): string[] {
  return groups.filter(g => g.id !== ALL_FILTER_ID).map(g => g.id);
}

/** Resolve a filter id to its display label for the active-filter readout. */
export function filterLabel(
  activeId: string,
  groups: LibraryObjectFilter[],
  typeFilters: TypeFilter[],
): string {
  if (activeId === ALL_FILTER_ID) return 'All';
  if (activeId === FAVORITES_FILTER_ID) return 'Favorites';
  return (
    typeFilters.find(t => t.id === activeId)?.label ??
    groups.find(g => g.id === activeId)?.label ??
    activeId
  );
}
