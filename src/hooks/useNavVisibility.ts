import { createContext, useContext, useState, useCallback, useMemo, createElement, type ReactNode } from 'react';

export type NavItemId = 'forecast' | 'planner' | 'catalogs' | 'help';

export const NAV_ITEMS: { id: NavItemId; label: string }[] = [
  { id: 'forecast', label: 'Forecast' },
  { id: 'planner',  label: 'Planner' },
  { id: 'catalogs', label: 'Catalogs' },
  { id: 'help',     label: 'Help' },
];

const STORAGE_KEY = 'nebulis-nav-hidden';

/** Nav items that default to hidden as of this change, until the user turns
 *  them on in Settings → General. A brand-new browser has no `STORAGE_KEY`
 *  entry at all, so these could just be the fallback for a missing key — but
 *  most real users already have one (even an empty `[]`, written the first
 *  time the provider ever mounted), which would otherwise mask the new
 *  default forever. `FORECAST_DEFAULT_SEEDED_KEY` below applies it once,
 *  regardless of what's already stored, the same "seen/applied once" pattern
 *  TourProvider uses for its tour-seen flag. */
const DEFAULT_HIDDEN: NavItemId[] = ['forecast'];
const FORECAST_DEFAULT_SEEDED_KEY = 'nebulis-nav-forecast-default-seeded-v1';

function getInitialHidden(): Set<NavItemId> {
  if (typeof window === 'undefined') return new Set(DEFAULT_HIDDEN);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as string[]) : [];
    const valid = parsed.filter((id): id is NavItemId =>
      NAV_ITEMS.some(item => item.id === id)
    );
    const hidden = new Set(valid);

    // One-time seed: merge in the new default exactly once per browser, then
    // never again — a later explicit re-enable (toggle() writing forecast
    // back out of the stored set) must stick on every future load.
    if (localStorage.getItem(FORECAST_DEFAULT_SEEDED_KEY) !== '1') {
      for (const id of DEFAULT_HIDDEN) hidden.add(id);
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...hidden]));
      localStorage.setItem(FORECAST_DEFAULT_SEEDED_KEY, '1');
    }

    return hidden;
  } catch {
    return new Set(DEFAULT_HIDDEN);
  }
}

interface NavVisibilityContextValue {
  hidden: Set<NavItemId>;
  isVisible: (id: NavItemId) => boolean;
  toggle: (id: NavItemId) => void;
}

const NavVisibilityContext = createContext<NavVisibilityContextValue | null>(null);

export function NavVisibilityProvider({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState<Set<NavItemId>>(getInitialHidden);

  const toggle = useCallback((id: NavItemId) => {
    setHidden(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

  const isVisible = useCallback((id: NavItemId) => !hidden.has(id), [hidden]);

  const value = useMemo<NavVisibilityContextValue>(
    () => ({ hidden, isVisible, toggle }),
    [hidden, isVisible, toggle]
  );

  return createElement(NavVisibilityContext.Provider, { value }, children);
}

export function useNavVisibility(): NavVisibilityContextValue {
  const ctx = useContext(NavVisibilityContext);
  if (!ctx) throw new Error('useNavVisibility must be used within NavVisibilityProvider');
  return ctx;
}
