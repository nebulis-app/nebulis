/**
 * One month of observing nights.
 *
 * Two things changed from the version this replaces. The grid always drew six
 * rows, so most months ended on a full row of greyed-out padding that was
 * taller than anything it contained; the trailing row is now dropped when it
 * holds no day of the month. And an entry is now the object's own thumbnail
 * next to its name, which is what makes a month scannable: you recognise a
 * night by the picture you got, not by reading four short words.
 *
 * Year and month navigation lives in the hero (see YearActivity); the
 * month stepper and the way back to today live in the toolbar above the grid
 * (see ObservationsToolbar). This component just draws the month it is given.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CalendarOff, Clock, NotebookPen } from 'lucide-react';
import type { ObservationSummary } from '../../lib/api/observations';
import type { TelescopeProfile } from '../../lib/api/telescopes';
import type { DayPlan } from '../../lib/planNights';
import { PlanResultInline, PlannedNightEntry } from './PlanNightBadges';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { formatDate, weekdayLabels, weekStartsOn } from '../../lib/formatLocale';
import { nightSafeColor } from '../../lib/nightSafeColor';

/** Per-entry height (thumbnail + padding + gap) at each size tier, in px. */
function entryHeight(width: number): number {
  return width >= 2400 ? 38 : 34;
}
/** Space a cell spends on everything but entries: padding, day number, "+N more". */
const CELL_CHROME = 64;
/** Space left under the grid: main's bottom padding plus a small buffer. */
const BOTTOM_BUFFER = 48;
/** Share of the free viewport height the grid fills; the rest is breathing room. */
const FIT_HEIGHT_SHARE = 0.95;
/** At and above this width the month is fitted to the viewport height. */
const FIT_MIN_WIDTH = 1800;

export interface CalendarDay {
  date: string;
  day: number;
  isCurrentMonth: boolean;
}

interface Props {
  days: CalendarDay[];
  observationsByDate: Map<string, ObservationSummary[]>;
  /** Plan vs actual per night (Planner blocks), when available. */
  planByDate?: Map<string, DayPlan>;
  monthLabel: string;
  /** `YYYY-MM-DD`. */
  today: string;
  /** Offered when this month is empty but the record is not. */
  nearestDate: string | null;
  onGoToNearest: () => void;

  telescopeById: Map<string, TelescopeProfile>;
  showTelescopeUI: boolean;
  obsName: (obs: ObservationSummary) => string;
  formatTime: (timestamp: string) => string;

  /** Reports how many entries each cell shows, so the "+N more" popup lists
   *  exactly the rest. */
  onVisiblePerDayChange?: (count: number) => void;
  onExpandDay: (date: string, rect: DOMRect) => void;
  onEntryHoverEnter: (obs: ObservationSummary, target: HTMLElement) => void;
  onEntryHoverLeave: () => void;
  onEntryClick: () => void;

  isDark: boolean;
  isNight: boolean;
  isSpace: boolean;
  accentText: string;
}

/** Weekday header labels in Sunday-first order rotated to start on the
 *  active locale's first day of the week, matching the day grid `days` is
 *  built in (ObservationsCalendar.tsx computes its padding with the same
 *  weekStartsOn() so the two never disagree on which column is which). */
function localeWeekdayHeaders(): string[] {
  const labels = weekdayLabels();
  const start = weekStartsOn();
  return [...labels.slice(start), ...labels.slice(0, start)];
}

