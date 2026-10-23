/**
 * Cloud cover, coloured as a verdict. Less is better, so this runs the opposite
 * way to most bars: clear is the good end. The three steps are the same
 * traffic-light the planner uses for a scheduled block.
 */
export function cloudVerdict(pct: number, t: (key: string) => string, isNight: boolean): { label: string; hex: string } {
  if (isNight) {
    if (pct <= 15) return { label: t('observationDetail.conditionsPanel.cloudClear'), hex: '#cc3333' };
    if (pct <= 40) return { label: t('observationDetail.conditionsPanel.cloudMostlyClear'), hex: '#a02828' };
    if (pct <= 70) return { label: t('observationDetail.conditionsPanel.cloudBroken'), hex: '#882222' };
    return { label: t('observationDetail.conditionsPanel.cloudOvercast'), hex: '#661a1a' };
  }
  if (pct <= 15) return { label: t('observationDetail.conditionsPanel.cloudClear'), hex: '#10b981' };
  if (pct <= 40) return { label: t('observationDetail.conditionsPanel.cloudMostlyClear'), hex: '#34d399' };
  if (pct <= 70) return { label: t('observationDetail.conditionsPanel.cloudBroken'), hex: '#f59e0b' };
  return { label: t('observationDetail.conditionsPanel.cloudOvercast'), hex: '#ef4444' };
}
