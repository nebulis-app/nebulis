import { useEffect, useRef, useState, memo } from 'react';
import { RotateCw, AlertCircle } from 'lucide-react';
import { parseFits, renderFitsThumbnail, type Colormap } from '../lib/fits';
import { fetchBinary } from '../lib/api/client';

interface FitsThumbnailProps {
  url: string;
  /** Pre-rendered JPEG from the server — skips the full FITS download when present. */
  thumbUrl?: string;
  colormap?: Colormap;
  stretch?: number;
  isDark: boolean;
  /** Max dimension for the rendered thumbnail (px). Default 256. */
  maxDim?: number;
}

/**
 * Lazy-loading FITS thumbnail. Fetches and renders the FITS file only when
 * the element scrolls into view (via IntersectionObserver).
 */
export const FitsThumbnail = memo(function FitsThumbnail({
  url,
  thumbUrl,
  colormap = 'gray',
  stretch = 0.5,
  isDark,
  maxDim = 256,
}: FitsThumbnailProps) {
  // All hooks must be declared before any conditional return (Rules of Hooks).
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  // Trigger fetch once the thumbnail enters the viewport. Skipped when the
  // server has already pre-rendered a JPEG (thumbUrl path below).
  useEffect(() => {
    if (thumbUrl) return;
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          observer.disconnect();
          setState('loading');
        }
      },
      { rootMargin: '200px' } // pre-load slightly before visible
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [thumbUrl]);

  // Fetch + render when state becomes 'loading'
  useEffect(() => {
    if (thumbUrl || state !== 'loading') return;
    const controller = new AbortController();

    fetchBinary(url, controller.signal)
      .then(buffer => {
        const { imageData, width, height } = parseFits(buffer);
        if (canvasRef.current) {
          renderFitsThumbnail(canvasRef.current, imageData, width, height, stretch, colormap, maxDim, window.devicePixelRatio || 1);
        }
        setState('done');
      })
      .catch(err => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err.message);
        setState('error');
      });

    return () => { controller.abort(); };
  }, [thumbUrl, state, url, stretch, colormap, maxDim]);

  // Re-fetch when colormap/stretch changes, but only if already loaded — don't
  // bypass IntersectionObserver on mount (which would cause all thumbnails to
  // start fetching simultaneously, exhausting the browser's connection limit).
  useEffect(() => {
    if (thumbUrl) return;
    setState(s => (s === 'idle' ? 'idle' : 'loading'));
  }, [thumbUrl, colormap, stretch]);

  // Fast path: server has already rendered a small JPEG — no need to download
  // the full FITS file or do any client-side pixel work.
  if (thumbUrl) {
    return (
      <img
        src={thumbUrl}
        alt=""
        loading="lazy"
        className="w-full h-full object-cover"
      />
    );
  }

  return (
    <div
      ref={containerRef}
      className="w-full h-full flex items-center justify-center overflow-hidden"
    >
      {state === 'idle' && (
        <div className={`w-full h-full ${isDark ? 'bg-slate-900' : 'bg-slate-100'}`} />
      )}

      {state === 'loading' && (
        <div className={`w-full h-full flex items-center justify-center ${isDark ? 'bg-slate-900' : 'bg-slate-100'}`}>
          <RotateCw className="w-4 h-4 animate-spin text-accent-500/50" />
        </div>
      )}

      {state === 'error' && (
        <div className={`w-full h-full flex flex-col items-center justify-center gap-1 ${isDark ? 'bg-slate-900' : 'bg-slate-100'}`}>
          <AlertCircle className={`w-4 h-4 ${isDark ? 'text-slate-600' : 'text-slate-400'}`} />
          <span className={`text-[10px] ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
            {error ?? 'Error'}
          </span>
        </div>
      )}

      {/* Canvas is always square (renderFitsThumbnail renders square+letterboxed),
          so w-full + aspect-square in the parent tile works correctly. */}
      <canvas
        ref={canvasRef}
        className={`w-full h-full transition-opacity ${state === 'done' ? 'opacity-100' : 'opacity-0 absolute'}`}
      />
    </div>
  );
});
