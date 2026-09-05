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
import { Link } from 'react-router-dom';
import { CalendarOff, Clock, NotebookPen } from 'lucide-react';
import type { ObservationSummary } from '../../lib/api/observations';
import type { TelescopeProfile } from '../../lib/api/telescopes';
import { useMediaQuery } from '../../hooks/useMediaQuery';

/** How many entries fit a cell before the rest go behind "+N more". */
const VISIBLE_PER_DAY = 3;

export interface CalendarDay {
  date: string;
  day: number;
  isCurrentMonth: boolean;
}

interface Props {
  days: CalendarDay[];
  observationsByDate: Map<string, ObservationSummary[]>;
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

  onExpandDay: (date: string, rect: DOMRect) => void;
  onEntryHoverEnter: (obs: ObservationSummary, target: HTMLElement) => void;
  onEntryHoverLeave: () => void;
  onEntryClick: () => void;

  isDark: boolean;
  isNight: boolean;
  isSpace: boolean;
  accentText: string;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function MonthGrid({
  days, observationsByDate, monthLabel, today, nearestDate, onGoToNearest,
  telescopeById, showTelescopeUI, obsName, formatTime,
  onExpandDay, onEntryHoverEnter, onEntryHoverLeave, onEntryClick,
  isDark, isNight, isSpace, accentText,
}: Props) {
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
          .filter(d => d.isCurrentMonth && (observationsByDate.get(d.date)?.length ?? 0) > 0)
          .map(day => {
            const dayObs = observationsByDate.get(day.date) ?? [];
            const weekday = new Date(`${day.date}T12:00:00`)
              .toLocaleDateString('en-US', { weekday: 'short' });
            const isToday = day.date === today;

            return (
              <li
                key={day.date}
                className={`flex gap-3 border-b p-3 last:border-b-0 ${
                  isDark ? 'border-slate-800' : 'border-slate-200'
                }`}
              >
                <div className="w-11 shrink-0 text-center">
                  <div className={`text-[10px] font-medium uppercase tracking-wider ${
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
                                style={{ backgroundColor: scope.color }}
                                aria-hidden="true"
                              />
                            )}
                            <span className={`block truncate text-[13px] font-medium ${
                              isDark ? 'text-slate-100' : 'text-slate-800'
                            }`}>
                              {obsName(obs)}
                            </span>
                            {obs.hasNotes && (
                              <NotebookPen
                                className={`h-3 w-3 shrink-0 ${accentText}`}
                                aria-label="Has session notes"
                              />
                            )}
                          </span>
                          <span className={`flex items-center gap-2 text-[11px] tabular-nums ${
                            isDark ? 'text-slate-500' : 'text-slate-400'
                          }`}>
                            {obs.startTime && (
                              <span className="inline-flex items-center gap-1">
                                <Clock className="h-2.5 w-2.5" />
                                {formatTime(obs.startTime)}
                              </span>
                            )}
                            {obs.fileCount > 0 && <span>{obs.fileCount} files</span>}
                          </span>
                        </span>
                      </Link>
                    );
                  })}
                </div>
              </li>
            );
          })}
      </ol>
      ) : (
      <>
      {/* Weekday headers */}
      <div className="grid grid-cols-7">
        {WEEKDAYS.map(day => (
          <div
            key={day}
            className={`border-b py-2.5 text-center text-[10px] font-semibold uppercase tracking-[0.12em] ${
              isDark ? 'border-slate-800 text-slate-500' : 'border-slate-200 text-slate-400'
            }`}
          >
            {day}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div className="grid grid-cols-7">
        {visibleDays.map(day => {
          const dayObs = observationsByDate.get(day.date) ?? [];
          const hasObs = dayObs.length > 0;
          const isToday = day.date === today;

          return (
            <div
              key={day.date}
              className={`min-h-[96px] border-b border-r p-1.5 transition-colors last:border-r-0 ${
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
                <span className={`text-xs font-medium tabular-nums ${
                  isToday
                    ? `${accentText} font-bold`
                    : !day.isCurrentMonth
                      ? isDark ? 'text-slate-700' : 'text-slate-400'
                      : isDark ? 'text-slate-400' : 'text-slate-600'
                }`}>
                  {day.day}
                </span>
                {isToday && (
                  <span className={`rounded-full px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider ${
                    isDark ? 'bg-accent-500/15 text-accent-400' : 'bg-accent-300 text-accent-700'
                  }`}>
                    Today
                  </span>
                )}
              </div>

              <div className="space-y-1">
                {dayObs.slice(0, VISIBLE_PER_DAY).map(obs => {
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
                      <span className={`h-6 w-6 shrink-0 overflow-hidden rounded-md ${
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
                              style={{ backgroundColor: scope.color }}
                              aria-hidden="true"
                            />
                          )}
                          <span className={`block truncate text-[11px] font-medium ${
                            isDark ? 'text-slate-100' : 'text-slate-800'
                          }`}>
                            {obsName(obs)}
                          </span>
                          {obs.hasNotes && (
                            <NotebookPen
                              className={`h-2.5 w-2.5 shrink-0 ${accentText}`}
                              aria-label="Has session notes"
                            />
                          )}
                        </span>
                        {obs.startTime && (
                          <span className={`flex items-center gap-1 text-[10px] tabular-nums ${
                            isDark ? 'text-slate-500' : 'text-slate-400'
                          }`}>
                            <Clock className="h-2.5 w-2.5" />
                            {formatTime(obs.startTime)}
                          </span>
                        )}
                      </span>
                    </Link>
                  );
                })}

                {dayObs.length > VISIBLE_PER_DAY && (
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      onExpandDay(day.date, e.currentTarget.getBoundingClientRect());
                    }}
                    className={`w-full rounded-md px-2 py-0.5 text-left text-[10px] font-medium transition ${
                      isDark ? 'text-slate-500 hover:bg-accent-500/10 hover:text-accent-400' : 'text-slate-400 hover:bg-accent-50 hover:text-accent-600'
                    }`}
                  >
                    +{dayObs.length - VISIBLE_PER_DAY} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      </>
      )}

      {/* An empty month is a dead end unless it says where the nights are. */}
      {!monthHasObservations && nearestDate && (
        <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 border-t px-4 py-3 text-[13px] ${
          isDark ? 'border-slate-800 text-slate-500' : 'border-slate-200 text-slate-400'
        }`}>
          <CalendarOff className="h-3.5 w-3.5 shrink-0" />
          <span>Nothing recorded in {monthLabel}.</span>
          <button
            onClick={onGoToNearest}
            className={`font-medium transition hover:underline ${accentText}`}
          >
            Jump to the closest night
          </button>
        </div>
      )}
    </div>
  );
}
