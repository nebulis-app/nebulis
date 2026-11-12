/**
 * Scope (telescope) filtering for the Calibration Library.
 *
 * Calibration frames are stored per telescope under `_archive/<telescopeId>/`,
 * plus one shared `_archive/_unscoped/` bucket for runs that had no telescope
 * (a folder import). Every group the API returns already carries its `scope`, so
 * filtering is pure client-side work. This module owns the value mapping and the
 * `?scope=` round-trip so the page and its tests share one definition.
 *
 * `?scope=` carries a telescope id, the `UNSCOPED` sentinel, or nothing at all
 * for every scope. Telescope ids are UUIDs (server/lib/telescopes.ts), so they
 * are URL-safe as they stand.
 */

/** A `t` function handed in by the caller, which owns `useTranslation`. */
type TFunc = (key: string, opts?: Record<string, unknown>) => string;

/** Filter value meaning "every scope". Also the absence of a `?scope=` param. */
export const ALL_SCOPES = '__all__';

/** Filter value for the shared bucket, i.e. a group whose scope is null. */
export const UNSCOPED = 'unscoped';

interface Scoped {
  scope: string | null;
}

/** The filter value a group belongs to. */
export function scopeValueOf(scope: string | null): string {
  return scope ?? UNSCOPED;
}

/**
 * Whether a `?scope=` value names a scope that is actually present. An unknown
 * id (the telescope was deleted, or the URL was hand-edited) falls back to
 * every scope, so a stale or shared link shows the library rather than an empty
 * page.
 */
export function resolveScope(value: string | null | undefined, groups: readonly Scoped[]): string {
  if (!value || value === ALL_SCOPES) return ALL_SCOPES;
  return groups.some(group => scopeValueOf(group.scope) === value) ? value : ALL_SCOPES;
}

export function filterByScope<T extends Scoped>(groups: readonly T[], scope: string): T[] {
  if (scope === ALL_SCOPES) return [...groups];
  return groups.filter(group => scopeValueOf(group.scope) === scope);
}

export interface ScopeOption {
  value: string;
  label: string;
  fileCount: number;
}

/**
 * Filter options in display order: every scope first, then each telescope by
 * name, then each linked folder by name, then the unscoped bucket last (matching the server's own ordering, so
 * "Unassigned" never leads the list). Each option carries its frame count.
 */
export function buildScopeOptions(
  groups: ReadonlyArray<Scoped & { fileCount: number }>,
  telescopeNames: ReadonlyMap<string, string>,
  t: TFunc,
  /** Scope value to label, for the groups read from a linked folder (their scope is `@src/<sourceId>`). */
  linkedNames: ReadonlyMap<string, string> = new Map(),
): ScopeOption[] {
  const counts = new Map<string, number>();
  let total = 0;
  for (const group of groups) {
    const value = scopeValueOf(group.scope);
    counts.set(value, (counts.get(value) ?? 0) + group.fileCount);
    total += group.fileCount;
  }

  const options: ScopeOption[] = [
    { value: ALL_SCOPES, label: t('calibrations.scope.all'), fileCount: total },
  ];

  // Telescopes by name, then linked folders by name, then the shared bucket.
  const telescopeScopes = [...counts.keys()]
    .filter(value => value !== UNSCOPED && !linkedNames.has(value))
    .sort((a, b) => (telescopeNames.get(a) ?? '').localeCompare(telescopeNames.get(b) ?? ''));
  const linkedScopes = [...linkedNames.keys()]
    .filter(value => counts.has(value))
    .sort((a, b) => (linkedNames.get(a) ?? '').localeCompare(linkedNames.get(b) ?? ''));
  for (const value of telescopeScopes) {
    options.push({
      value,
      // A scope id with no profile left is a deleted telescope. Its frames stay
      // on disk and stay reachable, so it keeps an option with a generic label.
      label: telescopeNames.get(value) ?? t('calibrations.scope.deleted'),
      fileCount: counts.get(value) ?? 0,
    });
  }
  for (const value of linkedScopes) {
    options.push({
      value,
      label: t('calibrations.scope.linked', { name: linkedNames.get(value) ?? value }),
      fileCount: counts.get(value) ?? 0,
    });
  }

  if (counts.has(UNSCOPED)) {
    options.push({
      value: UNSCOPED,
      label: t('calibrations.scope.unassigned'),
      fileCount: counts.get(UNSCOPED) ?? 0,
    });
  }

  return options;
}
