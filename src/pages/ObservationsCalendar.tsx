import { useQuery } from '@tanstack/react-query';
import { useCallback, useState, useMemo, useRef, useEffect, Suspense } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Map as MapIcon, MapPin, Clock, Calendar } from 'lucide-react';
import { getObservations, getObservationLocations, type ObservationSummary } from '../lib/api/observations';
import { lazyRoute } from '../lib/chunkReload';
import { CalendarShareModal } from '../components/calendar/CalendarShareModal';
import { MonthGrid, type CalendarDay } from '../components/calendar/MonthGrid';
import { ListShareModal } from '../components/observations/ListShareModal';
import { MapShareModal } from '../components/observations/MapShareModal';
import { ObservationsList } from '../components/observations/ObservationsList';
import { ObservationsHero } from '../components/observations/ObservationsHero';
import { TourAnchor } from '../components/tour/TourAnchor';
import {
  ObservationsToolbar,
  ALL_TELESCOPES_FILTER,
  type ObservationsView,
} from '../components/observations/ObservationsToolbar';
import {
  summarize,
  bucketByMonth,
  yearsWithObservations,
  nearestObservedDate,
} from '../lib/observationStats';
import { resolveObjectLabel, formatObservationDate } from '../lib/observationDisplay';
import type { CalendarShareData } from '../lib/calendarShare';
import type { ListShareData } from '../lib/listShare';

// Leaflet is heavy; only pull it in when the user opens the map view.
// lazyRoute, not plain lazy, so a stale chunk reloads instead of erroring — the
// same stale-build recovery every route in App.tsx gets (lib/chunkReload.ts).
const ObservationsWorldMap = lazyRoute(() =>
  import('../components/ObservationsWorldMap').then(m => ({ default: m.ObservationsWorldMap })),
);
import type { ObservationsWorldMapHandle } from '../components/ObservationsWorldMap';
import { listTelescopes, type TelescopeProfile } from '../lib/api/telescopes';
import { listPlanNights } from '../lib/api/plannedSessions';
import { indexPlanByDate } from '../lib/planNights';
import { useTheme } from '../hooks/useTheme';
import { nightSafeColor } from '../lib/nightSafeColor';
import { cleanCatalogId, formatObjectName } from '../lib/utils';
import { formatDate, formatTime24, weekStartsOn } from '../lib/formatLocale';

function obsName(obs: ObservationSummary): string {
  const id = cleanCatalogId(obs.objectId);
  const name = cleanCatalogId(obs.objectName);
  return formatObjectName(id, name);
}

