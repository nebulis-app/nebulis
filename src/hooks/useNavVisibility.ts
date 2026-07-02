import { createContext, useContext, useState, useCallback, useMemo, createElement, type ReactNode } from 'react';

export type NavItemId = 'forecast' | 'planner' | 'catalogs' | 'help';

export const NAV_ITEMS: { id: NavItemId; label: string }[] = [
  { id: 'forecast', label: 'Forecast' },
  { id: 'planner',  label: 'Planner' },
  { id: 'catalogs', label: 'Catalogs' },
  { id: 'help',     label: 'Help' },
];

const STORAGE_KEY = 'nebulis-nav-hidden';

function getInitialHidden(): Set<NavItemId> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as string[];
    const valid = parsed.filter((id): id is NavItemId =>
      NAV_ITEMS.some(item => item.id === id)
    );
    return new Set(valid);
  } catch {
    return new Set();
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
