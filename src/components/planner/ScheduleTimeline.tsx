/**
 * The night itself: a vertical dusk-to-dawn canvas you drop targets onto.
 *
 * Four layers sit behind the blocks, each answering a question you would
 * otherwise have to leave the page for:
 *
 *   Twilight   the real sun-angle gradient, so dusk fades rather than switching
 *   Weather    the hourly forecast rating down the gutter, hour by hour
 *   Moon       when the moon is above the horizon, and when it rises and sets
 *   Now        a live line, so the page is usable while you are actually out
 *
 * Empty stretches of the dark window are offered as fillable gaps rather than
 * left as dead space. The canvas is dark in every theme: it is a picture of
 * the night, like the Sky Forecast hero.
 */
import { forwardRef, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { Moon, Plus } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { formatObjectName } from '../../lib/utils';
import { scoreHex, calculateVisibilityScore } from '../../lib/forecastScore';
import { useTheme } from '../../hooks/useTheme';
import { formatDuration, twilightGradientCss, type Interval, type NightGap, type TwilightMarks } from '../../lib/plannerNight';
import { ScheduledImagingBlock } from './ScheduledImagingBlock';
import {
  computePxPerMinute,
  formatHm,
  hourTicks,
  minutesBetween,
  rangesOverlap,
  SNAP_MINUTES,
  TIMELINE_GUTTER_PX,
} from './scheduleGeometry';
import type { PlannedSession } from '../../lib/api/plannedSessions';
import type { ForecastHour } from '../../lib/api/planner';
import type { BlockVisibilityResult } from '../../lib/visibilityCheck';
import type { MoonProximityResult } from '../../lib/moonProximity';

interface ScheduleTimelineProps {
  nightStart: Date;
  nightEnd: Date;
  /** Actual dark window boundaries, drawn as the deep part of the gradient. */
  darkStart?: Date;
  darkEnd?: Date;
  /** Sun-angle boundaries used to paint the twilight gradient. */
  twilight?: TwilightMarks | null;
  sessions: PlannedSession[];
  visibilityById: Map<number, BlockVisibilityResult>;
  moonById: Map<number, MoonProximityResult>;
  /** Thumbnail URL per session id, so blocks show the object rather than text alone. */
  thumbnailById?: Map<number, string>;
  /** Provisional Y delta during a body-drag (px), keyed by session id. */
  dragDeltaById: Map<number, number>;
  /** Provisional resize, keyed by session id; positive = bottom edge moved down. */
  resizeDeltaById: Map<number, { edge: 'top' | 'bottom'; deltaMinutes: number }>;
  /** Hourly weather for this night, drawn down the gutter. Empty when unknown. */
  forecastHours?: ForecastHour[];
  moonIllumination?: number;
  /** Opens the night's full forecast, focused on the hour that was clicked.
   *  The gutter is the only place the weather is visible on this canvas, so it
   *  is also the way in to the detail behind it. */
  onSelectWeatherHour?: (hour: ForecastHour) => void;
  /** Stretches where the moon is above the horizon. */
  moonIntervals?: Interval[];
  /** Empty stretches of the dark window worth offering to fill. */
  gaps?: NightGap[];
  onFillGap?: (gap: NightGap) => void;
  /** Minutes booked inside the dark window, summarised in the header. */
  plannedMinutes?: number;
  targetCount?: number;
  /** The forecast's longest usable run, named in the header rather than
   *  described in a panel above the canvas it applies to. */
  bestWindow?: { start: Date; end: Date } | null;
  onDelete: (id: number) => void;
  onResize: (id: number, edge: 'top' | 'bottom', deltaMinutes: number, commit: boolean) => void;
  /** Open the details popup (altitude curve, sky-survey image, blurb) for a block. */
  onShowDetails: (session: PlannedSession) => void;
  /** Jumps straight to the Framing & Mosaic modal for a block, preloaded with
   *  its saved mosaic. Passed through to ScheduledImagingBlock, which only
   *  shows the shortcut icon when a block actually has one saved. */
  onShowFraming?: (session: PlannedSession) => void;
  /** Buttons for the end of the header: what you do with the plan as a whole (copy, share). */
  headerActions?: ReactNode;
  /** Shown under the header while the night has no blocks, in place of a bare empty canvas. */
  emptyState?: ReactNode;
  /** Reports the runtime pixels-per-minute scale so the page's drag/drop math
   *  (which converts pointer pixels to times) matches what's rendered here. */
  onScaleChange?: (pxPerMinute: number) => void;
  /** IANA timezone for displaying tick labels (e.g. "Europe/London"). Defaults to machine-local. */
  observerTimezone?: string;
}

// Floor a Date to the nearest SNAP_MINUTES boundary for overlap comparisons.
// This absorbs any sub-minute precision that can creep in when a session's end
// time gets clamped to the timeline boundary (which may not be snap-aligned).
// Two sessions displaying the same HH:MM should never appear as overlapping.
const SNAP_MS = SNAP_MINUTES * 60_000;
function floorSnap(d: Date): number {
  return Math.floor(d.getTime() / SNAP_MS) * SNAP_MS;
}

/**
 * Lane assignment: pack overlapping sessions into the fewest parallel
 * columns. Greedy first-fit by start time.
 */
function assignLanes(sessions: PlannedSession[]): { laneIndex: Map<number, number>; laneCount: Map<number, number> } {
  const sorted = sessions.slice().sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  const laneIndex = new Map<number, number>();
  // Cluster sessions that transitively overlap, then assign lanes within the cluster.
  // Times are floored to the nearest snap boundary so a session whose stored end
  // time is 02:00:30 (from timeline-boundary clamping) is treated as 02:00 and
  // does not cause a session starting at exactly 02:00 to join the cluster.
  const clusters: PlannedSession[][] = [];
  for (const s of sorted) {
    const sStartSnap = floorSnap(new Date(s.startTime));
    const cluster = clusters[clusters.length - 1];
    if (cluster) {
      const clusterMaxEnd = Math.max(...cluster.map(c => floorSnap(new Date(c.endTime))));
      if (sStartSnap < clusterMaxEnd) {
        cluster.push(s);
        continue;
      }
    }
    clusters.push([s]);
  }
  const laneCount = new Map<number, number>();
  for (const cluster of clusters) {
    const laneEnds: number[] = []; // snap-floored end-time of last session in each lane
    for (const s of cluster) {
      const sStartSnap = floorSnap(new Date(s.startTime));
      const sEndSnap = floorSnap(new Date(s.endTime));
      let placed = false;
      for (let i = 0; i < laneEnds.length; i++) {
        if (laneEnds[i] <= sStartSnap) {
          laneIndex.set(s.id, i);
          laneEnds[i] = sEndSnap;
          placed = true;
          break;
        }
      }
      if (!placed) {
        laneIndex.set(s.id, laneEnds.length);
        laneEnds.push(sEndSnap);
      }
    }
    for (const s of cluster) laneCount.set(s.id, laneEnds.length);
  }
  return { laneIndex, laneCount };
}

export const ScheduleTimeline = forwardRef<HTMLDivElement, ScheduleTimelineProps>(function ScheduleTimeline(
  {
    nightStart,
    nightEnd,
    darkStart,
    darkEnd,
    twilight,
    sessions,
    visibilityById,
    moonById,
    thumbnailById,
    dragDeltaById,
    resizeDeltaById,
    forecastHours = [],
    moonIllumination = 0,
    onSelectWeatherHour,
    moonIntervals = [],
    gaps = [],
    onFillGap,
    plannedMinutes = 0,
    targetCount = 0,
    bestWindow,
    onDelete,
    onResize,
    onShowDetails,
    onShowFraming,
    headerActions,
    emptyState,
    onScaleChange,
    observerTimezone,
  },
  ref,
) {
  const { t } = useTranslation('planner');
  const { isNight } = useTheme();
  const fmtHm = (d: Date) => formatHm(d, observerTimezone);
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: 'schedule' });

  const totalMinutes = Math.max(60, minutesBetween(nightStart, nightEnd));

  // Scale the night to fill the scrollable viewport. We measure the scroll
  // container (not the inner content, whose height we're deriving) so there's
  // no feedback loop: a vertical scrollbar changes width, not height.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewportHeight, setViewportHeight] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const h = entries[0]?.contentRect.height ?? 0;
      setViewportHeight(h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pxPerMinute = computePxPerMinute(viewportHeight, totalMinutes);
  const totalHeight = totalMinutes * pxPerMinute;
  const startMs = nightStart.getTime();
  const totalMs = nightEnd.getTime() - startMs;
  const yFor = (ms: number) => ((ms - startMs) / 60_000) * pxPerMinute;

  // Live "now" marker. Only meaningful when the clock actually falls inside
  // this night, so past and future nights render without it. Ticks each
  // minute, which is as precise as a 10-minute snap grid warrants.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const nowInWindow = nowMs > startMs && nowMs < nightEnd.getTime();

  // Keep the page's pointer-to-time math in sync with the rendered scale.
  useEffect(() => {
    onScaleChange?.(pxPerMinute);
  }, [pxPerMinute, onScaleChange]);

  const ticks = useMemo(() => hourTicks(nightStart, nightEnd, observerTimezone), [nightStart, nightEnd, observerTimezone]);
  const { laneIndex, laneCount } = useMemo(() => assignLanes(sessions), [sessions]);

  // Hourly weather down the gutter, scored with the same engine the Sky
  // Forecast uses so an hour can never read "good" on one page and "poor" on
  // the other. Each band spans its own hour, clipped to the timeline.
  const weatherBands = useMemo(() => {
    if (forecastHours.length === 0 || totalMs <= 0) return [];
    const darkWindow = darkStart && darkEnd ? { start: darkStart.getTime(), end: darkEnd.getTime() } : null;
    return forecastHours
      .map(h => {
        const from = new Date(h.time).getTime();
        const to = from + 3_600_000;
        const vis = calculateVisibilityScore(h, moonIllumination, observerTimezone, darkWindow, t, isNight);
        return { from, to, hour: h, vis };
      })
      .filter(b => b.to > startMs && b.from < nightEnd.getTime());
  }, [forecastHours, moonIllumination, observerTimezone, darkStart, darkEnd, startMs, nightEnd, totalMs, t, isNight]);

  // Detect overlap per session for the warning badge. Uses direct pairwise
  // rangesOverlap (strict <) so sessions sharing an exact endpoint are never
  // flagged: they display the same HH:MM and should butt up against each other.
  const overlapById = useMemo(() => {
    const map = new Map<number, boolean>();
    for (let i = 0; i < sessions.length; i++) {
      const a = sessions[i];
      const aStart = new Date(floorSnap(new Date(a.startTime)));
      const aEnd = new Date(floorSnap(new Date(a.endTime)));
      let hasOverlap = false;
      for (let j = 0; j < sessions.length; j++) {
        if (i === j) continue;
        const b = sessions[j];
        if (rangesOverlap(aStart, aEnd, new Date(floorSnap(new Date(b.startTime))), new Date(floorSnap(new Date(b.endTime))))) {
          hasOverlap = true;
          break;
        }
      }
      map.set(a.id, hasOverlap);
    }
    return map;
  }, [sessions]);

  // Combine the dnd-kit drop ref with the parent's measure-rect ref.
  const combineRefs = (el: HTMLDivElement | null) => {
    setDropRef(el);
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };

  const background = twilightGradientCss(twilight, startMs, totalMs, 'to bottom', isNight);
  const darkMinutes = darkStart && darkEnd ? Math.max(0, Math.round(minutesBetween(darkStart, darkEnd))) : 0;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* The header carries what is true of the schedule as a whole: how much
          of the dark you have booked, and the two windows the canvas below
          draws. These used to sit in a panel above the page, away from the
          thing they describe. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-white/10 bg-slate-950/80 px-4 py-2.5 backdrop-blur">
        <div className="flex items-baseline gap-2.5">
          <span className="text-sm font-medium text-white">{t('scheduleTimeline.nightSchedule')}</span>
          {darkMinutes > 0 && (
            <span className="text-[0.6875rem] text-white/45 tabular-nums">
              <Trans
                i18nKey="scheduleTimeline.plannedOfDark"
                ns="planner"
                values={{ planned: formatDuration(plannedMinutes), dark: formatDuration(darkMinutes) }}
                components={{ 1: <span className="font-medium text-white/75" /> }}
              />
              {targetCount > 0 && ` · ${t('scheduleTimeline.targetCount', { count: targetCount })}`}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[0.6875rem] text-white/45 tabular-nums">
          {bestWindow && (
            <span className="hidden md:inline">
              {t('scheduleTimeline.clearest', { start: fmtHm(bestWindow.start), end: fmtHm(bestWindow.end) })}
            </span>
          )}
          {darkStart && darkEnd && (
            <span>
              {t('scheduleTimeline.dark', { start: fmtHm(darkStart), end: fmtHm(darkEnd), duration: formatDuration(darkMinutes) })}
            </span>
          )}
          {headerActions}
        </div>
      </div>
      {emptyState}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" style={{ background }}>
        <div
          ref={combineRefs}
          className={`relative ${isOver ? 'bg-accent-500/[0.07]' : ''}`}
          style={{ height: `${totalHeight}px` }}
          data-testid="schedule-drop-zone"
        >
          {/* Weather gutter: one band per forecast hour, in its rating colour. */}
          {weatherBands.map(b => {
            const top = Math.max(0, yFor(b.from));
            const bottom = Math.min(totalHeight, yFor(b.to));
            if (bottom <= top) return null;
            return (
              <button
                key={b.from}
                type="button"
                onClick={onSelectWeatherHour ? () => onSelectWeatherHour(b.hour) : undefined}
                disabled={!onSelectWeatherHour}
                aria-label={t('scheduleTimeline.forecastFor', { time: fmtHm(new Date(b.from)) })}
                className="absolute rounded-full transition hover:scale-x-[2.2] disabled:pointer-events-none"
                style={{
                  top: `${top + 1}px`,
                  height: `${Math.max(2, bottom - top - 2)}px`,
                  left: `${TIMELINE_GUTTER_PX - 14}px`,
                  width: '5px',
                  background: scoreHex(b.vis.score, isNight),
                  opacity: 0.85,
                }}
                title={t('scheduleTimeline.weatherTitle', {
                  time: fmtHm(new Date(b.from)),
                  label: b.vis.label,
                  score: b.vis.score,
                  cloud: b.hour.cloudCover,
                  tail: onSelectWeatherHour ? t('scheduleTimeline.clickForForecast') : '',
                })}
              />
            );
          })}

          {/* Moon-up strip down the right edge, with its rise and set marked. */}
          {moonIntervals.map(m => {
            const top = Math.max(0, yFor(m.start));
            const bottom = Math.min(totalHeight, yFor(m.end));
            if (bottom <= top) return null;
            return (
              <div
                key={`moon-${m.start}`}
                className="pointer-events-none absolute right-1 rounded-full bg-amber-200/25"
                style={{ top: `${top}px`, height: `${bottom - top}px`, width: '4px' }}
              />
            );
          })}
          {moonIntervals.flatMap(m => {
            const events: { at: number; label: string }[] = [];
            if (m.start > startMs + 60_000) events.push({ at: m.start, label: t('scheduleTimeline.moonrise') });
            if (m.end < nightEnd.getTime() - 60_000) events.push({ at: m.end, label: t('scheduleTimeline.moonset') });
            return events.map(e => (
              <div
                key={`${e.label}-${e.at}`}
                className="pointer-events-none absolute right-0 flex items-center gap-1 pr-3"
                style={{ top: `${yFor(e.at)}px`, transform: 'translateY(-50%)' }}
              >
                <span className="rounded-full bg-slate-950/70 px-2 py-0.5 text-[0.625rem] text-amber-200/80 tabular-nums ring-1 ring-inset ring-amber-200/20">
                  <Moon className="mr-1 inline h-2.5 w-2.5" />
                  {e.label} {fmtHm(new Date(e.at))}
                </span>
              </div>
            ));
          })}

          {/* Hour ticks. */}
          {ticks.map((t, i) => {
            const top = minutesBetween(nightStart, t) * pxPerMinute;
            return (
              <div
                key={i}
                className="absolute left-0 right-0 border-t border-white/[0.07]"
                style={{ top: `${top}px` }}
              >
                <span className="absolute -top-2 left-2 px-1 text-[0.625rem] text-white/40 tabular-nums">
                  {fmtHm(t)}
                </span>
              </div>
            );
          })}

          {/* Empty stretches of the dark window, offered rather than left blank. */}
          {gaps.map(gap => {
            const top = yFor(gap.start);
            const height = yFor(gap.end) - top;
            if (height < 26) return null;
            return (
              <button
                key={`gap-${gap.start}`}
                onClick={() => onFillGap?.(gap)}
                disabled={!onFillGap}
                className="group absolute flex items-center justify-center rounded-xl border border-dashed border-white/15 text-white/40 transition hover:border-accent-400/60 hover:bg-accent-400/[0.07] hover:text-accent-300 disabled:pointer-events-none"
                style={{
                  top: `${top + 8}px`,
                  height: `${height - 16}px`,
                  left: `${TIMELINE_GUTTER_PX + 4}px`,
                  right: '12px',
                }}
                title={t('scheduleTimeline.fillGapTitle', { duration: formatDuration(gap.minutes), time: fmtHm(new Date(gap.start)) })}
              >
                <span className="inline-flex items-center gap-1.5 text-[0.6875rem] font-medium">
                  <Plus className="h-3.5 w-3.5" />
                  {t('scheduleTimeline.freeDuration', { duration: formatDuration(gap.minutes) })}
                  <span className="hidden opacity-0 transition group-hover:opacity-100 sm:inline">{t('scheduleTimeline.fillIt')}</span>
                </span>
              </button>
            );
          })}

          {sessions.map(s => {
            const start = new Date(s.startTime);
            const end = new Date(s.endTime);
            const resize = resizeDeltaById.get(s.id);
            // Apply provisional resize for live feedback while the user drags an edge.
            const minutesFromStart = minutesBetween(nightStart, start) + (resize?.edge === 'top' ? resize.deltaMinutes : 0);
            const minutesEnd = minutesBetween(nightStart, end) + (resize?.edge === 'bottom' ? resize.deltaMinutes : 0);
            const top = Math.max(0, minutesFromStart * pxPerMinute);
            const height = Math.max(pxPerMinute * 15, (minutesEnd - minutesFromStart) * pxPerMinute);
            const verdict = visibilityById.get(s.id);
            return (
              <ScheduledImagingBlock
                key={s.id}
                session={s}
                displayName={formatObjectName(s.objectId, s.objectName)}
                thumbnailUrl={thumbnailById?.get(s.id)}
                pxPerMinute={pxPerMinute}
                top={top}
                height={height}
                verdict={verdict?.verdict ?? 'all'}
                verdictReason={verdict?.reason ?? ''}
                minAlt={verdict?.minAlt ?? null}
                maxAlt={verdict?.maxAlt ?? null}
                moonVerdict={moonById.get(s.id)?.verdict ?? 'ok'}
                moonReason={moonById.get(s.id)?.reason ?? ''}
                narrowbandVerdict={moonById.get(s.id)?.narrowbandVerdict}
                hasOverlap={overlapById.get(s.id) ?? false}
                laneIndex={laneIndex.get(s.id) ?? 0}
                laneCount={laneCount.get(s.id) ?? 1}
                onDelete={onDelete}
                onResize={onResize}
                onShowDetails={onShowDetails}
                onShowFraming={onShowFraming}
                dragDeltaY={dragDeltaById.get(s.id)}
                isSaving={s.id < 0}
                observerTimezone={observerTimezone}
              />
            );
          })}

          {/* Now. Drawn last so it sits over the blocks it passes through. */}
          {nowInWindow && (
            <div
              className="pointer-events-none absolute left-0 right-0 z-30 flex items-center"
              style={{ top: `${yFor(nowMs)}px`, transform: 'translateY(-50%)' }}
            >
              {/* Brightest step of the red ladder rather than the .night-mapped
                  rose-400 (which lands mid-ladder, too dim for a "find me
                  instantly" marker): this is the one indicator that has to
                  outshine the rest of the red-mapped UI, not blend into it. */}
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={isNight
                  ? { backgroundColor: '#dd3333', boxShadow: '0 0 10px 2px rgba(221,51,51,0.6)' }
                  : { backgroundColor: '#fb7185', boxShadow: '0 0 10px 2px rgba(251,113,133,0.6)' }}
              />
              <span className="h-px flex-1" style={{ backgroundColor: isNight ? 'rgba(221,51,51,0.7)' : 'rgba(251,113,133,0.7)' }} />
              {/* Dark label rather than text-white: the night theme remaps
                  text-white to red, which would vanish against the pill. */}
              <span
                className="mr-2 rounded-full px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-slate-950"
                style={{ backgroundColor: isNight ? '#dd3333' : '#fb7185' }}
              >
                {t('scheduleTimeline.now')}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
