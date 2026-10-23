import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { localDateKey, plannerToday } from '../../lib/nightWindow';
import { isNightKey, nightLabel } from '../../lib/exploreFormat';

/**
 * The night Explore is looking at. Normally tonight; the Planner sends you here with `?night=YYYY-MM-DD` so "up
 * tonight" means "up on the night you are planning". The date lives in the URL, so a link, a refresh and the back
 * button all keep it, and it follows you from the landing page into a category.
 */
export function useExploreNight() {
  const { t, i18n } = useTranslation('catalogs');
  const [params, setParams] = useSearchParams();
  const raw = params.get('night');
  const night = isNightKey(raw) ? raw : null;
  const isTonight = night === null || night === localDateKey(plannerToday());

  const clear = useCallback(() => {
    setParams(prev => {
      const next = new URLSearchParams(prev);
      next.delete('night');
      return next;
    }, { replace: true });
  }, [setParams]);

  return {
    /** The date to send to the server; null is tonight. */
    night,
    /** True for tonight, including when the URL names tonight's own date. */
    isTonight,
    /** "Sat, Oct 11", or null when looking at tonight. */
    dateLabel: !isTonight && night ? nightLabel(night, i18n.language) : null,
    /** "Up tonight" for the chip, or "Up on Sat, Oct 11". Undefined lets the chip use its default. */
    upLabel: !isTonight && night ? t('explore.visibility.upOn', { date: nightLabel(night, i18n.language) }) : undefined,
    clear,
  };
}

/** Adds `night` to an Explore path so the night follows a link. */
export function withNight(path: string, night: string | null): string {
  if (!night) return path;
  return `${path}${path.includes('?') ? '&' : '?'}night=${night}`;
}
