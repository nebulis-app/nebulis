import { useTranslation } from 'react-i18next';
import { Filter } from 'lucide-react';
import { useIntegrationProgress } from '../../hooks/useIntegrationProgress';
import { suggestFilter } from '../../lib/filterSuggestion';
import { formatDuration } from '../../lib/captureMetrics';
import type { FilterBand } from '../../lib/moonProximity';

/**
 * In a block's details: the filter to shoot through, from the object's
 * integration goals (most time left) and the Moon (narrowband only when it
 * is too close for broadband). Renders nothing for an object without goals.
 */
export function FilterSuggestionPanel({
  objectId,
  moon,
  currentFilter,
  onUse,
  isDark,
}: {
  objectId: string;
  /** Closest approach for the block (or the night, for an unscheduled target). */
  moon: { minSeparation: number; illumination: number } | null;
  currentFilter?: string | null;
  /** Sets the block's filter; absent for an unscheduled target. */
  onUse?: (filter: string | null, band: FilterBand) => void;
  isDark: boolean;
}) {
  const { t } = useTranslation('planner');
  const progress = useIntegrationProgress()(objectId);
  if (!progress || !moon) return null;

  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const name = (f: string | null) => f ?? t('integrationRemaining.noFilter');

  if (progress.complete) {
    return <p className={`text-xs ${muted}`}>{t('filterSuggestion.complete')}</p>;
  }
  const suggestion = suggestFilter(progress, moon);
  const isCurrent = suggestion && (currentFilter ?? null) === suggestion.filter;

  return (
    <div className={`rounded-lg px-2.5 py-2 text-xs ${isDark ? 'bg-slate-800/50 text-slate-300' : 'bg-slate-100 text-slate-600'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Filter className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {suggestion ? (
          <span>
            {t('filterSuggestion.suggest', { filter: name(suggestion.filter), left: formatDuration(suggestion.remainingSec) })}
          </span>
        ) : (
          <span>{t('filterSuggestion.noneTonight')}</span>
        )}
        {suggestion && onUse && (
          isCurrent ? (
            <span className={`ml-auto ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>{t('filterSuggestion.inUse')}</span>
          ) : (
            <button
              type="button"
              onClick={() => onUse(suggestion.filter, suggestion.band)}
              className="ml-auto rounded-md bg-accent-500 px-2 py-0.5 font-semibold text-white transition hover:bg-accent-600"
            >
              {t('filterSuggestion.use', { filter: name(suggestion.filter) })}
            </button>
          )
        )}
      </div>
      {suggestion && suggestion.ruledOutByMoon.length > 0 && (
        <p className={`mt-1 ${muted}`}>
          {t('filterSuggestion.ruledOut', {
            filters: suggestion.ruledOutByMoon.map(f => `${name(f.filter)} (${formatDuration(f.remainingSec)})`).join(', '),
          })}
        </p>
      )}
    </div>
  );
}
