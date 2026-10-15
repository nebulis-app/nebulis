/**
 * One scheduled imaging block on the planner timeline.
 *
 * Body: @dnd-kit draggable for repositioning.
 * Top / bottom edges: native pointer-based resize handles (axis-locked Y).
 *
 * The parent owns time math. This component reports edits via onResize (called
 * with provisional minute offsets, then again on release to commit).
 *
 * Blocks sit on the dark night canvas in every theme, so their styling is
 * night-side and does not branch on the app theme. The left stripe stays the
 * traffic-light system: green fully visible, amber partial or low, red blocked
 * or below the horizon.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { AlertTriangle, ArrowUp, Frame, GripVertical, Info, Moon, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { IntegrationRemainingChips } from './IntegrationRemainingChips';
import { formatHm, SNAP_MINUTES, TIMELINE_GUTTER_PX } from './scheduleGeometry';
import { useTheme } from '../../hooks/useTheme';
import type { PlannedSession } from '../../lib/api/plannedSessions';
import type { VisibilityVerdict } from '../../lib/visibilityCheck';
import type { MoonVerdict } from '../../lib/moonProximity';
import type { BlockDragData } from './dragData';

const MIN_IMAGING_ALT = 20;

/** Below this the block only has room for its name and times. */
const COMPACT_HEIGHT = 74;
/** Below this even the thumbnail is dropped. */
const TINY_HEIGHT = 44;
/** Above this the top-anchored content leaves enough empty space below it
 *  that a single-object block (e.g. one target imaged for hours because
 *  nothing else was scheduled after it) reads as broken rather than long.
 *  A bottom-anchored end-time echo fills that space and orients the user
 *  without needing to scroll to the block's lower edge. */
const LONG_BLOCK_HEIGHT = COMPACT_HEIGHT * 3;

interface ScheduledImagingBlockProps {
  session: PlannedSession;
  /** Formatted display name, e.g. "M81 - Bode's Galaxy". Falls back to session.objectName. */
  displayName?: string;
  /** Catalog thumbnail for the object, when one is known. */
  thumbnailUrl?: string;
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
  /** The same closest approach judged for narrowband, when the block is not
   *  narrowband already: lets it say a narrowband filter would be fine. */
  narrowbandVerdict?: MoonVerdict;
  hasOverlap: boolean;
  laneIndex: number;
  laneCount: number;
  onDelete: (id: number) => void;
  onResize: (id: number, edge: 'top' | 'bottom', deltaMinutes: number, commit: boolean) => void;
  onShowDetails: (session: PlannedSession) => void;
  /** Jumps straight to the Framing & Mosaic modal for this block, preloaded
   *  with its saved mosaic. Only rendered when the block actually has one
   *  (`session.framingSetup`) — see FramingModal.tsx. */
  onShowFraming?: (session: PlannedSession) => void;
  /** Provisional Y delta during a drag (px). Parent uses this to render motion. */
  dragDeltaY?: number;
  /** True while the block's create POST is still in-flight (optimistic temp id). */
  isSaving?: boolean;
  observerTimezone?: string;
}

