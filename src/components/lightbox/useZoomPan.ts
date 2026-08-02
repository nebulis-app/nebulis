import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Zoom and pan engine for the image lightboxes.
 *
 * ── Zoom is in natural pixels, not container widths ──────────────────────────
 * The previous implementation sized the image with `width: zoom * 100%` of the
 * viewer pane and labelled that number as the zoom percentage. It is not one: a
 * 4000px stacked frame in a 1200px pane read "100%" while showing 30% of the
 * real pixels. For frame review, where the whole point is judging star shapes at
 * 1:1, that number has to mean what it says.
 *
 * Here `zoom` is always `displayed pixels / natural pixels`, matching what
 * `FitsViewer` already does with its canvas, so the two viewers agree and a
 * genuine 1:1 button is possible.
 *
 * `zoom === null` means fit-to-pane, recomputed on resize. Any explicit zoom is
 * a number. `fitZoom` is capped at 1 so a small image is never blown up to fill
 * the pane by default.
 */

export interface ZoomPanState {
  /** Effective scale in natural pixels (1 = one image pixel per CSS pixel). */
  zoom: number;
  /** True while following the pane size rather than an explicit zoom. */
  isFit: boolean;
  /** Scale that fits the image in the pane, capped at 1:1. */
  fitZoom: number;
  /** True once the image's natural dimensions are known. */
  measured: boolean;
  natural: { w: number; h: number } | null;
  pan: { x: number; y: number };
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 16;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function useZoomPan(
  /** Changing this resets zoom and pan (used to reset on navigation). */
  resetKey: unknown,
) {
  // The pane is tracked as state, not a plain ref, because it does not exist on
  // the hook's first render: the viewers are mounted closed and return null
  // until opened. A mount-time effect would find nothing to measure and never
  // run again, leaving the pane size at zero, which silently turns "fit" into
  // 100% (the guarded fallback below) while the toolbar still claims to fit.
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const containerRef = useCallback((el: HTMLDivElement | null) => setNode(el), []);

  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [container, setContainer] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [userZoom, setUserZoom] = useState<number | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);

