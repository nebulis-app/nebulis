import { useTranslation } from 'react-i18next';
import { Download, Loader2, RotateCw, ScanSearch } from 'lucide-react';
import type { AnnotateQuality } from '../../lib/api/annotate';
import type { useImageAnnotations } from './useImageAnnotations';

type AnnotationState = ReturnType<typeof useImageAnnotations>;

const BADGE: Record<AnnotateQuality, string> = {
  solved: 'bg-emerald-500/20 text-emerald-300',
  header: 'bg-emerald-500/20 text-emerald-300',
  approximate: 'bg-accent-500/20 text-accent-300',
  unavailable: 'bg-white/10 text-white/60',
};

const BTN =
  'inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-[0.7188rem] font-medium '
  + 'text-white/85 outline-none transition hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/60 '
  + 'disabled:pointer-events-none disabled:opacity-40';

/**
 * What the annotation layer is doing and how far to trust it, as a small glass
 * card: the quality of the positions, the object count, and (when the estimate
 * can be improved) the one button that does it. It is placed by
 * `AnnotationDock`, which keeps it clear of the picture. Pointer events are
 * stopped so a click here never starts a pan.
 * Only an admin can start the install (the endpoint is admin-only), so the
 * button is hidden for everyone else.
 */
export function AnnotationPanel({ annotations, canInstall, zoomedPastEstimate = false }: {
  annotations: AnnotationState;
  canInstall: boolean;
  /** The picture is zoomed well past fit, where an estimate shows its error. */
  zoomedPastEstimate?: boolean;
}) {
  const { t } = useTranslation('library');
  const { data, isLoading, error, install, installPending, retrySolve, hiddenIds, setShown, setAllShown } = annotations;

  const installing = !!data && (data.solver.state === 'downloading' || data.solver.state === 'extracting');
  const percent = data ? Math.round(data.solver.progress * 100) : 0;

  return (
    <div
      onPointerDown={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      onWheel={e => e.stopPropagation()}
      className="w-full cursor-default select-none rounded-xl bg-black/60 p-3
        text-xs text-white/80 ring-1 ring-inset ring-white/10 backdrop-blur-md"
    >
      <div className="flex items-center gap-2">
        <ScanSearch className="h-3.5 w-3.5 flex-shrink-0 text-accent-400" aria-hidden="true" />
        <span className="font-medium text-white">{t('annotate.title')}</span>
        {data && (
          <span className={`ml-auto rounded-full px-2 py-0.5 text-[0.6562rem] font-medium ${BADGE[data.quality]}`}>
            {t(`annotate.quality.${data.quality}`)}
          </span>
        )}
      </div>

      {isLoading && (
        <p className="mt-2 flex items-center gap-1.5 text-white/60">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          {t('annotate.loading')}
        </p>
      )}

      {error && !data && <p className="mt-2 text-red-300">{error instanceof Error ? error.message : String(error)}</p>}

      {data && (
        <div className="mt-2 space-y-2 leading-snug">
          {data.quality === 'unavailable' && data.reason && (
            <p className="text-white/65">{t(`annotate.reason.${data.reason}`)}</p>
          )}
          {data.quality === 'approximate' && <p className="text-white/65">{t('annotate.approximateHelp')}</p>}
          {data.quality === 'approximate' && zoomedPastEstimate && <p className="text-accent-300">{t('annotate.zoomedHint')}</p>}
          {data.quality !== 'unavailable' && (
            data.annotations.length > 0
              ? <p className="text-white/55">{t('annotate.foundCount', { count: data.annotations.length })}</p>
              : <p className="text-white/55">{t('annotate.none')}</p>
          )}
          {data.quality !== 'unavailable' && data.annotations.length > 0 && (
            <div>
              {data.annotations.length > 1 && (
                <div className="mb-1 flex items-center gap-1.5 text-[0.6875rem] text-accent-300">
                  <button type="button" className="outline-none hover:underline focus-visible:underline disabled:opacity-40"
                    disabled={hiddenIds.size === 0} onClick={() => setAllShown(true)}>{t('annotate.all')}</button>
                  <span className="text-white/30" aria-hidden="true">·</span>
                  <button type="button" className="outline-none hover:underline focus-visible:underline disabled:opacity-40"
                    disabled={hiddenIds.size === data.annotations.length} onClick={() => setAllShown(false)}>{t('annotate.noneShown')}</button>
                </div>
              )}
              <ul className="max-h-48 space-y-0.5 overflow-y-auto">
                {data.annotations.map(a => {
                  const on = !hiddenIds.has(a.id);
                  return (
                    <li key={a.id}>
                      <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-white/5">
                        <input type="checkbox" checked={on} onChange={e => setShown(a.id, e.target.checked)}
                          className="h-3.5 w-3.5 flex-shrink-0 accent-accent-400" />
                        <span className={`min-w-0 truncate ${on ? 'text-white/90' : 'text-white/40'}`}>{a.label}</span>
                        {a.designation && <span className="flex-shrink-0 text-white/45">{a.designation}</span>}
                        {a.isTarget && <span className="ml-auto flex-shrink-0 text-accent-300">{t('annotate.target')}</span>}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {data.solve.state === 'running' && (
            <p className="flex items-center gap-1.5 text-accent-300">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              {t('annotate.solving')}
            </p>
          )}

          {data.solve.state === 'failed' && (
            <div className="space-y-1.5">
              <p className="text-white/65">{t('annotate.solveFailed')}</p>
              <button type="button" className={BTN} onClick={retrySolve}>
                <RotateCw className="h-3 w-3" aria-hidden="true" />
                {t('annotate.retry')}
              </button>
            </div>
          )}

          {installing && (
            <div className="space-y-1.5" role="status">
              <p className="flex items-center gap-1.5 text-accent-300">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                {data.solver.state === 'extracting' ? t('annotate.install.extracting') : t('annotate.install.downloading')}
              </p>
              <div className="h-1 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-accent-400 transition-[width] duration-500" style={{ width: `${percent}%` }} />
              </div>
            </div>
          )}

          {data.solver.state === 'error' && data.solver.error && (
            <p className="text-red-300">{t('annotate.install.failed', { error: data.solver.error })}</p>
          )}

          {canInstall && data.solver.supported && !data.solver.ready && !installing && data.quality !== 'solved' && (
            <div className="space-y-1.5">
              <button type="button" className={BTN} onClick={() => install()} disabled={installPending}>
                <Download className="h-3 w-3" aria-hidden="true" />
                {t('annotate.install.cta')}
              </button>
              <p className="text-[0.6875rem] text-white/45">{t('annotate.install.detail')}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
