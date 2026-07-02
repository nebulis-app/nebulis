/**
 * Month-grid popover for picking a planning date and browsing history.
 *
 * Renders a Sun-Sat grid for the visible month. Days with any saved planned
 * sessions get a small dot indicator. "Today" is highlighted with a ring,
 * the currently-selected day with a solid fill.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { listPlannedSessions } from '../../lib/api/plannedSessions';
import { localDateKey, plannerDateKeyForInstant, plannerToday, sameLocalDay } from '../../lib/nightWindow';
import { useTheme } from '../../hooks/useTheme';

interface PlanCalendarProps {
  selectedDate: Date;
  observerTimezone?: string;
  onSelect: (date: Date) => void;
  onClose: () => void;
}

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export function PlanCalendar({ selectedDate, observerTimezone, onSelect, onClose }: PlanCalendarProps) {
  const { isDark } = useTheme();
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
    const start = new Date(first);
    start.setDate(start.getDate() - start.getDay()); // back up to Sunday
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [viewMonth]);

  const monthLabel = viewMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

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
            aria-label="Previous month"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="text-sm font-semibold">{monthLabel}</div>
          <button
            onClick={() => setViewMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
            className={`p-1 rounded ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
            aria-label="Next month"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-7 gap-0.5 mb-1">
          {DAY_LABELS.map((d, i) => (
            <div key={i} className={`text-[10px] text-center py-1 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
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
                title={d.toLocaleDateString()}
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
            Tonight
          </button>
          <div className="text-[10px] opacity-60">Dot = planned sessions</div>
        </div>
      </div>
    </div>
  );
}
