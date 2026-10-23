/**
 * Crop-box framing of one image.
 *
 * The whole picture is shown with a box over it. Drag the box to move it, drag
 * a corner to resize it, and nothing is applied until the caller saves. The box
 * keeps the image's own aspect ratio, or that ratio turned on its side for a
 * portrait frame, which is what the server renders for the object (see
 * server/lib/library/galleryCrop.ts): a window of 1/zoom of the largest box of
 * that shape that fits the image, centred on (x, y).
 */
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Minus, Plus, RotateCcw, RectangleVertical, RectangleHorizontal } from 'lucide-react';
import type { GalleryCrop } from '../types';

const MAX_ZOOM = 8;
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** Window size as fractions of the image at zoom 1 (mirrors baseWindow on the
 *  server). `aspect` is the image's width / height. */
function baseWindow(aspect: number, rotated: boolean, frameAspect?: number) {
  const a = frameAspect ?? (rotated ? 1 / aspect : aspect);
  return a >= aspect ? { w: 1, h: aspect / a } : { w: a / aspect, h: 1 };
}

/** Keep the window inside the image: the centre can't get closer than half a
 *  window to any edge. */
function constrain(c: GalleryCrop, aspect: number, frameAspect?: number): GalleryCrop {
  const b = baseWindow(aspect, !!c.rotated, frameAspect);
  const hx = b.w / (2 * c.zoom);
  const hy = b.h / (2 * c.zoom);
  const out: GalleryCrop = { zoom: c.zoom, x: clamp(c.x, hx, 1 - hx), y: clamp(c.y, hy, 1 - hy) };
  if (c.rotated) out.rotated = true;
  return out;
}

type Corner = { sx: 1 | -1; sy: 1 | -1 };
type Gesture =
  | { kind: 'move'; px: number; py: number; start: GalleryCrop }
  | { kind: 'resize'; corner: Corner; anchorX: number; anchorY: number };

const CORNERS: (Corner & { cls: string; cursor: string })[] = [
  { sx: -1, sy: -1, cls: '-left-2 -top-2', cursor: 'nwse-resize' },
  { sx: 1, sy: -1, cls: '-right-2 -top-2', cursor: 'nesw-resize' },
  { sx: -1, sy: 1, cls: '-left-2 -bottom-2', cursor: 'nesw-resize' },
  { sx: 1, sy: 1, cls: '-right-2 -bottom-2', cursor: 'nwse-resize' },
];

