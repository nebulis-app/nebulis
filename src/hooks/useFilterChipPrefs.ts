import { useMemo, useState } from 'react';

const STORAGE_KEY = 'nebulis-filter-chips';

function readStored(): string[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string');
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Persists which filter chips the user has pinned to the top row, shared across
 * the Library and Image Gallery via one localStorage key. Until the user
 * customizes anything, the enabled set falls back to `defaultIds` (the curated
 * groups), so the out-of-the-box row is unchanged. Mirrors the try/catch
 * persistence pattern used for the gallery sort preference.
 */
export function useFilterChipPrefs(defaultIds: string[]) {
  const [stored, setStored] = useState<string[] | null>(readStored);

  const defaultKey = defaultIds.join('|');
  const enabledIds = useMemo(
    () => new Set(stored ?? defaultIds),
    // defaultKey stands in for the freshly-mapped defaultIds array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stored, defaultKey],
  );

  // Plain handler (recreated each render) so it closes over the current
  // `stored`/`defaultIds` without a ref update during render. Toggling before
  // any customization starts from the defaults, not an empty set, so the
  // existing group chips aren't dropped.
  function toggle(id: string) {
    const base = stored ?? defaultIds;
    const next = base.includes(id) ? base.filter(x => x !== id) : [...base, id];
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    setStored(next);
  }

  // Unpin every chip (a customized-empty set, distinct from the uncustomized
  // default). The top row then shows only All and Favorites.
  function clearAll() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify([])); } catch { /* ignore */ }
    setStored([]);
  }

  return { enabledIds, toggle, clearAll };
}
