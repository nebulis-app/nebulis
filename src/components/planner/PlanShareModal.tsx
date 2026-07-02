/**
 * Share Plan modal, web counterpart to the iOS/Android PlanShareSheet.
 *
 * Renders the observation plan as a branded card on a <canvas> (the same
 * pixels are exported as PNG), and offers two share actions:
 *   - Copy as text: a plain-text summary to the clipboard.
 *   - Share / Save image: the Web Share API with the PNG file when the browser
 *     supports it (phones, Safari), otherwise a PNG download.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Share2, Download } from 'lucide-react';
import { buildPlanShareText, drawPlanShareCard, type PlanShareData } from '../../lib/planShare';

interface PlanShareModalProps {
  data: PlanShareData;
  onClose: () => void;
}

function canShareFiles(files: File[]): boolean {
  return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files });
}

export function PlanShareModal({ data, onClose }: PlanShareModalProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [didCopy, setDidCopy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shareSupported, setShareSupported] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dims = drawPlanShareCard(canvas, data, Math.min(3, Math.max(2, window.devicePixelRatio || 2)));
    canvas.style.width = `${dims.width}px`;
    canvas.style.height = `${dims.height}px`;
    // Probe Web Share support with a tiny placeholder file (real PNG is built on click).
    setShareSupported(canShareFiles([new File([new Blob()], 'observation-plan.png', { type: 'image/png' })]));
  }, [data]);

  // Esc to close, matching the other planner modals.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleCopyText = async () => {
    try {
      await navigator.clipboard.writeText(buildPlanShareText(data));
      setDidCopy(true);
      setTimeout(() => setDidCopy(false), 1800);
    } catch {
      /* clipboard blocked (insecure context); the image export still works */
    }
  };

  const toBlob = (canvas: HTMLCanvasElement): Promise<Blob | null> =>
    new Promise(resolve => canvas.toBlob(resolve, 'image/png'));

  const handleShareImage = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setBusy(true);
    try {
      const blob = await toBlob(canvas);
      if (!blob) return;
      const file = new File([blob], 'observation-plan.png', { type: 'image/png' });
      if (canShareFiles([file])) {
        try {
          await navigator.share({ files: [file], title: 'Observation Plan' });
          return;
        } catch (err) {
          // User cancelled the share sheet — not an error, just stop.
          if (err instanceof DOMException && err.name === 'AbortError') return;
          // Anything else: fall through to a download.
        }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'observation-plan.png';
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
        className="relative rounded-2xl shadow-2xl max-w-md w-full max-h-[92vh] overflow-hidden flex flex-col bg-slate-900 text-slate-100"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-slate-700/40">
          <h2 className="text-lg font-semibold">Share Plan</h2>
          <button onClick={onClose} className="text-sm px-3 py-1.5 rounded-lg hover:bg-white/10 transition">
            Done
          </button>
        </div>

        <div className="overflow-auto p-5 flex justify-center bg-slate-950/40">
          <canvas
            ref={canvasRef}
            className="rounded-xl shadow-2xl max-w-full h-auto"
            aria-label="Observation plan card preview"
          />
        </div>

        <div className="p-5 border-t border-slate-700/40 space-y-2.5">
          <button
            onClick={handleCopyText}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border border-slate-600 text-slate-100 hover:bg-white/10 transition"
          >
            {didCopy ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            {didCopy ? 'Copied!' : 'Copy as text'}
          </button>
          <button
            onClick={handleShareImage}
            disabled={busy}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium text-white bg-accent-500 hover:bg-accent-600 transition disabled:opacity-60"
          >
            {shareSupported ? <Share2 className="w-4 h-4" /> : <Download className="w-4 h-4" />}
            {busy ? 'Preparing…' : shareSupported ? 'Share image' : 'Save image'}
          </button>
        </div>
      </div>
    </div>
  );
}
