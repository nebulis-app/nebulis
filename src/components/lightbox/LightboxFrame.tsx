import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Maximize2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { useSwipeDownToClose } from '../../hooks/useSwipeDownToClose';
import { LightboxThumbStrip, type ThumbEntry } from './LightboxThumbStrip';
import { LB_GROUP, LB_ICON_BTN, LB_TEXT_BTN, LB_ACTIVE, LB_CLOSE_BTN } from './chrome';
import type { ZoomControls } from './zoomControls';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** When set, Escape and a backdrop click run this instead of closing the
   *  viewer (the open annotation card dismisses itself first). */
  onEscape?: () => void;
  /** Accessible dialog name. */
  dialogTitle: string;

  titleIcon?: ReactNode;
  title: ReactNode;
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
  /** Buttons that change how the picture is shown (the annotation overlay), grouped with fullscreen. */
  viewActions?: ReactNode;

  /**
   * Fullscreen (AstroBin-style) mode: strips the header, zoom toolbar, and
   * thumbnail strip down to just the picture, edge-to-edge, with a floating
   * exit button. Both `immersive` and `onToggleImmersive` are controlled by
   * the caller so its own zoom/pan state (`children`) carries over unchanged
   * across the transition. Omitting `onToggleImmersive` hides the expand
   * button entirely (used for content with no zoom engine to hand off to,
   * e.g. the FITS viewer).
   */
  immersive?: boolean;
  onToggleImmersive?: () => void;

  thumbs?: ThumbEntry[];
  /** Disables swipe-to-close, e.g. while the image is zoomed and pannable. */
  swipeDisabled?: boolean;
  /** Transient message shown over the pane (share results, and similar). */
  status?: string | null;
  /**
   * Small already-loaded version of the current item, thrown far out of focus
   * behind the whole panel. A frame of the Veil should not sit on a flat slab
   * of grey, and a portrait stack leaves a lot of panel either side of itself.
   * A thumbnail is the right source: it is in cache from the grid behind the
   * viewer, and it is about to be blurred to nothing anyway.
   */
  ambientSrc?: string | null;
  /**
   * Width / height of the item being shown, once it is known.
   *
   * The panel is sized to the picture rather than to the screen. Every Seestar
   * stack is portrait, and in a fixed 1400px panel that left the frame as a
   * column down the middle with two thirds of the viewer as bare black either
   * side of it, the title stranded in one far corner and the toolbar in the
   * other. See the width calculation below for why this cannot feed back into
   * the fit zoom.
   */
  contentAspect?: number | null;

  children: ReactNode;
}

/**
 * How wide the panel is allowed to be for a picture of a given aspect ratio.
 *
 * `95dvh * aspect` is the width the frame would need if the stage were the full
 * height of the panel. The stage is shorter than that (the header and the rail
 * take their cut), so the pane always ends up wider than the fitted picture,
 * which is what keeps this out of a feedback loop: the fit zoom for a portrait
 * frame is decided by the pane's height, and narrowing the panel never touches
 * it. A landscape frame is capped by the 88rem ceiling long before the width
 * could bind. The 54rem floor is the point below which the header's own
 * controls would start to crowd the title.
 */
function panelMaxWidth(aspect: number | null | undefined): string | undefined {
  if (!aspect || !Number.isFinite(aspect) || aspect <= 0) return undefined;
  return `min(88rem, max(54rem, calc(95dvh * ${aspect.toFixed(3)} + 8rem)))`;
}

/**
 * Chrome shared by the observation viewer and the gallery viewer: the
 * accessible dialog, header layout, navigation, zoom toolbar, thumbnail strip,
 * and swipe-to-close.
 *
 * Both viewers previously reimplemented all of this separately and had drifted
 * apart, so a fix in one never reached the other. Content-specific behaviour
 * (FITS rendering, per-item actions) stays with the caller through slots.
 *
 * The surface is night-side in every theme (see `./chrome`), so nothing in here
 * takes an `isDark`. The old viewer was a white card in light mode, which put a
 * sheet of paper around an astrophoto and blew out the eye's adaptation the
 * moment you opened a frame.
 */
