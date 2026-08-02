import { useEffect, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, X, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { useSwipeDownToClose } from '../../hooks/useSwipeDownToClose';
import { LightboxThumbStrip, type ThumbEntry } from './LightboxThumbStrip';
import type { ZoomControls } from './zoomControls';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  isDark: boolean;
  /** Accessible dialog name. */
  dialogTitle: string;

  titleIcon?: ReactNode;
  title: string;
  subtitle?: ReactNode;

  index: number;
  count: number;
  onPrev: () => void;
  onNext: () => void;
  onSelectIndex: (i: number) => void;

  zoom?: ZoomControls;
  /** Controls specific to the content type, e.g. the FITS stretch slider. */
  extraControls?: ReactNode;
  /** Share / download / edit / delete buttons. */
  actions?: ReactNode;

  thumbs?: ThumbEntry[];
  /** Disables swipe-to-close, e.g. while the image is zoomed and pannable. */
  swipeDisabled?: boolean;
  /** Transient message shown over the pane (share results, and similar). */
  status?: string | null;

  children: ReactNode;
}

/**
 * Chrome shared by the observation viewer and the gallery viewer: the
 * accessible dialog, header layout, navigation, zoom toolbar, thumbnail strip,
 * and swipe-to-close.
 *
 * Both viewers previously reimplemented all of this separately and had drifted
 * apart, so a fix in one never reached the other. Content-specific behaviour
 * (FITS rendering, per-item actions) stays with the caller through slots.
 */
