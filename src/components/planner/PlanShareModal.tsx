/**
 * Share Plan modal, web counterpart to the iOS/Android PlanShareSheet.
 *
 * Renders the observation plan as a branded card on a <canvas> (the same
 * pixels are exported as PNG), and offers two share actions:
 *   - Copy as text: a plain-text summary to the clipboard.
 *   - Share / Save image: the Web Share API with the PNG file when the browser
 *     supports it (phones, Safari), otherwise a PNG download.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Share2, Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { buildPlanShareText, drawPlanShareCard, type PlanShareData, type PlanShareStrings } from '../../lib/planShare';
import { translateMoonPhase } from '../../lib/moonPhaseLabel';
import { BodyScrollLock } from '../ui/BodyScrollLock';

interface PlanShareModalProps {
  data: PlanShareData;
  onClose: () => void;
}

function canShareFiles(files: File[]): boolean {
  return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files });
}

export function PlanShareModal({ data, onClose }: PlanShareModalProps) {
  const { t } = useTranslation('planner');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [didCopy, setDidCopy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shareSupported, setShareSupported] = useState(false);

  // moonPhase is translated here since planShare.ts stays i18n-agnostic (see
  // its PlanShareStrings doc). Memoized so the draw effect below doesn't
  // re-run (and redraw the canvas) on every unrelated render.
  const shareData: PlanShareData = useMemo(
    () => (data.moonPhase ? { ...data, moonPhase: translateMoonPhase(t, data.moonPhase) } : data),
    [data, t],
  );
  const strings: PlanShareStrings = useMemo(() => ({
    title: t('planShareModal.observationPlan'),
    darkWindowLine: (start, end, hours) => t('planShareModal.darkWindowLine', { start, end, hours }),
    moonLine: (percent, phase) => t('planShareModal.moonLine', { percent, phase }),
    plannedWith: t('planShareModal.plannedWith'),
    timelineLabel: t('planShareModal.timelineLabel'),
    elevationLabel: t('planShareModal.elevationLabel'),
  }), [t]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dims = drawPlanShareCard(canvas, shareData, strings, Math.min(3, Math.max(2, window.devicePixelRatio || 2)));
    canvas.style.width = `${dims.width}px`;
    canvas.style.height = `${dims.height}px`;
    // Probe Web Share support with a tiny placeholder file (real PNG is built on click).
    setShareSupported(canShareFiles([new File([new Blob()], 'observation-plan.png', { type: 'image/png' })]));
  }, [shareData, strings]);

  // Esc to close, matching the other planner modals.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleCopyText = async () => {
    try {
      await navigator.clipboard.writeText(buildPlanShareText(shareData, strings));
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
          await navigator.share({ files: [file], title: strings.title });
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
      <BodyScrollLock />
      <div
        className="relative rounded-2xl shadow-2xl max-w-md w-full max-h-[92vh] overflow-hidden flex flex-col bg-slate-900 text-slate-100"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-slate-700/40">
          <h2 className="text-lg font-semibold">{t('planShareModal.sharePlan')}</h2>
          <button onClick={onClose} className="text-sm px-3 py-1.5 rounded-lg hover:bg-white/10 transition">
            {t('planShareModal.done')}
          </button>
        </div>

        <div className="overflow-auto p-5 flex justify-center bg-slate-950/40">
          <canvas
            ref={canvasRef}
            className="rounded-xl shadow-2xl max-w-full h-auto"
            aria-label={t('planShareModal.previewAriaLabel')}
          />
        </div>

        <div className="p-5 border-t border-slate-700/40 space-y-2.5">
          <button
            onClick={handleCopyText}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border border-slate-600 text-slate-100 hover:bg-white/10 transition"
          >
            {didCopy ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            {didCopy ? t('planShareModal.copied') : t('planShareModal.copyAsText')}
          </button>
          <button
            onClick={handleShareImage}
            disabled={busy}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium text-white bg-accent-500 hover:bg-accent-600 transition disabled:opacity-60"
          >
            {shareSupported ? <Share2 className="w-4 h-4" /> : <Download className="w-4 h-4" />}
            {busy ? t('planShareModal.preparing') : shareSupported ? t('planShareModal.shareImage') : t('planShareModal.saveImage')}
          </button>
        </div>
      </div>
    </div>
  );
}
