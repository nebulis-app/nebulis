/**
 * The planner.
 *
 *   Night hero      rating, Moon, the night's numbers, the fortnight ahead
 *   Targets (left)  everything up this night, searchable, drag or tap to add
 *   Schedule (right) a dusk-to-dawn canvas with weather, moon and a live now-line
 *
 * The hero answers "is this night worth it" before any scheduling starts, which
 * is why the weather forecast is read here and not just on the Sky Forecast
 * page. Both pages score a night with the same engine (lib/forecastScore via
 * lib/plannerNight) so they can never disagree.
 *
 * The "Set visible sky" polar editor captures which patches of sky the observer
 * can actually see (trees, neighbours, rooflines). Each scheduled block is
 * checked against that map and indicated with a green / amber / red stripe.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { CalendarRange, Check, ListTree } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { getPlannerTargets, getForecastForSite, getBlockVerdicts, type ForecastHour, type PlannerTarget } from '../lib/api/planner';
import { getSites, getActiveSite, setActiveSite, updateSite, type ObservingSite } from '../lib/api/sites';
import { SitePicker } from '../components/SitePicker';
import { listPlannedSessions, createPlannedSession, updatePlannedSession, deletePlannedSession, type PlannedSession, type PlannedSessionCreate } from '../lib/api/plannedSessions';
import { getCatalogObjectInfo } from '../lib/api/catalog';
import { getSettings } from '../lib/api/settings';
import { getCatalogThumbnailUrl } from '../lib/catalogImage';
import { LocationPrompt } from '../components/LocationPrompt';
import { AltitudeChart } from '../components/AltitudeChart';
import { SkyChart } from '../components/planner/SkyChart';
import { computeAltitudeCurve, buildTonightWindow } from '../lib/altaz';
import { LibraryPanel } from '../components/planner/LibraryPanel';
import { ScheduleTimeline } from '../components/planner/ScheduleTimeline';
import { VisibleSkyEditor } from '../components/ui/VisibleSkyEditor';
import { AltitudeBandChart } from '../components/planner/AltitudeBandChart';
import { PlanCalendar } from '../components/planner/PlanCalendar';
import { NightHero } from '../components/planner/NightHero';
import { NightStrip, type StripNight } from '../components/planner/NightStrip';
import { PlannerActions } from '../components/planner/PlannerActions';
import { parsePlannerDragData } from '../components/planner/dragData';
import { NightWeatherModal, type NightAstro } from '../components/planner/NightWeatherModal';
import {
  dateFromKey,
  formatPlannerDate,
  localDateKey,
  nightWindowFor,
  plannerDateKeyForInstant,
  plannerToday,
  sameLocalDay,
} from '../lib/nightWindow';
import {
  bestSlotFor,
  findGaps,
  hoursInWindow,
  moonPhaseNameFor,
  moonUpIntervals,
  plannedMinutes as sumPlannedMinutes,
  scoreNight,
  twilightMarksFor,
  type Interval,
  type NightGap,
} from '../lib/plannerNight';
import {
  DEFAULT_BLOCK_MINUTES,
  MIN_BLOCK_MINUTES,
  PX_PER_MINUTE,
  SNAP_MINUTES,
  clampTime,
  minutesBetween,
  snapToGrid,
} from '../components/planner/scheduleGeometry';
import {
  SKY_MAP_CELLS,
  type BlockVisibilityResult,
  type VisibleSkyMap,
} from '../lib/visibilityCheck';
import type { MoonProximityResult } from '../lib/moonProximity';
import { AutoPlanModal } from '../components/planner/AutoPlanModal';
import { PlanShareModal } from '../components/planner/PlanShareModal';
import { TourAnchor } from '../components/tour/TourAnchor';
import type { PlanBlock } from '../lib/planTypes';
import { formatObjectName } from '../lib/utils';
import { formatHm } from '../lib/timeFormat';
import SunCalc from 'suncalc';

const TIMELINE_BUFFER_MS = 30 * 60_000; // 30-min padding beyond sunset/sunrise
// Monotonic source of optimistic-row ids. `-Date.now()` collided when two
// creates landed in the same millisecond (both temp rows then mapped to the
// same server row in onSuccess); a decrementing counter can't.
let nextTempId = -Date.now();
const makeTempId = () => nextTempId--;
/** How many nights the picker strip offers by default. */
const STRIP_NIGHTS = 14;
/** Shortest empty stretch worth offering to fill. */
const MIN_GAP_MINUTES = 40;

