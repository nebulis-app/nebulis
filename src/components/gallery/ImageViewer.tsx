import { useCallback, useEffect, useRef, useState } from 'react';
import {
  X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Download, Image, Heart,
} from 'lucide-react';
import { getLibraryFileThumbnailUrl, type LibraryImage } from '../../lib/api/library';
import { useSwipeDownToClose } from '../../hooks/useSwipeDownToClose';

export interface ImageViewerProps {
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
  const areaRef = useRef<HTMLDivElement>(null);
  const fitImgRef = useRef<HTMLImageElement>(null);

  const image = images[index];

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

  const THUMB_WIN = 10;
  const start = Math.max(0, index - THUMB_WIN);
  const end = Math.min(images.length, index + THUMB_WIN + 1);

  // Swipe-down-to-close. Disabled while zoomed/panning so we don't fight the
  // user's pan gesture inside the scroll container.
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

        {/* Header */}
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
            <button onClick={() => navigate(-1)} disabled={index <= 0}
              className={`p-2 rounded-lg transition disabled:opacity-30 ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}>
              <ChevronLeft className="w-5 h-5" />
            </button>
            <span className={`text-sm font-medium tabular-nums px-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              {index + 1} / {images.length}
            </span>
            <button onClick={() => navigate(1)} disabled={index >= images.length - 1}
              className={`p-2 rounded-lg transition disabled:opacity-30 ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}>
              <ChevronRight className="w-5 h-5" />
            </button>

            <div className={`w-px h-5 mx-1 ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`} />

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

            <button onClick={() => onToggleFavorite(image)}
              className={`p-2 rounded-lg transition ${image.isFavorite ? 'text-rose-400 hover:text-rose-500' : isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'}`}>
              <Heart className={`w-4 h-4 ${image.isFavorite ? 'fill-current' : ''}`} />
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

        {/* Image area */}
        <div ref={areaRef} className={`flex-1 min-h-0 p-4 ${fit ? 'relative' : 'overflow-auto flex items-center justify-center'}`}>
          {fit ? (
            <div className="relative w-full h-full">
              <img ref={fitImgRef} src={image.downloadUrl} alt={image.name}
                className="absolute inset-0 w-full h-full object-contain rounded-xl" />
            </div>
          ) : (
            <div className="relative" style={{ width: `${zoom * 100}%`, flexShrink: 0 }}>
              <img src={image.downloadUrl} alt={image.name} className="rounded-xl w-full h-auto block" />
            </div>
          )}
        </div>

        {/* Thumbnail strip */}
        {images.length > 1 && (
          <div className={`flex-shrink-0 border-t p-3 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
            <div className="flex gap-2 overflow-x-auto pb-1 items-center">
              {start > 0 && (
                <span className={`flex-shrink-0 text-[10px] px-1.5 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                  +{start}
                </span>
              )}
              {images.slice(start, end).map((img, i) => {
                const idx = start + i;
                return (
                  <button key={img.path} onClick={() => { setIndex(idx); setZoom(1); setFit(true); }}
                    className={`flex-shrink-0 w-14 h-14 rounded-lg overflow-hidden border-2 ${
                      idx === index ? 'border-accent-500'
                        : isDark ? 'border-slate-800 hover:border-slate-600' : 'border-slate-200 hover:border-slate-300'
                    }`}>
                    <img src={getLibraryFileThumbnailUrl(img.path, 56, 56)} alt="" className="w-full h-full object-cover" loading="lazy" />
                  </button>
                );
              })}
              {end < images.length && (
                <span className={`flex-shrink-0 text-[10px] px-1.5 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                  +{images.length - end}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