export function ImageFramer({
  src,
  crop,
  onChange,
  isDark,
  frameAspect,
  onAspect,
  hint,
}: {
  src: string;
  /** null = whole image. */
  crop: GalleryCrop | null;
  onChange: (crop: GalleryCrop | null) => void;
  isDark: boolean;
  /** Fix the box to this width / height (a wall tile's shape) instead of the
   *  image's own. The portrait toggle is hidden then. */
  frameAspect?: number;
  /** Reports the image's natural width / height once it has loaded. */
  onAspect?: (aspect: number) => void;
  /** Replaces the default help line under the controls. */
  hint?: string;
}) {
  const { t } = useTranslation('library');
  const [aspect, setAspect] = useState(1.5);
  const [failed, setFailed] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);

  const c = crop ?? { x: 0.5, y: 0.5, zoom: 1 };
  const rotated = !!c.rotated;
  const base = baseWindow(aspect, rotated, frameAspect);
  const boxW = base.w / c.zoom;
  const boxH = base.h / c.zoom;

  const emit = (next: GalleryCrop) => {
    const fixed = constrain(next, aspect, frameAspect);
    // Back to whole-image framing is stored as "no crop". A rotated frame at
    // zoom 1 is still a crop (a strip), so it is kept.
    // A fixed-shape frame can still slide along the long edge at zoom 1.
    onChange(fixed.zoom <= 1.01 && !fixed.rotated && frameAspect == null ? null : fixed);
  };

  const toggleRotated = () => {
    const next: GalleryCrop = { x: c.x, y: c.y, zoom: c.zoom };
    if (!rotated) next.rotated = true;
    emit(next);
  };

  const point = (e: React.PointerEvent) => {
    const stage = stageRef.current;
    if (!stage) return null;
    const r = stage.getBoundingClientRect();
    return { fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height, w: r.width, h: r.height };
  };

  const startMove = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { kind: 'move', px: e.clientX, py: e.clientY, start: c };
  };
  const startResize = (corner: Corner) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    // The corner opposite the one being dragged stays where it is.
    gesture.current = {
      kind: 'resize',
      corner,
      anchorX: c.x - corner.sx * boxW / 2,
      anchorY: c.y - corner.sy * boxH / 2,
    };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const p = point(e);
    if (!p) return;
    if (g.kind === 'move') {
      emit({
        ...g.start,
        x: g.start.x + (e.clientX - g.px) / p.w,
        y: g.start.y + (e.clientY - g.py) / p.h,
      });
      return;
    }
    const { corner, anchorX, anchorY } = g;
    // One scale (1/zoom) drives both sides so the box keeps its shape.
    const room = Math.min(
      (corner.sx > 0 ? 1 - anchorX : anchorX) / base.w,
      (corner.sy > 0 ? 1 - anchorY : anchorY) / base.h,
    );
    const wanted = Math.max(Math.abs(p.fx - anchorX) / base.w, Math.abs(p.fy - anchorY) / base.h);
    const s = clamp(wanted, 1 / MAX_ZOOM, Math.min(1, room));
    emit({
      zoom: 1 / s,
      x: anchorX + corner.sx * base.w * s / 2,
      y: anchorY + corner.sy * base.h * s / 2,
      ...(rotated ? { rotated: true } : {}),
    });
  };
  const endGesture = () => { gesture.current = null; };

  const setZoom = (zoom: number) => emit({ ...c, zoom: clamp(zoom, 1, MAX_ZOOM) });
  const canMove = c.zoom > 1 || rotated || frameAspect != null;

  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const btn = `p-1.5 rounded-lg transition disabled:opacity-30 ${isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`;

  if (failed) {
    return <p className={`text-sm ${muted}`}>{t('galleryImageModal.framingUnavailable')}</p>;
  }

  return (
    <div className="space-y-4">
      <div
        ref={stageRef}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onWheel={(e) => setZoom(c.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))}
        className="relative mx-auto w-full overflow-hidden rounded-xl bg-black touch-none select-none"
        style={{ aspectRatio: String(aspect), maxHeight: '58vh', maxWidth: `calc(58vh * ${aspect})` }}
      >
        <img
          src={src}
          alt=""
          draggable={false}
          onLoad={(e) => {
            const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
            if (w && h) { setAspect(w / h); onAspect?.(w / h); }
          }}
          onError={() => setFailed(true)}
          className="absolute inset-0 w-full h-full"
        />
        <div
          onPointerDown={startMove}
          className={`absolute border-2 border-accent-400 ${canMove ? 'cursor-move' : ''}`}
          style={{
            left: `${(c.x - boxW / 2) * 100}%`,
            top: `${(c.y - boxH / 2) * 100}%`,
            width: `${boxW * 100}%`,
            height: `${boxH * 100}%`,
            // Dims everything outside the box; the stage clips the overflow.
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.6)',
          }}
        >
          {CORNERS.map((k) => (
            <span
              key={`${k.sx}${k.sy}`}
              onPointerDown={startResize(k)}
              className={`absolute w-4 h-4 rounded-sm bg-accent-400 border border-black/40 ${k.cls}`}
              style={{ cursor: k.cursor }}
            />
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 max-w-md mx-auto">
        <button type="button" onClick={() => setZoom(c.zoom / 1.25)} aria-label={t('galleryImageModal.zoomOut')} className={btn}>
          <Minus className="w-4 h-4" />
        </button>
        <input
          type="range"
          min={1}
          max={MAX_ZOOM}
          step={0.05}
          value={c.zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          aria-label={t('galleryImageModal.zoom')}
          className="flex-1 accent-accent-500"
        />
        <button type="button" onClick={() => setZoom(c.zoom * 1.25)} aria-label={t('galleryImageModal.zoomIn')} className={btn}>
          <Plus className="w-4 h-4" />
        </button>
        <span className={`w-12 text-right text-xs tabular-nums ${muted}`}>{c.zoom.toFixed(1)}×</span>
        {frameAspect == null && (
          <button
            type="button"
            onClick={toggleRotated}
            title={t(rotated ? 'galleryImageModal.frameLandscape' : 'galleryImageModal.framePortrait')}
            aria-label={t(rotated ? 'galleryImageModal.frameLandscape' : 'galleryImageModal.framePortrait')}
            className={btn}
          >
            {/* Shows the shape you will get by pressing it. */}
            {rotated ? <RectangleHorizontal className="w-4 h-4" /> : <RectangleVertical className="w-4 h-4" />}
          </button>
        )}
        <button
          type="button"
          onClick={() => onChange(null)}
          disabled={!crop}
          title={t('galleryImageModal.resetFraming')}
          aria-label={t('galleryImageModal.resetFraming')}
          className={btn}
        >
          <RotateCcw className="w-4 h-4" />
        </button>
      </div>
      <p className={`text-xs text-center ${muted}`}>{hint ?? t('galleryImageModal.framingHint')}</p>
    </div>
  );
}