export function MonthGrid({
  days, observationsByDate, planByDate, monthLabel, today, nearestDate, onGoToNearest,
  telescopeById, showTelescopeUI, obsName, formatTime,
  onVisiblePerDayChange, onExpandDay, onEntryHoverEnter, onEntryHoverLeave, onEntryClick,
  isDark, isNight, isSpace, accentText,
}: Props) {
  const { t } = useTranslation('observations');
  // Six rows are generated so every month has the same maximum, but a month
  // that fits in five leaves the last one entirely outside itself. Rendering it
  // added a row of empty cells taller than most weeks' content.
  const weeks: CalendarDay[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  while (weeks.length > 1 && weeks[weeks.length - 1].every(d => !d.isCurrentMonth)) weeks.pop();
  const visibleDays = weeks.flat();

  const monthHasObservations = visibleDays.some(
    d => d.isCurrentMonth && (observationsByDate.get(d.date)?.length ?? 0) > 0,
  );

  // Rendered, not just hidden with a breakpoint class. The two layouts hold the
  // same entries, so shipping both puts every observation in the document
  // twice: announced twice by a screen reader, and every thumbnail requested
  // twice. `md` matches the Tailwind breakpoint the grid used to appear at.
  const asAgenda = useMediaQuery('(max-width: 767px)');
  const weekdayHeaders = localeWeekdayHeaders();
  // On wide screens the month is sized to the viewport so it fits without
  // scrolling: rows share the height left below the grid's top edge, and the
  // number of entries per cell follows from the row height.
  const cellsRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ height: number; perDay: number } | null>(null);
  const weekCount = weeks.length;
  useEffect(() => {
    const measure = () => {
      const el = cellsRef.current;
      if (!el || window.innerWidth < FIT_MIN_WIDTH) { setFit(null); return; }
      const top = el.getBoundingClientRect().top + window.scrollY;
      const height = Math.max(320, Math.floor((window.innerHeight - top - BOTTOM_BUFFER) * FIT_HEIGHT_SHARE));
      const rowH = height / weekCount;
      const perDay = Math.max(1, Math.floor((rowH - CELL_CHROME) / entryHeight(window.innerWidth)));
      setFit(prev => (prev && prev.height === height && prev.perDay === perDay ? prev : { height, perDay }));
    };
    measure();
    window.addEventListener('resize', measure);
    const ro = new ResizeObserver(measure);
    // Anything above the grid (hero, toolbar) changing height moves its top edge.
    ro.observe(document.body);
    return () => { window.removeEventListener('resize', measure); ro.disconnect(); };
  }, [weekCount, asAgenda]);
  const visiblePerDay = fit?.perDay ?? 3;
  useEffect(() => { onVisiblePerDayChange?.(visiblePerDay); }, [visiblePerDay, onVisiblePerDayChange]);

  return (
    // The page wraps this (and the toolbar above it) in one bordered card, so
    // the grid itself carries no card chrome.
    <div className="overflow-hidden">
      {/* Phones get the same month as a list. Seven columns at that width
          leaves about 50px a cell, which truncates every object name to
          nothing and leaves a row of thumbnails you cannot identify. The grid
          returns as soon as there is room for it to be readable. */}
      {asAgenda ? (
      <ol>
        {visibleDays
          .filter(d => d.isCurrentMonth && (
            (observationsByDate.get(d.date)?.length ?? 0) > 0
            || (planByDate?.get(d.date)?.unmatched.length ?? 0) > 0
          ))
          .map(day => {
            const dayObs = observationsByDate.get(day.date) ?? [];
            const dayPlan = planByDate?.get(day.date);
            const weekday = formatDate(new Date(`${day.date}T12:00:00`), { weekday: 'short' });
            const isToday = day.date === today;

            return (
              <li
                key={day.date}
                className={`flex gap-3 border-b p-3 last:border-b-0 ${
                  isDark ? 'border-slate-800' : 'border-slate-200'
                }`}
              >
                <div className="w-11 shrink-0 text-center">
                  <div className={`text-[0.625rem] font-medium uppercase tracking-wider ${
                    isDark ? 'text-slate-500' : 'text-slate-400'
                  }`}>
                    {weekday}
                  </div>
                  <div className={`font-display text-xl font-bold tabular-nums leading-tight ${
                    isToday ? accentText : isDark ? 'text-slate-200' : 'text-slate-800'
                  }`}>
                    {day.day}
                  </div>
                </div>

                <div className="min-w-0 flex-1 space-y-1.5">
                  {dayObs.map(obs => {
                    const scope = obs.telescopeId ? telescopeById.get(obs.telescopeId) : null;
                    return (
                      <Link
                        key={obs.id}
                        to={`/observations/${encodeURIComponent(obs.objectId)}/${encodeURIComponent(obs.date)}`}
                        onClick={onEntryClick}
                        className={`flex items-center gap-2.5 rounded-xl p-2 transition ${
                          isDark ? 'bg-slate-800/60 active:bg-slate-800' : 'bg-slate-50 active:bg-slate-100'
                        }`}
                      >
                        <span className={`h-9 w-9 shrink-0 overflow-hidden rounded-lg ${
                          isDark ? 'bg-slate-900' : 'bg-slate-100'
                        }`}>
                          {obs.thumbnailUrl && (
                            <img
                              src={obs.thumbnailUrl}
                              alt=""
                              loading="lazy"
                              className="h-full w-full object-cover"
                              onError={e => {
                                if (e.target instanceof HTMLImageElement) e.target.style.display = 'none';
                              }}
                            />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            {showTelescopeUI && scope && (
                              <span
                                className="h-1.5 w-1.5 shrink-0 rounded-full"
                                style={{ backgroundColor: nightSafeColor(scope.color, isNight) }}
                                aria-hidden="true"
                              />
                            )}
                            <span className={`block truncate text-[0.8125rem] font-medium ${
                              isDark ? 'text-slate-100' : 'text-slate-800'
                            }`}>
                              {obsName(obs)}
                            </span>
                            {obs.hasNotes && (
                              <NotebookPen
                                className={`h-3 w-3 shrink-0 ${accentText}`}
                                aria-label={t('monthGrid.hasSessionNotes')}
                              />
                            )}
                          </span>
                          <span className={`flex items-center gap-2 text-[0.6875rem] tabular-nums ${
                            isDark ? 'text-slate-500' : 'text-slate-400'
                          }`}>
                            {obs.startTime && (
                              <span className="inline-flex items-center gap-1">
                                <Clock className="h-2.5 w-2.5" />
                                {formatTime(obs.startTime)}
                              </span>
                            )}
                            {obs.fileCount > 0 && <span>{t('monthGrid.fileCount', { count: obs.fileCount })}</span>}
                            {dayPlan?.byObject.get(obs.objectId) && (
                              <PlanResultInline plan={dayPlan.byObject.get(obs.objectId)!} isDark={isDark} />
                            )}
                          </span>
                        </span>
                      </Link>
                    );
                  })}
                  {dayPlan?.unmatched.map(plan => (
                    <PlannedNightEntry key={plan.objectId} plan={plan} isDark={isDark} compact={false} />
                  ))}
                </div>
              </li>
            );
          })}
      </ol>
      ) : (
      <>
      {/* Weekday headers */}
      <div className="grid grid-cols-7">
        {weekdayHeaders.map(day => (
          <div
            key={day}
            className={`border-b py-2.5 text-center text-[0.625rem] font-semibold uppercase tracking-[0.12em] ${
              isDark ? 'border-slate-800 text-slate-500' : 'border-slate-200 text-slate-400'
            }`}
          >
            {day}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div
        ref={cellsRef}
        className="grid grid-cols-7"
        style={fit ? { height: fit.height, gridTemplateRows: `repeat(${weekCount}, minmax(0, 1fr))` } : undefined}
      >
        {visibleDays.map(day => {
          const dayObs = observationsByDate.get(day.date) ?? [];
          const hasObs = dayObs.length > 0;
          const isToday = day.date === today;
          const dayPlan = planByDate?.get(day.date);

          return (
            <div
              key={day.date}
              className={`min-h-[96px] min-w-0 overflow-hidden border-b border-r p-1.5 transition-colors last:border-r-0 ${
                !day.isCurrentMonth
                  ? isDark ? 'border-slate-800/60 bg-slate-950/40' : 'border-slate-100 bg-slate-50/60'
                  : isDark ? 'border-slate-800' : 'border-slate-200'
              } ${
                // A tinted cell makes the shape of the month readable before you
                // read a single entry.
                hasObs && day.isCurrentMonth
                  ? isDark ? 'bg-accent-500/[0.04]' : 'bg-accent-50/50'
                  : ''
              }`}
            >
              <div className="mb-1 flex items-center justify-between px-0.5">
                <span className="inline-flex items-center gap-1">
                  <span className={`text-xs font-medium tabular-nums ${
                    isToday
                      ? `${accentText} font-bold`
                      : !day.isCurrentMonth
                        ? isDark ? 'text-slate-700' : 'text-slate-400'
                        : isDark ? 'text-slate-400' : 'text-slate-600'
                  }`}>
                    {day.day}
                  </span>
                  {/* Today's own badge already calls out the date, so the dot
                      would be a second signal for the same cell. */}
                  {hasObs && day.isCurrentMonth && !isToday && (
                    <span
                      className={`h-1 w-1 rounded-full ${isDark ? 'bg-accent-400' : 'bg-accent-500'}`}
                      aria-hidden="true"
                    />
                  )}
                </span>
                {isToday && (
                  <span className={`rounded-full px-1.5 py-px text-[0.5625rem] font-semibold uppercase tracking-wider ${
                    isDark ? 'bg-accent-500/15 text-accent-400' : 'bg-accent-300 text-accent-700'
                  }`}>
                    {t('monthGrid.today')}
                  </span>
                )}
              </div>

              <div className="space-y-1">
                {dayObs.slice(0, visiblePerDay).map(obs => {
                  const scope = obs.telescopeId ? telescopeById.get(obs.telescopeId) : null;
                  return (
                    <Link
                      key={obs.id}
                      to={`/observations/${encodeURIComponent(obs.objectId)}/${encodeURIComponent(obs.date)}`}
                      title={scope ? `${obsName(obs)} · ${scope.name}` : obsName(obs)}
                      onMouseEnter={e => onEntryHoverEnter(obs, e.currentTarget)}
                      onMouseLeave={onEntryHoverLeave}
                      onClick={onEntryClick}
                      className={`flex items-center gap-1.5 rounded-lg p-1 transition ${
                        isNight
                          ? 'bg-red-950/30 hover:bg-red-950/50'
                          : isSpace
                            ? 'bg-violet-900/20 hover:bg-violet-900/30'
                            : isDark
                              ? 'bg-slate-800/70 hover:bg-slate-800'
                              : 'bg-white hover:bg-slate-50 ring-1 ring-inset ring-slate-200'
                      }`}
                    >
                      {/* The picture is the fastest way to recognise a night.
                          A 404 hides the tile rather than the whole entry. */}
                      <span className={`h-6 w-6 min-[1800px]:h-[22px] min-[1800px]:w-[22px] min-[2400px]:h-[26px] min-[2400px]:w-[26px] shrink-0 overflow-hidden rounded-md ${
                        isDark ? 'bg-slate-900' : 'bg-slate-100'
                      }`}>
                        {obs.thumbnailUrl && (
                          <img
                            src={obs.thumbnailUrl}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover"
                            onError={e => {
                              if (e.target instanceof HTMLImageElement) e.target.style.display = 'none';
                            }}
                          />
                        )}
                      </span>

                      <span className="min-w-0 flex-1">
                        <span className={`flex items-center gap-1`}>
                          {showTelescopeUI && scope && (
                            <span
                              className="h-1.5 w-1.5 shrink-0 rounded-full"
                              style={{ backgroundColor: nightSafeColor(scope.color, isNight) }}
                              aria-hidden="true"
                            />
                          )}
                          <span className={`block truncate text-[0.6875rem] min-[1800px]:text-[0.6562rem] min-[2400px]:text-[0.7188rem] font-medium ${
                            isDark ? 'text-slate-100' : 'text-slate-800'
                          }`}>
                            {obsName(obs)}
                          </span>
                          {obs.hasNotes && (
                            <NotebookPen
                              className={`h-2.5 w-2.5 shrink-0 ${accentText}`}
                              aria-label={t('monthGrid.hasSessionNotes')}
                            />
                          )}
                        </span>
                        {(obs.startTime || dayPlan?.byObject.has(obs.objectId)) && (
                          <span className={`flex items-center gap-1 text-[0.625rem] tabular-nums ${
                            isDark ? 'text-slate-500' : 'text-slate-400'
                          }`}>
                            {obs.startTime && (
                              <>
                                <Clock className="h-2.5 w-2.5" />
                                {formatTime(obs.startTime)}
                              </>
                            )}
                            {dayPlan?.byObject.get(obs.objectId) && (
                              <PlanResultInline plan={dayPlan.byObject.get(obs.objectId)!} isDark={isDark} />
                            )}
                          </span>
                        )}
                      </span>
                    </Link>
                  );
                })}

                {dayObs.length > visiblePerDay && (
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      onExpandDay(day.date, e.currentTarget.getBoundingClientRect());
                    }}
                    className={`w-full rounded-md px-2 py-0.5 text-left text-[0.625rem] font-medium transition ${
                      isDark ? 'text-slate-500 hover:bg-accent-500/10 hover:text-accent-400' : 'text-slate-400 hover:bg-accent-50 hover:text-accent-600'
                    }`}
                  >
                    {t('monthGrid.moreCount', { count: dayObs.length - visiblePerDay })}
                  </button>
                )}

                {/* Planned in the Planner but nothing imaged that night. Only
                    on days of this month, two at most to keep cells short. */}
                {day.isCurrentMonth && dayPlan?.unmatched.slice(0, 2).map(plan => (
                  <PlannedNightEntry key={plan.objectId} plan={plan} isDark={isDark} compact />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      </>
      )}

      {/* An empty month is a dead end unless it says where the nights are. */}
      {!monthHasObservations && nearestDate && (
        <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 border-t px-4 py-3 text-[0.8125rem] ${
          isDark ? 'border-slate-800 text-slate-500' : 'border-slate-200 text-slate-400'
        }`}>
          <CalendarOff className="h-3.5 w-3.5 shrink-0" />
          <span>{t('monthGrid.nothingRecordedIn', { month: monthLabel })}</span>
          <button
            onClick={onGoToNearest}
            className={`font-medium transition hover:underline ${accentText}`}
          >
            {t('monthGrid.jumpToClosest')}
          </button>
        </div>
      )}
    </div>
  );
}