export function PlannerPage() {
  const { isDark, isNight, isSpace } = useTheme();
  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500';
  // The hero and the schedule canvas are night-side in every theme, so they
  // take the bright accent value rather than the light-mode-darkened token.
  const accent = isNight ? '#f87171' : isSpace ? '#a78bfa' : '#fbbf24';
  const queryClient = useQueryClient();
  const location = useLocation();
  const navState = location.state as { searchQuery?: string; focusDate?: string } | null;
  const initialSearch = navState?.searchQuery ?? '';
  // When arriving from "Plan Tonight" on a catalog, open on the night the plan
  // was scheduled into rather than the planner's own default "today".
  const initialFocusDate = navState?.focusDate;

  // ── Observing site ───────────────────────────────────────────────────────
  // Every location/sky value below (coordinates, minAlt, horizon, visible-sky
  // mask) comes from whichever site is selected. staleTime: 0 + a refetch
  // interval so a site edited from another tab/device (or the sky map redrawn
  // from the Planner there) shows up here without a manual reload.
  const sitesQuery = useQuery({ queryKey: ['sites'], queryFn: getSites, staleTime: 0, refetchInterval: 60_000 });
  const activeSiteQuery = useQuery({ queryKey: ['active-site'], queryFn: getActiveSite, staleTime: 0 });
  const sites = sitesQuery.data ?? [];
  // Local override for this tab, seeded null so the tab starts on whatever
  // the server reports as active. Switching sites here also persists via
  // setActiveSite, so other tabs/devices pick it up on their own next fetch.
  const [pickedSiteId, setPickedSiteId] = useState<string | null>(null);
  const effectiveSiteId = pickedSiteId ?? activeSiteQuery.data?.id ?? null;
  const currentSite: ObservingSite | null =
    sites.find(s => s.id === effectiveSiteId) ?? activeSiteQuery.data ?? null;

  const setActiveSiteMut = useMutation({
    mutationFn: (siteId: string) => setActiveSite(siteId),
    onSuccess: (site) => {
      setPickedSiteId(site.id);
      queryClient.invalidateQueries({ queryKey: ['active-site'] });
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      queryClient.invalidateQueries({ queryKey: ['planner-targets'] });
    },
  });

  const observerLat = currentSite?.latitude ?? null;
  const observerLon = currentSite?.longitude ?? null;

  // ── Date / night window ────────────────────────────────────────────────
  const [selectedDate, setSelectedDate] = useState<Date>(() =>
    initialFocusDate ? dateFromKey(initialFocusDate) : plannerToday(),
  );
  // Treat an explicit focus date as a user choice so the timezone effect below
  // doesn't snap the view back to "today" once settings load.
  const [dateTouched, setDateTouched] = useState(!!initialFocusDate);
  const selectedDateKey = localDateKey(selectedDate);

  // Server is now date-aware: /planner/tonight?date=YYYY-MM-DD returns the
  // catalog filtered for that night's visibility. For today, we omit the
  // param so the server uses "now" semantics (correct altNow/azNow).
  const settingsTimezone = currentSite?.timezone || undefined;
  const settingsToday = useMemo(() => plannerToday(new Date(), settingsTimezone), [settingsTimezone]);
  const isToday = sameLocalDay(selectedDate, settingsToday);
  const plannerQuery = useQuery({
    queryKey: ['planner-targets', effectiveSiteId, isToday ? 'today' : selectedDateKey],
    queryFn: () => getPlannerTargets({
      ...(isToday ? {} : { date: selectedDateKey }),
      ...(effectiveSiteId ? { siteId: effectiveSiteId } : {}),
    }),
    enabled: sitesQuery.isSuccess && activeSiteQuery.isSuccess,
    // Switching the selected night changes the query key (targets/altitudes
    // are night-specific), which would otherwise blank the whole page back to
    // the top-level loading screen below on every day click. Keep showing the
    // previous night's data while the new one fetches instead.
    placeholderData: keepPreviousData,
  });
  const planner = plannerQuery.data;
  const observerTimezone = planner?.observerTimezone || settingsTimezone;
  useEffect(() => {
    if (!observerTimezone || dateTouched) return;
    setSelectedDate(plannerToday(new Date(), observerTimezone));
  }, [observerTimezone, dateTouched]);

  // Immutable string forms of the server's dark window. Callbacks depend on
  // these rather than on `planner?.nightStart` directly.
  const darkStartIso = planner?.nightStart ?? null;
  const darkEndIso = planner?.nightEnd ?? null;

  const plannerTimelineStartIso = planner?.timelineStart ?? null;
  const plannerTimelineEndIso = planner?.timelineEnd ?? null;
  const sunsetIso = planner?.sunset ?? null;
  const sunriseIso = planner?.sunrise ?? null;

  // Each of these is a fresh `Date` derived from server strings. They're
  // memoized individually (not recomputed every render) because ~8 downstream
  // memos and 3 child components depend on nightStart/timelineStart, and the
  // page re-renders once per pointer frame during a drag.
  //
  // Server response is authoritative for the night window of the requested
  // date; fall back to client-side SunCalc when the server didn't return one
  // (e.g. location not set).
  const nightWindow = useMemo<{ start: Date; end: Date } | null>(() => (
    darkStartIso && darkEndIso
      ? { start: new Date(darkStartIso), end: new Date(darkEndIso) }
      : observerLat == null || observerLon == null
        ? null
        : nightWindowFor(selectedDate, observerLat, observerLon)
  ), [darkStartIso, darkEndIso, observerLat, observerLon, selectedDate]);
  const nightStart = nightWindow?.start ?? null;
  const nightEnd = nightWindow?.end ?? null;

  // Timeline spans from sunset to sunrise so users can schedule sessions in
  // twilight. Fall back to nightStart ± 2h when sunset/sunrise aren't available
  // (polar regions). A 10-hour minimum keeps the window from feeling cramped in
  // high-latitude summers.
  const timelineStart = useMemo<Date | null>(() => {
    if (plannerTimelineStartIso) return new Date(new Date(plannerTimelineStartIso).getTime() - TIMELINE_BUFFER_MS);
    if (sunsetIso) return new Date(new Date(sunsetIso).getTime() - TIMELINE_BUFFER_MS);
    return nightStart ? new Date(nightStart.getTime() - 2 * 60 * 60_000) : null;
  }, [plannerTimelineStartIso, sunsetIso, nightStart]);
  const timelineEnd = useMemo<Date | null>(() => {
    const MIN_TIMELINE_MS = 10 * 60 * 60_000;
    const raw = plannerTimelineEndIso
      ? new Date(new Date(plannerTimelineEndIso).getTime() + TIMELINE_BUFFER_MS)
      : sunriseIso
      ? new Date(new Date(sunriseIso).getTime() + TIMELINE_BUFFER_MS)
      : nightEnd ? new Date(nightEnd.getTime() + 2 * 60 * 60_000) : null;
    return timelineStart && raw
      ? new Date(Math.max(raw.getTime(), timelineStart.getTime() + MIN_TIMELINE_MS))
      : raw;
  }, [plannerTimelineEndIso, sunriseIso, nightEnd, timelineStart]);
  const timelineStartIso = timelineStart?.toISOString() ?? null;
  const timelineEndIso = timelineEnd?.toISOString() ?? null;

  // Load sessions across the full extended window. Poll on an interval so a plan
  // edited on another device (phone in the field, a second browser tab) shows up
  // here without a manual reload. Unlike the library queries, listing sessions is
  // a cheap indexed SQLite read, not a filesystem walk, so a 30s refetch is fine.
  const sessionsQuery = useQuery({
    queryKey: ['planned-sessions', timelineStartIso, timelineEndIso],
    enabled: timelineStartIso != null && timelineEndIso != null,
    refetchInterval: 30_000,
    queryFn: () =>
      timelineStartIso && timelineEndIso
        ? listPlannedSessions({ from: timelineStartIso, to: timelineEndIso })
        : Promise.resolve([]),
  });
  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);

  const visibleSkyMap: VisibleSkyMap | null =
    currentSite?.visibleSkyMap?.length === SKY_MAP_CELLS ? currentSite.visibleSkyMap : null;

  // ── Weather ────────────────────────────────────────────────────────────
  // The forecast reaches a few days out. Past that the hero degrades to moon
  // and altitude rather than showing a made-up rating.
  const forecastQuery = useQuery({
    queryKey: ['forecast', effectiveSiteId],
    queryFn: () => getForecastForSite(effectiveSiteId!),
    enabled: effectiveSiteId != null && observerLat != null && observerLon != null,
    staleTime: 600_000,
  });
  const forecastHourly = useMemo(() => forecastQuery.data?.hourly ?? [], [forecastQuery.data]);

  // Temperature and wind units are app-wide preferences rather than per-site,
  // so they come off settings, the same as on the Sky Forecast page.
  const appSettingsQuery = useQuery({ queryKey: ['settings'], queryFn: getSettings, staleTime: Infinity });
  const tempUnit = appSettingsQuery.data?.temperatureUnit ?? 'fahrenheit';
  const windUnit = appSettingsQuery.data?.windSpeedUnit ?? 'mph';

  const nightForecastHours = useMemo(() => {
    if (forecastHourly.length === 0 || !timelineStart || !timelineEnd) return [];
    return hoursInWindow(forecastHourly, timelineStart, timelineEnd, 0);
  }, [forecastHourly, timelineStart, timelineEnd]);

  const conditions = useMemo(() => {
    if (nightForecastHours.length === 0) return null;
    const darkWindow = nightStart && nightEnd
      ? { start: nightStart.getTime(), end: nightEnd.getTime() }
      : null;
    return scoreNight(nightForecastHours, planner?.moonIllumination ?? 0, observerTimezone, darkWindow);
  }, [nightForecastHours, nightStart, nightEnd, planner?.moonIllumination, observerTimezone]);

  // ── The fortnight ahead ────────────────────────────────────────────────
  // One extra sessions read covering the whole strip, so each night can show
  // whether it already has blocks on it. Indexed by start time, so it is cheap.
  const stripStart = useMemo(
    () => (selectedDate.getTime() < settingsToday.getTime() ? selectedDate : settingsToday),
    [selectedDate, settingsToday],
  );
  const stripNightCount = useMemo(() => {
    const spanDays = Math.round((selectedDate.getTime() - stripStart.getTime()) / 86_400_000);
    return Math.max(STRIP_NIGHTS, spanDays + 3);
  }, [selectedDate, stripStart]);
  const stripFromIso = useMemo(() => new Date(stripStart.getTime() - 12 * 3_600_000).toISOString(), [stripStart]);
  const stripToIso = useMemo(
    () => new Date(stripStart.getTime() + (stripNightCount + 1) * 86_400_000).toISOString(),
    [stripStart, stripNightCount],
  );
  const stripSessionsQuery = useQuery({
    queryKey: ['planned-sessions', 'strip', stripFromIso, stripToIso],
    queryFn: () => listPlannedSessions({ from: stripFromIso, to: stripToIso }),
    staleTime: 30_000,
  });

  const nights: StripNight[] = useMemo(() => {
    const plannedByNight = new Map<string, number>();
    for (const s of stripSessionsQuery.data ?? []) {
      const key = plannerDateKeyForInstant(new Date(s.startTime), observerTimezone);
      plannedByNight.set(key, (plannedByNight.get(key) ?? 0) + 1);
    }

    const out: StripNight[] = [];
    for (let i = 0; i < stripNightCount; i++) {
      const date = new Date(stripStart.getFullYear(), stripStart.getMonth(), stripStart.getDate() + i, 12, 0, 0);
      const key = localDateKey(date);
      const window = observerLat != null && observerLon != null
        ? nightWindowFor(date, observerLat, observerLon)
        : null;
      const midpoint = window
        ? new Date((window.start.getTime() + window.end.getTime()) / 2)
        : new Date(date.getTime() + 11 * 3_600_000);
      const illum = SunCalc.getMoonIllumination(midpoint);

      let score: number | null = null;
      if (window && forecastHourly.length > 0) {
        const hours = hoursInWindow(forecastHourly, window.start, window.end, 0);
        score = hours.length >= 2
          ? scoreNight(hours, Math.round(illum.fraction * 100), observerTimezone, {
              start: window.start.getTime(),
              end: window.end.getTime(),
            })?.score ?? null
          : null;
      }

      out.push({
        date,
        key,
        score,
        moonIllumination: Math.round(illum.fraction * 100),
        moonPhase: moonPhaseNameFor(illum.phase),
        plannedCount: plannedByNight.get(key) ?? 0,
        isToday: sameLocalDay(date, settingsToday),
      });
    }
    return out;
  }, [stripStart, stripNightCount, observerLat, observerLon, forecastHourly, observerTimezone, settingsToday, stripSessionsQuery.data]);

  // ── Mutations ──────────────────────────────────────────────────────────
  const createMut = useMutation({
    mutationFn: createPlannedSession,
    // Optimistically add the block so it appears on the timeline immediately,
    // even while catalog thumbnails are still loading. Those image requests can
    // saturate the browser's per-host connection pool, which otherwise delays
    // both this POST and the follow-up refetch, making a dropped block look
    // stuck on "Saving" and never appear. The real row replaces the temp one as
    // soon as the server responds.
    onMutate: async (vars: PlannedSessionCreate) => {
      await queryClient.cancelQueries({ queryKey: ['planned-sessions'] });
      const tempId = makeTempId();
      const now = new Date().toISOString();
      const optimistic: PlannedSession = {
        id: tempId,
        objectId: vars.objectId,
        objectName: vars.objectName,
        ra: vars.ra,
        dec: vars.dec,
        startTime: vars.startTime,
        endTime: vars.endTime,
        notes: vars.notes ?? '',
        createdAt: now,
        updatedAt: now,
      };
      // Scope the optimistic ADD to the exact timeline query. A prefix match on
      // ['planned-sessions'] also appended the block to the strip query and any
      // other date range, none of which had checked that the block falls inside
      // their window. update/delete stay prefix-matched — they touch rows by id,
      // so hitting every copy is correct.
      const timelineKey = ['planned-sessions', timelineStartIso, timelineEndIso];
      const previous = queryClient.getQueriesData<PlannedSession[]>({ queryKey: timelineKey });
      queryClient.setQueryData<PlannedSession[]>(timelineKey, old =>
        old ? [...old, optimistic] : [optimistic],
      );
      return { previous, tempId };
    },
    onError: (_err, _vars, context) => {
      context?.previous?.forEach(([key, data]) => queryClient.setQueryData(key, data));
    },
    onSuccess: (created, _vars, context) => {
      // Swap the temp row for the server row (with the real id) right away, so
      // drag/resize/delete work without waiting for the connection-starved
      // refetch in onSettled.
      queryClient.setQueriesData<PlannedSession[]>({ queryKey: ['planned-sessions'] }, old =>
        old ? old.map(s => (s.id === context?.tempId ? created : s)) : old,
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['planned-sessions'] }),
  });
  const updateMut = useMutation({
    mutationFn: (vars: { id: number; patch: { startTime?: string; endTime?: string } }) =>
      updatePlannedSession(vars.id, vars.patch),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: ['planned-sessions'] });
      const previous = queryClient.getQueriesData<PlannedSession[]>({ queryKey: ['planned-sessions'] });
      queryClient.setQueriesData<PlannedSession[]>({ queryKey: ['planned-sessions'] }, old =>
        old ? old.map(s => s.id === vars.id ? { ...s, ...vars.patch } : s) : old,
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      context?.previous?.forEach(([key, data]) => queryClient.setQueryData(key, data));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['planned-sessions'] }),
  });
  const deleteMut = useMutation({
    mutationFn: deletePlannedSession,
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['planned-sessions'] });
      const previous = queryClient.getQueriesData<PlannedSession[]>({ queryKey: ['planned-sessions'] });
      queryClient.setQueriesData<PlannedSession[]>({ queryKey: ['planned-sessions'] }, old =>
        old ? old.filter(s => s.id !== id) : old,
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      context?.previous?.forEach(([key, data]) => queryClient.setQueryData(key, data));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['planned-sessions'] }),
  });
  // useMutation returns a fresh wrapper object every render; `.mutate` is the
  // stable reference. Callbacks passed to memo'd children (ScheduledImagingBlock)
  // must depend on these, not on the mutation objects.
  const createMutate = createMut.mutate;
  const updateMutate = updateMut.mutate;
  const deleteMutate = deleteMut.mutate;
  const [skyMapSaveError, setSkyMapSaveError] = useState<string | null>(null);
  const saveSkyMapMut = useMutation({
    mutationFn: (map: VisibleSkyMap) => {
      if (!effectiveSiteId) return Promise.reject(new Error('No observing site selected'));
      return updateSite(effectiveSiteId, { visibleSkyMap: map });
    },
    onSuccess: () => {
      setSkyMapSaveError(null);
      queryClient.invalidateQueries({ queryKey: ['sites'] });
      queryClient.invalidateQueries({ queryKey: ['active-site'] });
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (err: Error) => setSkyMapSaveError(err.message ?? 'Failed to save sky map'),
  });

  // ── Drag state ─────────────────────────────────────────────────────────
  const timelineRef = useRef<HTMLDivElement | null>(null);
  // The timeline scale is computed at runtime (it fills the viewport), so the
  // drop/drag handlers read it from this ref to convert pointer pixels to time.
  // ScheduleTimeline keeps it current via onScaleChange. Falls back to the
  // static default until the first measurement.
  const pxPerMinuteRef = useRef(PX_PER_MINUTE);
  const [activeBlockDrag, setActiveBlockDrag] = useState<{ id: number; deltaY: number } | null>(null);
  const [activeLibraryDrag, setActiveLibraryDrag] = useState<{
    objectId: string;
    objectName: string;
    ra: number;
    dec: number;
  } | null>(null);
  /** Live pointer Y in viewport coordinates. Maintained by a window listener
   *  during a drag so we can compute the correct drop time even when the
   *  timeline is scrolled. Falls back to activatorEvent.clientY + delta. */
  const pointerYRef = useRef<number | null>(null);
  const [resizePreview, setResizePreview] = useState<Map<number, { edge: 'top' | 'bottom'; deltaMinutes: number }>>(new Map());
  const [copyingPrevNight, setCopyingPrevNight] = useState(false);
  const [copyPrevNightError, setCopyPrevNightError] = useState<string | null>(null);
  const [skyEditorOpen, setSkyEditorOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [autoPlanOpen, setAutoPlanOpen] = useState(false);
  const [autoPlanRange, setAutoPlanRange] = useState<{ start: Date; end: Date; clearFirst: boolean } | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [weatherOpen, setWeatherOpen] = useState(false);
  const [weatherHourTime, setWeatherHourTime] = useState<string | null>(null);
  const [refreshingForecast, setRefreshingForecast] = useState(false);
  const [mobilePane, setMobilePane] = useState<'targets' | 'schedule'>('targets');
  const [detailsSession, setDetailsSession] = useState<{
    objectId: string;
    objectName: string;
    ra: number;
    dec: number;
    majorAxisArcmin: number | null;
  } | null>(null);

  // Track pointer Y at the window level while a drag is in progress. dnd-kit
  // does not surface live cursor position to onDragEnd, and computing it from
  // activatorEvent + delta has been unreliable when the timeline is scrolled.
  useEffect(() => {
    if (!activeLibraryDrag && !activeBlockDrag) return;
    function track(e: PointerEvent) { pointerYRef.current = e.clientY; }
    window.addEventListener('pointermove', track);
    return () => window.removeEventListener('pointermove', track);
  }, [activeLibraryDrag, activeBlockDrag]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragStart = useCallback((event: DragStartEvent) => {
    const data = parsePlannerDragData(event.active.data.current);
    // Seed pointer tracking with the activator position so the very first
    // pointermove isn't needed before we have a reading. PointerEvent extends
    // MouseEvent, so this one check covers both.
    if (event.activatorEvent instanceof MouseEvent) {
      pointerYRef.current = event.activatorEvent.clientY;
    }
    if (!data) return;
    if (data.kind === 'block') {
      setActiveBlockDrag({ id: data.sessionId, deltaY: 0 });
      return;
    }
    setActiveLibraryDrag({
      objectId: data.objectId,
      objectName: data.objectName,
      ra: data.ra,
      dec: data.dec,
    });
  }, []);

  const onDragMove = useCallback((event: DragMoveEvent) => {
    const data = parsePlannerDragData(event.active.data.current);
    if (data?.kind === 'block') {
      setActiveBlockDrag({ id: data.sessionId, deltaY: event.delta.y });
    }
  }, []);

  const onDragEnd = useCallback((event: DragEndEvent) => {
    const data = parsePlannerDragData(event.active.data.current);
    setActiveBlockDrag(null);
    setActiveLibraryDrag(null);
    if (!data || !timelineStartIso || !timelineEndIso) return;
    const tStart = new Date(timelineStartIso);
    const tEnd = new Date(timelineEndIso);

    if (data.kind === 'library') {
      const rect = timelineRef.current?.getBoundingClientRect();
      if (!rect) return;
      // Prefer the live-tracked pointer Y; fall back to activatorEvent + delta
      // if for some reason no pointermove fired (e.g. keyboard activation).
      const activatorY = event.activatorEvent instanceof MouseEvent ? event.activatorEvent.clientY : 0;
      const fallbackY = activatorY + event.delta.y;
      const cursorY = pointerYRef.current ?? fallbackY;
      // Inside-rect check is more reliable than dnd-kit's collision detection
      // here because the library row's draggable rect doesn't have to overlap
      // the timeline. A pointer drop *inside* the timeline counts.
      const insideTimeline =
        cursorY >= rect.top && cursorY <= rect.bottom;
      if (!insideTimeline) return;
      const pointerY = cursorY - rect.top;
      // y=0 on the timeline corresponds to tStart (the extended window start).
      const rawStart = new Date(tStart.getTime() + Math.max(0, pointerY / pxPerMinuteRef.current) * 60000);
      const startSnapped = clampTime(snapToGrid(rawStart), tStart, tEnd);
      const endRaw = new Date(startSnapped.getTime() + DEFAULT_BLOCK_MINUTES * 60000);
      const endSnapped = clampTime(endRaw, tStart, tEnd);
      if (minutesBetween(startSnapped, endSnapped) < MIN_BLOCK_MINUTES) return;
      createMutate({
        objectId: data.objectId,
        objectName: data.objectName,
        ra: data.ra,
        dec: data.dec,
        startTime: startSnapped.toISOString(),
        endTime: endSnapped.toISOString(),
      });
      return;
    }

    if (data.kind === 'block') {
      const id = data.sessionId;
      if (id < 0) return; // optimistic block — save not yet confirmed
      const session = sessions.find(s => s.id === id);
      if (!session) return;
      const deltaMinRaw = event.delta.y / pxPerMinuteRef.current;
      const deltaMin = Math.round(deltaMinRaw / SNAP_MINUTES) * SNAP_MINUTES;
      if (deltaMin === 0) return;
      const originalDuration = new Date(session.endTime).getTime() - new Date(session.startTime).getTime();
      const rawStart = new Date(new Date(session.startTime).getTime() + deltaMin * 60000).getTime();
      const tStartMs = tStart.getTime();
      const tEndMs = tEnd.getTime();
      const clampedStart = Math.max(tStartMs, Math.min(tEndMs - originalDuration, rawStart));
      const newStart = new Date(clampedStart);
      const newEnd = new Date(clampedStart + originalDuration);
      if (minutesBetween(newStart, newEnd) < MIN_BLOCK_MINUTES) return;
      updateMutate({ id, patch: { startTime: newStart.toISOString(), endTime: newEnd.toISOString() } });
    }
  }, [createMutate, updateMutate, sessions, timelineStartIso, timelineEndIso]);

  const handleResize = useCallback(
    (id: number, edge: 'top' | 'bottom', deltaMinutes: number, commit: boolean) => {
      if (id < 0) return; // optimistic block — save not yet confirmed, no server id yet
      if (!commit) {
        setResizePreview(prev => {
          const next = new Map(prev);
          next.set(id, { edge, deltaMinutes });
          return next;
        });
        return;
      }
      setResizePreview(prev => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      if (deltaMinutes === 0 || !timelineStartIso || !timelineEndIso) return;
      const session = sessions.find(s => s.id === id);
      if (!session) return;
      const ns = new Date(timelineStartIso);
      const ne = new Date(timelineEndIso);
      const start = new Date(session.startTime);
      const end = new Date(session.endTime);
      let newStart = start;
      let newEnd = end;
      if (edge === 'top') newStart = new Date(start.getTime() + deltaMinutes * 60000);
      else newEnd = new Date(end.getTime() + deltaMinutes * 60000);
      newStart = clampTime(newStart, ns, ne);
      newEnd = clampTime(newEnd, ns, ne);
      if (minutesBetween(newStart, newEnd) < MIN_BLOCK_MINUTES) return;
      updateMutate({
        id,
        patch: edge === 'top' ? { startTime: newStart.toISOString() } : { endTime: newEnd.toISOString() },
      });
    },
    [sessions, timelineStartIso, timelineEndIso, updateMutate],
  );

  const handleCopyFromPrevNight = useCallback(async () => {
    if (observerLat == null || observerLon == null || !timelineStartIso || !timelineEndIso) return;
    setCopyingPrevNight(true);
    setCopyPrevNightError(null);
    try {
      const DAY_MS = 24 * 60 * 60 * 1000;
      // Derive the previous night's fetch window by shifting THIS night's
      // server-computed timeline window back 24h, rather than recomputing it
      // with client-side SunCalc. The server window is anchored in the scope's
      // timezone; a browser several zones away from the scope would otherwise
      // pick the wrong night. Shifting by the same DAY_MS the copied blocks use
      // keeps the fetch window and the block shift symmetric.
      const windowStart = new Date(timelineStartIso);
      const windowEnd = new Date(timelineEndIso);
      const prevSessions = await listPlannedSessions({
        from: new Date(windowStart.getTime() - DAY_MS).toISOString(),
        to: new Date(windowEnd.getTime() - DAY_MS).toISOString(),
      });
      if (prevSessions.length === 0) return;
      await Promise.all(
        prevSessions.map(s => {
          const newStart = clampTime(new Date(new Date(s.startTime).getTime() + DAY_MS), windowStart, windowEnd);
          const newEnd = clampTime(new Date(new Date(s.endTime).getTime() + DAY_MS), windowStart, windowEnd);
          if (minutesBetween(newStart, newEnd) < MIN_BLOCK_MINUTES) return Promise.resolve();
          return createPlannedSession({
            objectId: s.objectId,
            objectName: s.objectName,
            ra: s.ra,
            dec: s.dec,
            startTime: newStart.toISOString(),
            endTime: newEnd.toISOString(),
          });
        }),
      );
      await queryClient.invalidateQueries({ queryKey: ['planned-sessions'] });
    } catch (err) {
      // Previously the try/finally swallowed this: a copy that failed part-way
      // through looked identical to a completed one.
      setCopyPrevNightError(err instanceof Error ? err.message : 'Could not copy last night. Some blocks may not have been added.');
      await queryClient.invalidateQueries({ queryKey: ['planned-sessions'] });
    } finally {
      setCopyingPrevNight(false);
    }
  }, [observerLat, observerLon, timelineStartIso, timelineEndIso, queryClient]);

  // Moon-proximity + sky-visibility verdicts for placed blocks. Computed
  // server-side (POST /planner/verdict, see server/lib/autoPlan.ts's sibling
  // modules) so the timeline can never disagree with what "Plan My Night"
  // itself would say about the same block. Debounced so a rapid drag/resize
  // doesn't fire a request per frame — recomputed once things settle.
  const [visibilityById, setVisibilityById] = useState<Map<number, BlockVisibilityResult>>(new Map());
  const [moonById, setMoonById] = useState<Map<number, MoonProximityResult>>(new Map());

  useEffect(() => {
    if (observerLat == null || observerLon == null || sessions.length === 0) {
      setVisibilityById(new Map());
      setMoonById(new Map());
      return;
    }
    const illum = planner?.moonIllumination ?? 0;
    let cancelled = false;
    const timer = setTimeout(() => {
      getBlockVerdicts(
        sessions.map(s => ({ id: String(s.id), ra: s.ra, dec: s.dec, start: new Date(s.startTime), end: new Date(s.endTime) })),
        observerLat,
        observerLon,
        illum,
        visibleSkyMap,
        observerTimezone,
      )
        .then(results => {
          if (cancelled) return;
          const vis = new Map<number, BlockVisibilityResult>();
          const moon = new Map<number, MoonProximityResult>();
          for (const r of results) {
            const id = Number(r.id);
            vis.set(id, r.visibility);
            moon.set(id, r.moon);
          }
          setVisibilityById(vis);
          setMoonById(moon);
        })
        .catch(() => {
          // Leave the previous verdicts in place rather than clearing them
          // on a transient network error.
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessions, observerLat, observerLon, visibleSkyMap, planner?.moonIllumination, observerTimezone]);

  // Catalog thumbnail per scheduled block. The angular size comes from the
  // night's target list when it is there; blocks for objects outside tonight's
  // set still get a thumbnail at the default framing.
  const thumbnailById = useMemo(() => {
    const sizeById = new Map<string, number | null>();
    for (const t of planner?.targets ?? []) sizeById.set(t.id, t.majorAxisArcmin);
    const map = new Map<number, string>();
    for (const s of sessions) {
      map.set(s.id, getCatalogThumbnailUrl(s.objectId, sizeById.get(s.objectId) ?? null));
    }
    return map;
  }, [sessions, planner?.targets]);

  const scheduledIds = useMemo(() => new Set(sessions.map(s => s.objectId)), [sessions]);

  // Where the moon is above the horizon across this night, for the timeline
  // band and the hero's rise/set readout.
  const moonIntervals: Interval[] = useMemo(() => {
    if (observerLat == null || observerLon == null || !timelineStart || !timelineEnd) return [];
    return moonUpIntervals(timelineStart, timelineEnd, observerLat, observerLon);
  }, [observerLat, observerLon, timelineStart, timelineEnd]);

  const moonRise = useMemo(() => {
    if (!timelineStart) return null;
    const first = moonIntervals.find(m => m.start > timelineStart.getTime() + 60_000);
    return first ? new Date(first.start) : null;
  }, [moonIntervals, timelineStart]);
  const moonSet = useMemo(() => {
    if (!timelineEnd) return null;
    const last = moonIntervals.find(m => m.end < timelineEnd.getTime() - 60_000);
    return last ? new Date(last.end) : null;
  }, [moonIntervals, timelineEnd]);

  const twilight = useMemo(
    () => (observerLat != null && observerLon != null ? twilightMarksFor(selectedDate, observerLat, observerLon) : null),
    [selectedDate, observerLat, observerLon],
  );

  // Everything the Sky Forecast's hero and ribbon need to draw this night end
  // to end. The server only reports twilight for "tonight", so the phases come
  // from the same client-side sun-angle table the timeline gradient uses, and
  // the Moon's hours from the intervals computed above.
  const nightAstro: NightAstro | null = useMemo(() => {
    const sunsetIso = planner?.sunset ?? null;
    const sunriseIso = planner?.sunrise ?? null;
    if (!sunsetIso || !sunriseIso || !twilight) return null;

    const hoursBetween = (a: Date | null, b: Date | null) =>
      a && b && b.getTime() > a.getTime()
        ? Math.round(((b.getTime() - a.getTime()) / 3_600_000) * 10) / 10
        : 0;

    return {
      moonIllumination: planner?.moonIllumination ?? 0,
      moonPhase: planner?.moonPhase ?? 'Unknown',
      moonRise: moonRise?.toISOString() ?? null,
      moonSet: moonSet?.toISOString() ?? null,
      sunset: sunsetIso,
      sunrise: sunriseIso,
      astronomicalTwilightEnd: (twilight.astroEnd ?? twilight.nauticalEnd)?.toISOString() ?? sunsetIso,
      astronomicalTwilightStart: (twilight.astroStart ?? twilight.nauticalStart)?.toISOString() ?? sunriseIso,
      nauticalTwilightEnd: (twilight.nauticalEnd ?? twilight.civilEnd)?.toISOString() ?? sunsetIso,
      nauticalTwilightStart: (twilight.nauticalStart ?? twilight.civilStart)?.toISOString() ?? sunriseIso,
      darkHours: hoursBetween(twilight.astroEnd, twilight.astroStart),
      nauticalDarkHours: hoursBetween(twilight.nauticalEnd, twilight.nauticalStart),
    };
  }, [planner?.sunset, planner?.sunrise, planner?.moonIllumination, planner?.moonPhase, twilight, moonRise, moonSet]);

  const canOpenWeather = nightAstro != null && nightForecastHours.length > 1;

  const openWeather = useCallback((hour?: ForecastHour) => {
    setWeatherHourTime(hour?.time ?? null);
    setWeatherOpen(true);
  }, []);

  const refreshForecast = useCallback(async () => {
    if (!effectiveSiteId) return;
    setRefreshingForecast(true);
    try {
      await queryClient.fetchQuery({
        queryKey: ['forecast', effectiveSiteId],
        queryFn: () => getForecastForSite(effectiveSiteId, true),
        staleTime: 0,
      });
    } catch {
      // A failed refresh leaves the cached forecast on screen, which is the
      // right outcome: the popup keeps showing the last good data.
    } finally {
      setRefreshingForecast(false);
    }
  }, [effectiveSiteId, queryClient]);

  // Empty stretches of the dark window. Offered on the timeline as something to
  // fill rather than left as dead space.
  const gaps = useMemo(() => {
    const from = nightStart ?? timelineStart;
    const to = nightEnd ?? timelineEnd;
    if (!from || !to) return [];
    return findGaps(sessions, from, to, MIN_GAP_MINUTES);
  }, [sessions, nightStart, nightEnd, timelineStart, timelineEnd]);

  const plannedMinutes = useMemo(() => {
    const from = nightStart ?? timelineStart;
    const to = nightEnd ?? timelineEnd;
    if (!from || !to) return 0;
    return sumPlannedMinutes(sessions, from, to);
  }, [sessions, nightStart, nightEnd, timelineStart, timelineEnd]);

  const dragDeltaMap = useMemo(() => {
    const m = new Map<number, number>();
    if (activeBlockDrag) m.set(activeBlockDrag.id, activeBlockDrag.deltaY);
    return m;
  }, [activeBlockDrag]);

  /**
   * Schedule a target without dragging: drop it at its highest point in the
   * night that is still free. This is what makes the planner usable on a
   * touch screen, where dragging out of a scrolling list is not workable.
   */
  const handleQuickAdd = useCallback(
    (target: PlannerTarget) => {
      if (observerLat == null || observerLon == null || !timelineStartIso || !timelineEndIso) return;
      const tStart = new Date(timelineStartIso);
      const tEnd = new Date(timelineEndIso);
      const windowStart = darkStartIso ? new Date(darkStartIso) : tStart;
      const windowEnd = darkEndIso ? new Date(darkEndIso) : tEnd;

      // Never schedule into a part of tonight that has already gone by.
      const FIVE = 5 * 60_000;
      const nowMs = Date.now();
      const earliest = nowMs > windowStart.getTime() && nowMs < windowEnd.getTime()
        ? new Date(Math.ceil(nowMs / FIVE) * FIVE)
        : windowStart;

      const busy = sessions.map(s => ({
        start: new Date(s.startTime).getTime(),
        end: new Date(s.endTime).getTime(),
      }));
      const slot = bestSlotFor({
        ra: target.ra,
        dec: target.dec,
        lat: observerLat,
        lon: observerLon,
        windowStart: earliest,
        windowEnd,
        durationMinutes: DEFAULT_BLOCK_MINUTES,
        busy,
      });
      if (!slot) return;

      const start = clampTime(snapToGrid(slot.start), tStart, tEnd);
      const end = clampTime(new Date(start.getTime() + DEFAULT_BLOCK_MINUTES * 60_000), tStart, tEnd);
      if (minutesBetween(start, end) < MIN_BLOCK_MINUTES) return;

      createMutate({
        objectId: target.id,
        objectName: target.name,
        ra: target.ra,
        dec: target.dec,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
      });
      setMobilePane('schedule');
    },
    [observerLat, observerLon, timelineStartIso, timelineEndIso, darkStartIso, darkEndIso, sessions, createMutate],
  );

  /** Fill an empty stretch by running the auto-planner over just that window. */
  const handleFillGap = useCallback((gap: NightGap) => {
    setAutoPlanRange({ start: new Date(gap.start), end: new Date(gap.end), clearFirst: false });
    setAutoPlanOpen(true);
  }, []);

  // Apply an auto-generated plan: optionally wipe this night's blocks first,
  // then create each new block. We write through the raw API and invalidate
  // once at the end rather than firing the optimistic createMut per block,
  // which would thrash the cache and the connection pool. Errors propagate to
  // AutoPlanModal.handleApply, which surfaces them instead of silently closing.
  const applyAutoPlan = useCallback(
    async (blocks: PlanBlock[], clearFirst: boolean) => {
      if (clearFirst && timelineStartIso && timelineEndIso) {
        // Read the night's current blocks fresh from the server, not the query
        // cache: the cache can be stale (blocks added on another device, or
        // this exact date range was never populated because the user arrived
        // via a different range), and a stale read leaves old blocks in place
        // for the new plan to stack on top of.
        const current = await listPlannedSessions({ from: timelineStartIso, to: timelineEndIso });
        await Promise.all(current.filter(s => s.id > 0).map(s => deletePlannedSession(s.id)));
      }
      for (const b of blocks) {
        await createPlannedSession({
          objectId: b.target.id,
          objectName: b.target.name,
          ra: b.target.ra,
          dec: b.target.dec,
          startTime: b.start.toISOString(),
          endTime: b.end.toISOString(),
        });
      }
      await queryClient.invalidateQueries({ queryKey: ['planned-sessions'] });
    },
    [queryClient, timelineStartIso, timelineEndIso],
  );

  const stepDate = useCallback((days: number) => {
    setDateTouched(true);
    setSelectedDate(d => addDays(d, days));
  }, []);

  const pickDate = useCallback((d: Date) => {
    setDateTouched(true);
    setSelectedDate(d);
  }, []);

  // Memoized so LibraryPanel's row-level React.memo (LibraryRow/UnobservableRow)
  // isn't defeated by a fresh arrow on every render — onDragMove fires a state
  // update on every pointermove of a block drag, and without this, that
  // re-rendered up to RESULT_CAP (200) library rows per drag tick. Defined
  // above the early returns below: a hook can't be called conditionally.
  const handleShowTargetDetails = useCallback((t: Pick<PlannerTarget, 'id' | 'name' | 'ra' | 'dec' | 'majorAxisArcmin'>) => {
    setDetailsSession({
      objectId: t.id,
      objectName: t.name,
      ra: t.ra,
      dec: t.dec,
      majorAxisArcmin: t.majorAxisArcmin,
    });
  }, []);

  // Same reasoning as handleShowTargetDetails above: ScheduledImagingBlock is
  // also React.memo'd, and an inline arrow here would re-render every block on
  // every pointermove of a drag.
  const handleDeleteSession = useCallback((id: number) => {
    if (id > 0) deleteMutate(id);
  }, [deleteMutate]);
  const handleShowSessionDetails = useCallback((s: PlannedSession) => {
    setDetailsSession({
      objectId: s.objectId,
      objectName: s.objectName,
      ra: s.ra,
      dec: s.dec,
      majorAxisArcmin: planner?.targets.find(t => t.id === s.objectId)?.majorAxisArcmin ?? null,
    });
  }, [planner?.targets]);

  // ── Render ─────────────────────────────────────────────────────────────
  if (sitesQuery.isLoading || activeSiteQuery.isLoading || plannerQuery.isLoading) {
    return <div className={`p-6 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>Loading planner...</div>;
  }

  if (planner && !planner.locationSet) {
    // Wrapped in the same anchor as the fully-loaded planner below (not a
    // second, parallel one): a brand-new install always reaches this branch
    // during the tour's "planner" step, since onboarding never asks for a
    // location. Without the anchor here, that step has nothing to spotlight
    // and silently falls back to a floating, unhighlighted card.
    //
    // During the tour this branch should not be reached: starting the tour
    // fills in coordinates on the active site (see sampleLibrary.ts), so the
    // real Planner renders and the step demonstrates the actual feature. This
    // stays the honest fallback for everyone else, and for the moment before
    // that request lands.
    return (
      <TourAnchor id="planner" className="block">
        <LocationPrompt
          isDark={isDark}
          isNight={isNight}
          isSpace={isSpace}
          subText={isDark ? 'text-slate-400' : 'text-slate-600'}
          invalidateKeys={[['planner-targets'], ['settings']]}
        />
      </TourAnchor>
    );
  }

  const visibleCellCount = visibleSkyMap ? visibleSkyMap.filter(Boolean).length : SKY_MAP_CELLS;
  const skyConfigured = Boolean(visibleSkyMap);

  // Auto-plan scheduling window. The button is offered whenever there's a real
  // dark window to fill for the selected location and date. The actual start
  // ("now" rounded up when we're already into tonight, else dusk) is captured
  // in the click handler below, since reading the clock during render is impure.
  //
  // The window bounds are computed as millisecond numbers, taking the timeline
  // edges from the immutable ISO strings (Date.parse) rather than the
  // timelineStart/End Date objects. Calling a method like .getTime() on those
  // Dates here, after the drag/resize callbacks, makes the React Compiler treat
  // them (and the ISO strings the callbacks depend on) as possibly-mutated and
  // disables their memoization.
  const planWindowStartMs =
    nightStart != null ? nightStart.getTime() : timelineStartIso != null ? Date.parse(timelineStartIso) : null;
  const planWindowEndMs =
    nightEnd != null ? nightEnd.getTime() : timelineEndIso != null ? Date.parse(timelineEndIso) : null;
  const canAutoPlan =
    observerLat != null &&
    observerLon != null &&
    planWindowStartMs != null &&
    planWindowEndMs != null &&
    planWindowStartMs < planWindowEndMs - 15 * 60_000;
  const nightLabel = isToday ? 'Tonight' : formatPlannerDate(selectedDate);

  const openAutoPlan = () => {
    if (planWindowStartMs == null || planWindowEndMs == null) return;
    let startMs = planWindowStartMs;
    if (isToday) {
      const nowMs = Date.now();
      if (nowMs > planWindowStartMs) {
        const FIVE = 5 * 60_000;
        startMs = Math.ceil(nowMs / FIVE) * FIVE;
      }
    }
    setAutoPlanRange({ start: new Date(startMs), end: new Date(planWindowEndMs), clearFirst: true });
    setAutoPlanOpen(true);
  };

  const hasWindow = timelineStart != null && timelineEnd != null;

  const targetsPane = (
    <LibraryPanel
      targets={planner?.targets ?? []}
      initialQuery={initialSearch}
      observerLat={observerLat}
      observerLon={observerLon}
      nightStart={nightStart ?? timelineStart}
      nightEnd={nightEnd ?? timelineEnd}
      minAlt={currentSite?.minAlt ?? null}
      visibleSkyMap={visibleSkyMap}
      observerTimezone={observerTimezone}
      scheduledIds={scheduledIds}
      onQuickAdd={hasWindow ? handleQuickAdd : undefined}
      onShowDetails={handleShowTargetDetails}
    />
  );

  const schedulePane = hasWindow ? (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl bg-slate-950 ring-1 ring-inset ring-white/10 hero-panel">
      <div className="min-h-0 flex-1">
        <ScheduleTimeline
          ref={timelineRef}
          onScaleChange={(v) => { pxPerMinuteRef.current = v; }}
          nightStart={timelineStart!}
          nightEnd={timelineEnd!}
          darkStart={nightStart ?? undefined}
          darkEnd={nightEnd ?? undefined}
          twilight={twilight}
          sessions={sessions}
          visibilityById={visibilityById}
          moonById={moonById}
          thumbnailById={thumbnailById}
          dragDeltaById={dragDeltaMap}
          resizeDeltaById={resizePreview}
          forecastHours={nightForecastHours}
          onSelectWeatherHour={canOpenWeather ? openWeather : undefined}
          moonIllumination={planner?.moonIllumination ?? 0}
          moonIntervals={moonIntervals}
          gaps={gaps}
          onFillGap={canAutoPlan ? handleFillGap : undefined}
          plannedMinutes={plannedMinutes}
          targetCount={sessions.length}
          bestWindow={conditions?.bestWindow ?? null}
          onDelete={handleDeleteSession}
          onResize={handleResize}
          observerTimezone={observerTimezone}
          onShowDetails={handleShowSessionDetails}
        />
      </div>
      {/* The band chart squeezes a 12-hour axis into the pane width, so it is
          only legible from tablet up. On a phone the timeline takes the height
          instead. */}
      {observerLat != null && observerLon != null && (
        <div className="hidden shrink-0 md:block">
          <AltitudeBandChart
            nightStart={timelineStart!}
            nightEnd={timelineEnd!}
            sessions={sessions}
            observerLat={observerLat}
            observerLon={observerLon}
            minAlt={currentSite?.minAlt}
            observerTimezone={observerTimezone}
            twilight={twilight}
          />
        </div>
      )}
    </div>
  ) : (
    <div className={`flex h-full items-center justify-center rounded-2xl border p-6 text-center text-sm ${
      isDark ? 'border-slate-800 bg-slate-900/60 text-slate-400' : 'border-slate-200 bg-white text-slate-600'
    }`}>
      No observable night window is available for this location and date.
    </div>
  );

  return (
    <div className="space-y-6">
      <TourAnchor id="planner" className="block">
      <NightHero
        date={selectedDate}
        isToday={isToday}
        conditions={conditions}
        moonIllumination={planner?.moonIllumination ?? 0}
        moonPhase={planner?.moonPhase ?? 'Unknown'}
        moonRise={moonRise}
        moonSet={moonSet}
        timeZone={observerTimezone}
        accent={accent}
        canAutoPlan={canAutoPlan}
        onAutoPlan={openAutoPlan}
        onOpenWeather={canOpenWeather ? () => openWeather() : undefined}
        status={
          <SaveIndicator
            isPending={createMut.isPending || updateMut.isPending || deleteMut.isPending}
          />
        }
        siteControl={observerLat != null && observerLon != null && (
          <SitePicker
            isDark={isDark}
            accentText={accentText}
            sites={sites}
            currentSite={currentSite}
            fallbackLabel={`${observerLat.toFixed(2)}, ${observerLon.toFixed(2)}`}
            onSelect={(id) => setActiveSiteMut.mutate(id)}
            isSwitching={setActiveSiteMut.isPending}
          />
        )}
      />
      </TourAnchor>

      {/* Pick a night, then read that night. The night picker only needs a
          week of width, so the plan-level actions share its row. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <NightStrip
          nights={nights}
          selectedKey={selectedDateKey}
          onSelect={pickDate}
          onStep={stepDate}
          onOpenCalendar={() => setCalendarOpen(true)}
        />
        <PlannerActions
          isDark={isDark}
          onEditSky={() => setSkyEditorOpen(true)}
          skyLabel={skyConfigured ? `${visibleCellCount} / ${SKY_MAP_CELLS}` : 'not set'}
          onCopyPrevious={handleCopyFromPrevNight}
          isCopying={copyingPrevNight}
          canShare={sessions.length > 0 && hasWindow}
          onShare={() => setShareOpen(true)}
        />
      </div>

      {skyMapSaveError && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/15 px-3 py-2 text-xs text-red-400">
          Could not save sky map: {skyMapSaveError}
        </div>
      )}

      {copyPrevNightError && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/15 px-3 py-2 text-xs text-red-400">
          {copyPrevNightError}
        </div>
      )}

      {/* Below lg the two panes do not fit side by side, so they become tabs.
          Quick-add on a target row switches to the schedule, which is the
          confirmation that the tap landed. */}
      <div className="flex gap-2 lg:hidden">
        <PaneTab active={mobilePane === 'targets'} onClick={() => setMobilePane('targets')} isDark={isDark}>
          <ListTree className="h-4 w-4" />
          Targets
        </PaneTab>
        <PaneTab active={mobilePane === 'schedule'} onClick={() => setMobilePane('schedule')} isDark={isDark}>
          <CalendarRange className="h-4 w-4" />
          Schedule
          {sessions.length > 0 && (
            <span className="ml-1 rounded-full bg-accent-500 px-1.5 text-[10px] font-semibold text-white tabular-nums">
              {sessions.length}
            </span>
          )}
        </PaneTab>
      </div>

      <DndContext sensors={sensors} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd}>
        <div
          className={`grid h-[clamp(30rem,76vh,58rem)] min-h-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(19rem,32%)_1fr] transition-opacity duration-200 ${
            plannerQuery.isFetching ? 'opacity-60' : ''
          }`}
        >
          <div className={`min-h-0 ${mobilePane === 'targets' ? '' : 'hidden'} lg:block`}>
            {targetsPane}
          </div>
          <div className={`min-h-0 ${mobilePane === 'schedule' ? '' : 'hidden'} lg:block`}>
            {schedulePane}
          </div>
        </div>

        {/* Floats with the cursor while dragging from the library, so the user
            can see exactly where their drop will land on the timeline. */}
        <DragOverlay dropAnimation={null}>
          {activeLibraryDrag && (
            <div className="pointer-events-none rounded-xl border border-accent-400 bg-slate-900/95 px-3 py-2 text-sm font-medium text-slate-100 shadow-2xl">
              {formatObjectName(activeLibraryDrag.objectId, activeLibraryDrag.objectName)}
              <div className="mt-0.5 text-[11px] opacity-80">Drop on the timeline to schedule 90 minutes</div>
            </div>
          )}
        </DragOverlay>
      </DndContext>

      <VisibleSkyEditor
        open={skyEditorOpen}
        initialMap={visibleSkyMap}
        onSave={(map) => {
          saveSkyMapMut.mutate(map);
          setSkyEditorOpen(false);
        }}
        onClose={() => setSkyEditorOpen(false)}
      />

      {autoPlanOpen && autoPlanRange && observerLat != null && observerLon != null && (
        <AutoPlanModal
          targets={planner?.targets ?? []}
          observerLat={observerLat}
          observerLon={observerLon}
          scheduleStart={autoPlanRange.start}
          scheduleHardEnd={autoPlanRange.end}
          defaultClearFirst={autoPlanRange.clearFirst}
          moonIllumination={planner?.moonIllumination ?? 0}
          minAlt={currentSite?.minAlt ?? 30}
          visibleSkyMap={visibleSkyMap}
          observerTimezone={observerTimezone}
          nightLabel={nightLabel}
          isDark={isDark}
          onApply={applyAutoPlan}
          onClose={() => setAutoPlanOpen(false)}
        />
      )}

      {shareOpen && timelineStart && timelineEnd && (
        <PlanShareModal
          data={{
            sessions,
            nightStart: nightStart ?? timelineStart,
            nightEnd: nightEnd ?? timelineEnd,
            date: selectedDate,
            moonIllumination: planner?.moonIllumination ?? null,
            moonPhase: planner?.moonPhase ?? null,
            observerLat,
            observerLon,
            timezone: observerTimezone,
          }}
          onClose={() => setShareOpen(false)}
        />
      )}

      {weatherOpen && nightAstro && (
        <NightWeatherModal
          date={selectedDate}
          isToday={isToday}
          hours={nightForecastHours}
          astro={nightAstro}
          darkWindow={
            nightStart && nightEnd ? { start: nightStart.getTime(), end: nightEnd.getTime() } : null
          }
          allHours={forecastHourly}
          nightRatings={forecastQuery.data?.nightRatings ?? []}
          selectedDateKey={selectedDateKey}
          timeZone={observerTimezone}
          tempUnit={tempUnit}
          windUnit={windUnit}
          accent={accent}
          isDark={isDark}
          initialHourTime={weatherHourTime}
          onRefresh={refreshForecast}
          isRefreshing={refreshingForecast}
          onClose={() => setWeatherOpen(false)}
        />
      )}

      {calendarOpen && (
        <PlanCalendar
          selectedDate={selectedDate}
          observerTimezone={observerTimezone}
          onSelect={pickDate}
          onClose={() => setCalendarOpen(false)}
        />
      )}

      {detailsSession && (
        <SessionDetailsModal
          objectId={detailsSession.objectId}
          objectName={detailsSession.objectName}
          ra={detailsSession.ra}
          dec={detailsSession.dec}
          majorAxisArcmin={detailsSession.majorAxisArcmin}
          observerLat={observerLat}
          observerLon={observerLon}
          observerTimezone={observerTimezone}
          nightStart={nightStart}
          nightEnd={nightEnd}
          minAlt={currentSite?.minAlt}
          isDark={isDark}
          onClose={() => setDetailsSession(null)}
        />
      )}
    </div>
  );
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
}

function PaneTab({
  active,
  onClick,
  isDark,
  children,
}: {
  active: boolean;
  onClick: () => void;
  isDark: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition ${
        active
          ? 'bg-accent-500 text-white'
          : isDark
            ? 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
      }`}
    >
      {children}
    </button>
  );
}

function SaveIndicator({ isPending }: { isPending: boolean }) {
  const [showSaved, setShowSaved] = useState(false);
  const wasPending = useRef(false);

  useEffect(() => {
    const justFinished = wasPending.current && !isPending;
    wasPending.current = isPending;
    if (justFinished) {
      setShowSaved(true);
      const timer = setTimeout(() => setShowSaved(false), 2000);
      return () => clearTimeout(timer);
    }
  }, [isPending]);

  if (!isPending && !showSaved) return null;

  return (
    <span className="inline-flex items-center gap-1 text-[10px] normal-case tracking-normal text-white/50">
      {isPending ? (
        <>
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
          Saving...
        </>
      ) : (
        <>
          <Check className="h-3 w-3" />
          Saved
        </>
      )}
    </span>
  );
}

interface SessionDetailsModalProps {
  objectId: string;
  objectName: string;
  ra: number;
  dec: number;
  majorAxisArcmin: number | null;
  observerLat: number | null;
  observerLon: number | null;
  observerTimezone?: string;
  nightStart: Date | null;
  nightEnd: Date | null;
  minAlt: number | undefined;
  isDark: boolean;
  onClose: () => void;
}

function SessionDetailsModal({
  objectId,
  objectName,
  ra,
  dec,
  majorAxisArcmin,
  observerLat,
  observerLon,
  observerTimezone,
  nightStart,
  nightEnd,
  minAlt,
  isDark,
  onClose,
}: SessionDetailsModalProps) {
  const hasLocation = observerLat != null && observerLon != null;

  // Default the sky chart to the object's highest point tonight, the natural
  // "when should I image this" moment. Falls back to now when we can't compute
  // a curve (no location). Sample the planner's dark window if we have one,
  // else the local noon-to-noon window the altitude chart uses.
  const bestTime = useMemo(() => {
    if (!hasLocation) return new Date();
    const { start, end } = nightStart && nightEnd
      ? { start: nightStart, end: nightEnd }
      : buildTonightWindow(new Date(), observerTimezone);
    const curve = computeAltitudeCurve(ra, dec, observerLat, observerLon, start, end, 5);
    let best = curve[0];
    for (const s of curve) if (s.alt > best.alt) best = s;
    return best?.time ?? new Date();
  }, [hasLocation, ra, dec, observerLat, observerLon, observerTimezone, nightStart, nightEnd]);

  // Scrubbing the altitude chart drives the sky chart's moment. Null = not
  // scrubbing, so we fall back to the best-altitude default.
  const [scrubTime, setScrubTime] = useState<Date | null>(null);
  const skyTime = scrubTime ?? bestTime;

  const { data: info } = useQuery({
    queryKey: ['catalog-info', objectId],
    queryFn: () => getCatalogObjectInfo(objectId),
    staleTime: Infinity,
  });
  const description = info?.description?.trim() || '';
  const wikiUrl = info?.wikiUrl || null;

  const referenceUrl = getCatalogThumbnailUrl(objectId, majorAxisArcmin);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className={`relative rounded-2xl shadow-2xl max-w-3xl w-full max-h-[92vh] overflow-auto ${
          isDark ? 'bg-slate-900 text-slate-100' : 'bg-white text-slate-900'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-slate-700/40">
          <div>
            <h2 className="text-lg font-semibold">{formatObjectName(objectId, objectName)}</h2>
            <p className="text-xs opacity-70 mt-0.5">RA {ra.toFixed(2)}h · Dec {dec.toFixed(2)}°</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-white/10 transition"
            aria-label="Close details"
          >
            <CloseIcon />
          </button>
        </div>
        <div className="p-5 space-y-5">
          {/* Reference photo (left) + sky-position chart (right) */}
          <div className="grid gap-4 sm:grid-cols-2 items-start">
            <div className="space-y-2">
              <img
                src={referenceUrl}
                alt={`Reference image of ${objectName}`}
                loading="lazy"
                className={`block w-full aspect-square rounded-xl object-cover border ${
                  isDark ? 'border-slate-800 bg-slate-950' : 'border-slate-200 bg-slate-100'
                }`}
              />
              <p className={`text-[11px] text-center ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                Reference image
              </p>
            </div>

            {observerLat != null && observerLon != null ? (
              <SkyChart
                objectName={objectName}
                ra={ra}
                dec={dec}
                lat={observerLat}
                lon={observerLon}
                time={skyTime}
                isDark={isDark}
              />
            ) : (
              <div className={`flex aspect-square items-center justify-center rounded-xl border px-4 text-center text-sm ${
                isDark ? 'border-slate-800 bg-slate-950 text-slate-400' : 'border-slate-200 bg-slate-50 text-slate-500'
              }`}>
                Set your location in Settings to see where this sits in your sky.
              </div>
            )}
          </div>

          {hasLocation && (
            <p className={`-mt-2 text-[11px] text-center ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
              Sky shown at{' '}
              {formatHm(skyTime, observerTimezone)}
              {scrubTime ? '' : ' (highest tonight)'}. Scrub the curve below to retime.
            </p>
          )}

          {/* Description */}
          <div className="min-w-0">
            {description ? (
              <p className={`text-sm leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                {description}
              </p>
            ) : (
              <p className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                No catalog description available for this object.
              </p>
            )}
            {wikiUrl && (
              <a
                href={wikiUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={`inline-block text-xs mt-2 ${isDark ? 'text-amber-400 hover:text-amber-300' : 'text-amber-600 hover:text-amber-700'}`}
              >
                Read more on Wikipedia →
              </a>
            )}
          </div>

          {hasLocation ? (
            <div>
              <div className={`text-xs font-medium mb-2 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                Altitude tonight (local noon to noon)
              </div>
              <AltitudeChart
                ra={ra}
                dec={dec}
                lat={observerLat}
                lon={observerLon}
                minAlt={minAlt}
                timeZone={observerTimezone}
                isDark={isDark}
                onScrub={(p) => setScrubTime(p ? p.time : null)}
              />
            </div>
          ) : (
            <div className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
              Set your location in Settings to see the altitude curve.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
