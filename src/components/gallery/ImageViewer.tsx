import { useCallback, useEffect, useRef, useState } from 'react';
import {
  X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Download, Image, Heart, Share2, Loader2,
} from 'lucide-react';
import { getLibraryFileThumbnailUrl, type LibraryImage } from '../../lib/api/library';
import { useSwipeDownToClose } from '../../hooks/useSwipeDownToClose';

interface ImageViewerProps {
  images: LibraryImage[];
  initialIndex: number;
  onClose: () => void;
  onToggleFavorite: (img: LibraryImage) => void;
  isDark: boolean;
}

export function ImageViewer({
  images, initialIndex, onClose, onToggleFavorite, isDark,
}: ImageViewerProps) {
  const [index, setIndex] = useState(initialIndex);
  const [zoom, setZoom] = useState(1.0);
  const [fit, setFit] = useState(true);
  const [isPanning, setIsPanning] = useState(false);
  const panRef = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const fitImgRef = useRef<HTMLImageElement>(null);
  const thumbStripRef = useRef<HTMLDivElement>(null);
  const activeThumbRef = useRef<HTMLButtonElement>(null);
  // Refs so the wheel handler always sees current values without re-subscribing on every render
  const fitRef = useRef(fit);
  const zoomRef = useRef(zoom);
  fitRef.current = fit;
  zoomRef.current = zoom;

  const handlePanStart = (e: { clientX: number; clientY: number; currentTarget: HTMLDivElement }) => {
    if (fit) return;
    panRef.current = { x: e.clientX, y: e.clientY, sl: e.currentTarget.scrollLeft, st: e.currentTarget.scrollTop };
    setIsPanning(true);
  };
  const handlePanMove = (e: { clientX: number; clientY: number; currentTarget: HTMLDivElement }) => {
    if (!panRef.current) return;
    e.currentTarget.scrollLeft = panRef.current.sl - (e.clientX - panRef.current.x);
    e.currentTarget.scrollTop = panRef.current.st - (e.clientY - panRef.current.y);
  };
  const handlePanEnd = () => { panRef.current = null; setIsPanning(false); };

  const [sharing, setSharing] = useState(false);
  const image = images[index];

  const handleShare = async () => {
    const title = image.objectName || image.name;
    setSharing(true);
    try {
      const res = await fetch(image.downloadUrl);
      const blob = await res.blob();
      const file = new File([blob], image.name, { type: blob.type || 'image/jpeg' });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title });
        return;
      }
      const abs = new URL(image.downloadUrl, window.location.href).href;
      window.location.href = `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(abs)}`;
    } catch { /* cancelled or unsupported */ } finally {
      setSharing(false);
    }
  };

  const getFitZoom = useCallback(() => {
    if (!fitImgRef.current || !areaRef.current) return 1.0;
    const { naturalWidth: nW, naturalHeight: nH } = fitImgRef.current;
    if (!nW || !nH) return 1.0;
    const cW = areaRef.current.clientWidth - 32;
    const cH = areaRef.current.clientHeight - 32;
    if (cW <= 0 || cH <= 0) return 1.0;
    return (nW * Math.min(cW / nW, cH / nH)) / cW;
  }, []);

  const navigate = useCallback((dir: -1 | 1) => {
    setIndex(p => { const n = p + dir; return (n < 0 || n >= images.length) ? p : n; });
    setZoom(1); setFit(true);
  }, [images.length]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); navigate(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); navigate(1); }
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [navigate, onClose]);

  useEffect(() => { setFit(true); }, [index]);

  // Smooth zoom via scroll wheel or trackpad pinch.
  // Pinch (ctrlKey) zooms in any mode. Regular scroll zooms only in fit mode
  // (when zoomed, regular scroll pans the overflow container naturally).
  // Uses refs so rapid events accumulate instead of each one restarting from getFitZoom().
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const onWheel = (e: WheelEvent) => {
      const isPinch = e.ctrlKey;
      if (!isPinch && !fitRef.current) return; // let natural scroll pan when zoomed
      e.preventDefault();
      // Pinch sends small deltas; regular scroll sends large ones — different sensitivities
      const step = -e.deltaY * (isPinch ? 0.01 : 0.001);
      const base = fitRef.current ? getFitZoom() : zoomRef.current;
      if (fitRef.current) {
        fitRef.current = false;
        setFit(false);
      }
      const next = +(Math.max(0.1, Math.min(4, base + step)).toFixed(2));
      zoomRef.current = next;
      setZoom(next);
    };
    area.addEventListener('wheel', onWheel, { passive: false });
    return () => area.removeEventListener('wheel', onWheel);
  }, [getFitZoom]); // stable — no re-subscribe on every fit/zoom change

  // Scroll active thumbnail to center of strip whenever index changes
  useEffect(() => {
    const thumb = activeThumbRef.current;
    const strip = thumbStripRef.current;
    if (!thumb || !strip) return;
    strip.scrollTo({
      left: thumb.offsetLeft - strip.clientWidth / 2 + thumb.offsetWidth / 2,
      behavior: 'smooth',
    });
  }, [index]);

  const { handlers: swipeHandlers, dy, dragging } = useSwipeDownToClose(onClose, { disabled: !fit });
  const backdropOpacity = Math.max(0, 1 - dy / 400);


  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
      style={{ backgroundColor: `rgba(0, 0, 0, ${0.9 * backdropOpacity})` }}
    >
      <div
        {...swipeHandlers}
        className={`relative w-full max-w-6xl h-[95dvh] flex flex-col rounded-2xl touch-pan-y overscroll-contain ${isDark ? 'bg-slate-900' : 'bg-white'}`}
        style={{
          transform: dy ? `translateY(${dy}px)` : undefined,
          transition: dragging ? 'none' : 'transform 200ms ease-out',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >

        {/* Header — title/subtitle left, zoom + actions + close right */}
        <div className={`flex-shrink-0 flex items-center justify-between p-4 border-b ${isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
          <div className="flex items-center gap-3 min-w-0 mr-3">
            <Image className="w-5 h-5 text-accent-500 flex-shrink-0" />
            <div className="min-w-0">
              <span className={`font-medium text-sm truncate block ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                {image.objectName}
                {image.objectType && (
                  <span className={`ml-2 text-xs font-normal ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    {image.objectType}
                  </span>
                )}
              </span>
              <span className={`text-xs truncate block ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                {image.date !== 'unknown' ? `${image.date} · ` : ''}{image.name}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1 flex-shrink-0">
            {/* Zoom */}
            <button onClick={() => { if (!fit) setZoom(z => Math.max(0.1, +(z - 0.1).toFixed(2))); }}
              disabled={fit || zoom <= 0.1}
              className={`p-2 rounded-lg transition disabled:opacity-30 ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}>
              <ZoomOut className="w-4 h-4" />
            </button>
            <button onClick={() => setFit(true)}
              className={`px-2 py-1 rounded text-xs font-medium tabular-nums min-w-[3rem] text-center transition ${
                fit ? isDark ? 'text-accent-400 bg-accent-500/10' : 'text-accent-600 bg-accent-50'
                    : isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'
              }`}>
              {fit ? 'Fit' : `${Math.round(zoom * 100)}%`}
            </button>
            <button
              onClick={() => {
                if (fit) { setFit(false); setZoom(+(getFitZoom() + 0.1).toFixed(2)); }
                else setZoom(z => Math.min(4, +(z + 0.1).toFixed(2)));
              }}
              disabled={!fit && zoom >= 4}
              className={`p-2 rounded-lg transition disabled:opacity-30 ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}>
              <ZoomIn className="w-4 h-4" />
            </button>

            <div className={`w-px h-5 mx-1 ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`} />

            {/* Actions */}
            <button onClick={() => onToggleFavorite(image)}
              className={`p-2 rounded-lg transition ${image.isFavorite ? 'text-rose-400 hover:text-rose-500' : isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'}`}>
              <Heart className={`w-4 h-4 ${image.isFavorite ? 'fill-current' : ''}`} />
            </button>
            <button onClick={handleShare} disabled={sharing}
              className={`p-2 rounded-lg transition disabled:opacity-50 ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}>
              {sharing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Share2 className="w-4 h-4" />}
            </button>
            <a href={image.downloadUrl} download={image.name}
              className={`p-2 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}>
              <Download className="w-4 h-4" />
            </a>

            <div className={`w-px h-5 mx-1 ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`} />

            <button onClick={onClose}
              className={`p-2 rounded-lg transition ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}>
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Image area + full-height sidebar nav strips (fit mode only) */}
        <div className="relative flex-1 min-h-0">
          {index > 0 && (
            <button
              onClick={() => navigate(-1)}
              className="absolute left-0 top-0 h-full w-16 z-10 flex items-center justify-start pl-2 group hover:bg-black/5 transition-colors"
            >
              <div className="p-2.5 rounded-full bg-black/30 group-hover:bg-black/60 backdrop-blur-sm text-white shadow-lg transition-all opacity-50 group-hover:opacity-100">
                <ChevronLeft className="w-6 h-6" />
              </div>
            </button>
          )}

          <div
            ref={areaRef}
            className={`w-full h-full p-4 ${fit ? 'relative' : 'overflow-auto select-none'}`}
            style={!fit ? { cursor: isPanning ? 'grabbing' : 'grab' } : undefined}
            onMouseDown={handlePanStart}
            onMouseMove={handlePanMove}
            onMouseUp={handlePanEnd}
            onMouseLeave={handlePanEnd}
            onDoubleClick={() => { if (!fit) { setFit(true); setZoom(1); } }}
          >
            {fit ? (
              <div className="relative w-full h-full">
                <img ref={fitImgRef} src={image.downloadUrl} alt={image.name}
                  className="absolute inset-0 w-full h-full object-contain rounded-xl" />
              </div>
            ) : (
              // Inner wrapper must have an EXPLICIT width (not just min-width) so the scroll
              // container's scrollWidth grows when zoomed. min-width alone stays at container
              // width in the flex layout engine and the image just visually overflows without
              // making the scrollable area wider.
              //
              // Image uses min(zoom*100%, 100%) so it always equals zoom × container-width:
              //   zoom ≤ 1 → inner=100%, image=zoom*100% of that = zoom*W  ✓
              //   zoom > 1 → inner=zoom*100%, image=100% of that = zoom*W  ✓
              <div style={{ width: `max(100%, ${zoom * 100}%)`, minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <img
                  src={image.downloadUrl}
                  alt={image.name}
                  className="rounded-xl block"
                  style={{ width: `min(${zoom * 100}%, 100%)`, height: 'auto' }}
                  draggable={false}
                />
              </div>
            )}
          </div>

          {index < images.length - 1 && (
            <button
              onClick={() => navigate(1)}
              className="absolute right-0 top-0 h-full w-16 z-10 flex items-center justify-end pr-2 group hover:bg-black/5 transition-colors"
            >
              <div className="p-2.5 rounded-full bg-black/30 group-hover:bg-black/60 backdrop-blur-sm text-white shadow-lg transition-all opacity-50 group-hover:opacity-100">
                <ChevronRight className="w-6 h-6" />
              </div>
            </button>
          )}
        </div>

        {/* Thumbnail strip with counter */}
        {images.length > 1 && (
          <div className={`flex-shrink-0 border-t ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
            <div className={`text-center pt-2 pb-0.5 text-xs tabular-nums ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {index + 1} / {images.length}
            </div>
            <div ref={thumbStripRef} className="flex gap-2 overflow-x-auto px-3 py-2 items-center">
              {images.map((img, idx) => (
                <button
                  key={img.path}
                  ref={idx === index ? activeThumbRef : undefined}
                  onClick={() => { setIndex(idx); setZoom(1); setFit(true); }}
                  className={`flex-shrink-0 w-14 h-14 rounded-lg overflow-hidden border-2 transition-all ${
                    idx === index
                      ? 'border-accent-500 scale-105'
                      : isDark ? 'border-slate-800 hover:border-slate-600' : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <img src={getLibraryFileThumbnailUrl(img.path, 56, 56)} alt="" className="w-full h-full object-cover" loading="lazy" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
