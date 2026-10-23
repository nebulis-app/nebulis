import { useCallback, useEffect, useState } from 'react';

/**
 * Whether a page's hero banner is folded to its slim bar, remembered per page.
 *
 * The key is a short page name ("library", "planner"), stored as
 * `nebulis-<page>-hero-collapsed` so each banner keeps its own state: someone
 * who wants the Library stats out of the way may still want the Sky forecast
 * open. Storage can be missing or throw (private mode), in which case the
 * choice simply does not persist.
 */
function storageKey(page: string): string {
  return `nebulis-${page}-hero-collapsed`;
}

const COMPACT_KEY = 'nebulis-compact-banners';
const PREF_EVENT = 'nebulis-hero-pref';

/** The Settings -> General switch: banners start folded on every page that has
 *  no choice of its own. */
function readCompact(): boolean {
  try { return localStorage.getItem(COMPACT_KEY) === '1'; } catch { return false; }
}

function read(page: string): boolean {
  try {
    const own = localStorage.getItem(storageKey(page));
    if (own !== null) return own === '1';
  } catch { /* fall through to the default */ }
  return readCompact();
}

/** Turn "compact banners" on or off for every page. Per-page choices are
 *  cleared so the switch takes effect everywhere at once. */
export function setCompactBanners(on: boolean): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (/^nebulis-.+-hero-collapsed$/.test(key)) localStorage.removeItem(key);
    }
    localStorage.setItem(COMPACT_KEY, on ? '1' : '0');
  } catch { /* the choice just won't persist */ }
  window.dispatchEvent(new Event(PREF_EVENT));
}

export function useCompactBanners(): [boolean, (on: boolean) => void] {
  const [compact, setCompact] = useState(readCompact);
  useEffect(() => {
    const sync = () => setCompact(readCompact());
    window.addEventListener(PREF_EVENT, sync);
    return () => window.removeEventListener(PREF_EVENT, sync);
  }, []);
  return [compact, setCompactBanners];
}

export function useCollapsedHero(page: string): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsedState] = useState(() => read(page));
  useEffect(() => {
    const sync = () => setCollapsedState(read(page));
    window.addEventListener(PREF_EVENT, sync);
    return () => window.removeEventListener(PREF_EVENT, sync);
  }, [page]);
  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next);
    try { localStorage.setItem(storageKey(page), next ? '1' : '0'); } catch { /* the choice just won't persist */ }
  }, [page]);
  return [collapsed, setCollapsed];
}
