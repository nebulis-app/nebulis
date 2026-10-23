import type { TFunction } from 'i18next';

/** "30 minutes", "1 hour", "2 hours": how far ahead of the dew a warning goes. Whole hours read as hours. */
export function leadLabel(minutes: number, t: TFunction): string {
  return minutes % 60 === 0
    ? t('alerts.detail.leadHours', { count: minutes / 60 })
    : t('alerts.detail.leadMinutes', { count: minutes });
}
