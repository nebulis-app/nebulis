/**
 * Right pane of the planner: vertical night timeline.
 *
 * Renders hour ticks across the dark window and lays out scheduled blocks
 * in parallel "lanes" when they overlap. Acts as a single dnd-kit drop target;
 * the page maps the drop's pointer Y to a snapped start time using
 * scheduleGeometry.yToTime.
 */
import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { useTheme } from '../../hooks/useTheme';
import { ScheduledImagingBlock } from './ScheduledImagingBlock';
import {
  computePxPerMinute,
  formatHm,
  hourTicks,
  minutesBetween,
} from './scheduleGeometry';
import type { PlannedSession } from '../../lib/api/plannedSessions';
import type { BlockVisibilityResult } from '../../lib/visibilityCheck';
import type { MoonProximityResult } from '../../lib/moonProximity';

interface ScheduleTimelineProps {
  nightStart: Date;
  nightEnd: Date;
  /** Actual dark window boundaries — rendered as dashed markers inside the extended timeline. */
  darkStart?: Date;
  darkEnd?: Date;
  sessions: PlannedSession[];
  visibilityById: Map<number, BlockVisibilityResult>;
  moonById: Map<number, MoonProximityResult>;
  /** Provisional Y delta during a body-drag (px), keyed by session id. */
  dragDeltaById: Map<number, number>;
  /** Provisional resize, keyed by session id; positive = bottom edge moved down. */
  resizeDeltaById: Map<number, { edge: 'top' | 'bottom'; deltaMinutes: number }>;
  onDelete: (id: number) => void;
  onResize: (id: number, edge: 'top' | 'bottom', deltaMinutes: number, commit: boolean) => void;
  /** Open the details popup (altitude curve, sky-survey image, blurb) for a block. */
  onShowDetails: (session: PlannedSession) => void;
  /** Reports the runtime pixels-per-minute scale so the page's drag/drop math
   *  (which converts pointer pixels to times) matches what's rendered here. */
  onScaleChange?: (pxPerMinute: number) => void;
  /** IANA timezone for displaying tick labels (e.g. "Europe/London"). Defaults to machine-local. */
  observerTimezone?: string;
}

/**
 * Lane assignment: pack overlapping sessions into the fewest parallel
 * columns. Greedy first-fit by start time.
 */
function assignLanes(sessions: PlannedSession[]): { laneIndex: Map<number, number>; laneCount: Map<number, number> } {
  const sorted = sessions.slice().sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  const laneIndex = new Map<number, number>();
  // Cluster sessions that transitively overlap, then assign lanes within the cluster.
  const clusters: PlannedSession[][] = [];
  for (const s of sorted) {
    const sStart = new Date(s.startTime);
    const cluster = clusters[clusters.length - 1];
    if (cluster) {
      const clusterMaxEnd = Math.max(...cluster.map(c => new Date(c.endTime).getTime()));
      const overlaps = sStart.getTime() < clusterMaxEnd;
      if (overlaps) {
        cluster.push(s);
        continue;
      }
    }
    clusters.push([s]);
  }
  const laneCount = new Map<number, number>();
  for (const cluster of clusters) {
    const lanes: Date[] = []; // end-time of last session in each lane
    for (const s of cluster) {
      const sStart = new Date(s.startTime);
      const sEnd = new Date(s.endTime);
      let placed = false;
      for (let i = 0; i < lanes.length; i++) {
        if (lanes[i].getTime() <= sStart.getTime()) {
          laneIndex.set(s.id, i);
          lanes[i] = sEnd;
          placed = true;
          break;
        }
      }
      if (!placed) {
        laneIndex.set(s.id, lanes.length);
        lanes.push(sEnd);
      }
    }
    for (const s of cluster) laneCount.set(s.id, lanes.length);
  }
  return { laneIndex, laneCount };
}

