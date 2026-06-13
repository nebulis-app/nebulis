import { createContext, useContext, useState, useEffect, useCallback, useMemo, createElement, type ReactNode } from 'react';

export type Theme = 'light' | 'dark' | 'space' | 'night';

const VALID_THEMES: Theme[] = ['light', 'dark', 'space', 'night'];

function isTheme(s: string): s is Theme {
  return (VALID_THEMES as string[]).includes(s);
}

function getInitialTheme(): Theme {
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem('nebulis-theme');
    if (stored && isTheme(stored)) return stored;
  }
  return 'dark';
}

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  cycle: () => void;
  isDark: boolean;
  isNight: boolean;
  isSpace: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    const root = document.documentElement;
    VALID_THEMES.forEach(t => root.classList.remove(t));
    root.classList.add(theme);
    root.classList.toggle('dark-base', theme !== 'light');
    localStorage.setItem('nebulis-theme', theme);

    const themeColors: Record<Theme, string> = {
      dark:  '#0a0e17',
      night: '#000000',
      space: '#06050f',
      light: '#f4f6fa',
    };
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    meta.content = themeColors[theme];
  }, [theme]);

  const setTheme = useCallback((t: Theme) => setThemeState(t), []);

  const cycle = useCallback(() => {
    setThemeState(prev => {
      const idx = VALID_THEMES.indexOf(prev);
      return VALID_THEMES[(idx + 1) % VALID_THEMES.length];
    });
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({
    theme,
    setTheme,
    cycle,
    isDark: theme !== 'light',
    isNight: theme === 'night',
    isSpace: theme === 'space',
  }), [theme, setTheme, cycle]);

  return createElement(ThemeContext.Provider, { value }, children);
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
