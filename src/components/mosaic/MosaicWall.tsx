import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Focus, Maximize2, Minimize2, Minus, Plus, Share2, Type } from 'lucide-react';
import { layoutMosaic, type Placement } from '../../lib/mosaic/mosaicPacker';
import { useTheme } from '../../hooks/useTheme';
import { MosaicShareDialog } from './MosaicShareDialog';

export interface MosaicTile {
  id: string;
  title: string;
  /** The catalog designation, when the title is something friendlier. */
  subtitle?: string;
  /** One line under the title on hover: what has been done with it. */
  detail?: string;
  /** How much it matters: sets the tile's size. */
  score: number;
  href: string;
  /** Picture URL sized for a longest side of `px` device pixels. */
  imageUrl: (px: number) => string;
}

interface Props {
  tiles: MosaicTile[];
  onOpen: (id: string) => void;
  /** localStorage key for the names toggle. */
  labelsStorageKey: string;
  ariaLabel: string;
  /** Names the saved picture. Without it the wall offers no share button. */
  shareFileBase?: string;
}

interface Camera { cx: number; cy: number; s: number }
interface Size { w: number; h: number }

const BUCKETS = [96, 256, 512, 1024, 2048];
/** On-screen long side of the tile under the pointer, in CSS pixels. */
const ENLARGED_LONG_SIDE = 340;
const MAX_POP = 8;
const DRAG_SLOP = 4;

function bucketFor(px: number): number {
  return BUCKETS.find(b => b >= px) ?? BUCKETS[BUCKETS.length - 1];
}

function readLabels(key: string): boolean {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}