export const ScheduledImagingBlock = memo(function ScheduledImagingBlock({
  session,
  displayName,
  thumbnailUrl,
  pxPerMinute,
  top,
  height,
  verdict,
  verdictReason,
  minAlt,
  maxAlt,
  moonVerdict,
  moonReason,
  narrowbandVerdict,
  hasOverlap,
  laneIndex,
  laneCount,
  onDelete,
  onResize,
  onShowDetails,
  onShowFraming,
  dragDeltaY = 0,
  isSaving = false,
  observerTimezone,
}: ScheduledImagingBlockProps) {
  const { t } = useTranslation('planner');
  const { isNight } = useTheme();
  // Which edge handle (if any) is hovered or mid-drag, so the block that owns it
  // can light up when two blocks share a seam.
  const [engaged, setEngaged] = useState<{ top: boolean; bottom: boolean }>({ top: false, bottom: false });
  const resizing = engaged.top || engaged.bottom;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `block:${session.id}`,
    data: { kind: 'block', sessionId: session.id } satisfies BlockDragData,
    disabled: isSaving,
  });

  // Lanes are packed into the area to the right of the timeline gutter.
  const widthPct = 100 / laneCount;
  const leftPct = laneIndex * widthPct;
  const leftFrac = leftPct / 100;   // column's start as a fraction of full width
  const laneFrac = 1 / laneCount;

  // Minimum altitude considered usable for imaging (matches iOS/Android ScheduledBlockView).
  const belowHorizon = verdict === 'all' && minAlt != null && minAlt < 0;
  const lowInSky = verdict === 'all' && minAlt != null && minAlt >= 0 && minAlt < MIN_IMAGING_ALT;

  const bad = verdict === 'none' || belowHorizon || moonVerdict === 'warning';
  const warn = !bad && (verdict === 'partial' || lowInSky || moonVerdict === 'caution' || hasOverlap);

  const stripeColor = bad ? 'bg-red-500' : warn ? 'bg-amber-500' : 'bg-emerald-500';
  // Raw rgba, not a Tailwind class, so .night's CSS variable overrides can't
  // reach it — it needs its own red-ladder branch like the traffic-light
  // stripe above gets for free from those overrides.
  const edgeGlow = isNight
    ? (bad ? 'rgba(204,51,51,0.35)' : warn ? 'rgba(136,34,34,0.32)' : 'rgba(102,26,26,0.28)')
    : bad
      ? 'rgba(239,68,68,0.35)'
      : warn
        ? 'rgba(245,158,11,0.32)'
        : 'rgba(16,185,129,0.28)';

  const start = new Date(session.startTime);
  const end = new Date(session.endTime);
  const compact = height < COMPACT_HEIGHT;
  const tiny = height < TINY_HEIGHT;

  const band = session.filterBand ?? null;
  // The Moon is too close for broadband, but a narrowband filter would cope.
  const narrowbandWouldDo = moonVerdict !== 'ok' && band !== 'narrowband' && narrowbandVerdict === 'ok';

  // One line of warning text, worst first. Below the compact threshold there is
  // no room for it and the tooltip carries the detail instead.
  const warning = belowHorizon
    ? t('scheduledImagingBlock.setsBelowHorizon')
    : verdict === 'none' || verdict === 'partial'
      ? verdictReason
      : moonVerdict !== 'ok'
        ? narrowbandWouldDo ? `${moonReason} · ${t('scheduledImagingBlock.narrowbandOk')}` : moonReason
        : lowInSky && minAlt != null
          ? t('scheduledImagingBlock.lowInSky', { deg: Math.round(minAlt) })
          : hasOverlap
            ? t('scheduledImagingBlock.overlapsAnother')
            : '';

  return (
    <div
      ref={setNodeRef}
      style={{
        top: `${top + dragDeltaY}px`,
        height: `${height}px`,
        left: `calc(${leftPct}% + ${TIMELINE_GUTTER_PX * (1 - leftFrac) + 4}px)`,
        width: `calc(${widthPct}% - ${TIMELINE_GUTTER_PX * laneFrac + 14}px)`,
        // Inline, not a ring-* class: the ring is also a box-shadow and this
        // style would override it.
        boxShadow: isDragging
          ? `0 18px 40px -18px rgba(0,0,0,0.9), inset 0 0 0 1px ${edgeGlow}`
          : resizing
            ? `0 8px 22px -16px rgba(0,0,0,0.9), 0 0 0 2px ${isNight ? '#dd3333' : '#fbbf24'}, 0 0 14px 1px ${isNight ? 'rgba(221,51,51,0.45)' : 'rgba(251,191,36,0.4)'}`
            : `0 8px 22px -16px rgba(0,0,0,0.9), inset 0 0 0 1px ${edgeGlow}`,
      }}
      className={`group absolute select-none rounded-xl bg-slate-900/85 text-slate-100 backdrop-blur-sm transition-shadow ${
        isDragging ? 'z-20 opacity-80 ring-2 ring-accent-400' : resizing ? 'z-10' : ''
      } ${isSaving ? 'opacity-60' : ''}`}
    >
      {/* Clipping lives on this inner layer so the resize handles below can
          reach past the block's edge and still be grabbed from just outside it. */}
      <div className="absolute inset-0 overflow-hidden rounded-xl">
      <div className={`absolute bottom-0 left-0 top-0 w-1.5 ${stripeColor}`} />

      <div
        {...(isSaving ? {} : listeners)}
        {...(isSaving ? {} : attributes)}
        className={`absolute inset-0 flex gap-2.5 py-1.5 pl-3 pr-7 ${
          isSaving ? 'cursor-default' : 'cursor-grab active:cursor-grabbing'
        }`}
        title={[verdictReason, moonReason].filter(Boolean).join(' · ') || undefined}
      >
        {thumbnailUrl && !tiny && (
          <img
            src={thumbnailUrl}
            alt=""
            loading="lazy"
            draggable={false}
            className="mt-0.5 h-10 w-10 shrink-0 rounded-lg object-cover ring-1 ring-inset ring-white/15"
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col justify-start gap-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <GripVertical className="h-3 w-3 shrink-0 opacity-40" />
            <span className="truncate text-sm font-semibold">{displayName ?? session.objectName}</span>
            {isSaving && <span className="shrink-0 text-[10px] opacity-60">{t('scheduledImagingBlock.saving')}</span>}
          </div>

          <div className="text-[11px] text-white/60 tabular-nums">
            {t('scheduledImagingBlock.timeRange', { start: formatHm(start, observerTimezone), end: formatHm(end, observerTimezone) })}
          </div>

          {!compact && (
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
              {minAlt != null && maxAlt != null && (
                <Chip tone={belowHorizon ? 'bad' : lowInSky ? 'warn' : 'ok'}>
                  <ArrowUp className="h-2.5 w-2.5" />
                  {t('scheduledImagingBlock.altitudeRange', { min: Math.round(minAlt), max: Math.round(maxAlt) })}
                </Chip>
              )}
              {(band || session.filter) && (
                <Chip tone="ok">
                  <span title={band ? t(`scheduledImagingBlock.band.${band}`) : undefined}>
                    {session.filter || t(`scheduledImagingBlock.bandShort.${band!}`)}
                  </span>
                </Chip>
              )}
              {moonVerdict !== 'ok' && (
                <Chip tone={moonVerdict === 'warning' ? 'bad' : 'warn'}>
                  <Moon className="h-2.5 w-2.5" />
                  {narrowbandWouldDo ? t('scheduledImagingBlock.moonNbOk') : t('scheduledImagingBlock.moon')}
                </Chip>
              )}
              {hasOverlap && (
                <Chip tone="warn">
                  <AlertTriangle className="h-2.5 w-2.5" />
                  {t('scheduledImagingBlock.overlap')}
                </Chip>
              )}
              <IntegrationRemainingChips objectId={session.objectId} isDark tone="block" />
            </div>
          )}

          {!compact && !isSaving && warning && (
            <div className={`truncate text-[10.5px] ${bad ? 'text-red-300' : 'text-amber-300'}`}>
              {warning}
            </div>
          )}
        </div>
      </div>

      {!isSaving && (
        <div className="absolute right-1 top-1 z-10 flex items-center gap-0.5 opacity-70 transition group-hover:opacity-100">
          {session.framingSetup && onShowFraming && (
            <button
              onClick={(e) => { e.stopPropagation(); onShowFraming(session); }}
              onPointerDown={(e) => e.stopPropagation()}
              className="flex h-5 w-5 items-center justify-center rounded-full bg-white/10 text-sky-300 transition hover:bg-white/20"
              aria-label={t('scheduledImagingBlock.showFraming')}
              title={t('scheduledImagingBlock.showFraming')}
            >
              <Frame className="h-3 w-3" />
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onShowDetails(session); }}
            onPointerDown={(e) => e.stopPropagation()}
            className="flex h-5 w-5 items-center justify-center rounded-full bg-white/10 transition hover:bg-white/20"
            aria-label={t('scheduledImagingBlock.showObjectDetails')}
            title={t('scheduledImagingBlock.showDetails')}
          >
            <Info className="h-3 w-3" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(session.id); }}
            onPointerDown={(e) => e.stopPropagation()}
            className="flex h-5 w-5 items-center justify-center rounded-full transition hover:bg-white/20"
            aria-label={t('scheduledImagingBlock.removeScheduledBlock')}
            title={t('scheduledImagingBlock.remove')}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {height >= LONG_BLOCK_HEIGHT && (
        <div className="absolute bottom-1.5 left-3.5 text-[10px] text-white/35 tabular-nums">
          {t('scheduledImagingBlock.until', { time: formatHm(end, observerTimezone) })}
        </div>
      )}
      </div>

      <ResizeHandle edge="top" pxPerMinute={pxPerMinute} onResize={(d, commit) => onResize(session.id, 'top', d, commit)} onEngage={(v) => setEngaged(e => (e.top === v ? e : { ...e, top: v }))} disabled={isSaving} />
      <ResizeHandle edge="bottom" pxPerMinute={pxPerMinute} onResize={(d, commit) => onResize(session.id, 'bottom', d, commit)} onEngage={(v) => setEngaged(e => (e.bottom === v ? e : { ...e, bottom: v }))} disabled={isSaving} />
    </div>
  );
});

