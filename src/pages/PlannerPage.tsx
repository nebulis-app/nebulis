/**
 * Tonight's planner. Two-pane layout:
 *
 *   Library (left)  |  Schedule (right, vertical timeline, dusk-to-dawn)
 *
 * Plus a "Set Visible Sky" polar editor in the top bar that captures which
 * patches of sky the observer can actually see (trees, neighbors, rooflines).
 * Each scheduled block is checked against that map and indicated with a
 * green / amber / red stripe.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
import { Moon, Compass, MapPin, Calendar, ChevronLeft, ChevronRight, Check, Crosshair, Sparkles, Share2, Copy } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { getPlannerTargets } from '../lib/api/planner';
import { getSettings, updateSettings } from '../lib/api/settings';
import { listPlannedSessions, createPlannedSession, updatePlannedSession, deletePlannedSession, type PlannedSession, type PlannedSessionCreate } from '../lib/api/plannedSessions';
import { getCatalogObjectInfo } from '../lib/api/catalog';
import { getCatalogThumbnailUrl } from '../lib/catalogImage';
import { LocationPrompt } from '../components/LocationPrompt';
import { AltitudeChart } from '../components/AltitudeChart';
import { SkyChart } from '../components/planner/SkyChart';
import { computeAltitudeCurve, buildTonightWindow } from '../lib/altaz';
import { LibraryPanel } from '../components/planner/LibraryPanel';
import { ScheduleTimeline } from '../components/planner/ScheduleTimeline';
import { VisibleSkyEditor } from '../components/planner/VisibleSkyEditor';
import { AltitudeBandChart } from '../components/planner/AltitudeBandChart';
import { PlanCalendar } from '../components/planner/PlanCalendar';
import { dateFromKey, formatPlannerDate, localDateKey, nightWindowFor, plannerToday, sameLocalDay, timelineWindowFor } from '../lib/nightWindow';
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
  checkBlockVisibility,
  SKY_MAP_CELLS,
  type BlockVisibilityResult,
  type VisibleSkyMap,
} from '../lib/visibilityCheck';
import { checkMoonProximity, type MoonProximityResult } from '../lib/moonProximity';
import { AutoPlanModal } from '../components/planner/AutoPlanModal';
import { PlanShareModal } from '../components/planner/PlanShareModal';
import type { PlanBlock } from '../lib/autoPlan';
import { formatObjectName } from '../lib/utils';

const TIMELINE_BUFFER_MS = 30 * 60_000; // 30-min padding beyond sunset/sunrise

export function PlannerPage() {
  const { isDark, isNight, isSpace } = useTheme();
  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500';
  const queryClient = useQueryClient();
  const location = useLocation();
  const navState = location.state as { searchQuery?: string; focusDate?: string } | null;
  const initialSearch = navState?.searchQuery ?? '';
  // When arriving from "Plan Tonight" on a catalog, open on the night the plan
  // was scheduled into rather than the planner's own default "today".
  const initialFocusDate = navState?.focusDate;

  // staleTime: 0 so navigating to the planner always loads current settings
  // (sky map and location can be changed from another device/tab).
  // refetchInterval keeps the sky map in sync while the planner is open.
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
    staleTime: 0,
    refetchInterval: 60_000,
  });

  const settings = settingsQuery.data;

  const observerLat = settings?.latitude ?? null;
  const observerLon = settings?.longitude ?? null;

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
  const settingsTimezone = settings?.timezone || undefined;
  const settingsToday = useMemo(() => plannerToday(new Date(), settingsTimezone), [settingsTimezone]);
  const isToday = sameLocalDay(selectedDate, settingsToday);
  const plannerQuery = useQuery({
    queryKey: ['planner-targets', observerLat, observerLon, settingsTimezone, isToday ? 'today' : selectedDateKey],
    queryFn: () => getPlannerTargets(isToday ? {} : { date: selectedDateKey }),
  });
  const planner = plannerQuery.data;
  const observerTimezone = planner?.observerTimezone || settingsTimezone;
  useEffect(() => {
    if (!observerTimezone || dateTouched) return;
    setSelectedDate(plannerToday(new Date(), observerTimezone));
  }, [observerTimezone, dateTouched]);

  // Server response is authoritative for the night window of the requested
  // date. Fall back to client-side SunCalc only if the server didn't return
  // one (e.g. location not set).
  const nightWindow: { start: Date; end: Date } | null =
    planner?.nightStart && planner?.nightEnd
      ? { start: new Date(planner.nightStart), end: new Date(planner.nightEnd) }
      : observerLat == null || observerLon == null
        ? null
        : nightWindowFor(selectedDate, observerLat, observerLon);

  const nightStart = nightWindow?.start ?? null;
  const nightEnd = nightWindow?.end ?? null;
  const plannerTimelineStart = planner?.timelineStart ? new Date(planner.timelineStart) : null;
  const plannerTimelineEnd = planner?.timelineEnd ? new Date(planner.timelineEnd) : null;

  // Timeline spans from sunset to sunrise so users can schedule sessions in
  // twilight. The dark window is shown as dashed markers inside this wider
  // range, not as hard boundaries. Fall back to nightStart ± 2h when
  // sunset/sunrise aren't available (polar regions where the sun doesn't set).
  // A 10-hour minimum ensures the window never feels cramped in high-latitude
  // summers where sunset and sunrise are only ~7 hours apart.
  const MIN_TIMELINE_MS = 10 * 60 * 60_000;
  const sunset = planner?.sunset ? new Date(planner.sunset) : null;
  const sunrise = planner?.sunrise ? new Date(planner.sunrise) : null;
  const timelineStart = plannerTimelineStart
    ? new Date(plannerTimelineStart.getTime() - TIMELINE_BUFFER_MS)
    : sunset
    ? new Date(sunset.getTime() - TIMELINE_BUFFER_MS)
    : nightStart ? new Date(nightStart.getTime() - 2 * 60 * 60_000) : null;
  const timelineEndRaw = plannerTimelineEnd
    ? new Date(plannerTimelineEnd.getTime() + TIMELINE_BUFFER_MS)
    : sunrise
    ? new Date(sunrise.getTime() + TIMELINE_BUFFER_MS)
    : nightEnd ? new Date(nightEnd.getTime() + 2 * 60 * 60_000) : null;
  const timelineEnd = timelineStart && timelineEndRaw
    ? new Date(Math.max(timelineEndRaw.getTime(), timelineStart.getTime() + MIN_TIMELINE_MS))
    : timelineEndRaw;
  const timelineStartIso = timelineStart?.toISOString() ?? null;
  const timelineEndIso = timelineEnd?.toISOString() ?? null;

  // Load sessions across the full extended window.
  const sessionsQuery = useQuery({
    queryKey: ['planned-sessions', timelineStartIso, timelineEndIso],
    enabled: timelineStartIso != null && timelineEndIso != null,
    queryFn: () =>
      timelineStartIso && timelineEndIso
        ? listPlannedSessions({ from: timelineStartIso, to: timelineEndIso })
        : Promise.resolve([]),
  });
  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);

  const visibleSkyMap: VisibleSkyMap | null = settings?.visibleSkyMap?.length === SKY_MAP_CELLS ? settings.visibleSkyMap : null;

  // ── Mutations ──────────────────────────────────────────────────────────
  const createMut = useMutation({
    mutationFn: createPlannedSession,
    // Optimistically add the block so it appears on the timeline immediately,
    // even while catalog thumbnails are still loading. Those image requests can
    // saturate the browser's per-host connection pool, which otherwise delays
    // both this POST and the follow-up refetch — making a dropped block look
    // stuck on "Saving" and never appear. The real row replaces the temp one as
    // soon as the server responds.
    onMutate: async (vars: PlannedSessionCreate) => {
      await queryClient.cancelQueries({ queryKey: ['planned-sessions'] });
      const tempId = -Date.now();
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
      const previous = queryClient.getQueriesData<PlannedSession[]>({ queryKey: ['planned-sessions'] });
      queryClient.setQueriesData<PlannedSession[]>({ queryKey: ['planned-sessions'] }, old =>
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
  const [skyMapSaveError, setSkyMapSaveError] = useState<string | null>(null);
  const saveSkyMapMut = useMutation({
    mutationFn: (map: VisibleSkyMap) => updateSettings({ visibleSkyMap: map }),
    onSuccess: () => {
      setSkyMapSaveError(null);
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
   *  timeline is scrolled. Falls back to activatorEvent.clientY + delta.y. */
  const pointerYRef = useRef<number | null>(null);
  const [resizePreview, setResizePreview] = useState<Map<number, { edge: 'top' | 'bottom'; deltaMinutes: number }>>(new Map());
  const [copyingPrevNight, setCopyingPrevNight] = useState(false);
  const [skyEditorOpen, setSkyEditorOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [autoPlanOpen, setAutoPlanOpen] = useState(false);
  const [autoPlanStart, setAutoPlanStart] = useState<Date | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
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
    const data = event.active.data.current as Record<string, unknown> | undefined;
    // Seed pointer tracking with the activator position so the very first
    // pointermove isn't needed before we have a reading.
    const activator = event.activatorEvent as PointerEvent | MouseEvent | undefined;
    if (activator && typeof activator.clientY === 'number') {
      pointerYRef.current = activator.clientY;
    }
    if (data?.kind === 'block') {
      const id = Number(String(event.active.id).split(':')[1]);
      setActiveBlockDrag({ id, deltaY: 0 });
      return;
    }
    if (data?.kind === 'library') {
      setActiveLibraryDrag({
        objectId: String(data.objectId),
        objectName: String(data.objectName),
        ra: Number(data.ra),
        dec: Number(data.dec),
      });
    }
  }, []);

  const onDragMove = useCallback((event: DragMoveEvent) => {
    const data = event.active.data.current as { kind?: string } | undefined;
    if (data?.kind === 'block') {
      const id = Number(String(event.active.id).split(':')[1]);
      setActiveBlockDrag({ id, deltaY: event.delta.y });
    }
  }, []);

  const onDragEnd = useCallback((event: DragEndEvent) => {
    const data = event.active.data.current as Record<string, unknown> | undefined;
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
      const activator = event.activatorEvent as PointerEvent | MouseEvent | undefined;
      const fallbackY = (activator?.clientY ?? 0) + event.delta.y;
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
      createMut.mutate({
        objectId: String(data.objectId),
        objectName: String(data.objectName),
        ra: Number(data.ra),
        dec: Number(data.dec),
        startTime: startSnapped.toISOString(),
        endTime: endSnapped.toISOString(),
      });
      return;
    }

    if (data.kind === 'block') {
      const id = Number(String(event.active.id).split(':')[1]);
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
      updateMut.mutate({ id, patch: { startTime: newStart.toISOString(), endTime: newEnd.toISOString() } });
    }
  }, [createMut, updateMut, sessions, timelineStartIso, timelineEndIso]);

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
      updateMut.mutate({
        id,
        patch: edge === 'top' ? { startTime: newStart.toISOString() } : { endTime: newEnd.toISOString() },
      });
    },
    [sessions, timelineStartIso, timelineEndIso, updateMut],
  );

  const handleCopyFromPrevNight = useCallback(async () => {
    if (observerLat == null || observerLon == null || !timelineStart || !timelineEnd) return;
    setCopyingPrevNight(true);
    try {
      const prevDate = addDays(selectedDate, -1);
      // Use the sunset-buffered timeline window (not the narrower astronomical
      // dark window) so twilight blocks from the previous night — a lunar or
      // planetary session scheduled right after sunset, say — are included in
      // what gets copied forward, matching what the timeline actually let the
      // user schedule that night.
      const prevWindow = timelineWindowFor(prevDate, observerLat, observerLon, TIMELINE_BUFFER_MS);
      if (!prevWindow) return;
      const prevSessions = await listPlannedSessions({
        from: prevWindow.start.toISOString(),
        to: prevWindow.end.toISOString(),
      });
      if (prevSessions.length === 0) return;
      const DAY_MS = 24 * 60 * 60 * 1000;
      await Promise.all(
        prevSessions.map(s => {
          const newStart = clampTime(new Date(new Date(s.startTime).getTime() + DAY_MS), timelineStart!, timelineEnd!);
          const newEnd = clampTime(new Date(new Date(s.endTime).getTime() + DAY_MS), timelineStart!, timelineEnd!);
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
    } finally {
      setCopyingPrevNight(false);
    }
  }, [selectedDate, observerLat, observerLon, timelineStart, timelineEnd, queryClient]);

  const visibilityById = useMemo(() => {
    const map = new Map<number, BlockVisibilityResult>();
    if (observerLat == null || observerLon == null) return map;
    for (const s of sessions) {
      map.set(
        s.id,
        checkBlockVisibility(
          s.ra,
          s.dec,
          observerLat,
          observerLon,
          new Date(s.startTime),
          new Date(s.endTime),
          visibleSkyMap,
          5,
          observerTimezone,
        ),
      );
    }
    return map;
  }, [sessions, observerLat, observerLon, visibleSkyMap, observerTimezone]);

  const moonById = useMemo(() => {
    const map = new Map<number, MoonProximityResult>();
    if (observerLat == null || observerLon == null) return map;
    const illum = planner?.moonIllumination ?? 0;
    for (const s of sessions) {
      map.set(
        s.id,
        checkMoonProximity(
          s.ra,
          s.dec,
          observerLat,
          observerLon,
          new Date(s.startTime),
          new Date(s.endTime),
          illum,
          5,
          observerTimezone,
        ),
      );
    }
    return map;
  }, [sessions, observerLat, observerLon, planner?.moonIllumination, observerTimezone]);

  const dragDeltaMap = useMemo(() => {
    const m = new Map<number, number>();
    if (activeBlockDrag) m.set(activeBlockDrag.id, activeBlockDrag.deltaY);
    return m;
  }, [activeBlockDrag]);

  // Apply an auto-generated plan: optionally wipe this night's blocks first,
  // then create each new block. We write through the raw API and invalidate
  // once at the end rather than firing the optimistic createMut per block,
  // which would thrash the cache and the connection pool.
  // applyAutoPlan reads the night's existing blocks straight from the query
  // cache rather than closing over the `sessions` value. Referencing `sessions`
  // in this later-defined closure makes the React Compiler treat it as
  // possibly-mutated and disables memoization on the drag/resize callbacks
  // above; going through queryClient (opaque to the compiler) sidesteps that.
  const applyAutoPlan = useCallback(
    async (blocks: PlanBlock[], clearFirst: boolean) => {
      if (clearFirst) {
        // Scoped to this night's own query key only. The cache can hold
        // other nights' ['planned-sessions', from, to] entries (e.g. the
        // user arrowed through a few dates before opening this modal) — a
        // key-agnostic scan across all ['planned-sessions'] queries would
        // delete blocks belonging to those other nights too.
        const current = queryClient.getQueryData<PlannedSession[]>(
          ['planned-sessions', timelineStartIso, timelineEndIso],
        ) ?? [];
        const ids = current.filter(s => s.id > 0).map(s => s.id);
        await Promise.all(ids.map(id => deletePlannedSession(id)));
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


  // ── Render ─────────────────────────────────────────────────────────────
  if (settingsQuery.isLoading || plannerQuery.isLoading) {
    return <div className={`p-6 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>Loading planner...</div>;
  }

  if (planner && !planner.locationSet) {
    return (
      <LocationPrompt
        isDark={isDark}
        isNight={isNight}
        isSpace={isSpace}
        subText={isDark ? 'text-slate-400' : 'text-slate-600'}
        invalidateKeys={[['planner-targets'], ['settings']]}
      />
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
  const planWindowEnd = planWindowEndMs != null ? new Date(planWindowEndMs) : null;
  const canAutoPlan =
    observerLat != null &&
    observerLon != null &&
    planWindowStartMs != null &&
    planWindowEndMs != null &&
    planWindowStartMs < planWindowEndMs - 15 * 60_000;
  const nightLabel = isToday ? 'Tonight' : formatPlannerDate(selectedDate);

  const openAutoPlan = () => {
    if (planWindowStartMs == null) return;
    let startMs = planWindowStartMs;
    if (isToday) {
      const nowMs = Date.now();
      if (nowMs > planWindowStartMs) {
        const FIVE = 5 * 60_000;
        startMs = Math.ceil(nowMs / FIVE) * FIVE;
      }
    }
    setAutoPlanStart(new Date(startMs));
    setAutoPlanOpen(true);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-6rem)] -mb-8 min-h-0">
      <div className="flex items-center justify-between gap-4 pb-4">
        <h1 className={`font-display text-3xl font-bold tracking-tight flex items-center gap-3 ${isDark ? 'text-white' : 'text-slate-900'}`}>
          <Crosshair className={`w-7 h-7 ${accentText}`} />
          Planner
        </h1>
        {observerLat != null && observerLon != null && (
          <div className="flex flex-col items-end gap-1 shrink-0">
            <div className={`flex items-center gap-1.5 text-sm ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
              <MapPin className={`w-4 h-4 shrink-0 ${accentText}`} />
              <span className="font-medium">
                {settings?.locationName || `${observerLat.toFixed(2)}, ${observerLon.toFixed(2)}`}
              </span>
            </div>
            <div className={`flex items-center gap-3 text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
              <SaveIndicator
                isPending={createMut.isPending || updateMut.isPending || deleteMut.isPending}
                isDark={isDark}
              />
              {planner?.moonIllumination != null && (
                <span className="flex items-center gap-1">
                  <Moon className="w-3.5 h-3.5" />
                  Moon {planner.moonIllumination}% ({planner.moonPhase})
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      <header
        className={`flex items-center justify-between gap-3 px-4 py-3 border-b ${
          isDark ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-white'
        }`}
      >
        <div className="flex items-center gap-3 flex-wrap">
          {/* Date stepper + calendar trigger */}
          <div className={`inline-flex items-center gap-0.5 rounded-lg overflow-hidden ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
            <button
              onClick={() => {
                setDateTouched(true);
                setSelectedDate(d => addDays(d, -1));
              }}
              className={`p-2 ${isDark ? 'text-slate-300 hover:bg-slate-700' : 'text-slate-700 hover:bg-slate-200'}`}
              aria-label="Previous night"
              title="Previous night"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => setCalendarOpen(true)}
              className={`flex items-center gap-2 px-3 py-2 text-sm font-medium ${isDark ? 'text-slate-100 hover:bg-slate-700' : 'text-slate-900 hover:bg-slate-200'}`}
              title="Pick a date"
            >
              <Calendar className="w-4 h-4" />
              {formatPlannerDate(selectedDate)}
              {isToday && (
                <span className="text-[10px] uppercase tracking-wide opacity-70">Tonight</span>
              )}
            </button>
            <button
              onClick={() => {
                setDateTouched(true);
                setSelectedDate(d => addDays(d, 1));
              }}
              className={`p-2 ${isDark ? 'text-slate-300 hover:bg-slate-700' : 'text-slate-700 hover:bg-slate-200'}`}
              aria-label="Next night"
              title="Next night"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          {!isToday && (
            <button
              onClick={handleCopyFromPrevNight}
              disabled={copyingPrevNight || !timelineStart || !timelineEnd}
              className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded transition disabled:opacity-40 ${
                isDark
                  ? 'bg-slate-700 hover:bg-slate-600 text-slate-200'
                  : 'bg-slate-200 hover:bg-slate-300 text-slate-700'
              }`}
              title="Copy sessions from the previous night to this night"
            >
              <Copy className="w-3.5 h-3.5" />
              {copyingPrevNight ? 'Copying…' : 'Copy from previous night'}
            </button>
          )}
          {canAutoPlan && (
            <button
              onClick={openAutoPlan}
              className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition border ${
                isNight
                  ? 'bg-red-500/15 text-red-400 hover:bg-red-500/25 border-red-500/30'
                  : isSpace
                    ? 'bg-violet-500/15 text-violet-400 hover:bg-violet-500/25 border-violet-500/30'
                    : isDark
                      ? 'bg-accent-500/15 text-accent-400 hover:bg-accent-500/25 border-accent-500/30'
                      : 'bg-accent-300 text-accent-700 hover:bg-accent-400 border-accent-400'
              }`}
              title="Auto-generate an imaging plan for this night"
            >
              <Sparkles className="w-4 h-4" />
              Plan My Night
            </button>
          )}
          <button
            onClick={() => setSkyEditorOpen(true)}
            className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition border ${
              isNight
                ? 'bg-red-500/15 text-red-400 hover:bg-red-500/25 border-red-500/30'
                : isSpace
                  ? 'bg-violet-500/15 text-violet-400 hover:bg-violet-500/25 border-violet-500/30'
                  : isDark
                    ? 'bg-accent-500/15 text-accent-400 hover:bg-accent-500/25 border-accent-500/30'
                    : 'bg-accent-300 text-accent-700 hover:bg-accent-400 border-accent-400'
            }`}
          >
            <Compass className="w-4 h-4" />
            Set Visible Sky
            <span className="text-[11px] opacity-90">
              {skyConfigured ? `${visibleCellCount} / ${SKY_MAP_CELLS}` : 'not set'}
            </span>
          </button>
        </div>
        {skyMapSaveError && (
          <div className="mx-4 mt-1 px-3 py-1.5 rounded-lg bg-red-500/15 text-red-400 text-xs border border-red-500/30">
            Could not save sky map: {skyMapSaveError}
          </div>
        )}
        {sessions.length > 0 && timelineStart && timelineEnd && (
          <button
            onClick={() => setShareOpen(true)}
            className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition shrink-0 ${
              isDark ? 'bg-slate-800 text-slate-100 hover:bg-slate-700' : 'bg-slate-100 text-slate-900 hover:bg-slate-200'
            }`}
            title="Share this night's plan as text or an image"
          >
            <Share2 className="w-4 h-4" />
            Share
          </button>
        )}
      </header>

      <DndContext sensors={sensors} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd}>
        <div className="grid grid-cols-[minmax(280px,38%)_1fr] flex-1 min-h-0">
          <LibraryPanel
            targets={planner?.targets ?? []}
            initialQuery={initialSearch}
            observerLat={observerLat}
            observerLon={observerLon}
            nightStart={nightStart ?? timelineStart}
            nightEnd={nightEnd ?? timelineEnd}
            minAlt={settings?.minAlt ?? null}
            visibleSkyMap={visibleSkyMap}
            onShowDetails={(t) => setDetailsSession({
              objectId: t.id,
              objectName: t.name,
              ra: t.ra,
              dec: t.dec,
              majorAxisArcmin: t.majorAxisArcmin,
            })}
          />
          {timelineStart && timelineEnd ? (
            <div className="flex flex-col h-full min-h-0">
              <div className="flex-1 min-h-0">
                <ScheduleTimeline
                  ref={timelineRef}
                  onScaleChange={(v) => { pxPerMinuteRef.current = v; }}
                  nightStart={timelineStart}
                  nightEnd={timelineEnd}
                  darkStart={nightStart ?? undefined}
                  darkEnd={nightEnd ?? undefined}
                  sessions={sessions}
                  visibilityById={visibilityById}
                  moonById={moonById}
                  dragDeltaById={dragDeltaMap}
                  resizeDeltaById={resizePreview}
                  onDelete={(id) => { if (id > 0) deleteMut.mutate(id); }}
                  onResize={handleResize}
                  observerTimezone={observerTimezone}
                  onShowDetails={(s) => setDetailsSession({
                    objectId: s.objectId,
                    objectName: s.objectName,
                    ra: s.ra,
                    dec: s.dec,
                    majorAxisArcmin: planner?.targets.find(t => t.id === s.objectId)?.majorAxisArcmin ?? null,
                  })}
                />
              </div>
              {observerLat != null && observerLon != null && (
                <AltitudeBandChart
                  nightStart={timelineStart ?? nightStart}
                  nightEnd={timelineEnd ?? nightEnd}
                  sessions={sessions}
                  observerLat={observerLat}
                  observerLon={observerLon}
                  minAlt={settings?.minAlt}
                  observerTimezone={observerTimezone}
                />
              )}
            </div>
          ) : (
            <div className={`p-6 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
              No observable night window is available for this location and date.
            </div>
          )}
        </div>

        {/* Floats with the cursor while dragging from the library, so the user
            can see exactly where their drop will land on the timeline. */}
        <DragOverlay dropAnimation={null}>
          {activeLibraryDrag && (
            <div className="pointer-events-none rounded-lg border border-amber-400 bg-slate-800/95 text-slate-100 shadow-2xl px-3 py-2 text-sm font-medium">
              {formatObjectName(activeLibraryDrag.objectId, activeLibraryDrag.objectName)}
              <div className="text-[11px] opacity-80 mt-0.5">Drop on the timeline to schedule (1 hour)</div>
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

      {autoPlanOpen && autoPlanStart && planWindowEnd && observerLat != null && observerLon != null && (
        <AutoPlanModal
          targets={planner?.targets ?? []}
          observerLat={observerLat}
          observerLon={observerLon}
          scheduleStart={autoPlanStart}
          scheduleHardEnd={planWindowEnd}
          moonIllumination={planner?.moonIllumination ?? 0}
          minAlt={settings?.minAlt ?? 30}
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

      {calendarOpen && (
        <PlanCalendar
          selectedDate={selectedDate}
          observerTimezone={observerTimezone}
          onSelect={(d) => {
            setDateTouched(true);
            setSelectedDate(d);
          }}
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
          minAlt={settings?.minAlt}
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

function SaveIndicator({ isPending, isDark }: { isPending: boolean; isDark: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}
      title="Plans save automatically on every change"
    >
      {isPending ? (
        <>
          <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
          Saving…
        </>
      ) : (
        <>
          <Check className="w-3 h-3" />
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

  // Default the sky chart to the object's highest point tonight — the natural
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
              {skyTime.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(observerTimezone ? { timeZone: observerTimezone } : {}) })}
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
