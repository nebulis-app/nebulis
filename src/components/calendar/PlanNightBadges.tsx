import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Check, CircleDashed, XCircle, SkipForward, CalendarClock } from 'lucide-react';
import type { PlanNightSummary } from '../../lib/api/plannedSessions';
import { formatDuration } from '../../lib/captureMetrics';

/**
 * Plan vs actual on the Observations calendar.
 *
 *   - PlanResultInline: on an observation that had been planned, "2h 40m / 3h"
 *     with a status icon.
 *   - PlannedNightEntry: a plan with no observation that night (missed,
 *     skipped, or still to come), as a dashed entry that opens the Planner on
 *     that night.
 */

function statusTone(status: PlanNightSummary['status'], isDark: boolean): string {
  switch (status) {
    case 'done': return isDark ? 'text-emerald-400' : 'text-emerald-600';
    case 'partial':
    case 'in_progress': return isDark ? 'text-amber-400' : 'text-amber-600';
    case 'missed': return isDark ? 'text-red-400' : 'text-red-600';
    default: return isDark ? 'text-slate-500' : 'text-slate-400';
  }
}

function StatusIcon({ status, className }: { status: PlanNightSummary['status']; className: string }) {
  switch (status) {
    case 'done': return <Check className={className} aria-hidden="true" />;
    case 'partial':
    case 'in_progress': return <CircleDashed className={className} aria-hidden="true" />;
    case 'missed': return <XCircle className={className} aria-hidden="true" />;
    case 'skipped': return <SkipForward className={className} aria-hidden="true" />;
    default: return <CalendarClock className={className} aria-hidden="true" />;
  }
}

export function PlanResultInline({ plan, isDark }: { plan: PlanNightSummary; isDark: boolean }) {
  const { t } = useTranslation('observations');
  const status = t(`planOutcome.status.${plan.status}`);
  return (
    <span
      className={`inline-flex items-center gap-0.5 tabular-nums ${statusTone(plan.status, isDark)}`}
      title={t('planOutcome.resultTitle', {
        status,
        achieved: formatDuration(plan.achievedSec),
        planned: formatDuration(plan.plannedSec),
        count: plan.blocks,
      })}
    >
      <StatusIcon status={plan.status} className="h-2.5 w-2.5 shrink-0" />
      <span className="sr-only">{status}: </span>
      {t('planOutcome.achievedOfPlanned', { achieved: formatDuration(plan.achievedSec), planned: formatDuration(plan.plannedSec) })}
    </span>
  );
}

export function PlannedNightEntry({
  plan,
  isDark,
  compact,
}: {
  plan: PlanNightSummary;
  isDark: boolean;
  /** Calendar cell (true) or phone agenda row (false). */
  compact: boolean;
}) {
  const { t } = useTranslation('observations');
  const status = t(`planOutcome.status.${plan.status}`);
  return (
    <Link
      to="/planner"
      state={{ focusDate: plan.night }}
      title={t('planOutcome.plannedTitle', { status, name: plan.objectName, planned: formatDuration(plan.plannedSec) })}
      className={`flex items-center gap-1.5 rounded-lg border border-dashed transition ${
        compact ? 'p-1' : 'p-2'
      } ${
        isDark ? 'border-slate-700 hover:bg-slate-800/60' : 'border-slate-300 hover:bg-slate-50'
      }`}
    >
      <StatusIcon status={plan.status} className={`${compact ? 'h-3 w-3' : 'h-4 w-4'} shrink-0 ${statusTone(plan.status, isDark)}`} />
      <span className="min-w-0 flex-1">
        <span className={`block truncate ${compact ? 'text-[0.6875rem]' : 'text-[0.8125rem]'} ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          {plan.objectName}
        </span>
        <span className={`block text-[0.625rem] ${statusTone(plan.status, isDark)}`}>
          {t('planOutcome.plannedLine', { status, planned: formatDuration(plan.plannedSec) })}
        </span>
      </span>
    </Link>
  );
}
