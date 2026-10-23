import { useCallback, useEffect, useState } from 'react';

/**
 * Per-device interface size, a multiplier on the automatic rem base set in
 * index.css (--ui-scale). 1 means "automatic for this screen". It lives in
 * localStorage rather than server settings because the right value depends on
 * the screen in front of you, not on the account.
 */
export const UI_SCALE_MIN = 0.75;
export const UI_SCALE_MAX = 1.5;
export const UI_SCALE_STEP = 0.05;

const KEY = 'nebulis-ui-scale';
const EVENT = 'nebulis-ui-scale-change';

function clamp(value: number): number {
  const snapped = Math.round(value / UI_SCALE_STEP) * UI_SCALE_STEP;
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, Number(snapped.toFixed(2))));
}

function read(): number {
  try {
    const raw = Number(localStorage.getItem(KEY));
    return Number.isFinite(raw) && raw > 0 ? clamp(raw) : 1;
  } catch {
    return 1;
  }
}

function apply(scale: number): void {
  document.documentElement.style.setProperty('--ui-scale', String(scale));
}

/** Call once before first render so the saved size is applied without a flash. */
export function initUiScale(): void {
  apply(read());
}

export function useUiScale(): [number, (next: number) => void] {
  const [scale, setScaleState] = useState(read);
  useEffect(() => {
    const sync = () => setScaleState(read());
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  const setScale = useCallback((next: number) => {
    const value = clamp(next);
    setScaleState(value);
    apply(value);
    try { localStorage.setItem(KEY, String(value)); } catch { /* the choice just won't persist */ }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [scale, setScale];
}
