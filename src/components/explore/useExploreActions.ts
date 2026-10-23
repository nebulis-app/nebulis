import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWishlist } from '../../hooks/useWishlist';
import { usePlanObject, type PlanResult } from './usePlanObject';
import type { ExploreRow } from '../../lib/api/explore';

/**
 * The actions every Explore surface shares: add to the wishlist, plan tonight
 * or a chosen night, and the little per-card status text that follows a plan
 * attempt. One hook so the landing page, a category page and the object sheet
 * behave identically.
 */
export function useExploreActions(siteId: string | null) {
  const { t } = useTranslation('catalogs');
  const wishlist = useWishlist();
  const plan = usePlanObject(siteId);
  const [planning, setPlanning] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const addRow = useCallback((row: ExploreRow) => {
    wishlist.add({
      objectId: row.id,
      name: row.name,
      type: row.type,
      constellation: row.constellation,
      magnitude: row.magnitude,
      majorAxisArcmin: row.majorAxisArcmin,
    });
  }, [wishlist]);

  const planOnNight = useCallback(
    (row: ExploreRow, date?: string): Promise<PlanResult> =>
      plan({ objectId: row.id, name: row.name, ra: row.ra, dec: row.dec }, date),
    [plan],
  );

  const planTonight = useCallback(async (row: ExploreRow) => {
    setPlanning(row.id);
    const result = await planOnNight(row);
    setPlanning(null);
    const text = result.ok
      ? t('explore.card.planned')
      : result.reason === 'noRoom' ? t('explore.card.noRoom') : t('explore.card.planFailed');
    setNotes(n => ({ ...n, [row.id]: text }));
    setTimeout(() => setNotes(n => {
      const next = { ...n };
      delete next[row.id];
      return next;
    }), 5000);
  }, [planOnNight, t]);

  return { wishlist, addRow, planOnNight, planTonight, planning, notes };
}