export function ObservationsCalendar() {
  const [visiblePerDay, setVisiblePerDay] = useState(3);
  // Reserve the scrollbar's width on this page so the centred calendar never
  // slides sideways when a scrollbar appears or goes away (hovering a preview).
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.scrollbarGutter;
    root.style.scrollbarGutter = 'stable';
    return () => { root.style.scrollbarGutter = previous; };
  }, []);
  const { t } = useTranslation('observations');
  const { isDark, isNight, isSpace } = useTheme();
  /** Null until the user picks a month, so the landing month can follow the
   *  data (see `currentMonth` below) without an effect racing the query. */
  const [chosenMonth, setChosenMonth] = useState<{ year: number; month: number } | null>(null);

  // Which view's Share modal is open, if any — each view shares something
  // different (a calendar card, the table, or a screenshot of the map), so
  // there's one modal per view rather than one shareOpen boolean.
  const [shareModal, setShareModal] = useState<'calendar' | 'list' | 'map' | null>(null);
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [expandedDayRect, setExpandedDayRect] = useState<DOMRect | null>(null);
  const expandedRef = useRef<HTMLDivElement>(null);
  const mapHandleRef = useRef<ObservationsWorldMapHandle>(null);

  // Mirrors what the List view currently has on screen — bubbled up from
  // ObservationsList so "Share" exports exactly what's sorted/visible there,
  // not a separately-recomputed default order.
  const [listShareState, setListShareState] = useState<{ rows: ObservationSummary[]; sortLabel: string }>({
    rows: [],
    sortLabel: t('list.sortedByDateNewest'),
  });
  const handleListSortedRowsChange = useCallback((rows: ObservationSummary[], sortLabel: string) => {
    setListShareState({ rows, sortLabel });
  }, []);

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
  // Two telescopes, or one with several optical trains: either way nights
  // come from more than one rig and the filter/rig column are worth showing.
  const showTelescopeUI = telescopes.length >= 2 || telescopes.some(s => (s.opticalConfigs?.length ?? 0) >= 2);
  const [view, setView] = useState<ObservationsView>('calendar');
  const [telescopeFilter, setTelescopeFilter] = useState<string>(ALL_TELESCOPES_FILTER);

  // Observation-site coordinates power the map view; fetched lazily on first open.
  const { data: locations = [], isLoading: locationsLoading } = useQuery({
    queryKey: ['observation-locations'],
    queryFn: getObservationLocations,
    staleTime: 5 * 60 * 1000,
    enabled: view === 'map',
  });
  const telescopeById = useMemo(() => {
    const map = new Map<string, TelescopeProfile>();
    for (const scope of telescopes) map.set(scope.id, scope);
    return map;
  }, [telescopes]);
  // If the selected telescope was removed, fall back to "All" during render
  // rather than via a corrective setState-in-effect.
  // A filter is a telescope id, or `telescopeId|configId` for one optical
  // train of it (the server's rigKey shape).
  const filterTelescopeId = telescopeFilter.split('|')[0]!;
  const effectiveTelescopeFilter =
    telescopeFilter === ALL_TELESCOPES_FILTER || telescopeById.has(filterTelescopeId)
      ? telescopeFilter
      : ALL_TELESCOPES_FILTER;
  const matchesTelescopeFilter = (o: { telescopeId: string | null; rigKey?: string }) =>
    effectiveTelescopeFilter.includes('|')
      ? o.rigKey === effectiveTelescopeFilter
      : o.telescopeId === effectiveTelescopeFilter;

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
    if (effectiveTelescopeFilter === ALL_TELESCOPES_FILTER) return observations;
    return observations.filter(matchesTelescopeFilter);
    // matchesTelescopeFilter only reads effectiveTelescopeFilter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [observations, effectiveTelescopeFilter]);

  const filteredLocations = useMemo(() => {
    if (effectiveTelescopeFilter === ALL_TELESCOPES_FILTER) return locations;
    // Map points carry no optical train: one train's filter shows its telescope.
    const scopeId = effectiveTelescopeFilter.split('|')[0];
    return locations.filter(l => l.telescopeId === scopeId);
  }, [locations, effectiveTelescopeFilter]);

  /** Most recent recorded night, which decides the landing month. */
  const latestDate = useMemo(() => {
    let latest: string | null = null;
    for (const o of filteredObservations) {
      if (latest === null || o.date > latest) latest = o.date;
    }
    return latest;
  }, [filteredObservations]);

  /**
   * The month on screen.
   *
   * Until the user navigates, this follows the record rather than the wall
   * clock: opening on the current month showed an empty grid to anyone whose
   * last clear night was a while ago, with no hint that the library had
   * anything in it at all. Today still wins whenever today's month holds
   * something, which is the case for anyone observing regularly.
   */
  const currentMonth = useMemo(() => {
    if (chosenMonth) return chosenMonth;
    const now = new Date();
    const fallback = { year: now.getFullYear(), month: now.getMonth() };
    if (!latestDate) return fallback;
    const thisMonthPrefix = `${fallback.year}-${String(fallback.month + 1).padStart(2, '0')}`;
    if (latestDate.startsWith(thisMonthPrefix)) return fallback;
    const [y, m] = latestDate.split('-').map(Number);
    return y && m ? { year: y, month: m - 1 } : fallback;
  }, [chosenMonth, latestDate]);

  const setCurrentMonth = useCallback(
    (next: { year: number; month: number } | ((prev: { year: number; month: number }) => { year: number; month: number })) => {
      setChosenMonth(prev => {
        const base = prev ?? currentMonth;
        return typeof next === 'function' ? next(base) : next;
      });
    },
    [currentMonth],
  );

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

  // Plan vs actual for the month on screen: Planner blocks summed per object
  // and night (server/lib/planOutcome.ts). Best-effort — a failure just
  // leaves the calendar as it was.
  const planRange = useMemo(() => {
    const { year, month } = currentMonth;
    const pad = (n: number) => String(n).padStart(2, '0');
    const last = new Date(year, month + 1, 0).getDate();
    return { from: `${year}-${pad(month + 1)}-01`, to: `${year}-${pad(month + 1)}-${pad(last)}` };
  }, [currentMonth]);
  const { data: planNights = [] } = useQuery({
    queryKey: ['plan-nights', planRange.from, planRange.to],
    queryFn: () => listPlanNights(planRange.from, planRange.to),
    staleTime: 60_000,
    retry: false,
  });
  const planByDate = useMemo(() => {
    const objectIdsByDate = new Map<string, string[]>();
    for (const [date, list] of observationsByDate) objectIdsByDate.set(date, list.map(o => o.objectId));
    return indexPlanByDate(planNights, objectIdsByDate);
  }, [planNights, observationsByDate]);

  // Calendar grid generation
  const calendarDays = useMemo(() => {
    const { year, month } = currentMonth;
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    // getDay() is always 0=Sunday; rebase it onto the active locale's first
    // day of the week (MonthGrid.tsx's header row rotates by the same
    // weekStartsOn() so the two never disagree on which column is which).
    const startOffset = (firstDay.getDay() - weekStartsOn() + 7) % 7;
    const daysInMonth = lastDay.getDate();

    const days: CalendarDay[] = [];

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

  const monthLabel = formatDate(new Date(currentMonth.year, currentMonth.month), {
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

  const today = new Date().toISOString().split('T')[0];

  // Stats reflect the telescope filter, so the hero's numbers always describe
  // the same set of nights the grid is drawing.
  const totals = useMemo(() => summarize(filteredObservations), [filteredObservations]);
  const totalObservations = totals.sessions;
  const uniqueObjects = totals.objects;

  // The hero's year chart is the page's month navigation, so it always shows
  // the year the grid is on rather than tracking a year of its own. Stepping to
  // another year lands on that year's first month with something in it, which
  // is the month you were looking for by stepping.
  const monthBuckets = useMemo(
    () => bucketByMonth(filteredObservations, currentMonth.year),
    [filteredObservations, currentMonth.year],
  );
  const yearsWithData = useMemo(
    () => yearsWithObservations(filteredObservations),
    [filteredObservations],
  );

  const goToYear = useCallback((year: number) => {
    // Straight to setChosenMonth rather than through setCurrentMonth: the
    // target does not depend on the month currently on screen, so there is no
    // reason to take a dependency on it and re-create this on every navigation.
    const first = bucketByMonth(filteredObservations, year).find(b => b.sessions > 0);
    setChosenMonth({ year, month: first?.month ?? 0 });
  }, [filteredObservations]);

  const observedDates = useMemo(
    () => [...new Set(filteredObservations.map(o => o.date))],
    [filteredObservations],
  );
  // Measured from the middle of the month on screen, so "closest" means closest
  // to what you are looking at rather than to its first day.
  const nearestDate = useMemo(() => {
    const mid = `${currentMonth.year}-${String(currentMonth.month + 1).padStart(2, '0')}-15`;
    return nearestObservedDate(observedDates, mid);
  }, [observedDates, currentMonth]);

  // Month of observations, packaged for the printable / shareable calendar card.
  const shareData: CalendarShareData = useMemo(() => {
    const weeks: CalendarShareData['weeks'] = [];
    for (let i = 0; i < calendarDays.length; i += 7) {
      weeks.push(
        calendarDays.slice(i, i + 7).map(d => ({
          date: d.date,
          day: d.day,
          isCurrentMonth: d.isCurrentMonth,
          observations: observationsByDate.get(d.date) ?? [],
        })),
      );
    }
    // Drop trailing weeks that hold no day of the current month (the padded 6th row).
    while (weeks.length > 1 && weeks[weeks.length - 1].every(d => !d.isCurrentMonth)) {
      weeks.pop();
    }
    const telescopeColorById: Record<string, string> = {};
    for (const scope of telescopes) telescopeColorById[scope.id] = scope.color;
    return {
      monthLabel,
      weeks,
      totalObservations,
      uniqueObjects,
      today,
      telescopeColorById,
      showTelescopeDots: showTelescopeUI,
    };
  }, [calendarDays, observationsByDate, telescopes, monthLabel, totalObservations, uniqueObjects, today, showTelescopeUI]);

  // List view's share card. Sourced from `listShareState` (bubbled up from
  // ObservationsList, see handleListSortedRowsChange) rather than
  // `filteredObservations` directly, so the export matches the table's
  // current sort instead of always reflecting some other default order.
  const listShareData: ListShareData = useMemo(() => ({
    rows: listShareState.rows.map(obs => {
      const { display, catalog } = resolveObjectLabel(obs);
      const scope = obs.telescopeId ? telescopeById.get(obs.telescopeId) : undefined;
      return {
        id: obs.id,
        display,
        catalog,
        dateLabel: formatObservationDate(obs.date),
        telescopeColor: scope?.color,
      };
    }),
    uniqueObjects,
    sortLabel: listShareState.sortLabel,
    showTelescopeDots: showTelescopeUI,
  }), [listShareState, telescopeById, uniqueObjects, showTelescopeUI]);

  // Map view has nothing to export until the map has actually loaded some
  // locations — sharing an empty or still-loading map isn't a useful action.
  const canShare = view === 'map'
    ? !locationsLoading && filteredLocations.length > 0
    : totalObservations > 0;

  const shareTitle = view === 'map'
    ? t('calendarPage.shareMapTitle')
    : view === 'list'
      ? t('calendarPage.shareListTitle')
      : t('calendarPage.shareCalendarTitle');

  const handleCaptureMap = useCallback(() => {
    if (!mapHandleRef.current) return Promise.reject(new Error('Map is not ready'));
    return mapHandleRef.current.captureImage();
  }, []);

  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500';
  // The hero sits on a dark panel in every theme, and only a fixed set of
  // accent-* utilities is re-mapped for night and space, so it takes the bright
  // accent value directly rather than the light-mode-darkened token.
  const accent = isNight ? '#f87171' : isSpace ? '#a78bfa' : '#fbbf24';

  const now = new Date();
  const viewingCurrentMonth =
    currentMonth.year === now.getFullYear() && currentMonth.month === now.getMonth();

  return (
    <div className="space-y-8">
      <TourAnchor id="observations" className="block">
      <ObservationsHero
        totals={totals}
        year={currentMonth.year}
        buckets={monthBuckets}
        selectedMonth={currentMonth.month}
        onSelectMonth={month => setCurrentMonth(prev => ({ ...prev, month }))}
        onYearChange={goToYear}
        yearsWithData={yearsWithData}
        accent={accent}
        filteredLabel={
          effectiveTelescopeFilter === ALL_TELESCOPES_FILTER
            ? null
            : (() => {
              const [scopeId, configId] = effectiveTelescopeFilter.split('|');
              const scope = telescopeById.get(scopeId!);
              const config = configId ? scope?.opticalConfigs?.find(c => c.id === configId) : undefined;
              return scope ? [scope.name, config?.name].filter(Boolean).join(' · ') : null;
            })()
        }
      />
      </TourAnchor>

      <div className={`overflow-hidden rounded-2xl border ${
        isDark ? 'border-slate-800 bg-slate-900' : 'border-slate-200 bg-white shadow-sm'
      }`}>
      <ObservationsToolbar
        view={view}
        onViewChange={setView}
        telescopes={showTelescopeUI ? telescopes : []}
        telescopeFilter={effectiveTelescopeFilter}
        onTelescopeFilterChange={setTelescopeFilter}
        onShare={canShare ? () => setShareModal(view) : null}
        shareTitle={shareTitle}
        isDark={isDark}
        monthLabel={monthLabel}
        year={currentMonth.year}
        month={currentMonth.month}
        onPickMonthYear={(y, m) => setCurrentMonth({ year: y, month: m })}
        isCurrentMonth={viewingCurrentMonth}
        onNavigateMonth={navigateMonth}
        onGoToToday={() => {
          const now = new Date();
          setCurrentMonth({ year: now.getFullYear(), month: now.getMonth() });
        }}
      />

      {view === 'list' ? (
        <ObservationsList
          observations={filteredObservations}
          telescopeById={telescopeById}
          showTelescopeUI={showTelescopeUI}
          isDark={isDark}
          onSortedRowsChange={handleListSortedRowsChange}
        />
      ) : view === 'map' ? (
        <div className="overflow-hidden">
          <div className="relative w-full h-[70vh] min-h-[420px]">
            {locationsLoading ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                <MapIcon className={`w-8 h-8 animate-pulse ${isDark ? 'text-slate-700' : 'text-slate-300'}`} />
                <p className={isDark ? 'text-slate-600' : 'text-slate-400'}>{t('calendarPage.loadingLocations')}</p>
              </div>
            ) : filteredLocations.length === 0 ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
                <MapPin className={`w-8 h-8 ${isDark ? 'text-slate-700' : 'text-slate-300'}`} />
                <p className={`font-medium ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>{t('calendarPage.noLocationData')}</p>
                <p className={`text-sm ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                  {t('calendarPage.noLocationDataHint')}
                </p>
              </div>
            ) : (
              <Suspense fallback={
                <div className="absolute inset-0 flex items-center justify-center">
                  <MapIcon className={`w-8 h-8 animate-pulse ${isDark ? 'text-slate-700' : 'text-slate-300'}`} />
                </div>
              }>
                <ObservationsWorldMap
                  ref={mapHandleRef}
                  locations={filteredLocations}
                  telescopeById={telescopeById}
                  showTelescopeUI={showTelescopeUI}
                  isDark={isDark}
                  isNight={isNight}
                  isSpace={isSpace}
                />
              </Suspense>
            )}
          </div>
        </div>
      ) : isLoading ? (
        <div className="p-10 text-center">
          <div className="flex animate-pulse flex-col items-center gap-3">
            <Calendar className={`h-8 w-8 ${isDark ? 'text-slate-700' : 'text-slate-300'}`} />
            <p className={isDark ? 'text-slate-600' : 'text-slate-400'}>{t('calendarPage.loadingObservations')}</p>
          </div>
        </div>
      ) : (
        <MonthGrid
          onVisiblePerDayChange={setVisiblePerDay}
          days={calendarDays}
          observationsByDate={observationsByDate}
          planByDate={planByDate}
          monthLabel={monthLabel}
          today={today}
          nearestDate={nearestDate}
          onGoToNearest={() => {
            if (!nearestDate) return;
            const [y, m] = nearestDate.split('-').map(Number);
            setCurrentMonth({ year: y, month: m - 1 });
          }}
          telescopeById={telescopeById}
          showTelescopeUI={showTelescopeUI}
          obsName={obsName}
          formatTime={formatTime}
          onExpandDay={(date, rect) => {
            const next = expandedDay === date ? null : date;
            setExpandedDay(next);
            setExpandedDayRect(next ? rect : null);
          }}
          onEntryHoverEnter={handleObsHoverEnter}
          onEntryHoverLeave={handleObsHoverLeave}
          onEntryClick={() => { clearHoverTimers(); setHoverPreview(null); }}
          isDark={isDark}
          isNight={isNight}
          isSpace={isSpace}
          accentText={accentText}
        />
      )}
      </div>

      {shareModal === 'calendar' && (
        <CalendarShareModal data={shareData} onClose={() => setShareModal(null)} />
      )}
      {shareModal === 'list' && (
        <ListShareModal data={listShareData} onClose={() => setShareModal(null)} />
      )}
      {shareModal === 'map' && (
        <MapShareModal onCapture={handleCaptureMap} onClose={() => setShareModal(null)} />
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

        const overflowObs = (observationsByDate.get(expandedDay) ?? []).slice(visiblePerDay);
        const dateLabel = formatDate(new Date(expandedDay + 'T12:00:00'), { month: 'short', day: 'numeric' });

        return (
          <div
            ref={expandedRef}
            className={`rounded-xl border shadow-lg p-2 space-y-1 ${
              isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'
            }`}
            style={{ position: 'fixed', top: popupTop, left: popupLeft, width: POPUP_W, zIndex: 50 }}
          >
            <div className={`text-[0.6875rem] font-medium px-2 py-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {t('calendarPage.moreAtDate', { count: overflowObs.length, date: dateLabel })}
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
                        style={{ backgroundColor: nightSafeColor(scope.color, isNight) }}
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
  const { t } = useTranslation('observations');
  // Same size tiers as the calendar grid: small screens keep the original 220px.
  const PREVIEW_W = window.innerWidth >= 2400 ? 320 : window.innerWidth >= 1800 ? 270 : 220;
  const PREVIEW_H = PREVIEW_W;
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
            {t('calendarPage.noPreview')}
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
          {obs.fileCount > 0 && <> · {t('calendarPage.fileCount', { count: obs.fileCount })}</>}
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
    return formatTime24(d);
  } catch {
    return timestamp;
  }
}