export const ScheduleTimeline = forwardRef<HTMLDivElement, ScheduleTimelineProps>(function ScheduleTimeline(
  { nightStart, nightEnd, darkStart, darkEnd, sessions, visibilityById, moonById, dragDeltaById, resizeDeltaById, onDelete, onResize, onShowDetails, onScaleChange, observerTimezone },
  ref,
) {
  const fmtHm = (d: Date) => formatHm(d, observerTimezone);
  const { isDark } = useTheme();
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

  // Pixel offsets for the dark window boundaries within the extended timeline.
  const darkStartPx = darkStart ? minutesBetween(nightStart, darkStart) * pxPerMinute : null;
  const darkEndPx = darkEnd ? minutesBetween(nightStart, darkEnd) * pxPerMinute : null;

  // Keep the page's pointer-to-time math in sync with the rendered scale.
  useEffect(() => {
    onScaleChange?.(pxPerMinute);
  }, [pxPerMinute, onScaleChange]);

  const ticks = useMemo(() => hourTicks(nightStart, nightEnd, observerTimezone), [nightStart, nightEnd, observerTimezone]);
  const { laneIndex, laneCount } = useMemo(() => assignLanes(sessions), [sessions]);

  // Detect overlap per session for the warning badge (only flagged when
  // sharing a cluster of 2+).
  const overlapById = useMemo(() => {
    const map = new Map<number, boolean>();
    for (const s of sessions) {
      map.set(s.id, (laneCount.get(s.id) ?? 1) > 1);
    }
    return map;
  }, [sessions, laneCount]);

  // Combine the dnd-kit drop ref with the parent's measure-rect ref.
  const combineRefs = (el: HTMLDivElement | null) => {
    setDropRef(el);
    if (typeof ref === 'function') ref(el);
    else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
  };

  return (
    <div className={`flex flex-col h-full min-h-0 ${isDark ? 'bg-slate-950/40' : 'bg-slate-50'}`}>
      <div className={`flex items-center justify-between p-3 border-b ${isDark ? 'border-slate-800 text-slate-200' : 'border-slate-200 text-slate-700'}`}>
        <div className="text-sm font-medium">Night schedule</div>
        {darkStart && darkEnd && (
          <div className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
            <span className="font-medium">Dark window:</span>{' '}
            {fmtHm(darkStart)} – {fmtHm(darkEnd)}{' '}
            ({Math.round((minutesBetween(darkStart, darkEnd) / 60) * 10) / 10}h)
          </div>
        )}
      </div>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        <div
          ref={combineRefs}
          className={`relative ${isOver ? 'bg-emerald-500/5' : ''}`}
          style={{ height: `${totalHeight}px` }}
          data-testid="schedule-drop-zone"
        >
          {/* Pre-dark buffer zone */}
          {darkStartPx != null && darkStartPx > 0 && (
            <div
              className="absolute left-0 right-0 pointer-events-none"
              style={{
                top: 0,
                height: `${darkStartPx}px`,
                background: isDark ? 'rgba(148,163,184,0.05)' : 'rgba(100,116,139,0.07)',
              }}
            >
              <span className={`absolute bottom-1.5 right-2 text-[10px] select-none ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                darkness {darkStart ? fmtHm(darkStart) : ''}
              </span>
            </div>
          )}
          {darkStartPx != null && (
            <div
              className={`absolute left-0 right-0 pointer-events-none border-t border-dashed ${isDark ? 'border-slate-600' : 'border-slate-400'}`}
              style={{ top: `${darkStartPx}px` }}
            />
          )}

          {/* Post-dark buffer zone */}
          {darkEndPx != null && darkEndPx < totalHeight && (
            <div
              className="absolute left-0 right-0 pointer-events-none"
              style={{
                top: `${darkEndPx}px`,
                height: `${totalHeight - darkEndPx}px`,
                background: isDark ? 'rgba(148,163,184,0.05)' : 'rgba(100,116,139,0.07)',
              }}
            >
              <span className={`absolute top-1.5 right-2 text-[10px] select-none ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                dawn {darkEnd ? fmtHm(darkEnd) : ''}
              </span>
            </div>
          )}
          {darkEndPx != null && (
            <div
              className={`absolute left-0 right-0 pointer-events-none border-t border-dashed ${isDark ? 'border-slate-600' : 'border-slate-400'}`}
              style={{ top: `${darkEndPx}px` }}
            />
          )}

          {ticks.map((t, i) => {
            const top = minutesBetween(nightStart, t) * pxPerMinute;
            return (
              <div
                key={i}
                className={`absolute left-0 right-0 border-t ${isDark ? 'border-slate-800' : 'border-slate-200'}`}
                style={{ top: `${top}px` }}
              >
                <span className={`absolute -top-2 left-2 text-[10px] px-1 ${isDark ? 'bg-slate-950/40 text-slate-400' : 'bg-slate-50 text-slate-500'}`}>
                  {fmtHm(t)}
                </span>
              </div>
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
                pxPerMinute={pxPerMinute}
                top={top}
                height={height}
                verdict={verdict?.verdict ?? 'all'}
                verdictReason={verdict?.reason ?? ''}
                minAlt={verdict?.minAlt ?? null}
                maxAlt={verdict?.maxAlt ?? null}
                moonVerdict={moonById.get(s.id)?.verdict ?? 'ok'}
                moonReason={moonById.get(s.id)?.reason ?? ''}
                hasOverlap={overlapById.get(s.id) ?? false}
                laneIndex={laneIndex.get(s.id) ?? 0}
                laneCount={laneCount.get(s.id) ?? 1}
                onDelete={onDelete}
                onResize={onResize}
                onShowDetails={() => onShowDetails(s)}
                dragDeltaY={dragDeltaById.get(s.id)}
                isSaving={s.id < 0}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
});