export function MosaicWall({ tiles, onOpen, labelsStorageKey, ariaLabel, shareFileBase }: Props) {
  const { t } = useTranslation('library');
  const { isNight } = useTheme();
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const [labels, setLabels] = useState(() => readLabels(labelsStorageKey));
  const [hotId, setHotId] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  // True fullscreen where the browser grants it; otherwise (iPhone Safari, a refused request) the wall fills the window.
  const [nativeFull, setNativeFull] = useState(false);
  const [windowFull, setWindowFull] = useState(false);
  const isFull = nativeFull || windowFull;

  // The camera lives in a ref and is written straight to the layer, so panning never re-renders thousands of tiles.
  // `cam` is the committed copy (throttled), used to decide which tiles are on screen and how sharp they must be.
  const camRef = useRef<Camera>({ cx: 0, cy: 0, s: 1 });
  const [cam, setCam] = useState<Camera>({ cx: 0, cy: 0, s: 1 });
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userMoved = useRef(false);
  const suppressClick = useRef(false);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => () => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
    if (animTimer.current) clearTimeout(animTimer.current);
  }, []);

  // The wall is laid out for the box it is shown in, rounded so a small resize does not re-pack.
  const aspect = size.w > 0 && size.h > 0 ? Math.min(3, Math.max(0.6, Math.round((size.w / size.h) * 10) / 10)) : 1.5;
  const tileKey = tiles.map(tile => `${tile.id}:${tile.score.toFixed(3)}`).join('|');
  const layout = useMemo(
    () => layoutMosaic(tiles.map(tile => ({ id: tile.id, score: tile.score })), aspect),
    // tileKey stands for the ids and scores; `tiles` itself changes identity on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tileKey, aspect],
  );
  const tileById = useMemo(() => new Map(tiles.map(tile => [tile.id, tile])), [tiles]);

  const fit = useMemo<Camera>(() => {
    if (size.w <= 0 || size.h <= 0 || layout.width <= 0) return { cx: 0, cy: 0, s: 1 };
    const s = Math.min(size.w / layout.width, size.h / layout.height) * 0.94;
    return { cx: layout.width / 2, cy: layout.height / 2, s: Math.min(2.2, s) };
  }, [size.w, size.h, layout.width, layout.height]);

  const limits = useMemo(() => {
    let smallest = Number.POSITIVE_INFINITY;
    for (const p of layout.placements) smallest = Math.min(smallest, p.w, p.h);
    if (!Number.isFinite(smallest) || smallest <= 0) smallest = 1;
    const lo = fit.s * 0.7;
    const hi = Math.min(fit.s * 40, Math.max(fit.s * 3, 260 / smallest));
    return { lo, hi: Math.max(hi, lo * 1.5) };
  }, [layout.placements, fit.s]);

  const applyCamera = useCallback((c: Camera) => {
    camRef.current = c;
    const layer = layerRef.current;
    if (!layer) return;
    const tx = size.w / 2 - c.cx * c.s;
    const ty = size.h / 2 - c.cy * c.s;
    layer.style.transform = `translate(${tx}px, ${ty}px) scale(${c.s})`;
    layer.style.setProperty('--mosaic-s', String(c.s));
  }, [size.w, size.h]);

  const commitSoon = useCallback(() => {
    if (commitTimer.current) return;
    commitTimer.current = setTimeout(() => {
      commitTimer.current = null;
      setCam({ ...camRef.current });
    }, 100);
  }, []);

  const moveTo = useCallback((c: Camera, animate = false) => {
    const s = Math.min(limits.hi, Math.max(limits.lo, c.s));
    // At or below "fit" the whole wall is on screen, so there is nothing to pan to: hold it centred.
    const atFit = s <= fit.s * 1.001;
    const clamped: Camera = {
      s,
      cx: atFit ? fit.cx : Math.min(layout.width, Math.max(0, c.cx)),
      cy: atFit ? fit.cy : Math.min(layout.height, Math.max(0, c.cy)),
    };
    const layer = layerRef.current;
    if (layer && animate) {
      layer.style.transition = 'transform 0.24s cubic-bezier(0.2, 0.7, 0.2, 1)';
      if (animTimer.current) clearTimeout(animTimer.current);
      animTimer.current = setTimeout(() => { if (layerRef.current) layerRef.current.style.transition = ''; }, 280);
    } else if (layer) {
      layer.style.transition = '';
    }
    applyCamera(clamped);
    commitSoon();
  }, [applyCamera, commitSoon, fit, layout.width, layout.height, limits.lo, limits.hi]);

  // A new layout or a resized box starts at "everything fits". After the user has moved, only a new layout resets.
  const lastLayout = useRef(layout);
  useLayoutEffect(() => {
    if (size.w <= 0) return;
    const layoutChanged = lastLayout.current !== layout;
    lastLayout.current = layout;
    if (layoutChanged) userMoved.current = false;
    if (!userMoved.current) {
      applyCamera(fit);
      setCam(fit);
    } else {
      applyCamera(camRef.current);
    }
  }, [layout, fit, size.w, size.h, applyCamera]);

  const zoomAround = useCallback((factor: number, ax: number, ay: number, animate = false) => {
    const c = camRef.current;
    const next = Math.min(limits.hi, Math.max(limits.lo, c.s * factor));
    const wx = c.cx + (ax - size.w / 2) / c.s;
    const wy = c.cy + (ay - size.h / 2) / c.s;
    userMoved.current = true;
    moveTo({ s: next, cx: wx - (ax - size.w / 2) / next, cy: wy - (ay - size.h / 2) / next }, animate);
  }, [limits.hi, limits.lo, moveTo, size.w, size.h]);

  const resetFit = useCallback(() => {
    userMoved.current = false;
    moveTo(fit, true);
  }, [fit, moveTo]);

  // Wheel: a pinch (ctrl) or a mouse wheel zooms around the cursor; a trackpad's two-finger scroll pans. Native
  // listener because React's wheel handler is passive and could not stop the page from scrolling.
  const wheelRef = useRef({ zoomAround, moveTo });
  useEffect(() => { wheelRef.current = { zoomAround, moveTo }; });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      setHotId(null);
      const rect = el!.getBoundingClientRect();
      const mouseWheel = e.deltaMode !== 0 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50);
      if (e.ctrlKey || e.metaKey || mouseWheel) {
        const k = e.deltaMode !== 0 ? 0.05 : e.ctrlKey ? 0.01 : 0.0018;
        wheelRef.current.zoomAround(Math.exp(-e.deltaY * k), e.clientX - rect.left, e.clientY - rect.top);
      } else {
        const c = camRef.current;
        userMoved.current = true;
        wheelRef.current.moveTo({ ...c, cx: c.cx + e.deltaX / c.s, cy: c.cy + e.deltaY / c.s });
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Pointer: drag pans, two fingers pinch, a still pointer hovers. Capture only starts once a drag is real, so a plain
  // click still reaches the tile's own link.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const pinch = useRef<number | null>(null);
  const hoverFrame = useRef<number | null>(null);

  function localPoint(e: React.PointerEvent): { x: number; y: number } {
    const rect = stageRef.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    const p = localPoint(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = Math.hypot(a.x - b.x, a.y - b.y);
      drag.current = null;
    } else {
      drag.current = { x: p.x, y: p.y, moved: false };
    }
  }

  function hitTest(px: number, py: number): Placement | null {
    const c = camRef.current;
    const wx = c.cx + (px - size.w / 2) / c.s;
    const wy = c.cy + (py - size.h / 2) / c.s;
    for (const p of layout.placements) {
      if (wx >= p.x && wx < p.x + p.w && wy >= p.y && wy < p.y + p.h) return p;
    }
    return null;
  }

  function onPointerMove(e: React.PointerEvent) {
    const p = localPoint(e);
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, p);

    if (pinch.current !== null && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.current > 0 && d > 0) zoomAround(d / pinch.current, (a.x + b.x) / 2, (a.y + b.y) / 2);
      pinch.current = d;
      suppressClick.current = true;
      setHotId(null);
      return;
    }

    const d = drag.current;
    if (d && e.buttons === 1) {
      const dx = p.x - d.x;
      const dy = p.y - d.y;
      if (!d.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
      if (!d.moved) {
        d.moved = true;
        suppressClick.current = true;
        stageRef.current?.setPointerCapture(e.pointerId);
        setHotId(null);
      }
      const c = camRef.current;
      userMoved.current = true;
      moveTo({ ...c, cx: c.cx - dx / c.s, cy: c.cy - dy / c.s });
      d.x = p.x;
      d.y = p.y;
      return;
    }

    if (e.pointerType === 'touch' || e.buttons !== 0) return;
    if (hoverFrame.current !== null) cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = null;
      setHotId(hitTest(p.x, p.y)?.id ?? null);
    });
  }

  function endPointer(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    drag.current = null;
    if (suppressClick.current) setTimeout(() => { suppressClick.current = false; }, 0);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const cx = size.w / 2;
    const cy = size.h / 2;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomAround(1.3, cx, cy, true); }
    else if (e.key === '-') { e.preventDefault(); zoomAround(1 / 1.3, cx, cy, true); }
    else if (e.key === '0') { e.preventDefault(); resetFit(); }
  }

  useEffect(() => {
    const root = rootRef.current;
    const onChange = () => setNativeFull(document.fullscreenElement === root);
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      if (document.fullscreenElement === root) void document.exitFullscreen().catch(() => {});
    };
  }, []);
  // The box changes size, so start again from "everything fits".
  useEffect(() => { userMoved.current = false; }, [isFull]);
  useEffect(() => {
    if (!windowFull) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setWindowFull(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [windowFull]);

  function toggleFullscreen() {
    if (document.fullscreenElement) { void document.exitFullscreen().catch(() => {}); return; }
    if (windowFull) { setWindowFull(false); return; }
    const root = rootRef.current;
    if (!root || !document.fullscreenEnabled) { setWindowFull(true); return; }
    root.requestFullscreen().catch(() => setWindowFull(true));
  }

  function toggleLabels() {
    setLabels(v => {
      try { localStorage.setItem(labelsStorageKey, v ? '0' : '1'); } catch { /* ignore */ }
      return !v;
    });
  }

  // Only tiles near the viewport are in the DOM. The margin covers a pan between commits.
  const visible = useMemo(() => {
    if (size.w <= 0) return [] as Placement[];
    const halfW = size.w / 2 / cam.s;
    const halfH = size.h / 2 / cam.s;
    const mx = halfW * 0.6;
    const my = halfH * 0.6;
    return layout.placements.filter(p =>
      p.x + p.w >= cam.cx - halfW - mx && p.x <= cam.cx + halfW + mx
      && p.y + p.h >= cam.cy - halfH - my && p.y <= cam.cy + halfH + my);
  }, [layout.placements, cam, size.w, size.h]);

  const dpr = typeof window === 'undefined' ? 1 : Math.min(2, window.devicePixelRatio || 1);
  const hot = hotId ? layout.placements.find(p => p.id === hotId) : undefined;
  const hotTile = hotId ? tileById.get(hotId) : undefined;
  // The enlarged tile is kept inside the stage: its size is capped to the box, and it is nudged back in from any edge it
  // would cross. `shift` is in screen pixels; the tile's own transform wants layer units, so it is divided by the scale.
  let hotFactor = 1;
  let shift = { x: 0, y: 0 };
  let caption: { left: number; top: number; width: number } | null = null;
  if (hot && size.w > 0 && size.h > 0) {
    const baseW = hot.w * cam.s;
    const baseH = hot.h * cam.s;
    hotFactor = Math.min(MAX_POP, Math.max(1, ENLARGED_LONG_SIDE / Math.max(baseW, baseH)), size.w / baseW, size.h / baseH);
    hotFactor = Math.max(1, hotFactor);
    const w = baseW * hotFactor;
    const h = baseH * hotFactor;
    const cxs = size.w / 2 + (hot.x + hot.w / 2 - cam.cx) * cam.s;
    const cys = size.h / 2 + (hot.y + hot.h / 2 - cam.cy) * cam.s;
    const left = Math.min(Math.max(0, size.w - w), Math.max(0, cxs - w / 2));
    const top = Math.min(Math.max(0, size.h - h), Math.max(0, cys - h / 2));
    shift = hotFactor > 1 ? { x: left + w / 2 - cxs, y: top + h / 2 - cys } : { x: 0, y: 0 };
    // The caption is laid along the foot of the enlarged tile, in screen space so its text is never scaled.
    if (hotTile) {
      const width = Math.min(w, size.w);
      caption = { left: Math.min(size.w - width, Math.max(0, left)), top: Math.max(0, Math.min(size.h, top + h) - 74), width };
    }
  }

  const line = isNight ? 'rgba(248, 113, 113, 0.75)' : 'rgba(255, 255, 255, 0.95)';
  const btn = 'flex items-center justify-center w-8 h-8 rounded-full text-slate-100 bg-slate-950/70 ring-1 ring-inset ring-white/15 hover:bg-slate-800/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 transition-colors';

  return (
    <div ref={rootRef} className={isFull ? 'fixed inset-0 z-[60] flex flex-col gap-2 p-4 bg-slate-950' : 'space-y-2'}>
        <div className="flex items-center justify-end gap-1.5">
          <button type="button" className={`${btn} ${labels ? 'ring-accent-400 text-accent-300' : ''}`} onClick={toggleLabels}
            aria-pressed={labels} aria-label={t('mosaic.names')} title={t('mosaic.names')}>
            <Type className="w-4 h-4" />
          </button>
          <button type="button" className={btn} onClick={() => zoomAround(1 / 1.3, size.w / 2, size.h / 2, true)}
            aria-label={t('mosaic.zoomOut')} title={t('mosaic.zoomOut')}>
            <Minus className="w-4 h-4" />
          </button>
          <button type="button" className={btn} onClick={resetFit} aria-label={t('mosaic.fit')} title={t('mosaic.fit')}>
            <Focus className="w-4 h-4" />
          </button>
          <button type="button" className={btn} onClick={() => zoomAround(1.3, size.w / 2, size.h / 2, true)}
            aria-label={t('mosaic.zoomIn')} title={t('mosaic.zoomIn')}>
            <Plus className="w-4 h-4" />
          </button>
            <button type="button" className={btn} onClick={toggleFullscreen}
            aria-pressed={isFull}
            aria-label={isFull ? t('mosaic.exitFullscreen') : t('mosaic.fullscreen')}
            title={isFull ? t('mosaic.exitFullscreen') : t('mosaic.fullscreen')}>
            {isFull ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
          {shareFileBase && (
            <button type="button" className={btn} onClick={() => setSharing(true)}
              aria-label={t('mosaic.share.open')} title={t('mosaic.share.open')}>
              <Share2 className="w-4 h-4" />
            </button>
          )}
        </div>
    <div
      ref={stageRef}
      className={`mosaic-stage rounded-2xl ring-1 ring-inset ring-slate-700/60 ${isFull ? 'flex-1 min-h-0' : ''}`}
      style={{
        height: isFull ? undefined : 'clamp(420px, calc(100vh - 200px), 1200px)',
        '--mosaic-line': line,
      } as React.CSSProperties}
      role="group"
      aria-label={ariaLabel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onPointerLeave={() => { if (!drag.current?.moved) setHotId(null); }}
      onKeyDown={onKeyDown}
    >
      <div ref={layerRef} className="mosaic-layer" data-hovering={hotId !== null} style={{ width: layout.width, height: layout.height }}>
        {visible.map(p => {
          const tile = tileById.get(p.id);
          if (!tile) return null;
          const isHot = p.id === hotId;
          const longPx = Math.max(p.w, p.h) * cam.s * (isHot ? hotFactor : 1);
          const shortPx = Math.min(p.w, p.h) * cam.s;
          const src = shortPx < 4 ? undefined : tile.imageUrl(bucketFor(longPx * dpr));
          return (
            <a
              key={p.id}
              href={tile.href}
              className="mosaic-tile"
              data-hot={isHot}
              draggable={false}
              aria-label={tile.title}
              style={{
                left: p.x,
                top: p.y,
                width: p.w,
                height: p.h,
                transform: isHot && hotFactor > 1 ? `translate(${shift.x / cam.s}px, ${shift.y / cam.s}px) scale(${hotFactor})` : undefined,
              }}
              onClick={e => {
                if (suppressClick.current) { e.preventDefault(); return; }
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                // Leave full screen first, so the object opens in a normal window and not hidden behind this one.
                if (document.fullscreenElement) {
                  void document.exitFullscreen().catch(() => {}).then(() => onOpen(p.id));
                  return;
                }
                setWindowFull(false);
                onOpen(p.id);
              }}
              onFocus={() => setHotId(p.id)}
              onBlur={() => setHotId(null)}
            >
              {src && <img src={src} alt="" draggable={false} decoding="async" />}
              {labels && !isHot && shortPx >= 38 && <span className="mosaic-name">{tile.title}</span>}
            </a>
          );
        })}
      </div>

      {caption && hotTile && (
        <div
          className="absolute pointer-events-none px-3 pt-8 pb-3 text-white bg-gradient-to-t from-black/80 to-transparent"
          style={{ left: caption.left, top: caption.top, width: caption.width, height: 74 }}
        >
          <p className="text-sm font-semibold leading-tight truncate">{hotTile.title}</p>
          {hotTile.subtitle && <p className="text-xs text-slate-300 truncate">{hotTile.subtitle}</p>}
          {hotTile.detail && <p className="text-xs text-slate-300 truncate">{hotTile.detail}</p>}
        </div>
      )}
    </div>
      {sharing && shareFileBase && (
        <MosaicShareDialog tiles={tiles} shownAspect={aspect} labels={labels} fileBase={shareFileBase} onClose={() => setSharing(false)} />
      )}
    </div>
  );
}
