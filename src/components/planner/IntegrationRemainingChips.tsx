import { useTranslation } from 'react-i18next';
import { Check, Hourglass } from 'lucide-react';
import { useIntegrationProgress, useIntegrationProgressByLibraryId } from '../../hooks/useIntegrationProgress';
import type { ObjectIntegrationProgress } from '../../lib/api/library';
import { formatDuration } from '../../lib/captureMetrics';

/**
 * "4h left · D2" chips for an object with per-filter integration goals, shown
 * on Planner and Wishlist rows so a campaign's remaining time is visible where
 * the next night gets planned. Renders nothing for objects without goals.
 *
 * Self-contained (reads the shared progress query itself) so memoised rows
 * don't need a new prop threaded through every list.
 *
 * `tone`:
 *   - 'surface': on a normal light/dark card
 *   - 'block':   on a coloured timeline block (white-on-colour, like its chips)
 */
const MAX_CHIPS = 3;

type Tone = 'surface' | 'block';

/** For ids that may be catalog or variant ids (Planner, Wishlist). */
export function IntegrationRemainingChips({
  objectId,
  isDark,
  tone = 'surface',
}: {
  objectId: string;
  isDark: boolean;
  tone?: Tone;
}) {
  const progress = useIntegrationProgress()(objectId);
  return progress ? <RemainingChips progress={progress} isDark={isDark} tone={tone} /> : null;
}

/** For a library object id (Library grid), no catalog resolution needed. */
export function LibraryIntegrationRemainingChips({
  libraryObjectId,
  isDark,
}: {
  libraryObjectId: string;
  isDark: boolean;
}) {
  const progress = useIntegrationProgressByLibraryId().get(libraryObjectId);
  return progress ? <RemainingChips progress={progress} isDark={isDark} tone="surface" /> : null;
}

function RemainingChips({
  progress,
  isDark,
  tone,
}: {
  progress: ObjectIntegrationProgress;
  isDark: boolean;
  tone: Tone;
}) {
  const { t } = useTranslation('planner');

  const chipBase = 'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums';
  const pending = tone === 'block'
    ? 'bg-white/[0.07] text-white/70 ring-1 ring-inset ring-white/10'
    : isDark ? 'bg-accent-500/10 text-accent-300' : 'bg-accent-50 text-accent-700';
  const done = tone === 'block'
    ? 'bg-emerald-500/20 text-emerald-200 ring-1 ring-inset ring-emerald-300/25'
    : isDark ? 'bg-emerald-500/10 text-emerald-400' : 'bg-emerald-50 text-emerald-700';

  const filterName = (f: string | null) => f ?? t('integrationRemaining.noFilter');

  if (progress.complete) {
    return (
      <span className={`${chipBase} ${done}`} title={t('integrationRemaining.completeTitle')}>
        <Check className="h-2.5 w-2.5" />
        {t('integrationRemaining.complete')}
      </span>
    );
  }

  // Largest remaining first: that's the filter the next night should go to.
  const left = progress.filters
    .filter(f => f.remainingSec > 0)
    .sort((a, b) => b.remainingSec - a.remainingSec);
  const shown = left.slice(0, MAX_CHIPS);
  const hidden = left.length - shown.length;

  return (
    <>
      {shown.map(f => (
        <span
          key={f.filter ?? '\u0000none'}
          className={`${chipBase} ${pending}`}
          title={t('integrationRemaining.title', {
            filter: filterName(f.filter),
            done: formatDuration(f.exposureSec),
            goal: formatDuration(f.goalSec),
          })}
        >
          <Hourglass className="h-2.5 w-2.5" />
          {t('integrationRemaining.left', { duration: formatDuration(f.remainingSec), filter: filterName(f.filter) })}
        </span>
      ))}
      {hidden > 0 && <span className={`${chipBase} ${pending}`}>+{hidden}</span>}
    </>
  );
}