function Chip({ tone, children }: { tone: 'ok' | 'warn' | 'bad'; children: React.ReactNode }) {
  const cls =
    tone === 'bad'
      ? 'bg-red-500/15 text-red-300 ring-red-400/25'
      : tone === 'warn'
        ? 'bg-amber-500/15 text-amber-300 ring-amber-400/25'
        : 'bg-white/[0.07] text-white/65 ring-white/10';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums ring-1 ring-inset ${cls}`}>
      {children}
    </span>
  );
}

interface ResizeHandleProps {
  edge: 'top' | 'bottom';
  pxPerMinute: number;
  onResize: (deltaMinutes: number, commit: boolean) => void;
  /** True while the pointer is over the handle or dragging it. */
  onEngage?: (engaged: boolean) => void;
  disabled?: boolean;
}

function ResizeHandle({ edge, pxPerMinute, onResize, onEngage, disabled }: ResizeHandleProps) {
  const { t } = useTranslation('planner');
  const [active, setActive] = useState(false);
  const [hovered, setHovered] = useState(false);
  useEffect(() => { onEngage?.(active || hovered); }, [active, hovered, onEngage]);
  const startYRef = useRef<number | null>(null);
  const lastSnappedRef = useRef(0);
  // Read the scale through a ref so the pointer-move listener never needs to
  // re-subscribe mid-drag (the scale only changes on a viewport resize anyway).
  const pxPerMinuteRef = useRef(pxPerMinute);
  pxPerMinuteRef.current = pxPerMinute;

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    // Pointer capture only exists on Elements. In practice the target is
    // always the handle div, but narrow rather than assert so a non-Element
    // target degrades to "drag without capture" instead of throwing.
    if (e.target instanceof Element) e.target.setPointerCapture(e.pointerId);
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

  if (disabled) return null;

  return (
    <div
      className={`group/handle absolute left-0 right-0 z-20 flex cursor-ns-resize justify-center ${edge === 'top' ? '-top-1 items-end' : '-bottom-1 items-start'} h-4`}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onPointerDown={handlePointerDown}
      aria-label={edge === 'top' ? t('scheduledImagingBlock.resizeTop') : t('scheduledImagingBlock.resizeBottom')}
    >
      {/* The hit area stays generous; only this slim pill is drawn. */}
      <span
        className={`mx-auto my-0.5 h-1 w-10 rounded-full transition ${
          active ? 'bg-accent-400' : 'bg-accent-400/0 group-hover/handle:bg-accent-400/70'
        }`}
      />
    </div>
  );
}
