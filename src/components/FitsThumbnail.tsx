import { useEffect, useRef, useState, memo } from 'react';
import { useQuery } from '@tanstack/react-query';
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
  const [inView, setInView] = useState(false);
  // The server thumbnail can 404/500 for an unparseable FITS. When that
  // happens, fall through to the client-side render path below instead of
  // showing a broken image.
  const [serverThumbFailed, setServerThumbFailed] = useState(false);
  const useServerThumb = !!thumbUrl && !serverThumbFailed;

  // Trigger fetch once the thumbnail enters the viewport. Skipped when the
  // server has already pre-rendered a JPEG (thumbUrl path below).
  useEffect(() => {
    if (useServerThumb) return;
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          observer.disconnect();
          setInView(true);
        }
      },
      { rootMargin: '200px' } // pre-load slightly before visible
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [useServerThumb]);

  // Fetch + parse the raw FITS binary once in view, cached by url so
  // navigating back to this frame (or a second thumbnail of the same
  // sub-frame elsewhere on the page) reuses it instead of downloading a
  // multi-megabyte file again. staleTime: Infinity because the bytes at a
  // given library URL never change.
  const fitsQuery = useQuery({
    queryKey: ['fits-binary', url],
    queryFn: async ({ signal }) => parseFits(await fetchBinary(url, signal)),
    enabled: !useServerThumb && inView,
    staleTime: Infinity,
    retry: false,
  });

  // Colormap/stretch are a display parameter of the same pixel data, not a
  // reason to re-fetch — this just redraws the canvas from whatever is
  // already cached above.
  useEffect(() => {
    const fits = fitsQuery.data;
    if (!fits || !canvasRef.current) return;
    renderFitsThumbnail(canvasRef.current, fits, stretch, colormap, maxDim, window.devicePixelRatio || 1);
  }, [fitsQuery.data, stretch, colormap, maxDim]);

  const state: 'idle' | 'loading' | 'done' | 'error' = !inView
    ? 'idle'
    : fitsQuery.isError
      ? 'error'
      : fitsQuery.data
        ? 'done'
        : 'loading';
  const error = fitsQuery.error instanceof Error ? fitsQuery.error.message : null;

  // Fast path: server has already rendered a small JPEG — no need to download
  // the full FITS file or do any client-side pixel work. On load failure, mark
  // it failed so the render below takes over the client-side decode path.
  if (useServerThumb) {
    return (
      <img
        src={thumbUrl}
        alt=""
        loading="lazy"
        className="w-full h-full object-cover"
        onError={() => setServerThumbFailed(true)}
      />
    );
  }

  return (
    <div
      ref={containerRef}
      // `relative` is load-bearing, not decoration. Until the canvas renders it
      // carries `opacity-0 absolute`, and without a positioned ancestor here it
      // resolves against whatever ancestor happens to be positioned, stretching
      // an invisible click target across that region. A tile whose FITS is
      // still loading (or failed) then swallowed clicks on unrelated controls,
      // including the section tabs.
      className="relative w-full h-full flex items-center justify-center overflow-hidden"
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
