/**
 * "Share poster": live preview of the wall as a poster, plus download, copy and
 * the system share sheet. The poster is drawn in the browser (see
 * `catalogWallPoster.ts`) from the same layout the on-screen wall uses.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Download, Share2, X } from 'lucide-react';
import type { WallTile } from '../../../lib/api/catalogs';
import type { WallOverrides } from '../../../lib/catalogWallOverrides';
import {
  POSTER_FORMATS, canvasToBlob, renderPoster, type PosterFormat, type PosterSpec,
} from '../../../lib/catalogWallPoster';
import { everyMember } from '../../unionList';

interface Props {
  tiles: WallTile[];
  overrides: WallOverrides;
  label: string;
  imagedCount: number;
  total: number;
  accent: string;
  onClose: () => void;
}

const FORMATS = everyMember<PosterFormat>()(['wide', 'story', 'square', 'print']);
const SUBTITLE_KEY = 'nebulis_wall_poster_subtitle';

function readSubtitle(): string {
  try { return localStorage.getItem(SUBTITLE_KEY) ?? ''; } catch { return ''; }
}

export function PosterDialog({ tiles, overrides, label, imagedCount, total, accent, onClose }: Props) {
  const { t } = useTranslation('catalogs');
  const [format, setFormat] = useState<PosterFormat>('wide');
  const [imagedOnly, setImagedOnly] = useState(false);
  const [labels, setLabels] = useState(true);
  const [brand, setBrand] = useState(false);
  const [brandSide, setBrandSide] = useState<'left' | 'right' | 'bottom-right'>('right');
  const [title, setTitle] = useState(() => t('wall.title', { label }));
  const [subtitle, setSubtitle] = useState(readSubtitle);
  const [jpeg, setJpeg] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<'download' | 'copy' | 'share' | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const renderId = useRef(0);

  const spec: PosterSpec = useMemo(() => ({
    tiles, overrides, title, subtitle, format, imagedOnly, labels, brand, brandSide, imagedCount, total, accent,
  }), [tiles, overrides, title, subtitle, format, imagedOnly, labels, brand, brandSide, imagedCount, total, accent]);

  useEffect(() => {
    try { localStorage.setItem(SUBTITLE_KEY, subtitle); } catch { /* storage unavailable */ }
  }, [subtitle]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Debounced live preview at a fraction of the export size.
  useEffect(() => {
    const id = ++renderId.current;
    const { width, height } = POSTER_FORMATS[format];
    const scale = Math.min(1, 900 / Math.max(width, height));
    const timer = window.setTimeout(() => {
      renderPoster(spec, scale)
        .then(c => { if (id === renderId.current) setPreview(c.toDataURL('image/jpeg', 0.88)); })
        .catch(() => { if (id === renderId.current) setPreview(null); });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [spec, format]);

  const fileName = `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-catalog.${jpeg ? 'jpg' : 'png'}`;

  const makeBlob = async (type: 'image/png' | 'image/jpeg') => canvasToBlob(await renderPoster(spec, 1), type);

  const run = async (kind: 'download' | 'copy' | 'share') => {
    setBusy(kind);
    setNotice(null);
    try {
      if (kind === 'download') {
        const blob = await makeBlob(jpeg ? 'image/jpeg' : 'image/png');
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
        setNotice({ kind: 'ok', text: t('wall.poster.downloaded') });
      } else if (kind === 'copy') {
        // The clipboard only reliably takes PNG.
        const blob = await makeBlob('image/png');
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        setNotice({ kind: 'ok', text: t('wall.poster.copied') });
      } else {
        const blob = await makeBlob(jpeg ? 'image/jpeg' : 'image/png');
        const file = new File([blob], fileName, { type: blob.type });
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], title });
        } else {
          // No file sharing here: hand over the file instead.
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = fileName;
          a.click();
          window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
          setNotice({ kind: 'ok', text: t('wall.poster.shareFallback') });
        }
      }
    } catch (err) {
      // Dismissing the share sheet is not an error.
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setNotice({ kind: 'error', text: t('wall.poster.failed') });
      }
    } finally {
      setBusy(null);
    }
  };

  const chip = (active: boolean) =>
    `rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
      active ? 'bg-white/15 text-white ring-white/30' : 'text-white/60 ring-white/10 hover:bg-white/10 hover:text-white'
    }`;
  const { width, height } = POSTER_FORMATS[format];
  const canShareFiles = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 backdrop-blur-sm sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-label={t('wall.poster.title')}>
      <div className="flex max-h-[95vh] w-full max-w-5xl flex-col overflow-hidden rounded-t-3xl bg-slate-950 ring-1 ring-white/15 sm:rounded-3xl">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
          <h2 className="font-display text-lg font-semibold text-white">{t('wall.poster.title')}</h2>
          <button type="button" onClick={onClose} aria-label={t('wall.edit.close')} className="rounded-full p-1.5 text-white/70 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto p-5 md:grid-cols-[1fr_17rem]">
          <div className="flex h-[min(60vh,34rem)] items-center justify-center rounded-2xl bg-black/40 p-3 ring-1 ring-white/10">
            {preview ? (
              <img src={preview} alt={t('wall.poster.previewAlt')} className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" />
            ) : (
              <div className="h-40 w-full max-w-md animate-pulse rounded-lg bg-white/5" aria-hidden="true" />
            )}
          </div>

          <div className="flex flex-col gap-4">
            <div>
              <div className="mb-1.5 text-[0.6875rem] font-medium uppercase tracking-wider text-white/45">{t('wall.poster.format')}</div>
              <div className="flex flex-wrap gap-1.5">
                {FORMATS.map(f => (
                  <button key={f} type="button" aria-pressed={format === f} onClick={() => setFormat(f)} className={chip(format === f)}>
                    {t(`wall.poster.formats.${f}`)}
                  </button>
                ))}
              </div>
              <div className="mt-1.5 text-[0.6875rem] tabular-nums text-white/40">{width} × {height}</div>
            </div>

            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-xs text-white/75">
                <input type="checkbox" checked={imagedOnly} onChange={e => setImagedOnly(e.target.checked)} className="accent-amber-400" />
                {t('wall.poster.imagedOnly')}
              </label>
              <label className="flex items-center gap-2 text-xs text-white/75">
                <input type="checkbox" checked={labels} onChange={e => setLabels(e.target.checked)} className="accent-amber-400" />
                {t('wall.poster.labels')}
              </label>
              <label className="flex items-center gap-2 text-xs text-white/75">
                <input type="checkbox" checked={brand} onChange={e => setBrand(e.target.checked)} className="accent-amber-400" />
                {t('wall.poster.brand')}
              </label>
              {/* Always rendered (dimmed until the box is ticked) so ticking it never changes the dialog's height. */}
              <div className={`flex flex-wrap gap-1.5 pl-6 transition-opacity ${brand ? '' : 'pointer-events-none opacity-40'}`} aria-hidden={!brand}>
                {(['left', 'right', 'bottom-right'] as const).map(side => (
                  <button key={side} type="button" disabled={!brand} aria-pressed={brandSide === side} onClick={() => setBrandSide(side)} className={chip(brandSide === side)}>
                    {t(`wall.poster.brandSide.${side === 'bottom-right' ? 'bottomRight' : side}`)}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-2 text-xs text-white/75">
                <input type="checkbox" checked={jpeg} onChange={e => setJpeg(e.target.checked)} className="accent-amber-400" />
                {t('wall.poster.jpeg')}
              </label>
            </div>

            <label className="block text-xs text-white/60">
              {t('wall.poster.titleField')}
              <input value={title} onChange={e => setTitle(e.target.value)} maxLength={60} className="mt-1 w-full rounded-lg bg-white/5 px-3 py-1.5 text-sm text-white ring-1 ring-inset ring-white/15 focus:outline-none focus:ring-2 focus:ring-white/50" />
            </label>
            <label className="block text-xs text-white/60">
              {t('wall.poster.subtitleField')}
              <input value={subtitle} onChange={e => setSubtitle(e.target.value)} maxLength={80} placeholder={t('wall.poster.subtitlePlaceholder')} className="mt-1 w-full rounded-lg bg-white/5 px-3 py-1.5 text-sm text-white placeholder:text-white/30 ring-1 ring-inset ring-white/15 focus:outline-none focus:ring-2 focus:ring-white/50" />
            </label>

            <div className="mt-auto flex flex-col gap-2">
              <button
                type="button"
                onClick={() => void run('download')}
                disabled={busy !== null}
                className="inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-semibold text-slate-950 transition-transform hover:scale-[1.02] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                style={{ background: accent }}
              >
                <Download className="h-4 w-4" />
                {busy === 'download' ? t('wall.poster.rendering') : t('wall.poster.download')}
              </button>
              <div className="flex gap-2">
                <button type="button" onClick={() => void run('copy')} disabled={busy !== null} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-full bg-white/10 px-3 py-2 text-xs font-medium text-white ring-1 ring-inset ring-white/15 hover:bg-white/15 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60">
                  <Copy className="h-3.5 w-3.5" />
                  {t('wall.poster.copy')}
                </button>
                {canShareFiles && (
                  <button type="button" onClick={() => void run('share')} disabled={busy !== null} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-full bg-white/10 px-3 py-2 text-xs font-medium text-white ring-1 ring-inset ring-white/15 hover:bg-white/15 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60">
                    <Share2 className="h-3.5 w-3.5" />
                    {t('wall.poster.share')}
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
