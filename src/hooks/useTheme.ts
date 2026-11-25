import { createContext, useContext, useState, useEffect, useCallback, useMemo, createElement, type ReactNode } from 'react';
import { setUiSetting, UI_SETTINGS_HYDRATED_EVENT } from '../lib/uiSettings';

export type Theme = 'light' | 'dark' | 'space' | 'night';

const VALID_THEMES: Theme[] = ['light', 'dark', 'space', 'night'];

export interface ThemeOption {
  id: Theme;
  labelKey: string;
  descriptionKey: string;
}

// labelKey/descriptionKey rather than literal text: this array is built at
// module load, before any component (and its useTranslation() hook) exists.
// Consumers resolve via t(labelKey, { ns: 'settings' }) — see GeneralSection.tsx.
export const THEME_OPTIONS: ThemeOption[] = [
  { id: 'light', labelKey: 'appearance.light.label', descriptionKey: 'appearance.light.description' },
  { id: 'dark', labelKey: 'appearance.dark.label', descriptionKey: 'appearance.dark.description' },
  { id: 'space', labelKey: 'appearance.space.label', descriptionKey: 'appearance.space.description' },
  { id: 'night', labelKey: 'appearance.night.label', descriptionKey: 'appearance.night.description' },
];

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

const NEBULA_BACKDROP_KEY = 'nebulis-nebula-backdrop';

function getInitialNebulaBackdrop(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(NEBULA_BACKDROP_KEY) === '1';
}

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  cycle: () => void;
  isDark: boolean;
  isNight: boolean;
  isSpace: boolean;
  /** User preference for the faint nebula/starfield backdrop. Persists across
   *  theme changes but only takes visual effect under the Dark theme. */
  nebulaBackdrop: boolean;
  setNebulaBackdrop: (on: boolean) => void;
  /** `nebulaBackdrop` AND the Dark theme is active — i.e. the backdrop is
   *  actually being drawn right now. Drives the app shell dropping its opaque
   *  fill so the fixed backdrop shows through. */
  showNebulaBackdrop: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(getInitialTheme);
  const [nebulaBackdrop, setNebulaBackdropState] = useState<boolean>(getInitialNebulaBackdrop);

  // This provider mounts before sign-in, so it read this browser's copy. Pick up the user's saved values once
  // they arrive (see lib/uiSettings.ts).
  useEffect(() => {
    const reload = () => {
      setThemeState(getInitialTheme());
      setNebulaBackdropState(getInitialNebulaBackdrop());
    };
    window.addEventListener(UI_SETTINGS_HYDRATED_EVENT, reload);
    return () => window.removeEventListener(UI_SETTINGS_HYDRATED_EVENT, reload);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    VALID_THEMES.forEach(t => root.classList.remove(t));
    root.classList.add(theme);
    root.classList.toggle('dark-base', theme !== 'light');
    setUiSetting('nebulis-theme', theme);

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

  // Only drawn under the Dark theme: Space has its own full starfield and Night
  // needs a pure-black ground for dark adaptation. The preference itself is
  // kept regardless, so switching away and back restores it.
  const showNebulaBackdrop = nebulaBackdrop && theme === 'dark';

  useEffect(() => {
    document.documentElement.classList.toggle('nebula-backdrop', showNebulaBackdrop);
  }, [showNebulaBackdrop]);

  const setTheme = useCallback((t: Theme) => setThemeState(t), []);

  const setNebulaBackdrop = useCallback((on: boolean) => {
    setNebulaBackdropState(on);
    setUiSetting(NEBULA_BACKDROP_KEY, on ? '1' : '0');
  }, []);

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
    nebulaBackdrop,
    setNebulaBackdrop,
    showNebulaBackdrop,
  }), [theme, setTheme, cycle, nebulaBackdrop, setNebulaBackdrop, showNebulaBackdrop]);

  return createElement(ThemeContext.Provider, { value }, children);
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
