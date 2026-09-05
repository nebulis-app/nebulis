import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RotateCw, AlertCircle } from 'lucide-react';
import { parseFits, renderFitsToCanvas } from '../lib/fits';
import { fetchBinary } from '../lib/api/client';

interface FitsPreviewProps {
  url: string;
  isDark: boolean;
  /** Auto-stretch amount (0–1). Matches the FitsViewer default. */
  stretch?: number;
  /** Natural pixel dimensions, once the FITS has been parsed. Lets the hero
   *  slot size its column to the frame's orientation. */
  onNaturalSize?: (width: number, height: number) => void;
  /** Tailwind max-height for the canvas, so the caller controls the cap. */
  maxHeightClass?: string;
}

/**
 * Renders a FITS file to a canvas at its natural aspect ratio, sized to fill
 * its container width. Unlike FitsThumbnail (square + letterboxed for grids),
 * this is meant for a hero slot where the real image shape should show. It
 * loads immediately rather than lazily, since the hero is above the fold.
 */
export function FitsPreview({
  url,
  isDark,
  stretch = 0.5,
  onNaturalSize,
  maxHeightClass = 'max-h-[420px]',
}: FitsPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Held in a ref so a caller passing an inline arrow doesn't re-run the effect.
  const onNaturalSizeRef = useRef(onNaturalSize);
  onNaturalSizeRef.current = onNaturalSize;

  // Cached by url (same key namespace as FitsThumbnail/FitsViewer) so
  // navigating away and back to this observation doesn't re-download the
  // hero frame. staleTime: Infinity because the bytes at a given library URL
  // never change.
  const fitsQuery = useQuery({
    queryKey: ['fits-binary', url],
    queryFn: async ({ signal }) => parseFits(await fetchBinary(url, signal)),
    staleTime: Infinity,
    retry: false,
  });

  // Stretch is a display parameter of the same pixel data, not a reason to
  // re-fetch — this just redraws the canvas from whatever is already cached.
  useEffect(() => {
    const fits = fitsQuery.data;
    if (!fits || !canvasRef.current) return;
    renderFitsToCanvas(canvasRef.current, fits, stretch, 'gray', window.devicePixelRatio || 1);
    const { width, height } = canvasRef.current;
    if (width > 0 && height > 0) onNaturalSizeRef.current?.(width, height);
  }, [fitsQuery.data, stretch]);

  const state: 'loading' | 'done' | 'error' = fitsQuery.isError ? 'error' : fitsQuery.data ? 'done' : 'loading';
  const error = fitsQuery.error instanceof Error ? fitsQuery.error.message : null;

  return (
    <div className="relative w-full">
      {state === 'loading' && (
        <div className={`aspect-video w-full flex items-center justify-center ${isDark ? 'bg-slate-900' : 'bg-slate-100'}`}>
          <RotateCw className="w-5 h-5 animate-spin text-accent-500/60" />
        </div>
      )}

      {state === 'error' && (
        <div className={`aspect-video w-full flex flex-col items-center justify-center gap-1.5 ${isDark ? 'bg-slate-900' : 'bg-slate-100'}`}>
          <AlertCircle className={`w-5 h-5 ${isDark ? 'text-slate-600' : 'text-slate-400'}`} />
          <span className={`text-xs ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
            {error ?? 'Could not render FITS'}
          </span>
        </div>
      )}

      {/* Height is capped for the same reason the hero <img> is: an uncapped
          frame in a wide column renders tall enough to push the rest of the
          session below the fold. The cap itself comes from the caller, which
          knows the frame's orientation. See heroSizing in ObservationDetail. */}
      <canvas
        ref={canvasRef}
        className={`block mx-auto w-auto max-w-full ${maxHeightClass} transition-opacity ${state === 'done' ? 'opacity-100' : 'opacity-0 absolute inset-0'}`}
      />
    </div>
  );
}
