/**
 * Month-grid popover for picking a planning date and browsing history.
 *
 * Renders a Sun-Sat grid for the visible month. Days with any saved planned
 * sessions get a small dot indicator. "Today" is highlighted with a ring,
 * the currently-selected day with a solid fill.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { listPlannedSessions } from '../../lib/api/plannedSessions';
import { localDateKey, plannerDateKeyForInstant, plannerToday, sameLocalDay } from '../../lib/nightWindow';
import { useTheme } from '../../hooks/useTheme';
import { formatDate, weekdayLabels, weekStartsOn } from '../../lib/formatLocale';

interface PlanCalendarProps {
  selectedDate: Date;
  observerTimezone?: string;
  onSelect: (date: Date) => void;
  onClose: () => void;
}

/** Sunday-first weekday initials rotated to the active locale's first day of
 *  the week, matching the pattern in calendar/MonthGrid.tsx. */
function localeWeekdayHeaders(): string[] {
  const labels = weekdayLabels('narrow');
  const start = weekStartsOn();
  return [...labels.slice(start), ...labels.slice(0, start)];
}

export function PlanCalendar({ selectedDate, observerTimezone, onSelect, onClose }: PlanCalendarProps) {
  const { t } = useTranslation('planner');
  const { isDark } = useTheme();
  const dayLabels = useMemo(() => localeWeekdayHeaders(), []);
  const today = useMemo(() => plannerToday(new Date(), observerTimezone), [observerTimezone]);
  // Month being viewed in the popover — separate from the selected date so
  // the user can flip through months without losing their pick.
  const [viewMonth, setViewMonth] = useState(() => new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));

  // Pull every session whose start time falls anywhere in the visible month.
  // Cheap: usually tens of rows. If a user accumulates years of plans, we
  // can later add a dedicated /planned-sessions/dates endpoint.
  const monthStart = useMemo(() => new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1), [viewMonth]);
  const monthEnd = useMemo(() => new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1), [viewMonth]);
  const sessionsQuery = useQuery({
    queryKey: ['plan-calendar-sessions', monthStart.toISOString(), monthEnd.toISOString()],
    queryFn: () => listPlannedSessions({ from: monthStart.toISOString(), to: monthEnd.toISOString() }),
  });

  const datesWithSessions = useMemo(() => {
    const set = new Set<string>();
    for (const s of sessionsQuery.data ?? []) {
      const start = new Date(s.startTime);
      set.add(plannerDateKeyForInstant(start, observerTimezone));
    }
    return set;
  }, [sessionsQuery.data, observerTimezone]);

  // Build the 6×7 grid of cells starting at the Sunday on or before the 1st.
  const cells = useMemo(() => {
    const first = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
    // Back up to the active locale's first day of the week (matches the
    // rebasing in ObservationsCalendar.tsx, so both grids always agree on
    // which column a date lands in).
    const offset = (first.getDay() - weekStartsOn() + 7) % 7;
    const start = new Date(first);
    start.setDate(start.getDate() - offset);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [viewMonth]);

  const monthLabel = formatDate(viewMonth, { month: 'long', year: 'numeric' });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-20 px-4"
      onClick={onClose}
    >
      <div
        className={`w-80 rounded-2xl shadow-2xl p-4 ${isDark ? 'bg-slate-900 text-slate-100 border border-slate-700' : 'bg-white text-slate-900 border border-slate-200'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={() => setViewMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
            className={`p-1 rounded ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
            aria-label={t('planCalendar.previousMonth')}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="text-sm font-semibold">{monthLabel}</div>
          <button
            onClick={() => setViewMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
            className={`p-1 rounded ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
            aria-label={t('planCalendar.nextMonth')}
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-7 gap-0.5 mb-1">
          {dayLabels.map((d, i) => (
            <div key={i} className={`text-[0.625rem] text-center py-1 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
              {d}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-0.5">
          {cells.map((d, i) => {
            const inMonth = d.getMonth() === viewMonth.getMonth();
            const isToday = sameLocalDay(d, today);
            const isSelected = sameLocalDay(d, selectedDate);
            const hasSessions = datesWithSessions.has(localDateKey(d));
            return (
              <button
                key={i}
                onClick={() => { onSelect(d); onClose(); }}
                className={[
                  'relative aspect-square text-xs rounded transition flex items-center justify-center',
                  !inMonth ? 'opacity-30' : '',
                  isSelected
                    ? 'bg-accent-500 text-white font-medium'
                    : isToday
                      ? `${isDark ? 'ring-1 ring-accent-500 text-accent-300' : 'ring-1 ring-accent-500 text-accent-700'}`
                      : isDark
                        ? 'hover:bg-slate-800 text-slate-200'
                        : 'hover:bg-slate-100 text-slate-700',
                ].join(' ')}
                title={formatDate(d)}
              >
                {d.getDate()}
                {hasSessions && (
                  <span
                    className={`absolute bottom-1 w-1 h-1 rounded-full ${isSelected ? 'bg-white' : 'bg-accent-400'}`}
                    aria-hidden
                  />
                )}
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex items-center justify-between">
          <button
            onClick={() => { onSelect(today); onClose(); }}
            className="text-xs px-2 py-1 rounded bg-accent-500 hover:bg-accent-400 text-white"
          >
            {t('planCalendar.tonight')}
          </button>
          <div className="text-[0.625rem] opacity-60">{t('planCalendar.dotHint')}</div>
        </div>
      </div>
    </div>
  );
}