export function LightboxFrame({
  isOpen, onClose, onEscape, dialogTitle,
  titleIcon, title, subtitle,
  index, count, onPrev, onNext, onSelectIndex,
  zoom, extraControls, actions, viewActions,
  immersive, onToggleImmersive,
  thumbs, swipeDisabled, status, ambientSrc, contentAspect, children,
}: Props) {
  const { t } = useTranslation('library');
  // Escape and a backdrop click both route through Modal's own `onClose`.
  // While immersive, that should back out to the windowed view rather than
  // tear down the whole viewer — the same one-level-at-a-time behavior the
  // delete confirmation already gets by suspending the outer key handler.
  const effectiveOnClose = onEscape ?? (immersive ? (onToggleImmersive ?? onClose) : onClose);
  const { handlers: swipe, dy, dragging } = useSwipeDownToClose(onClose, { disabled: swipeDisabled || immersive });

  // The keyboard hint used to be permanent, hardcoded white, and positioned
  // over the thumbnail strip. It is a first-run nudge, so it now says its piece
  // and leaves: after four seconds, or as soon as the user navigates and has
  // plainly worked it out.
  const [hintDismissed, setHintDismissed] = useState(false);
  useEffect(() => {
    if (!isOpen || count <= 1) return;
    const timer = setTimeout(() => setHintDismissed(true), 4000);
    return () => clearTimeout(timer);
  }, [isOpen, count]);

  const [seenIndex, setSeenIndex] = useState(index);
  if (seenIndex !== index) {
    setSeenIndex(index);
    setHintDismissed(true);
  }
  const showHint = isOpen && count > 1 && !hintDismissed;

  /**
   * The last shape we were told about, kept until a new one arrives.
   *
   * A frame's dimensions are only known once it has decoded, so on every
   * navigation the live value is null for a moment. Sizing off that directly
   * made the panel snap out to full width and back on each step through a
   * session, which is far more distracting than the mat it was there to
   * remove. Frames from one session are all the same shape anyway.
   */
  const [stickyAspect, setStickyAspect] = useState(contentAspect ?? null);
  if (contentAspect && contentAspect !== stickyAspect) setStickyAspect(contentAspect);

  if (!isOpen) return null;

  return (
    <Modal
      isOpen
      onClose={effectiveOnClose}
      title={dialogTitle}
      focusOnOpen="dialog"
      backdropStyle={immersive ? undefined : { backgroundColor: `rgba(0,0,0,${0.92 * Math.max(0, 1 - dy / 400)})` }}
      backdropClassName={immersive ? 'bg-black' : ' '}
      edgeToEdge={immersive}
      className={immersive
        ? 'flex h-full w-full max-w-none flex-col overflow-hidden bg-black'
        : `w-full max-w-[88rem] h-[95dvh] max-h-full flex flex-col rounded-3xl bg-slate-950
          hero-panel overflow-hidden touch-pan-y overscroll-contain
          transition-[max-width] duration-300 ease-out`}
      style={immersive ? undefined : { maxWidth: panelMaxWidth(stickyAspect) }}
    >
      <div
        {...swipe}
        className="relative flex h-full min-h-0 flex-col"
        style={{
          transform: dy ? `translateY(${dy}px)` : undefined,
          transition: dragging ? 'none' : 'transform 200ms ease-out',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        {/* Ambient. Scaled well past the panel so the blur's own soft edge is
            cropped away rather than feathering to transparent inside it, the
            same treatment SessionHero gives its frame. */}
        {ambientSrc && (
          <img
            key={ambientSrc}
            src={ambientSrc}
            alt=""
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 h-full w-full scale-[1.6] object-cover
              blur-[80px] saturate-150 opacity-40 transition-opacity duration-500"
          />
        )}
        {!immersive && <div className="pointer-events-none absolute inset-0 bg-slate-950/70" />}
        {!immersive && (
          <div
            className="pointer-events-none absolute inset-0 rounded-3xl"
            style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.10)' }}
          />
        )}

        {/* Header. Stacks on narrow screens: the toolbar carries up to a dozen
            controls and cannot share a single row with the title on a phone.
            No rule underneath it, unlike the old card: the scrim behind the
            text is what separates it from the picture, so the panel reads as
            one dark surface rather than three boxes stacked up. Swapped out
            entirely for a single floating exit button in immersive mode —
            see below. */}
        {!immersive && (
        <div className="relative z-10 flex flex-shrink-0 flex-col gap-2.5 bg-gradient-to-b from-black/50 to-transparent
          px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-5 sm:py-4">
          <div className="flex min-w-0 items-center gap-3">
            {titleIcon && (
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl
                bg-white/[0.06] ring-1 ring-inset ring-white/10">
                {titleIcon}
              </div>
            )}
            <div className="min-w-0">
              <span
                className="font-display block truncate text-[0.9375rem] font-semibold tracking-tight text-white"
                title={typeof title === 'string' ? title : undefined}
              >
                {title}
              </span>
              {subtitle && (
                // The detail line ends in the filename, which is the first
                // thing to be truncated once the panel sizes itself to the
                // picture. Hovering gives it back rather than losing it.
                <span
                  className="mt-0.5 block truncate text-[0.7188rem] text-white/45"
                  title={typeof subtitle === 'string' ? subtitle : undefined}
                >
                  {subtitle}
                </span>
              )}
            </div>
          </div>

          {/* Close sits outside the scrolling group row. On a phone the tools
              overflow and scroll sideways, and the one control that gets you
              out of the viewer must never be the one that scrolled away. */}
          <div className="flex items-center gap-2">
          <div className="-mx-1 flex min-w-0 items-center gap-2 overflow-x-auto px-1 sm:mx-0 sm:overflow-visible sm:px-0">
            {zoom && (
              <div className={LB_GROUP}>
                <button type="button" onClick={zoom.zoomOut} disabled={!zoom.canZoomOut}
                  title={t('lightboxFrame.zoomOutTitle')} aria-label={t('lightboxFrame.zoomOutAria')} className={LB_ICON_BTN}>
                  <ZoomOut className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={zoom.setFit}
                  title={t('lightboxFrame.fitTitle')}
                  className={`${LB_TEXT_BTN} min-w-[3.25rem] tabular-nums ${zoom.isFit ? LB_ACTIVE : ''}`}
                >
                  {zoom.isFit ? t('lightboxFrame.fitLabel') : `${zoom.zoomPercent}%`}
                </button>
                <button type="button" onClick={zoom.zoomIn} disabled={!zoom.canZoomIn}
                  title={t('lightboxFrame.zoomInTitle')} aria-label={t('lightboxFrame.zoomInAria')} className={LB_ICON_BTN}>
                  <ZoomIn className="h-4 w-4" />
                </button>
                {/* True 1:1. The single most useful zoom for judging star shape
                    and noise, and previously unreachable. */}
                <button
                  type="button"
                  onClick={zoom.setActualSize}
                  title={t('lightboxFrame.actualSizeTitle')}
                  aria-label={t('lightboxFrame.actualSizeAria')}
                  className={`${LB_TEXT_BTN} ${!zoom.isFit && zoom.zoomPercent === 100 ? LB_ACTIVE : ''}`}
                >
                  1:1
                </button>
              </div>
            )}

            {(viewActions || onToggleImmersive) && (
              <div className={LB_GROUP}>
                {viewActions}
                {onToggleImmersive && (
                  <button
                    type="button"
                    onClick={onToggleImmersive}
                    title={t('lightboxFrame.fullscreenTitle')}
                    aria-label={t('lightboxFrame.fullscreenAria')}
                    className={LB_ICON_BTN}
                  >
                    <Maximize2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            )}

            {extraControls && <div className={LB_GROUP}>{extraControls}</div>}
            {actions && <div className={LB_GROUP}>{actions}</div>}
          </div>

          <button type="button" onClick={onClose} aria-label={t('lightboxFrame.closeAria')} className={LB_CLOSE_BTN}>
            <X className="h-4.5 w-4.5" />
          </button>
          </div>
        </div>
        )}

        {immersive && (
          <div className="absolute right-3 top-3 z-20 flex items-center gap-2 sm:right-4 sm:top-4">
            <button
              type="button"
              onClick={onToggleImmersive}
              aria-label={t('lightboxFrame.exitFullscreenAria')}
              className={LB_CLOSE_BTN}
            >
              <X className="h-4.5 w-4.5" />
            </button>
          </div>
        )}

        {/* Content pane. The inner element is the one measured by the zoom
            engine, so its box is exactly the visible area with no padding to
            account for. */}
        <div className="relative z-10 min-h-0 flex-1">
          {children}

          {count > 1 && (
            <>
              <EdgeNav side="left" onClick={onPrev} disabled={index <= 0} />
              <EdgeNav side="right" onClick={onNext} disabled={index >= count - 1} />
            </>
          )}

          {/* Position in the list. At the foot of the picture rather than in the toolbar, next to the edge
              arrows and thumbnails that move through it, which leaves the title room for its file name. */}
          {count > 1 && !immersive && (
            <span className="pointer-events-none absolute bottom-3 right-3 z-20 inline-flex h-7 items-center gap-1 rounded-full
              bg-black/55 px-2.5 text-[0.7188rem] font-medium tabular-nums text-white/75 ring-1 ring-inset ring-white/10 backdrop-blur-md">
              {index + 1}
              <span className="text-white/30">/</span>
              {count}
            </span>
          )}

          {status && (
            <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2" role="status">
              <span className="rounded-full bg-black/75 px-3.5 py-1.5 text-xs text-white/90
                ring-1 ring-inset ring-white/15 backdrop-blur-md">
                {status}
              </span>
            </div>
          )}

          {showHint && !status && (
            // Keyboard-only advice, so it is not shown at phone widths: there
            // is no keyboard to nudge anyone towards, and wrapped onto three
            // lines it covered the bottom of the frame.
            <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 hidden -translate-x-1/2 sm:block">
              <span className="flex items-center gap-2 whitespace-nowrap rounded-full bg-black/55 px-3 py-1.5 text-[0.6875rem]
                text-white/70 ring-1 ring-inset ring-white/10 backdrop-blur-md">
                <Key>←</Key><Key>→</Key> {t('lightboxFrame.browseHint')}
                <span className="text-white/20">·</span>
                <Key>F</Key> {t('lightboxFrame.fitHint')}
                <span className="text-white/20">·</span>
                <Key>1</Key> {t('lightboxFrame.actualSizeHint')}
              </span>
            </div>
          )}
        </div>

        {thumbs && !immersive && (
          <LightboxThumbStrip
            entries={thumbs}
            index={index}
            onSelect={onSelectIndex}
          />
        )}
      </div>
    </Modal>
  );
}

/** One key in the first-run hint. */
function Key({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded bg-white/10 px-1.5 py-0.5 font-sans text-[0.625rem] font-medium text-white/85">
      {children}
    </kbd>
  );
}

/**
 * Navigation on the picture's own edge.
 *
 * The chevrons used to sit in the header beside the counter, which put the
 * two most-used controls in the viewer as far from the picture as the layout
 * allowed. Here they land where the pointer already is, and they disappear
 * rather than grey out at the ends of the list, so the frame is never framed
 * by two dead buttons.
 */
function EdgeNav({ side, onClick, disabled }: {
  side: 'left' | 'right';
  onClick: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation('library');
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={side === 'left' ? t('lightboxFrame.previousImageAria') : t('lightboxFrame.nextImageAria')}
      className={`absolute top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full
        bg-black/40 text-white/70 opacity-70 ring-1 ring-inset ring-white/15 backdrop-blur-md outline-none
        transition hover:bg-black/70 hover:text-white hover:opacity-100 focus-visible:opacity-100
        focus-visible:ring-2 focus-visible:ring-white/60 disabled:pointer-events-none disabled:opacity-0
        sm:h-11 sm:w-11 ${side === 'left' ? 'left-1.5 sm:left-3' : 'right-1.5 sm:right-3'}`}
    >
      <Icon className="h-5 w-5" />
    </button>
  );
}

/** Pane wrapper that the zoom engine measures. Use inside `LightboxFrame`. */
export function LightboxPane({
  zpRef, isPanning, canPan, handlers, flush, reserve, children,
}: {
  /** Callback ref from `useZoomPan`, so the pane is measured whenever it mounts. */
  zpRef: (el: HTMLDivElement | null) => void;
  isPanning: boolean;
  canPan: boolean;
  handlers: Record<string, unknown>;
  /** No inset — the picture should be the only thing on screen. Used by the
   *  fullscreen mode; the windowed view keeps a small margin so the picture
   *  doesn't touch the panel's own rounded corners. */
  flush?: boolean;
  /** Space kept free along the left or top edge, in px, for a panel that must not sit over the picture. The
   *  pane itself shrinks, so the picture can neither fit nor zoom under it: the pane clips at its own edge. */
  reserve?: { left: number; top: number };
  children: ReactNode;
}) {
  return (
    <div
      ref={zpRef}
      {...handlers}
      data-lightbox-pane=""
      className={`absolute flex touch-none items-center justify-center overflow-hidden ${
        flush ? 'inset-0' : 'inset-2 sm:inset-4'
      }`}
      style={{
        cursor: canPan ? (isPanning ? 'grabbing' : 'grab') : undefined,
        // Margins shrink an absolutely positioned box that has all four insets, whatever the breakpoint's inset is.
        marginLeft: reserve?.left || undefined,
        marginTop: reserve?.top || undefined,
      }}
    >
      {children}
    </div>
  );
}
