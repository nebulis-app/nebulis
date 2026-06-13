import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Columns, GripVertical, Layers, ImageOff, RotateCcw } from 'lucide-react';
import { getLibrarySessions } from '../lib/api/library';
import { useTheme } from '../hooks/useTheme';
import { Modal } from './ui/Modal';

interface Props {
  objectId: string;
  onClose: () => void;
}

export function CompareSessionsModal({ objectId, onClose }: Props) {
  const { isDark } = useTheme();
  const [mode, setMode] = useState<'side-by-side' | 'slider'>('side-by-side');
  const [leftUrl, setLeftUrl] = useState<string | null>(null);
  const [rightUrl, setRightUrl] = useState<string | null>(null);
  const [sliderPos, setSliderPos] = useState(50);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDraggingPan, setIsDraggingPan] = useState(false);

  // Mutable refs so event handlers never capture stale state
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const sliderRef = useRef(50);
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    type: 'pan' | 'slider';
    startX: number;
    startY: number;
    startPanX: number;
    startPanY: number;
    startSlider: number;
    viewW: number;
  } | null>(null);

  const { data: sessions } = useQuery({
    queryKey: ['library-sessions', objectId],
    queryFn: () => getLibrarySessions(objectId),
  });

  // Auto-select oldest → left, newest → right
  const effectiveLeft = leftUrl ?? sessions?.[sessions.length - 1]?.thumbnailUrl ?? '';
  const effectiveRight = rightUrl ?? sessions?.[0]?.thumbnailUrl ?? '';

  const sessionOptions = (sessions ?? []).map(s => ({
    value: s.thumbnailUrl,
    label:
      s.date !== 'unknown'
        ? new Date(s.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : s.id,
    stackedCount: s.stackedCount,
  }));

  const leftLabel = sessionOptions.find(s => s.value === effectiveLeft)?.label ?? '';
  const rightLabel = sessionOptions.find(s => s.value === effectiveRight)?.label ?? '';

  const applyView = (z: number, p: { x: number; y: number }) => {
    zoomRef.current = z;
    panRef.current = p;
    setZoom(z);
    setPan(p);
  };

  const resetView = useCallback(() => {
    applyView(1, { x: 0, y: 0 });
  }, []);

  // Reset zoom/pan when mode changes
  useEffect(() => { resetView(); }, [mode, resetView]);

  // Wheel zoom — must use addEventListener (passive: false required for preventDefault)
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = el!.getBoundingClientRect();
      const W = rect.width;
      const H = rect.height;
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const prevZoom = zoomRef.current;
      const newZoom = Math.max(1, Math.min(10, prevZoom * factor));
      if (newZoom === prevZoom) return;

      const ratio = newZoom / prevZoom;
      const prevPan = panRef.current;

      // Keep the point under the cursor fixed: newPan = (cursor - center) * (1 - ratio) + prevPan * ratio
      let newX = (cx - W / 2) * (1 - ratio) + prevPan.x * ratio;
      let newY = (cy - H / 2) * (1 - ratio) + prevPan.y * ratio;

      if (newZoom === 1) {
        newX = 0;
        newY = 0;
      } else {
        const maxX = (W / 2) * (newZoom - 1);
        const maxY = (H / 2) * (newZoom - 1);
        newX = Math.max(-maxX, Math.min(maxX, newX));
        newY = Math.max(-maxY, Math.min(maxY, newY));
      }

      zoomRef.current = newZoom;
      panRef.current = { x: newX, y: newY };
      setZoom(newZoom);
      setPan({ x: newX, y: newY });
    }

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []); // stable refs mean no stale closure; setZoom/setPan are stable dispatcher refs

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;

    // In slider mode, check if near the divider handle
    if (mode === 'slider') {
      const dividerX = (sliderRef.current / 100) * rect.width;
      if (Math.abs(x - dividerX) < 28) {
        dragRef.current = {
          type: 'slider',
          startX: e.clientX, startY: e.clientY,
          startPanX: 0, startPanY: 0,
          startSlider: sliderRef.current,
          viewW: rect.width,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
    }

    dragRef.current = {
      type: 'pan',
      startX: e.clientX, startY: e.clientY,
      startPanX: panRef.current.x, startPanY: panRef.current.y,
      startSlider: sliderRef.current,
      viewW: rect.width,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDraggingPan(true);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;

    if (d.type === 'slider') {
      const newPos = Math.max(5, Math.min(95, d.startSlider + ((e.clientX - d.startX) / d.viewW) * 100));
      sliderRef.current = newPos;
      setSliderPos(newPos);
    } else {
      if (zoomRef.current <= 1) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const maxX = (rect.width / 2) * (zoomRef.current - 1);
      const maxY = (rect.height / 2) * (zoomRef.current - 1);
      const newPan = {
        x: Math.max(-maxX, Math.min(maxX, d.startPanX + (e.clientX - d.startX))),
        y: Math.max(-maxY, Math.min(maxY, d.startPanY + (e.clientY - d.startY))),
      };
      panRef.current = newPan;
      setPan(newPan);
    }
  }

  function onPointerUp() {
    dragRef.current = null;
    setIsDraggingPan(false);
  }

  const transformStyle = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;

  const cursor = isDraggingPan
    ? 'grabbing'
    : zoom > 1
    ? 'grab'
    : mode === 'slider'
    ? 'ew-resize'
    : 'default';

  const selectClass = `px-2.5 py-1.5 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-accent-500/40 ${
    isDark ? 'bg-slate-800 border-slate-700 text-slate-200' : 'bg-slate-800 border-slate-700 text-slate-200'
  }`;

  const hasImages = !!effectiveLeft && !!effectiveRight;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Compare Sessions"
      className="flex flex-col w-full max-w-7xl h-full max-h-[90vh] rounded-2xl overflow-hidden shadow-2xl ring-1 ring-white/10 bg-black"
    >
      {/* ── Header ──────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-slate-800 bg-slate-950 shrink-0">
        {/* Session selectors */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="w-5 h-5 rounded-full bg-accent-500 flex items-center justify-center text-white text-[10px] font-bold shrink-0">
            1
          </span>
          <select
            value={effectiveLeft}
            onChange={e => setLeftUrl(e.target.value)}
            className={`flex-1 min-w-0 ${selectClass}`}
          >
            {sessionOptions.map(s => (
              <option key={`l-${s.value}`} value={s.value}>
                {s.label} ({s.stackedCount} stacked)
              </option>
            ))}
          </select>

          <span className="text-slate-600 text-xs shrink-0 hidden sm:block">vs</span>

          <span className="w-5 h-5 rounded-full bg-violet-500 flex items-center justify-center text-white text-[10px] font-bold shrink-0">
            2
          </span>
          <select
            value={effectiveRight}
            onChange={e => setRightUrl(e.target.value)}
            className={`flex-1 min-w-0 ${selectClass}`}
          >
            {sessionOptions.map(s => (
              <option key={`r-${s.value}`} value={s.value}>
                {s.label} ({s.stackedCount} stacked)
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* Mode toggle */}
          <div className="flex rounded-lg overflow-hidden border border-slate-700">
            <button
              onClick={() => setMode('side-by-side')}
              className={`px-3 py-1.5 text-xs font-medium transition ${
                mode === 'side-by-side'
                  ? 'bg-accent-500/20 text-accent-400'
                  : 'bg-slate-900 text-slate-400 hover:bg-slate-800'
              }`}
            >
              <Columns className="w-3 h-3 inline mr-1" />
              Side by Side
            </button>
            <button
              onClick={() => setMode('slider')}
              className={`px-3 py-1.5 text-xs font-medium transition ${
                mode === 'slider'
                  ? 'bg-accent-500/20 text-accent-400'
                  : 'bg-slate-900 text-slate-400 hover:bg-slate-800'
              }`}
            >
              <GripVertical className="w-3 h-3 inline mr-1" />
              Slider
            </button>
          </div>

          {/* Reset zoom — shown only when zoomed */}
          {zoom > 1 && (
            <button
              onClick={resetView}
              title="Reset zoom"
              className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 transition"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
          )}

          <button
            onClick={onClose}
            title="Close (Esc)"
            className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Zoom level badge — floated over image area */}
      {zoom > 1 && (
        <div className="absolute top-14 right-4 z-20 pointer-events-none">
          <span className="px-2.5 py-1 rounded-full bg-black/80 text-white text-xs font-mono font-semibold backdrop-blur-sm border border-white/10">
            {zoom.toFixed(1)}×
          </span>
        </div>
      )}

      {/* ── Comparison area ─────────────────────────────────── */}
      <div
        ref={viewportRef}
        className="flex-1 min-h-0 select-none overflow-hidden"
        style={{ cursor, touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {!hasImages ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center space-y-3">
              <Layers className="w-10 h-10 mx-auto opacity-20 text-white" />
              <p className="text-slate-500 text-sm">Select two sessions above to compare</p>
            </div>
          </div>
        ) : mode === 'side-by-side' ? (
          /* ── Side by side ── */
          <div className="flex h-full">
            <SideBySidePanel
              src={effectiveLeft}
              alt="Session 1"
              label={leftLabel}
              badge={1}
              transform={transformStyle}
            />
            <div className="w-px bg-slate-800 shrink-0" />
            <SideBySidePanel
              src={effectiveRight}
              alt="Session 2"
              label={rightLabel}
              badge={2}
              transform={transformStyle}
            />
          </div>
        ) : (
          /* ── Slider ── */
          <div className="relative h-full">
            {/* Right image — fully visible behind the divider */}
            <div
              className="absolute inset-0"
              style={{ transform: transformStyle, transformOrigin: 'center center', willChange: 'transform' }}
            >
              <img
                src={effectiveRight}
                alt="Session 2"
                className="w-full h-full object-contain"
                draggable={false}
              />
            </div>

            {/* Left image — clipped at viewport level so the divider stays at sliderPos% of screen */}
            <div
              className="absolute inset-0"
              style={{ clipPath: `inset(0 ${100 - sliderPos}% 0 0)` }}
            >
              <div
                className="absolute inset-0"
                style={{ transform: transformStyle, transformOrigin: 'center center', willChange: 'transform' }}
              >
                <img
                  src={effectiveLeft}
                  alt="Session 1"
                  className="w-full h-full object-contain"
                  draggable={false}
                />
              </div>
            </div>

            {/* Divider line */}
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-white/60 pointer-events-none shadow-lg"
              style={{ left: `${sliderPos}%`, transform: 'translateX(-50%)' }}
            />

            {/* Handle */}
            <div
              className="absolute top-1/2 pointer-events-none"
              style={{ left: `${sliderPos}%`, transform: 'translate(-50%, -50%)' }}
            >
              <div className="w-10 h-10 rounded-full bg-accent-500 flex items-center justify-center shadow-xl ring-2 ring-white/20">
                <GripVertical className="w-4 h-4 text-white" />
              </div>
            </div>

            {/* Corner session labels */}
            <div className="absolute top-3 left-3 pointer-events-none">
              <span className="px-2 py-0.5 rounded-md bg-black/70 text-white text-xs font-medium backdrop-blur-sm">
                {leftLabel || '1'}
              </span>
            </div>
            <div className="absolute top-3 right-3 pointer-events-none">
              <span className="px-2 py-0.5 rounded-md bg-black/70 text-white text-xs font-medium backdrop-blur-sm">
                {rightLabel || '2'}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ── Footer hint ─────────────────────────────────────── */}
      <div className="flex items-center justify-center gap-4 px-4 py-1.5 text-xs text-slate-600 border-t border-slate-900 bg-slate-950 shrink-0">
        <span>Scroll to zoom</span>
        {zoom > 1 && <span>Drag to pan</span>}
        {mode === 'slider' && <span>Drag divider to compare</span>}
      </div>
    </Modal>
  );
}

function SideBySidePanel({
  src,
  alt,
  label,
  badge,
  transform,
}: {
  src: string;
  alt: string;
  label: string;
  badge: 1 | 2;
  transform: string;
}) {
  const [error, setError] = useState(false);
  return (
    <div className="flex-1 min-w-0 relative overflow-hidden bg-black">
      {/* Session label */}
      <div className="absolute top-3 left-3 z-10 pointer-events-none flex items-center gap-1.5">
        <span
          className={`w-5 h-5 rounded-full flex items-center justify-center text-white text-[10px] font-bold shrink-0 ${
            badge === 1 ? 'bg-accent-500' : 'bg-violet-500'
          }`}
        >
          {badge}
        </span>
        {label && (
          <span className="px-2 py-0.5 rounded-md bg-black/70 text-white text-xs font-medium backdrop-blur-sm">
            {label}
          </span>
        )}
      </div>

      {error ? (
        <div className="w-full h-full flex flex-col items-center justify-center text-slate-600">
          <ImageOff className="w-8 h-8 mb-2" />
          <span className="text-sm">Failed to load</span>
          <span className="text-xs opacity-60 mt-1">Close and reopen to try again.</span>
        </div>
      ) : (
        <div
          className="w-full h-full"
          style={{ transform, transformOrigin: 'center center', willChange: 'transform' }}
        >
          <img
            src={src}
            alt={alt}
            className="w-full h-full object-contain"
            draggable={false}
            onError={() => setError(true)}
          />
        </div>
      )}
    </div>
  );
}
