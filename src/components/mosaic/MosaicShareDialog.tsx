/**
 * "Share image" for the Mosaic view: a live preview of the wall as a picture, plus download, copy and the system
 * share sheet. The picture is drawn in the browser (see `mosaicExport.ts`).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Download, Share2, X } from 'lucide-react';
import {
  canvasToBlob, mosaicExportSize, renderMosaicImage, type MosaicExportFormat, type MosaicExportSpec,
} from '../../lib/mosaic/mosaicExport';
import { everyMember } from '../unionList';
import type { MosaicTile } from './MosaicWall';

interface Props {
  tiles: MosaicTile[];
  /** Width / height of the wall as shown, the shape of the "as shown" format. */
  shownAspect: number;
  /** Whether the wall is showing names right now, so the picture starts the same way. */
  labels: boolean;
  fileBase: string;
  onClose: () => void;
}

const FORMATS = everyMember<MosaicExportFormat>()(['shown', 'wide', 'square', 'story']);

function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function MosaicShareDialog({ tiles, shownAspect, labels: initialLabels, fileBase, onClose }: Props) {
  const { t } = useTranslation('library');
  const [format, setFormat] = useState<MosaicExportFormat>('shown');
  const [labels, setLabels] = useState(initialLabels);
  const [jpeg, setJpeg] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<'download' | 'copy' | 'share' | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const renderId = useRef(0);

  const spec: MosaicExportSpec = useMemo(
    () => ({ tiles, format, shownAspect, labels }),
    [tiles, format, shownAspect, labels],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Debounced live preview at a fraction of the export size.
  useEffect(() => {
    const id = ++renderId.current;
    const { width, height } = mosaicExportSize(format, shownAspect);
    const scale = Math.min(1, 900 / Math.max(width, height));
    const timer = window.setTimeout(() => {
      renderMosaicImage(spec, scale)
        .then(c => { if (id === renderId.current) setPreview(c.toDataURL('image/jpeg', 0.88)); })
        .catch(() => { if (id === renderId.current) setPreview(null); });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [spec, format, shownAspect]);

  const fileName = `${fileBase.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-mosaic.${jpeg ? 'jpg' : 'png'}`;
  const makeBlob = async (type: 'image/png' | 'image/jpeg') => canvasToBlob(await renderMosaicImage(spec, 1), type);

  const run = async (kind: 'download' | 'copy' | 'share') => {
    setBusy(kind);
    setNotice(null);
    try {
      if (kind === 'download') {
        saveFile(await makeBlob(jpeg ? 'image/jpeg' : 'image/png'), fileName);
        setNotice({ kind: 'ok', text: t('mosaic.share.downloaded') });
      } else if (kind === 'copy') {
        // The clipboard only reliably takes PNG.
        const blob = await makeBlob('image/png');
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        setNotice({ kind: 'ok', text: t('mosaic.share.copied') });
      } else {
        const blob = await makeBlob(jpeg ? 'image/jpeg' : 'image/png');
        const file = new File([blob], fileName, { type: blob.type });
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], title: fileBase });
        } else {
          saveFile(blob, fileName);
          setNotice({ kind: 'ok', text: t('mosaic.share.shareFallback') });
        }
      }
    } catch (err) {
      // Dismissing the share sheet is not an error.
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setNotice({ kind: 'error', text: t('mosaic.share.failed') });
      }
    } finally {
      setBusy(null);
    }
  };

  const chip = (active: boolean) =>
    `rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
      active ? 'bg-white/15 text-white ring-white/30' : 'text-white/60 ring-white/10 hover:bg-white/10 hover:text-white'
    }`;
  const { width, height } = mosaicExportSize(format, shownAspect);
  const canShareFiles = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const secondary = 'inline-flex flex-1 items-center justify-center gap-1.5 rounded-full bg-white/10 px-3 py-2 text-xs font-medium text-white ring-1 ring-inset ring-white/15 hover:bg-white/15 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60';

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/75 backdrop-blur-sm sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-label={t('mosaic.share.title')}>
      <div className="flex max-h-[95vh] w-full max-w-5xl flex-col overflow-hidden rounded-t-3xl bg-slate-950 ring-1 ring-white/15 sm:rounded-3xl">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
          <h2 className="font-display text-lg font-semibold text-white">{t('mosaic.share.title')}</h2>
          <button type="button" onClick={onClose} aria-label={t('mosaic.share.close')} className="rounded-full p-1.5 text-white/70 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto p-5 md:grid-cols-[1fr_17rem]">
          <div className="flex h-[min(60vh,34rem)] items-center justify-center rounded-2xl bg-black/40 p-3 ring-1 ring-white/10">
            {preview ? (
              <img src={preview} alt={t('mosaic.share.previewAlt')} className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" />
            ) : (
              <div className="h-40 w-full max-w-md animate-pulse rounded-lg bg-white/5" aria-hidden="true" />
            )}
          </div>

          <div className="flex flex-col gap-4">
            <div>
              <div className="mb-1.5 text-[0.6875rem] font-medium uppercase tracking-wider text-white/45">{t('mosaic.share.format')}</div>
              <div className="flex flex-wrap gap-1.5">
                {FORMATS.map(f => (
                  <button key={f} type="button" aria-pressed={format === f} onClick={() => setFormat(f)} className={chip(format === f)}>
                    {t(`mosaic.share.formats.${f}`)}
                  </button>
                ))}
              </div>
              <div className="mt-1.5 text-[0.6875rem] tabular-nums text-white/40">{width} × {height}</div>
            </div>

            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-xs text-white/75">
                <input type="checkbox" checked={labels} onChange={e => setLabels(e.target.checked)} className="accent-amber-400" />
                {t('mosaic.names')}
              </label>
              <label className="flex items-center gap-2 text-xs text-white/75">
                <input type="checkbox" checked={jpeg} onChange={e => setJpeg(e.target.checked)} className="accent-amber-400" />
                {t('mosaic.share.jpeg')}
              </label>
            </div>

            <div className="mt-auto flex flex-col gap-2">
              <button
                type="button"
                onClick={() => void run('download')}
                disabled={busy !== null}
                className="inline-flex items-center justify-center gap-2 rounded-full bg-accent-400 px-4 py-2 text-sm font-semibold text-slate-950 transition-transform hover:scale-[1.02] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              >
                <Download className="h-4 w-4" />
                {busy === 'download' ? t('mosaic.share.rendering') : t('mosaic.share.download')}
              </button>
              <div className="flex gap-2">
                <button type="button" onClick={() => void run('copy')} disabled={busy !== null} className={secondary}>
                  <Copy className="h-3.5 w-3.5" />
                  {t('mosaic.share.copy')}
                </button>
                {canShareFiles && (
                  <button type="button" onClick={() => void run('share')} disabled={busy !== null} className={secondary}>
                    <Share2 className="h-3.5 w-3.5" />
                    {t('mosaic.share.share')}
                  </button>
                )}
              </div>
              {notice && (
                <p role="status" className={`flex items-center gap-1.5 text-xs ${notice.kind === 'ok' ? 'text-emerald-300' : 'text-red-300'}`}>
                  {notice.kind === 'ok' && <Check className="h-3.5 w-3.5" />}
                  {notice.text}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
