/**
 * One scheduled imaging block on the planner timeline.
 *
 * Body: @dnd-kit draggable for repositioning.
 * Top / bottom edges: native pointer-based resize handles (axis-locked Y).
 *
 * The parent owns time math — this component reports edits via onResize / onMove
 * (called with provisional minute offsets) and onCommit when the user releases.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { GripVertical, Info, Moon, X } from 'lucide-react';
import { formatHm, SNAP_MINUTES } from './scheduleGeometry';
import type { PlannedSession } from '../../lib/api/plannedSessions';
import type { VisibilityVerdict } from '../../lib/visibilityCheck';
import type { MoonVerdict } from '../../lib/moonProximity';

interface ScheduledImagingBlockProps {
  session: PlannedSession;
  /** Runtime timeline scale; resize handles convert drag pixels to minutes with it. */
  pxPerMinute: number;
  top: number;
  height: number;
  verdict: VisibilityVerdict;
  verdictReason: string;
  /** Lowest altitude (degrees) the object reaches during this block. */
  minAlt: number | null;
  /** Highest altitude (degrees) the object reaches during this block. */
  maxAlt: number | null;
  /** Phase-aware moon proximity verdict for this block. */
  moonVerdict: MoonVerdict;
  /** Plain-English moon reason, empty when no concern. */
  moonReason: string;
  hasOverlap: boolean;
  laneIndex: number;
  laneCount: number;
  onDelete: (id: number) => void;
  onResize: (id: number, edge: 'top' | 'bottom', deltaMinutes: number, commit: boolean) => void;
  onShowDetails: () => void;
  /** Provisional Y delta during a drag (px). Parent uses this to render motion. */
  dragDeltaY?: number;
}

export function ScheduledImagingBlock({
  session,
  pxPerMinute,
  top,
  height,
  verdict,
  verdictReason,
  minAlt,
  maxAlt,
  moonVerdict,
  moonReason,
  hasOverlap,
  laneIndex,
  laneCount,
  onDelete,
  onResize,
  onShowDetails,
  dragDeltaY = 0,
}: ScheduledImagingBlockProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `block:${session.id}`,
    data: { kind: 'block', sessionId: session.id },
  });

  // Reserve a left gutter for the hour-tick labels so blocks never cover the
  // time axis. Lanes are packed into the area to the right of the gutter.
  const GUTTER_PX = 48;
  const widthPct = 100 / laneCount;
  const leftPct = laneIndex * widthPct;
  const leftFrac = leftPct / 100;   // column's start as a fraction of full width
  const laneFrac = 1 / laneCount;

  const stripeColor =
    verdict === 'all' ? 'bg-emerald-500'
    : verdict === 'partial' ? 'bg-amber-500'
    : 'bg-red-500';

  const start = new Date(session.startTime);
  const end = new Date(session.endTime);

  return (
    <div
      ref={setNodeRef}
      style={{
        top: `${top + dragDeltaY}px`,
        height: `${height}px`,
        left: `calc(${leftPct}% + ${GUTTER_PX * (1 - leftFrac) + 4}px)`,
        width: `calc(${widthPct}% - ${GUTTER_PX * laneFrac + 8}px)`,
      }}
      className={`absolute rounded-lg border shadow-sm overflow-hidden select-none transition-shadow ${
        isDragging ? 'opacity-70 shadow-xl ring-2 ring-emerald-400' : ''
      } bg-slate-800/95 border-slate-600 text-slate-100`}
    >
      <div className={`absolute left-0 top-0 bottom-0 w-1.5 ${stripeColor}`} />

      <ResizeHandle edge="top" pxPerMinute={pxPerMinute} onResize={(d, commit) => onResize(session.id, 'top', d, commit)} />

      <div
        {...listeners}
        {...attributes}
        className="absolute inset-0 pl-3 pr-7 py-1.5 cursor-grab active:cursor-grabbing flex flex-col justify-start gap-0.5"
        title={[verdictReason, moonReason].filter(Boolean).join(' · ') || undefined}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <GripVertical className="w-3 h-3 opacity-50 shrink-0" />
          <span className="font-medium text-sm truncate">{session.objectName}</span>
          {moonVerdict !== 'ok' && (
            <Moon
              className={`w-3 h-3 shrink-0 ${moonVerdict === 'warning' ? 'text-red-400' : 'text-amber-400'}`}
              aria-label="Moon interference warning"
            />
          )}
        </div>
        <div className="text-[11px] opacity-80">
          {formatHm(start)} - {formatHm(end)}
          {hasOverlap && <span className="ml-2 text-amber-400">overlap</span>}
        </div>
        {minAlt != null && maxAlt != null && (
          <div className="text-[10px] opacity-75">
            alt {Math.round(minAlt)}° – {Math.round(maxAlt)}°
          </div>
        )}
        {verdict !== 'all' && verdictReason && (
          <div className={`text-[10px] truncate ${verdict === 'none' ? 'text-red-300' : 'text-amber-300'}`}>
            {verdictReason}
          </div>
        )}
        {moonVerdict !== 'ok' && moonReason && (
          <div className={`text-[10px] truncate ${moonVerdict === 'warning' ? 'text-red-300' : 'text-amber-300'}`}>
            {moonReason}
          </div>
        )}
      </div>

      <div className="absolute right-1 top-1 flex items-center gap-0.5 z-10">
        <button
          onClick={(e) => { e.stopPropagation(); onShowDetails(); }}
          onPointerDown={(e) => e.stopPropagation()}
          className="w-5 h-5 rounded-full flex items-center justify-center bg-white/10 hover:bg-white/20 transition"
          aria-label="Show object details"
          title="Show details"
        >
          <Info className="w-3 h-3" />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(session.id); }}
          onPointerDown={(e) => e.stopPropagation()}
          className="w-5 h-5 rounded hover:bg-white/10 flex items-center justify-center"
          aria-label="Remove scheduled block"
          title="Remove"
        >
          <X className="w-3 h-3" />
        </button>
      </div>

      <ResizeHandle edge="bottom" pxPerMinute={pxPerMinute} onResize={(d, commit) => onResize(session.id, 'bottom', d, commit)} />
    </div>
  );
}