export function LightboxFrame({
  isOpen, onClose, isDark, dialogTitle,
  titleIcon, title, subtitle,
  index, count, onPrev, onNext, onSelectIndex,
  zoom, extraControls, actions,
  thumbs, swipeDisabled, status, children,
}: Props) {
  const { handlers: swipe, dy, dragging } = useSwipeDownToClose(onClose, { disabled: swipeDisabled });

  // The keyboard hint used to be permanent, hardcoded white, and positioned
  // over the thumbnail strip. It is a first-run nudge, so it now says its piece
  // and leaves: after four seconds, or as soon as the user navigates and has
  // plainly worked it out.
  const [hintDismissed, setHintDismissed] = useState(false);
  useEffect(() => {
    if (!isOpen || count <= 1) return;
    const t = setTimeout(() => setHintDismissed(true), 4000);
    return () => clearTimeout(t);
  }, [isOpen, count]);

  const [seenIndex, setSeenIndex] = useState(index);
  if (seenIndex !== index) {
    setSeenIndex(index);
    setHintDismissed(true);
  }
  const showHint = isOpen && count > 1 && !hintDismissed;

  if (!isOpen) return null;

  const iconBtn = `p-2 rounded-lg transition disabled:opacity-30 ${
    isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'
  }`;
  const divider = `w-px h-5 mx-1 flex-shrink-0 ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={dialogTitle}
      focusOnOpen="dialog"
      backdropStyle={{ backgroundColor: `rgba(0,0,0,${0.9 * Math.max(0, 1 - dy / 400)})` }}
      backdropClassName=" "
      className={`w-full max-w-6xl h-[95dvh] max-h-full flex flex-col rounded-2xl touch-pan-y overscroll-contain ${
        isDark ? 'bg-slate-900' : 'bg-white'
      }`}
    >
      <div
        {...swipe}
        className="flex flex-col h-full min-h-0"
        style={{
          transform: dy ? `translateY(${dy}px)` : undefined,
          transition: dragging ? 'none' : 'transform 200ms ease-out',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        {/* Header. Stacks on narrow screens: the toolbar carries up to a dozen
            controls and cannot share a single row with the title on a phone. */}
        <div className={`flex-shrink-0 flex flex-col gap-2 p-3 sm:p-4 sm:flex-row sm:items-center sm:justify-between border-b ${
          isDark ? 'border-slate-800' : 'border-slate-200'
        }`}>
          <div className="flex items-center gap-3 min-w-0 sm:mr-3">
            {titleIcon}
            <div className="min-w-0">
              <span className={`font-medium text-sm truncate block ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                {title}
              </span>
              {subtitle && (
                <span className={`text-xs truncate block ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  {subtitle}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 flex-shrink-0 overflow-x-auto -mx-1 px-1 sm:overflow-visible sm:mx-0 sm:px-0">
            {count > 1 && (
              <>
                <button type="button" onClick={onPrev} disabled={index <= 0} aria-label="Previous image" className={iconBtn}>
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <span className={`text-sm font-medium tabular-nums px-1 whitespace-nowrap ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  {index + 1} / {count}
                </span>
                <button type="button" onClick={onNext} disabled={index >= count - 1} aria-label="Next image" className={iconBtn}>
                  <ChevronRight className="w-5 h-5" />
                </button>
                <div className={divider} />
              </>
            )}

            {zoom && (
              <>
                <button type="button" onClick={zoom.zoomOut} disabled={!zoom.canZoomOut} title="Zoom out (−)" aria-label="Zoom out" className={iconBtn}>
                  <ZoomOut className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={zoom.setFit}
                  title="Fit to window (F)"
                  className={`px-2 py-1 rounded text-xs font-medium tabular-nums min-w-[3.25rem] text-center transition ${
                    zoom.isFit
                      ? isDark ? 'text-accent-400 bg-accent-500/10' : 'text-accent-700 bg-accent-300'
                      : isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'
                  }`}
                >
                  {zoom.isFit ? 'Fit' : `${zoom.zoomPercent}%`}
                </button>
                <button type="button" onClick={zoom.zoomIn} disabled={!zoom.canZoomIn} title="Zoom in (+)" aria-label="Zoom in" className={iconBtn}>
                  <ZoomIn className="w-4 h-4" />
                </button>
                {/* True 1:1. The single most useful zoom for judging star shape
                    and noise, and previously unreachable. */}
                <button
                  type="button"
                  onClick={zoom.setActualSize}
                  title="Actual size, 1 image pixel per screen pixel (1)"
                  aria-label="Actual size"
                  className={`px-2 py-1 rounded text-xs font-medium transition ${
                    !zoom.isFit && zoom.zoomPercent === 100
                      ? isDark ? 'text-accent-400 bg-accent-500/10' : 'text-accent-700 bg-accent-300'
                      : isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'
                  }`}
                >
                  1:1
                </button>
                <div className={divider} />
              </>
            )}

            {extraControls}
            {actions}

            <button type="button" onClick={onClose} aria-label="Close viewer"
              className={`p-2 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content pane. The inner element is the one measured by the zoom
            engine, so its box is exactly the visible area with no padding to
            account for. */}
        <div className="relative flex-1 min-h-0">
          {children}

          {status && (
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 pointer-events-none" role="status">
              <span className="px-3 py-1.5 rounded-full bg-black/70 backdrop-blur-sm text-white text-xs">
                {status}
              </span>
            </div>
          )}

          {showHint && !status && (
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 pointer-events-none">
              <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/50 backdrop-blur-sm text-white/80 text-xs">
                <Maximize2 className="w-3 h-3" />
                Arrow keys to navigate, F to fit, 1 for actual size
              </span>
            </div>
          )}
        </div>

        {thumbs && (
          <LightboxThumbStrip
            entries={thumbs}
            index={index}
            onSelect={onSelectIndex}
            isDark={isDark}
          />
        )}
      </div>
    </Modal>
  );
}

/** Pane wrapper that the zoom engine measures. Use inside `LightboxFrame`. */
export function LightboxPane({
  zpRef, isPanning, canPan, handlers, children,
}: {
  /** Callback ref from `useZoomPan`, so the pane is measured whenever it mounts. */
  zpRef: (el: HTMLDivElement | null) => void;
  isPanning: boolean;
  canPan: boolean;
  handlers: Record<string, unknown>;
  children: ReactNode;
}) {
  return (
    <div
      ref={zpRef}
      {...handlers}
      data-lightbox-pane=""
      className="absolute inset-2 sm:inset-4 flex items-center justify-center overflow-hidden touch-none"
      style={{ cursor: canPan ? (isPanning ? 'grabbing' : 'grab') : undefined }}
    >
      {children}
    </div>
  );
}
