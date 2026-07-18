import { useEffect, useRef, useState } from 'react';
import { RotateCw, AlertCircle } from 'lucide-react';
import { parseFits, renderFitsToCanvas } from '../lib/fits';
import { fetchBinary } from '../lib/api/client';

interface FitsPreviewProps {
  url: string;
  isDark: boolean;
  /** Auto-stretch amount (0–1). Matches the FitsViewer default. */
  stretch?: number;
}

/**
 * Renders a FITS file to a canvas at its natural aspect ratio, sized to fill
 * its container width. Unlike FitsThumbnail (square + letterboxed for grids),
 * this is meant for a hero slot where the real image shape should show. It
 * loads immediately rather than lazily, since the hero is above the fold.
 */
export function FitsPreview({ url, isDark, stretch = 0.5 }: FitsPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'loading' | 'done' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    setError(null);

    fetchBinary(url, controller.signal)
      .then(buffer => {
        const fits = parseFits(buffer);
        if (canvasRef.current) {
          renderFitsToCanvas(canvasRef.current, fits, stretch, 'gray', window.devicePixelRatio || 1);
        }
        setState('done');
      })
      .catch(err => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err.message);
        setState('error');
      });

    return () => { controller.abort(); };
  }, [url, stretch]);

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

      <canvas
        ref={canvasRef}
        className={`w-full h-auto object-contain transition-opacity ${state === 'done' ? 'opacity-100' : 'opacity-0 absolute inset-0'}`}
      />
    </div>
  );
}
