import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Loader2, Share2 } from 'lucide-react';
import { Modal } from '../ui/Modal';
import type { AnnotationData } from '../../lib/api/annotate';
import { annotatedFileName, burnSources, renderAnnotatedCanvas } from '../../lib/annotateBurn';
import { canvasToBlob } from '../../lib/catalogWallPoster';
import { shareBlob, shareOutcomeMessage } from './shareImage';

type Action = 'download' | 'share';

interface Options {
  /** Annotation data while the rings are showing, else undefined. */
  data: AnnotationData | undefined;
  /** The picture's true file, as Download and Share use it. */
  original: { url: string; name: string } | null;
  /** The bounded preview the viewer shows. */
  previewUrl: string | null;
  /** Title for the share sheet. */
  title: string;
  /** The ordinary action, used for "original" and whenever no rings are showing. */
  plainDownload: () => void;
  plainShare: () => void;
  flash: (msg: string | null) => void;
}

/**
 * Download and Share for a viewer that can draw object names on the picture.
 *
 * With the rings showing, either action first asks whether to keep the original or burn the names in; with them
 * hidden (or none found) it does what it always did, with no extra step. The burned copy is a JPEG drawn in the
 * browser from the original when it can be decoded, else from the viewer's preview.
 */
export function useAnnotatedExport(o: Options) {
  const { t } = useTranslation('library');
  const [asking, setAsking] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);

  const burnable = !!o.data && o.data.annotations.length > 0;

  const request = useCallback((action: Action) => {
    if (burnable) setAsking(action);
    else if (action === 'download') o.plainDownload();
    else o.plainShare();
  }, [burnable, o]);

  const choose = useCallback(async (burn: boolean) => {
    const action = asking;
    if (!action) return;
    if (!burn || !o.data) {
      setAsking(null);
      if (action === 'download') o.plainDownload(); else o.plainShare();
      return;
    }
    setBusy(true);
    try {
      const canvas = await renderAnnotatedCanvas(o.data, burnSources(o.original, o.previewUrl));
      const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
      const name = annotatedFileName(o.original?.name ?? 'image');
      if (action === 'download') {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      } else {
        const outcome = await shareBlob(blob, name, o.title, () => canvasToBlob(canvas, 'image/png'));
        o.flash(shareOutcomeMessage(outcome, {
          copiedImage: t('imageViewer.copiedImage'),
          copiedLink: t('imageViewer.copiedLink'),
          failed: t('imageViewer.shareFailed'),
        }));
      }
      setAsking(null);
    } catch {
      o.flash(t('annotate.export.failed'));
    } finally {
      setBusy(false);
    }
  }, [asking, o, t]);

  const close = useCallback(() => { if (!busy) setAsking(null); }, [busy]);

  const Icon = asking === 'share' ? Share2 : Download;
  const dialog = (
    <Modal
      isOpen={asking !== null}
      onClose={close}
      title={asking === 'share' ? t('annotate.export.shareTitle') : t('annotate.export.downloadTitle')}
      className="w-full max-w-sm rounded-2xl bg-slate-900 p-5 text-white ring-1 ring-white/10"
    >
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-accent-400" aria-hidden="true" />
        <h2 className="font-display text-base font-semibold">
          {asking === 'share' ? t('annotate.export.shareTitle') : t('annotate.export.downloadTitle')}
        </h2>
      </div>
      <p className="mt-1.5 text-sm text-white/60">{t('annotate.export.question')}</p>
      <div className="mt-4 flex flex-col gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void choose(true)}
          className="flex items-center justify-between gap-3 rounded-xl bg-accent-500 px-4 py-3 text-left text-sm font-medium text-black outline-none transition hover:bg-accent-400 focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-60"
        >
          <span>
            {t('annotate.export.withNames')}
            <span className="mt-0.5 block text-xs font-normal text-black/70">{t('annotate.export.withNamesHint')}</span>
          </span>
          {busy && <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin" aria-hidden="true" />}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void choose(false)}
          className="rounded-xl bg-white/[0.07] px-4 py-3 text-left text-sm font-medium text-white outline-none ring-1 ring-inset ring-white/10 transition hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-60"
        >
          {t('annotate.export.original')}
          <span className="mt-0.5 block text-xs font-normal text-white/55">{t('annotate.export.originalHint')}</span>
        </button>
      </div>
    </Modal>
  );

  return {
    /** Download button / `D` key. */
    download: useCallback(() => request('download'), [request]),
    /** Share button. */
    share: useCallback(() => request('share'), [request]),
    /** Rings are showing, so Download and Share will ask first. */
    burnable,
    /** True while the choice dialog is open, so the viewer's own keys stand down. */
    asking: asking !== null,
    dialog,
  };
}
