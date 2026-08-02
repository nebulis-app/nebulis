/**
 * Share List modal, the List-view counterpart to CalendarShareModal.
 *
 * Renders the currently visible, currently sorted observations table as a
 * branded card on a <canvas> (the same pixels are exported as PNG), and
 * offers:
 *   - Print: opens the card image in a print window.
 *   - Copy as text: a plain-text table to the clipboard.
 *   - Share / Save image: the Web Share API with the PNG file when the
 *     browser supports it, otherwise a PNG download.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Share2, Download, Printer } from 'lucide-react';
import { buildListShareText, drawListShareCard, type ListShareData } from '../../lib/listShare';

interface ListShareModalProps {
  data: ListShareData;
  onClose: () => void;
}

function canShareFiles(files: File[]): boolean {
  return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files });
}

export function ListShareModal({ data, onClose }: ListShareModalProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [didCopy, setDidCopy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shareSupported, setShareSupported] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dims = drawListShareCard(canvas, data, Math.min(3, Math.max(2, window.devicePixelRatio || 2)));
    canvas.style.width = `${dims.width}px`;
    canvas.style.height = `${dims.height}px`;
    setShareSupported(canShareFiles([new File([new Blob()], 'observations-list.png', { type: 'image/png' })]));
  }, [data]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleCopyText = async () => {
    try {
      await navigator.clipboard.writeText(buildListShareText(data));
      setDidCopy(true);
      setTimeout(() => setDidCopy(false), 1800);
    } catch {
      /* clipboard blocked (insecure context); the image export still works */
    }
  };

  const toBlob = (canvas: HTMLCanvasElement): Promise<Blob | null> =>
    new Promise(resolve => canvas.toBlob(resolve, 'image/png'));

  // Same popup + own-script print flow as CalendarShareModal: the CSP forbids
  // inline scripts and framing, so a data: <img> in a fresh window is what's
  // available. On popup block, fall back to sharing/downloading instead.
  const handlePrint = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL('image/png');
    const win = window.open('', '_blank');
    if (!win) { void handleShareImage(); return; }
    win.document.title = 'Observations list';
    const style = win.document.createElement('style');
    style.textContent = '@page{margin:12mm}html,body{margin:0;background:#0F1426}img{display:block;width:100%;height:auto}';
    win.document.head.appendChild(style);
    const img = win.document.createElement('img');
    img.alt = 'Observations list';
    img.onload = () => { win.focus(); win.print(); };
    img.src = dataUrl;
    win.document.body.appendChild(img);
  };

  const handleShareImage = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setBusy(true);
    try {
      const blob = await toBlob(canvas);
      if (!blob) return;
      const file = new File([blob], 'observations-list.png', { type: 'image/png' });
      if (canShareFiles([file])) {
        try {
          await navigator.share({ files: [file], title: 'Observations list' });
          return;
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return;
        }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'observations-list.png';
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
        className="relative rounded-2xl shadow-2xl max-w-2xl w-full max-h-[92vh] overflow-hidden flex flex-col bg-slate-900 text-slate-100"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-slate-700/40">
          <h2 className="text-lg font-semibold">Share Observations List</h2>
          <button onClick={onClose} className="text-sm px-3 py-1.5 rounded-lg hover:bg-white/10 transition">
            Done
          </button>
        </div>

        <div className="overflow-auto p-5 flex justify-center bg-slate-950/40">
          <canvas
            ref={canvasRef}
            className="rounded-xl shadow-2xl max-w-full h-auto"
            aria-label="Observations list preview"
          />
        </div>

        <div className="p-5 border-t border-slate-700/40 grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          <button
            onClick={handlePrint}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border border-slate-600 text-slate-100 hover:bg-white/10 transition"
          >
            <Printer className="w-4 h-4" />
            Print
          </button>
          <button
            onClick={handleCopyText}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border border-slate-600 text-slate-100 hover:bg-white/10 transition"
          >
            {didCopy ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            {didCopy ? 'Copied!' : 'Copy as text'}
          </button>
          <button
            onClick={handleShareImage}
            disabled={busy}
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
