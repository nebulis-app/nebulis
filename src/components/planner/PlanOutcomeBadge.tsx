import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Check, CircleDashed, XCircle, SkipForward, CalendarPlus, Undo2, Loader2 } from 'lucide-react';
import { createPlannedSession, updatePlannedSession, type PlannedSession, type PlanOutcome } from '../../lib/api/plannedSessions';
import { formatDuration } from '../../lib/captureMetrics';

/**
 * Plan vs actual on a scheduled block: how much of the planned time the
 * library actually holds for that object and night (server/lib/planOutcome.ts),
 * plus the follow-ups that make sense once a block is over:
 *   - "Plan again tomorrow" for a missed or partial block (same clock times,
 *     next night), keeping the original as history;
 *   - "Mark skipped" / "Unmark" so a deliberate skip stops reading as missed.
 *
 * Rendered on the dark timeline block, so colours follow its own chips.
 */
const DAY_MS = 86_400_000;

export function PlanOutcomeIcon({ outcome }: { outcome: PlanOutcome | null | undefined }) {
  const { t } = useTranslation('planner');
  if (!outcome) return null;
  const label = t(`planOutcome.status.${outcome.status}`);
  switch (outcome.status) {
    case 'done':
      return <span role="img" aria-label={label} title={label} className="inline-flex shrink-0"><Check className="h-3 w-3 shrink-0 text-emerald-300" /></span>;
    case 'partial':
      return <span role="img" aria-label={label} title={label} className="inline-flex shrink-0"><CircleDashed className="h-3 w-3 shrink-0 text-amber-300" /></span>;
    case 'missed':
      return <span role="img" aria-label={label} title={label} className="inline-flex shrink-0"><XCircle className="h-3 w-3 shrink-0 text-red-300" /></span>;
    case 'skipped':
      return <span role="img" aria-label={label} title={label} className="inline-flex shrink-0"><SkipForward className="h-3 w-3 shrink-0 text-white/40" /></span>;
    default:
      return null;
  }
}

export function PlanOutcomeChip({ outcome }: { outcome: PlanOutcome | null | undefined }) {
  const { t } = useTranslation('planner');
  if (!outcome || outcome.status === 'upcoming') return null;

  const tone =
    outcome.status === 'done'
      ? 'bg-emerald-500/15 text-emerald-200 ring-emerald-300/25'
      : outcome.status === 'partial' || outcome.status === 'in_progress'
        ? 'bg-amber-500/15 text-amber-200 ring-amber-300/25'
        : outcome.status === 'missed'
          ? 'bg-red-500/15 text-red-200 ring-red-300/25'
          : 'bg-white/[0.07] text-white/55 ring-white/10';

  const text = outcome.status === 'skipped' || outcome.status === 'awaiting_import'
    ? t(`planOutcome.status.${outcome.status}`)
    : outcome.status === 'missed'
      ? t('planOutcome.status.missed')
      : t('planOutcome.achieved', {
        achieved: formatDuration(outcome.achievedSec),
        planned: formatDuration(outcome.plannedSec),
      });

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.625rem] font-medium tabular-nums ring-1 ring-inset ${tone}`}
      title={outcome.status === 'awaiting_import'
        ? t('planOutcome.awaitingImportHint')
        : t('planOutcome.title', { status: t(`planOutcome.status.${outcome.status}`), count: outcome.frames })}
    >
      {text}
    </span>
  );
}

/** Follow-up buttons for an ended block. Admin-only surfaces render this. */
export function PlanOutcomeActions({ session }: { session: PlannedSession }) {
  const { t } = useTranslation('planner');
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<'repeat' | 'skip' | null>(null);
  const status = session.outcome?.status;
  if (!status || status === 'upcoming' || status === 'in_progress' || status === 'awaiting_import') return null;

  const run = async (kind: 'repeat' | 'skip', action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(kind);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: ['planned-sessions'] });
    } catch {
      /* the list refetch shows the real state either way */
    } finally {
      setBusy(null);
    }
  };

  const repeat = () => run('repeat', () => createPlannedSession({
    objectId: session.objectId,
    objectName: session.objectName,
    ra: session.ra,
    dec: session.dec,
    startTime: new Date(Date.parse(session.startTime) + DAY_MS).toISOString(),
    endTime: new Date(Date.parse(session.endTime) + DAY_MS).toISOString(),
  }));
  const toggleSkip = () => run('skip', () => updatePlannedSession(session.id, { skipped: status !== 'skipped' }));

  const btn = 'flex h-5 w-5 items-center justify-center rounded-full bg-white/10 transition hover:bg-white/20 disabled:opacity-50';
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <>
      {(status === 'missed' || status === 'partial') && (
        <button
          type="button"
          onClick={(e) => { stop(e); void repeat(); }}
          onPointerDown={stop}
          disabled={busy !== null}
          className={btn}
          aria-label={t('planOutcome.repeatTomorrow')}
          title={t('planOutcome.repeatTomorrow')}
        >
          {busy === 'repeat' ? <Loader2 className="h-3 w-3 animate-spin" /> : <CalendarPlus className="h-3 w-3" />}
        </button>
      )}
      {(status === 'missed' || status === 'skipped') && (
        <button
          type="button"
          onClick={(e) => { stop(e); void toggleSkip(); }}
          onPointerDown={stop}
          disabled={busy !== null}
          className={btn}
          aria-label={status === 'skipped' ? t('planOutcome.unskip') : t('planOutcome.markSkipped')}
          title={status === 'skipped' ? t('planOutcome.unskip') : t('planOutcome.markSkipped')}
        >
          {busy === 'skip'
            ? <Loader2 className="h-3 w-3 animate-spin" />
            : status === 'skipped' ? <Undo2 className="h-3 w-3" /> : <SkipForward className="h-3 w-3" />}
        </button>
      )}
    </>
  );
}
