/**
 * Share Map modal, the Map-view counterpart to CalendarShareModal.
 *
 * Unlike the calendar and list cards, there's no data model to redraw here —
 * "share the map" means the tiles and site markers as the user is currently
 * viewing them (pan/zoom included; an open popup is closed first, since it
 * has nowhere to go in a hand-composited capture). That image is built by the
 * map component itself (see ObservationsWorldMap's captureImage, which owns
 * the tile-CORS and marker-geometry details) and handed to this modal as a
 * ready canvas.
 *
 * Offers Print and Share/Save; there's no "Copy as text" because an image
 * has no text form.
 */
import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Download, Loader2, Printer, RotateCw, Share2 } from 'lucide-react';

interface MapShareModalProps {
  /** Captures the current map view. Rejects if the map isn't ready or the
   *  browser can't read the tiles back (a tainted canvas). */
  onCapture: () => Promise<HTMLCanvasElement>;
  onClose: () => void;
}

function canShareFiles(files: File[]): boolean {
  return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files });
}

type Status = 'capturing' | 'ready' | 'error';

export function MapShareModal({ onCapture, onClose }: MapShareModalProps) {
  const [status, setStatus] = useState<Status>('capturing');
  const [attempt, setAttempt] = useState(0);
  const canvasHolderRef = useRef<HTMLDivElement | null>(null);
  const capturedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [busy, setBusy] = useState(false);
  // Web Share support is a static browser capability, not something that
  // changes across this modal's lifetime — a one-time lazy check, not
  // something to resynchronize from an effect.
  const [shareSupported] = useState(() =>
    canShareFiles([new File([new Blob()], 'observation-map.png', { type: 'image/png' })]));

  useEffect(() => {
    let cancelled = false;
    onCapture()
      .then(canvas => {
        if (cancelled) return;
        capturedCanvasRef.current = canvas;
        canvas.className = 'rounded-xl shadow-2xl max-w-full h-auto block';
        canvas.setAttribute('aria-label', 'Observation map preview');
        const holder = canvasHolderRef.current;
        if (holder) {
          holder.replaceChildren(canvas);
        }
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => { cancelled = true; };
    // `attempt` exists only to let Retry re-run this effect; the click
    // handler itself resets `status` to 'capturing' before bumping it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toBlob = (canvas: HTMLCanvasElement): Promise<Blob | null> =>
    new Promise(resolve => canvas.toBlob(resolve, 'image/png'));

  const handlePrint = () => {
    const canvas = capturedCanvasRef.current;
    if (!canvas) return;
    let dataUrl: string;
    try {
      dataUrl = canvas.toDataURL('image/png');
    } catch {
      // A tainted canvas (a tile CORS hiccup despite the tile layer's
      // crossOrigin setting) throws here on readback rather than during the
      // earlier capture, since drawImage itself doesn't fail for a
      // cross-origin source — only reading the pixels back does.
      setStatus('error');
      return;
    }
    const win = window.open('', '_blank');
    if (!win) { void handleShareImage(); return; }
    win.document.title = 'Observation map';
    const style = win.document.createElement('style');
    style.textContent = '@page{margin:12mm}html,body{margin:0;background:#0F1426}img{display:block;width:100%;height:auto}';
    win.document.head.appendChild(style);
    const img = win.document.createElement('img');
    img.alt = 'Observation map';
    img.onload = () => { win.focus(); win.print(); };
    img.src = dataUrl;
    win.document.body.appendChild(img);
  };

  const handleShareImage = async () => {
    const canvas = capturedCanvasRef.current;
    if (!canvas) return;
    setBusy(true);
    try {
      const blob = await toBlob(canvas);
      if (!blob) { setStatus('error'); return; }
      const file = new File([blob], 'observation-map.png', { type: 'image/png' });
      if (canShareFiles([file])) {
        try {
          await navigator.share({ files: [file], title: 'Observation map' });
          return;
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return;
        }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'observation-map.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="relative rounded-2xl shadow-2xl max-w-3xl w-full max-h-[92vh] overflow-hidden flex flex-col bg-slate-900 text-slate-100"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-slate-700/40">
          <h2 className="text-lg font-semibold">Share Map</h2>
          <button onClick={onClose} className="text-sm px-3 py-1.5 rounded-lg hover:bg-white/10 transition">
            Done
          </button>
        </div>

        <div className="overflow-auto p-5 flex items-center justify-center bg-slate-950/40 min-h-[240px]">
          {status === 'capturing' && (
            <div className="flex flex-col items-center gap-3 text-slate-400 py-10">
              <Loader2 className="w-6 h-6 animate-spin text-accent-500" />
              <span className="text-sm">Capturing the map…</span>
            </div>
          )}
          {status === 'error' && (
            <div className="flex flex-col items-center gap-3 text-center py-10 px-4">
              <AlertCircle className="w-8 h-8 text-red-400" />
              <p className="text-sm text-slate-300">Couldn't capture the map.</p>
              <p className="text-xs text-slate-500 max-w-xs">
                This can happen if the map tiles haven't finished loading. Try again, or use your device's
                own screenshot tool instead.
              </p>
              <button
                onClick={() => { setStatus('capturing'); setAttempt(a => a + 1); }}
                className="inline-flex items-center gap-2 mt-1 px-3.5 py-1.5 rounded-lg text-xs font-medium border border-slate-600 hover:bg-white/10 transition"
              >
                <RotateCw className="w-3.5 h-3.5" />
                Try again
              </button>
            </div>
          )}
          {/* Always mounted so the captured <canvas> has somewhere to land the
              moment the promise resolves, but only visible once ready. */}
          <div ref={canvasHolderRef} className={status === 'ready' ? '' : 'hidden'} />
        </div>

        <div className={`p-5 border-t border-slate-700/40 grid grid-cols-1 sm:grid-cols-2 gap-2.5 ${
          status !== 'ready' ? 'opacity-50 pointer-events-none' : ''
        }`}>
          <button
            onClick={handlePrint}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border border-slate-600 text-slate-100 hover:bg-white/10 transition"
          >
            <Printer className="w-4 h-4" />
            Print
          </button>
          <button
            onClick={handleShareImage}
            disabled={busy || status !== 'ready'}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium text-white bg-accent-500 hover:bg-accent-600 transition disabled:opacity-60"
          >
            {shareSupported ? <Share2 className="w-4 h-4" /> : <Download className="w-4 h-4" />}
            {busy ? 'Preparing…' : shareSupported ? 'Share image' : 'Save image'}
          </button>
        </div>
      </div>
    </div>
  );
}