  // Track the pane size so fit zoom follows resizes, orientation changes, and
  // the modal's own open animation.
  useLayoutEffect(() => {
    if (!node) return;
    const measure = () => setContainer({ w: node.clientWidth, h: node.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, [node]);

  // Reset on navigation. Natural size is cleared too so the new image's
  // dimensions are read fresh rather than inherited from the previous one.
  //
  // Adjusted during render rather than in an effect: an effect would paint one
  // frame of the new image at the old image's zoom and pan before correcting
  // itself, which reads as a flicker on every navigation.
  const [seenKey, setSeenKey] = useState(resetKey);
  if (seenKey !== resetKey) {
    setSeenKey(resetKey);
    setUserZoom(null);
    setPan({ x: 0, y: 0 });
    setNatural(null);
  }

  const fitZoom = natural && container.w > 0 && container.h > 0
    ? Math.min(container.w / natural.w, container.h / natural.h, 1)
    : 1;

  const zoom = userZoom ?? fitZoom;
  const isFit = userZoom === null;

  /**
   * Keep the image inside the pane. When the scaled image is smaller than the
   * pane on an axis it stays centred (max offset 0); when larger, panning is
   * bounded by the overhang. Without this the image could be dragged entirely
   * off-screen with no way back except toggling Fit.
   */
  const clampPan = useCallback((p: { x: number; y: number }, z: number) => {
    if (!natural) return { x: 0, y: 0 };
    const maxX = Math.max(0, (natural.w * z - container.w) / 2);
    const maxY = Math.max(0, (natural.h * z - container.h) / 2);
    return { x: clamp(p.x, -maxX, maxX), y: clamp(p.y, -maxY, maxY) };
  }, [natural, container.w, container.h]);

  // The bounds depend on the pane size, so a resize can put a previously valid
  // pan out of range. Clamping on read rather than storing a corrected value
  // means the image is never drawn outside its bounds, not even for the frame
  // before a correction lands.
  const clampedPan = clampPan(pan, zoom);

  /**
   * Zoom to `next`, keeping the image point under `anchor` fixed on screen.
   * `anchor` is in client coordinates; omitted means zoom about the pane centre.
   */
  const zoomTo = useCallback((next: number, anchor?: { clientX: number; clientY: number }) => {
    const z = clamp(next, MIN_ZOOM, MAX_ZOOM);
    setUserZoom(z);
    setPan(prev => {
      if (!node || !anchor) return clampPan(prev, z);
      const rect = node.getBoundingClientRect();
      // Pointer position relative to the pane centre, which is where the
      // untranslated image is centred.
      const px = anchor.clientX - rect.left - rect.width / 2;
      const py = anchor.clientY - rect.top - rect.height / 2;
      // The image-space point currently under the pointer, then the pan that
      // puts that same point back under the pointer at the new scale.
      const current = userZoom ?? fitZoom;
      const ux = (px - prev.x) / current;
      const uy = (py - prev.y) / current;
      return clampPan({ x: px - ux * z, y: py - uy * z }, z);
    });
  }, [clampPan, userZoom, fitZoom, node]);

  const setFit = useCallback(() => {
    setUserZoom(null);
    setPan({ x: 0, y: 0 });
  }, []);

  /** Snap to true 1:1, the zoom that matters for judging stars and noise. */
  const setActualSize = useCallback(() => {
    setUserZoom(1);
    setPan(p => clampPan(p, 1));
  }, [clampPan]);

  const zoomBy = useCallback((factor: number, anchor?: { clientX: number; clientY: number }) => {
    zoomTo(zoom * factor, anchor);
  }, [zoom, zoomTo]);

  /**
   * Wheel and trackpad pinch. Pinch arrives as a wheel event with `ctrlKey`
   * and small deltas; a normal wheel sends large ones, so they need different
   * sensitivities. Both are multiplicative so each step feels the same at any
   * zoom level, and both are anchored to the pointer.
   *
   * Registered natively (not via React's `onWheel`) because the handler calls
   * `preventDefault`, which requires a non-passive listener.
   */
  useEffect(() => {
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const intensity = e.ctrlKey ? 0.01 : 0.0025;
      zoomBy(Math.exp(-e.deltaY * intensity), e);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [node, zoomBy]);

  // Pointer panning. Move and release are bound to the document so a fast drag
  // that leaves the pane does not strand the gesture in a pressed state.
  const panStartRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Touch is reserved for swipe-to-close and pinch; only drag with a mouse or pen.
    if (e.pointerType === 'touch') return;
    if (!natural) return;
    const overflows = natural.w * zoom > container.w + 1 || natural.h * zoom > container.h + 1;
    if (!overflows) return;
    e.preventDefault();
    panStartRef.current = { x: e.clientX, y: e.clientY, ox: clampedPan.x, oy: clampedPan.y };
    setIsPanning(true);
  }, [natural, zoom, container.w, container.h, clampedPan.x, clampedPan.y]);

  useEffect(() => {
    if (!isPanning) return;
    const onMove = (e: PointerEvent) => {
      const s = panStartRef.current;
      if (!s) return;
      setPan(clampPan({ x: s.ox + e.clientX - s.x, y: s.oy + e.clientY - s.y }, zoom));
    };
    const onUp = () => { panStartRef.current = null; setIsPanning(false); };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
    };
  }, [isPanning, clampPan, zoom]);

  // Two-finger pinch on touch devices. Tracked here rather than through the
  // wheel path because touch never produces wheel events.
  const pinchRef = useRef<{ dist: number; zoom: number } | null>(null);
  const activeTouches = useRef(new Map<number, { x: number; y: number }>());

  const onTouchPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    activeTouches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }, []);

  const onTouchPointerMove = useCallback((e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    const touches = activeTouches.current;
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size !== 2) { pinchRef.current = null; return; }
    const [a, b] = Array.from(touches.values());
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 };
    if (!pinchRef.current) {
      pinchRef.current = { dist, zoom };
      return;
    }
    if (pinchRef.current.dist > 0) {
      zoomTo(pinchRef.current.zoom * (dist / pinchRef.current.dist), mid);
    }
  }, [zoom, zoomTo]);

  const onTouchPointerUp = useCallback((e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    activeTouches.current.delete(e.pointerId);
    if (activeTouches.current.size < 2) pinchRef.current = null;
  }, []);

  /** Double click toggles between fit and 1:1, anchored at the pointer. */
  const onDoubleClick = useCallback((e: React.MouseEvent) => {
    if (isFit) zoomTo(1, e);
    else setFit();
  }, [isFit, zoomTo, setFit]);

  const onImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (img.naturalWidth && img.naturalHeight) {
      setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    }
  }, []);

  const overflows = !!natural
    && (natural.w * zoom > container.w + 1 || natural.h * zoom > container.h + 1);

  return {
    containerRef,
    zoom,
    isFit,
    fitZoom,
    natural,
    pan: clampedPan,
    isPanning,
    /** True when the image is larger than the pane, so panning does something. */
    overflows,
    /** Integer percent for display. Honest: 100 means one image pixel per CSS pixel. */
    zoomPercent: Math.round(zoom * 100),
    canZoomIn: zoom < MAX_ZOOM,
    canZoomOut: zoom > MIN_ZOOM,
    setFit,
    setActualSize,
    zoomTo,
    zoomBy,
    onImageLoad,
    /** Spread onto the pane element. */
    paneHandlers: {
      onPointerDown: (e: React.PointerEvent) => { onPointerDown(e); onTouchPointerDown(e); },
      onPointerMove: onTouchPointerMove,
      onPointerUp: onTouchPointerUp,
      onPointerCancel: onTouchPointerUp,
      onDoubleClick,
    },
    /**
     * Style for the scaled image element, or undefined until both the image
     * and the pane have been measured. Undefined is the caller's cue to fall
     * back to `object-contain`, which fits by definition. Sizing the image
     * from an unmeasured pane would render it at 1:1 while the toolbar
     * reported "Fit".
     */
    imageStyle: natural && container.w > 0 && container.h > 0
      ? {
          width: natural.w * zoom,
          height: natural.h * zoom,
          maxWidth: 'none' as const,
          transform: `translate3d(${clampedPan.x}px, ${clampedPan.y}px, 0)`,
          willChange: isPanning ? ('transform' as const) : undefined,
        }
      : undefined,
  };
}

export type ZoomPan = ReturnType<typeof useZoomPan>;