interface ResizeHandleProps {
  edge: 'top' | 'bottom';
  pxPerMinute: number;
  onResize: (deltaMinutes: number, commit: boolean) => void;
}

function ResizeHandle({ edge, pxPerMinute, onResize }: ResizeHandleProps) {
  const [active, setActive] = useState(false);
  const startYRef = useRef<number | null>(null);
  const lastSnappedRef = useRef(0);
  // Read the scale through a ref so the pointer-move listener never needs to
  // re-subscribe mid-drag (the scale only changes on a viewport resize anyway).
  const pxPerMinuteRef = useRef(pxPerMinute);
  pxPerMinuteRef.current = pxPerMinute;

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    startYRef.current = e.clientY;
    lastSnappedRef.current = 0;
    setActive(true);
  }, []);

  useEffect(() => {
    if (!active) return;

    function move(e: PointerEvent) {
      if (startYRef.current === null) return;
      const rawDeltaPx = e.clientY - startYRef.current;
      const rawDeltaMin = rawDeltaPx / pxPerMinuteRef.current;
      const snapped = Math.round(rawDeltaMin / SNAP_MINUTES) * SNAP_MINUTES;
      if (snapped !== lastSnappedRef.current) {
        lastSnappedRef.current = snapped;
        onResize(snapped, false);
      }
    }
    function up() {
      onResize(lastSnappedRef.current, true);
      startYRef.current = null;
      lastSnappedRef.current = 0;
      setActive(false);
    }

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [active, onResize]);

  return (
    <div
      className={`absolute left-0 right-0 cursor-ns-resize z-20 ${edge === 'top' ? 'top-0' : 'bottom-0'} h-1.5 ${active ? 'bg-emerald-500/40' : 'hover:bg-emerald-500/30'}`}
      onPointerDown={handlePointerDown}
      aria-label={`Resize ${edge}`}
    />
  );
}
