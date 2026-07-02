import { useQuery } from '@tanstack/react-query';
import { useState, useMemo, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Clock,
  Star,
  Layers,
  Image as ImageIcon,
  Pencil,
  NotebookPen,
  Telescope as TelescopeIcon,
} from 'lucide-react';
import { getObservations, type ObservationSummary } from '../lib/api/observations';
import { listTelescopes, type TelescopeProfile } from '../lib/api/telescopes';
import { useTheme } from '../hooks/useTheme';
import { cleanCatalogId, formatObjectName } from '../lib/utils';

const ALL_TELESCOPES_FILTER = '__all__';

function obsName(obs: ObservationSummary): string {
  const id = cleanCatalogId(obs.objectId);
  const name = cleanCatalogId(obs.objectName);
  return formatObjectName(id, name);
}

export function ObservationsCalendar() {
  const { isDark, isNight, isSpace } = useTheme();
  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });

  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [expandedDayRect, setExpandedDayRect] = useState<DOMRect | null>(null);
  const expandedRef = useRef<HTMLDivElement>(null);

  // ── Hover-preview state ─────────────────────────────────────────────
  // A single shared preview tile that follows whichever observation the
  // user is hovering over. Shows after a 700 ms dwell so quick mouse
  // sweeps across the calendar don't trigger flashes; instant-swaps when
  // moving from one entry to another while a preview is already up.
  // Positioned beside the entry rather than below it so the cursor can
  // continue down the day cell to the next observation without colliding.
  const [hoverPreview, setHoverPreview] = useState<{
    obs: ObservationSummary;
    rect: DOMRect;
  } | null>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearHoverTimers = () => {
    if (showTimerRef.current) clearTimeout(showTimerRef.current);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    showTimerRef.current = undefined;
    hideTimerRef.current = undefined;
  };

  const handleObsHoverEnter = (obs: ObservationSummary, target: HTMLElement) => {
    clearHoverTimers();
    const rect = target.getBoundingClientRect();
    if (hoverPreview) {
      // Preview already up — swap instantly to the new entry
      setHoverPreview({ obs, rect });
    } else {
      showTimerRef.current = setTimeout(() => {
        setHoverPreview({ obs, rect });
      }, 700);
    }
  };

  const handleObsHoverLeave = () => {
    if (showTimerRef.current) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = undefined;
    }
    // Small grace period — gives the user time to land on an adjacent
    // entry without the preview blinking off and back on.
    hideTimerRef.current = setTimeout(() => setHoverPreview(null), 150);
  };

  // Tear down timers on unmount.
  useEffect(() => () => clearHoverTimers(), []);

  const { data: observations, isLoading } = useQuery({
    queryKey: ['observations'],
    queryFn: getObservations,
    staleTime: 5 * 60 * 1000,
  });
  const { data: telescopes = [] } = useQuery({
    queryKey: ['telescopes'],
    queryFn: listTelescopes,
  });
  const showTelescopeUI = telescopes.length >= 2;
  const [telescopeFilter, setTelescopeFilter] = useState<string>(ALL_TELESCOPES_FILTER);
  const telescopeById = useMemo(() => {
    const map = new Map<string, TelescopeProfile>();
    for (const t of telescopes) map.set(t.id, t);
    return map;
  }, [telescopes]);
  // Reset the filter if the selected telescope is removed.
  useEffect(() => {
    if (telescopeFilter === ALL_TELESCOPES_FILTER) return;
    if (!telescopeById.has(telescopeFilter)) setTelescopeFilter(ALL_TELESCOPES_FILTER);
  }, [telescopeById, telescopeFilter]);

  // Close expanded popover on outside click or Escape
  useEffect(() => {
    if (!expandedDay) return;
    const handleClick = (e: MouseEvent) => {
      // `e.target` is `EventTarget | null` — guard with `instanceof Node`
      // so a null/non-Node target can't sneak past `contains`.
      if (
        expandedRef.current &&
        e.target instanceof Node &&
        !expandedRef.current.contains(e.target)
      ) {
        setExpandedDay(null);
        setExpandedDayRect(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setExpandedDay(null); setExpandedDayRect(null); }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [expandedDay]);

  // Group observations by date, after applying the telescope filter.
  const filteredObservations = useMemo(() => {
    if (!observations) return [];
    if (telescopeFilter === ALL_TELESCOPES_FILTER) return observations;
    return observations.filter(o => o.telescopeId === telescopeFilter);
  }, [observations, telescopeFilter]);

  const observationsByDate = useMemo(() => {
    const map = new Map<string, ObservationSummary[]>();
    for (const obs of filteredObservations) {
      const existing = map.get(obs.date) || [];
      existing.push(obs);
      map.set(obs.date, existing);
    }
    // Sort each day chronologically by startTime so the earliest observation
    // appears first. startTime is the SeeStar-style "YYYYMMDD-HHMMSS" string,
    // which lexicographically matches chronological order. Manual entries
    // without a startTime sort to the end.
    for (const list of map.values()) {
      list.sort((a, b) => {
        if (!a.startTime && !b.startTime) return 0;
        if (!a.startTime) return 1;
        if (!b.startTime) return -1;
        return a.startTime.localeCompare(b.startTime);
      });
    }
    return map;
  }, [filteredObservations]);

  // Calendar grid generation
  const calendarDays = useMemo(() => {
    const { year, month } = currentMonth;
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startOffset = firstDay.getDay(); // 0=Sunday
    const daysInMonth = lastDay.getDate();

    const days: Array<{ date: string; day: number; isCurrentMonth: boolean }> = [];

    // Previous month padding
    const prevMonthLast = new Date(year, month, 0).getDate();
    for (let i = startOffset - 1; i >= 0; i--) {
      const d = prevMonthLast - i;
      const prevMonth = month === 0 ? 11 : month - 1;
      const prevYear = month === 0 ? year - 1 : year;
      const dateStr = `${prevYear}-${String(prevMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      days.push({ date: dateStr, day: d, isCurrentMonth: false });
    }

    // Current month
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      days.push({ date: dateStr, day: d, isCurrentMonth: true });
    }

    // Next month padding
    const remaining = 42 - days.length; // 6 rows x 7 days
    for (let d = 1; d <= remaining; d++) {
      const nextMonth = month === 11 ? 0 : month + 1;
      const nextYear = month === 11 ? year + 1 : year;
      const dateStr = `${nextYear}-${String(nextMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      days.push({ date: dateStr, day: d, isCurrentMonth: false });
    }

    return days;
  }, [currentMonth]);

  const monthLabel = new Date(currentMonth.year, currentMonth.month).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });

  const navigateMonth = (direction: -1 | 1) => {
    setCurrentMonth(prev => {
      let { year, month } = prev;
      month += direction;
      if (month < 0) { month = 11; year--; }
      if (month > 11) { month = 0; year++; }
      return { year, month };
    });
  };

  // Month/year picker popup
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerYear, setPickerYear] = useState(currentMonth.year);
  const pickerRef = useRef<HTMLDivElement>(null);
  const thisYear = new Date().getFullYear();

  const openPicker = () => {
    setPickerYear(currentMonth.year);
    setPickerOpen(true);
  };

  useEffect(() => {
    if (!pickerOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (pickerRef.current && e.target instanceof Node && !pickerRef.current.contains(e.target))
        setPickerOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPickerOpen(false); };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [pickerOpen]);

  const today = new Date().toISOString().split('T')[0];

  // Stats — reflect the filtered view so the header subtitle agrees with the grid.
  const totalObservations = filteredObservations.length;
  const uniqueObjects = new Set(filteredObservations.map(o => o.objectId)).size;

  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500';
  const accentBg = isNight ? 'bg-red-500' : isSpace ? 'bg-violet-500' : 'bg-accent-500';

  return (
    <div className="space-y-4">
      {/* Header — title left, telescope selector right */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className={`font-display text-3xl font-bold tracking-tight flex items-center gap-3 ${isDark ? 'text-white' : 'text-slate-900'}`}>
            <Calendar className={`w-7 h-7 ${accentText}`} />
            Observations
          </h1>
          <p className={`text-sm mt-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {totalObservations} observations across {uniqueObjects} objects
          </p>
        </div>

        {showTelescopeUI && (
          <div className="flex items-center gap-1.5 shrink-0 mt-1">
            <TelescopeIcon className={`w-3.5 h-3.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
            <select
              id="telescope-filter"
              value={telescopeFilter}
              onChange={e => setTelescopeFilter(e.target.value)}
              className={`text-xs px-2 py-1 rounded-lg border ${
                isDark
                  ? 'bg-slate-800 border-slate-700 text-slate-300'
                  : 'bg-white border-slate-200 text-slate-600'
              }`}
            >
              <option value={ALL_TELESCOPES_FILTER}>All telescopes</option>
              {telescopes.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Month navigation */}
      <div className={`flex items-center justify-between rounded-xl border px-2 py-1.5 ${
        isDark ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
      }`}>
        <button
          onClick={() => navigateMonth(-1)}
          className={`p-1.5 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
          aria-label="Previous month"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        {/* Clickable month/year — opens picker popup */}
        <div className="relative" ref={pickerRef}>
          <button
            onClick={openPicker}
            className={`font-display font-semibold text-sm px-3 py-1 rounded-lg transition ${
              isDark ? 'text-white hover:bg-slate-800' : 'text-slate-900 hover:bg-slate-100'
            }`}
          >
            {monthLabel}
          </button>

          {pickerOpen && (
            <div className={`absolute top-full left-1/2 -translate-x-1/2 mt-1 z-50 rounded-xl border shadow-xl p-3 w-56 ${
              isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'
            }`}>
              {/* Year navigation */}
              <div className="flex items-center justify-between mb-2">
                <button
                  onClick={() => setPickerYear(y => Math.max(2018, y - 1))}
                  className={`p-1 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
                  aria-label="Previous year"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <span className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                  {pickerYear}
                </span>
                <button
                  onClick={() => setPickerYear(y => Math.min(thisYear, y + 1))}
                  className={`p-1 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
                  aria-label="Next year"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Month grid */}
              <div className="grid grid-cols-3 gap-1">
                {['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map((m, i) => {
                  const isSelected = pickerYear === currentMonth.year && i === currentMonth.month;
                  const isFuture = pickerYear > thisYear || (pickerYear === thisYear && i > new Date().getMonth());
                  return (
                    <button
                      key={m}
                      disabled={isFuture}
                      onClick={() => { setCurrentMonth({ year: pickerYear, month: i }); setPickerOpen(false); }}
                      className={`text-xs py-1.5 rounded-lg transition font-medium ${
                        isSelected
                          ? `${isDark ? 'bg-accent-500 text-white' : 'bg-accent-500 text-white'}`
                          : isFuture
                            ? `${isDark ? 'text-slate-700' : 'text-slate-300'} cursor-not-allowed`
                            : `${isDark ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-700 hover:bg-slate-100'}`
                      }`}
                    >
                      {m}
                    </button>
                  );
                })}
              </div>

              {/* Jump to today */}
              <button
                onClick={() => {
                  const now = new Date();
                  setCurrentMonth({ year: now.getFullYear(), month: now.getMonth() });
                  setPickerOpen(false);
                }}
                className={`mt-2 w-full text-xs py-1 rounded-lg transition ${
                  isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'
                }`}
              >
                Today
              </button>
            </div>
          )}
        </div>

        <button
          onClick={() => navigateMonth(1)}
          className={`p-1.5 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
          aria-label="Next month"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {/* Calendar grid */}
      {isLoading ? (
        <div className={`rounded-2xl border p-8 text-center ${isDark ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200'}`}>
          <div className="animate-pulse flex flex-col items-center gap-3">
            <Calendar className={`w-8 h-8 ${isDark ? 'text-slate-700' : 'text-slate-300'}`} />
            <p className={isDark ? 'text-slate-600' : 'text-slate-400'}>Loading observations...</p>
          </div>
        </div>
      ) : (
        <div className={`rounded-2xl border overflow-hidden ${
          isDark ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
        }`}>
          {/* Day headers */}
          <div className="grid grid-cols-7">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
              <div
                key={day}
                className={`py-3 text-center text-xs font-semibold uppercase tracking-wider border-b ${
                  isDark ? 'text-slate-500 border-slate-800 bg-slate-900' : 'text-slate-400 border-slate-200 bg-slate-50'
                }`}
              >
                {day}
              </div>
            ))}
          </div>

          {/* Day cells */}
          <div className="grid grid-cols-7">
            {calendarDays.map((day) => {
              const dayObs = observationsByDate.get(day.date) || [];
              const hasObs = dayObs.length > 0;
              const isToday = day.date === today;

              return (
                <div
                  key={day.date}
                  className={`min-h-[120px] border-b border-r p-2 transition ${
                    !day.isCurrentMonth
                      ? isDark ? 'bg-slate-950/50 border-slate-800/50' : 'bg-slate-50/50 border-slate-100'
                      : isDark ? 'border-slate-800' : 'border-slate-200'
                  } ${hasObs && day.isCurrentMonth ? isDark ? 'hover:bg-slate-800/30' : 'hover:bg-slate-50' : ''}`}
                >
                  {/* Day number */}
                  <div className="flex items-center justify-between mb-1">
                    <span className={`text-sm font-medium ${
                      isToday
                        ? `${accentText} font-bold`
                        : !day.isCurrentMonth
                          ? isDark ? 'text-slate-700' : 'text-slate-300'
                          : isDark ? 'text-slate-400' : 'text-slate-600'
                    }`}>
                      {day.day}
                    </span>
                    {isToday && (
                      <span className={`w-1.5 h-1.5 rounded-full ${accentBg}`} />
                    )}
                  </div>

                  {/* Observation entries */}
                  <div className="space-y-1">
                    {dayObs.slice(0, 3).map(obs => {
                      const scope = obs.telescopeId ? telescopeById.get(obs.telescopeId) : null;
                      return (
                      <Link
                        key={obs.id}
                        to={`/observations/${encodeURIComponent(obs.objectId)}/${encodeURIComponent(obs.date)}`}
                        title={scope ? `${obsName(obs)} · ${scope.name}` : obsName(obs)}
                        onMouseEnter={e => handleObsHoverEnter(obs, e.currentTarget)}
                        onMouseLeave={handleObsHoverLeave}
                        onClick={() => { clearHoverTimers(); setHoverPreview(null); }}
                        className={`block rounded-lg px-2 py-1 text-xs transition group ${
                          isNight
                            ? 'bg-red-950/30 hover:bg-red-950/50 text-red-400'
                            : isSpace
                              ? 'bg-violet-900/20 hover:bg-violet-900/30 text-violet-300'
                              : isDark
                                ? 'bg-accent-500/10 hover:bg-accent-500/20 text-accent-400'
                                : 'bg-accent-200 hover:bg-accent-300 text-accent-700'
                        }`}
                      >
                        <div className="flex items-center gap-1.5">
                          {showTelescopeUI && scope && (
                            <span
                              className="w-1.5 h-1.5 rounded-full shrink-0"
                              style={{ backgroundColor: scope.color }}
                              aria-hidden="true"
                            />
                          )}
                          <div className="font-medium truncate">{obsName(obs)}</div>
                        </div>
                        {obs.startTime && (
                          <div className={`flex items-center gap-1 ${
                            isDark ? 'text-slate-500' : 'text-slate-400'
                          }`}>
                            <Clock className="w-2.5 h-2.5" />
                            {formatTime(obs.startTime)}
                            {obs.endTime && obs.endTime !== obs.startTime && (
                              <> - {formatTime(obs.endTime)}</>
                            )}
                          </div>
                        )}
                      </Link>
                      );
                    })}
                    {dayObs.length > 3 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const next = expandedDay === day.date ? null : day.date;
                          setExpandedDay(next);
                          setExpandedDayRect(next ? e.currentTarget.getBoundingClientRect() : null);
                        }}
                        className={`text-xs px-2 py-0.5 rounded-md font-medium transition cursor-pointer ${
                          isDark ? 'text-slate-500 hover:text-accent-400 hover:bg-accent-500/10' : 'text-slate-400 hover:text-accent-600 hover:bg-accent-50'
                        }`}
                      >
                        +{dayObs.length - 3} more
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Observation list (below calendar) */}
      {filteredObservations.length > 0 && (
        <div className="space-y-3">
          <h3 className={`font-display font-semibold text-lg ${isDark ? 'text-white' : 'text-slate-900'}`}>
            Recent Observations
          </h3>
          <div className="grid gap-3">
            {filteredObservations.slice(0, 20).map(obs => {
              const scope = obs.telescopeId ? telescopeById.get(obs.telescopeId) : null;
              return (
              <Link
                key={obs.id}
                to={`/observations/${encodeURIComponent(obs.objectId)}/${encodeURIComponent(obs.date)}`}
                className={`flex items-center gap-4 p-4 rounded-2xl border transition group ${
                  isDark
                    ? 'bg-slate-900/50 border-slate-800 hover:border-slate-700'
                    : 'bg-white border-slate-200 hover:border-slate-300 shadow-sm'
                }`}
              >
                {/* Thumbnail */}
                <div className={`w-16 h-16 rounded-xl overflow-hidden flex-shrink-0 ${
                  isDark ? 'bg-slate-800' : 'bg-slate-100'
                }`}>
                  <img
                    src={obs.thumbnailUrl}
                    alt={obsName(obs)}
                    className="w-full h-full object-cover"
                    onError={e => { if (e.target instanceof HTMLImageElement) e.target.style.display = 'none'; }}
                  />
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`font-medium ${isDark ? 'text-white' : 'text-slate-900'}`}>
                      {obsName(obs)}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-500'
                    }`}>
                      {obs.type}
                    </span>
                    {obs.hasNotes && (
                      <NotebookPen className={`w-3.5 h-3.5 ${accentText}`} />
                    )}
                    {showTelescopeUI && scope && (
                      <span
                        className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${
                          isDark ? 'bg-slate-800/80' : 'bg-slate-100'
                        }`}
                        title={scope.name}
                      >
                        <span
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ backgroundColor: scope.color }}
                          aria-hidden="true"
                        />
                        <span className={isDark ? 'text-slate-300' : 'text-slate-600'}>{scope.name}</span>
                      </span>
                    )}
                  </div>
                  <div className={`flex items-center gap-3 text-xs mt-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    <span>{formatDate(obs.date)}</span>
                    {obs.startTime && (
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {formatTime(obs.startTime)}
                        {obs.endTime && obs.endTime !== obs.startTime && (
                          <> - {formatTime(obs.endTime)}</>
                        )}
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <Star className="w-3 h-3" />
                      {obs.constellation}
                    </span>
                  </div>
                </div>

                {/* Stats */}
                <div className={`flex items-center gap-4 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  {obs.stackedCount > 0 && (
                    <span className="flex items-center gap-1" title="Stacked images">
                      <Layers className="w-3.5 h-3.5 text-accent-500" />
                      {obs.stackedCount}
                    </span>
                  )}
                  {obs.subFrameCount > 0 && (
                    <span className="flex items-center gap-1" title="Sub-frames">
                      <ImageIcon className="w-3.5 h-3.5" />
                      {obs.subFrameCount}
                    </span>
                  )}
                  {obs.processedCount > 0 && (
                    <span className="flex items-center gap-1" title="Processed images">
                      <Pencil className="w-3.5 h-3.5" />
                      {obs.processedCount}
                    </span>
                  )}
                  <span>{obs.fileCount} files</span>
                </div>
              </Link>
              );
            })}
          </div>
        </div>
      )}

      {hoverPreview && (
        <ObservationHoverPreview
          obs={hoverPreview.obs}
          rect={hoverPreview.rect}
          isDark={isDark}
        />
      )}

      {/* "+X more" overflow popup — rendered here (outside the overflow-hidden
          calendar card) with fixed positioning so the card's overflow:hidden
          cannot clip it regardless of which row the day cell is in. */}
      {expandedDay && expandedDayRect && (() => {
        const POPUP_W = 224; // w-56
        let popupLeft = expandedDayRect.left;
        if (popupLeft + POPUP_W > window.innerWidth - 8) popupLeft = window.innerWidth - POPUP_W - 8;
        popupLeft = Math.max(8, popupLeft);
        let popupTop = expandedDayRect.bottom + 4;
        // Flip above if there isn't enough room below
        if (popupTop + 260 > window.innerHeight - 8) popupTop = Math.max(8, expandedDayRect.top - 260 - 4);

        const overflowObs = (observationsByDate.get(expandedDay) ?? []).slice(3);
        const dateLabel = new Date(expandedDay + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

        return (
          <div
            ref={expandedRef}
            className={`rounded-xl border shadow-lg p-2 space-y-1 ${
              isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'
            }`}
            style={{ position: 'fixed', top: popupTop, left: popupLeft, width: POPUP_W, zIndex: 50 }}
          >
            <div className={`text-[11px] font-medium px-2 py-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {overflowObs.length} more · {dateLabel}
            </div>
            {overflowObs.map(obs => {
              const scope = obs.telescopeId ? telescopeById.get(obs.telescopeId) : null;
              return (
                <Link
                  key={obs.id}
                  to={`/observations/${encodeURIComponent(obs.objectId)}/${encodeURIComponent(obs.date)}`}
                  onClick={() => { setExpandedDay(null); setExpandedDayRect(null); clearHoverTimers(); setHoverPreview(null); }}
                  onMouseEnter={e => handleObsHoverEnter(obs, e.currentTarget)}
                  onMouseLeave={handleObsHoverLeave}
                  title={scope ? `${obsName(obs)} · ${scope.name}` : obsName(obs)}
                  className={`block rounded-lg px-2 py-1.5 text-xs transition ${
                    isNight
                      ? 'hover:bg-red-950/50 text-red-400'
                      : isSpace
                        ? 'hover:bg-violet-900/30 text-violet-300'
                        : isDark
                          ? 'hover:bg-accent-500/15 text-accent-400'
                          : 'hover:bg-accent-200 text-accent-700'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    {showTelescopeUI && scope && (
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ backgroundColor: scope.color }}
                        aria-hidden="true"
                      />
                    )}
                    <div className="font-medium truncate">{obsName(obs)}</div>
                  </div>
                  {obs.startTime && (
                    <div className={`flex items-center gap-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                      <Clock className="w-2.5 h-2.5" />
                      {formatTime(obs.startTime)}
                      {obs.endTime && obs.endTime !== obs.startTime && (
                        <> - {formatTime(obs.endTime)}</>
                      )}
                    </div>
                  )}
                </Link>
              );
            })}
          </div>
        );
      })()}
    </div>
  );
}

/**
 * Floating thumbnail preview anchored to a hovered observation entry.
 * Positioned to the right of the entry by default so the cursor can
 * continue moving down the day cell to the next observation without
 * colliding with the preview. Auto-flips left when too close to the
 * right edge of the viewport.
 */
function ObservationHoverPreview({
  obs,
  rect,
  isDark,
}: {
  obs: ObservationSummary;
  rect: DOMRect;
  isDark: boolean;
}) {
  const PREVIEW_W = 220;
  const PREVIEW_H = 220;
  const GAP = 10;

  // Default to the right of the entry; flip to the left when there isn't
  // enough room. Vertically clamp inside the viewport so very-bottom rows
  // don't render off-screen.
  let left = rect.right + GAP;
  if (left + PREVIEW_W > window.innerWidth - 8) {
    left = Math.max(8, rect.left - PREVIEW_W - GAP);
  }
  let top = rect.top + rect.height / 2 - PREVIEW_H / 2;
  if (top < 8) top = 8;
  if (top + PREVIEW_H > window.innerHeight - 8) {
    top = window.innerHeight - PREVIEW_H - 8;
  }

  return (
    <div
      role="tooltip"
      aria-hidden="true"
      style={{
        position: 'fixed',
        left,
        top,
        width: PREVIEW_W,
        // Pointer-events:none so the preview can never become a hover target
        // itself — that would create show/hide loops if the cursor entered it.
        pointerEvents: 'none',
        zIndex: 50,
      }}
      className={`rounded-xl overflow-hidden shadow-2xl border transition-opacity duration-150 ${
        isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'
      }`}
    >
      <div
        className={`w-full ${isDark ? 'bg-slate-950' : 'bg-slate-100'}`}
        style={{ height: PREVIEW_H }}
      >
        {obs.thumbnailUrl ? (
          <img
            src={obs.thumbnailUrl}
            alt=""
            className="w-full h-full object-cover"
            // Don't kill the whole preview on a 404 — fade the image only.
            onError={e => { if (e.target instanceof HTMLImageElement) e.target.style.opacity = '0'; }}
          />
        ) : (
          <div className={`w-full h-full flex items-center justify-center text-xs ${
            isDark ? 'text-slate-600' : 'text-slate-400'
          }`}>
            No preview
          </div>
        )}
      </div>
      <div className="px-3 py-2">
        <div className={`text-sm font-medium truncate ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
          {obsName(obs)}
        </div>
        <div className={`text-xs truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          {cleanCatalogId(obs.catalogId)}
          {obs.startTime && <> · {formatTime(obs.startTime)}</>}
          {obs.fileCount > 0 && <> · {obs.fileCount} file{obs.fileCount === 1 ? '' : 's'}</>}
        </div>
      </div>
    </div>
  );
}

function formatTime(timestamp: string): string {
  try {
    // YYYYMMDD-HHMMSS format (e.g. 20260330-201431)
    const m = timestamp.match(/^\d{8}-(\d{2})(\d{2})/);
    if (m) return `${m[1]}:${m[2]}`;
    const d = new Date(timestamp);
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  } catch {
    return timestamp;
  }
}

function formatDate(date: string): string {
  try {
    const d = new Date(date + 'T12:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return date;
  }
}
