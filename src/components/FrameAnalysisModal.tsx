import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, ScanSearch, Loader2, Trash2, RotateCw } from 'lucide-react';
import {
  getFrameAnalysis, measureFrame, setFrameReview,
  type FrameAnalysisReport, type FrameAnalysisRow, type FrameFlag, type FrameGrade,
} from '../lib/api/frameAnalysis';
import { deleteLibraryFile } from '../lib/api/library';
import { isLinkedPath } from '../lib/linkedPaths';
import { formatNumber } from '../lib/formatLocale';
import { FrameRow } from './frameAnalysis/FrameRow';
import { FLAG_ICONS, FLAG_ORDER, n0, n1 } from './frameAnalysis/frameFormat';
import { Modal } from './ui/Modal';
import { GalleryModal, type GalleryItem } from './GalleryModal';
import { CloseConfirm } from './ui/CloseConfirm';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  objectId: string;
  /** The nights that have raw frames. One entry hides the night picker. */
  nights: Array<{ date: string; count: number }>;
  initialDate: string;
  /** Fold in the object's mosaic/filter variants, as the object page does. */
  includeVariants?: boolean;
  onFilesDeleted: () => void;
  /** Titles the frame viewer. */
  objectName?: string;
  isDark: boolean;
}

type Filter = 'all' | 'good' | 'flagged' | 'bad';
type Sort = 'score' | 'time' | 'stars' | 'sharpness' | 'roundness';

const FILTERS: Filter[] = ['all', 'good', 'flagged', 'bad'];
const SORTS: Sort[] = ['score', 'time', 'stars', 'sharpness', 'roundness'];
/** Verdicts are read against the whole night, so they are refreshed from the server as frames arrive. */
const REFRESH_EVERY = 8;

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export function FrameAnalysisModal({ isOpen, onClose, objectId, nights, initialDate, includeVariants = false, onFilesDeleted, objectName, isDark }: Props) {
  const { t } = useTranslation('observations');

  const [report, setReport] = useState<FrameAnalysisReport | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('score');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [discardReport, setDiscardReport] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [date, setDate] = useState(initialDate);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  /** Measure whatever has no stored measurement (or every frame, when `force`), one at a time. */
  const run = useCallback(async (force: boolean) => {
    stop();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    setAnalyzing(true);
    setLoadError(null);
    setFailed({});
    try {
      let current = await getFrameAnalysis(objectId, date, { includeVariants, signal });
      setReport(current);
      const todo = (force ? current.frames : current.frames.filter(f => f.metrics === null)).map(f => f.path);
      setProgress({ done: 0, total: todo.length });
      let done = 0;
      for (const path of todo) {
        if (signal.aborted) return;
        try {
          const result = await measureFrame(path, force, signal);
          setReport(prev => prev && {
            ...prev,
            frames: prev.frames.map(f => f.path === path ? { ...f, metrics: result.metrics } : f),
          });
        } catch (err) {
          if (isAbortError(err) || signal.aborted) return;
          const message = err instanceof Error ? err.message : String(err);
          setFailed(prev => ({ ...prev, [path]: message }));
        }
        done++;
        setProgress({ done, total: todo.length });
        if (done % REFRESH_EVERY === 0) {
          current = await getFrameAnalysis(objectId, date, { includeVariants, signal });
          setReport(current);
        }
      }
      setReport(await getFrameAnalysis(objectId, date, { includeVariants, signal }));
    } catch (err) {
      if (isAbortError(err) || signal.aborted) return;
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setAnalyzing(false);
      }
    }
  }, [objectId, date, includeVariants, stop]);

  useEffect(() => {
    if (!isOpen) return;
    // Starting a run on open is this component's whole job; the state it sets is what the modal renders.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReport(null);
    setSelection(new Set());
    setDiscardReport(null);
    void run(false);
    return stop;
  }, [isOpen, run, stop]);

  const rows = useMemo(() => report?.frames ?? [], [report]);
  const measuredRows = useMemo(() => rows.filter(r => r.metrics !== null), [rows]);

  // ── Viewer: the frames as listed (filtered and sorted), with K / X to keep or reject the one on screen ──────────
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const reviewFrame = useMemo(() => ({
    stateFor: (path: string): 'keep' | 'reject' | null => rows.find(r => r.path === path)?.review ?? null,
    toggle: (path: string, which: 'keep' | 'reject') => {
      const current = rows.find(r => r.path === path)?.review ?? null;
      const next = current === which ? null : which;
      const mark = (review: 'keep' | 'reject' | null) =>
        setReport(prev => prev && { ...prev, frames: prev.frames.map(f => (f.path === path ? { ...f, review } : f)) });
      mark(next);
      void setFrameReview(path, next === null ? null : next === 'keep').catch(() => mark(current));
    },
  }), [rows]);

  const summary = useMemo(() => {
    const s: Record<FrameGrade, number> = { good: 0, fair: 0, bad: 0 };
    const flagCounts: Record<FrameFlag, number> = { clouds: 0, trails: 0, soft: 0, streak: 0, noStars: 0, noisy: 0 };
    for (const r of rows) {
      if (r.verdict) {
        s[r.verdict.grade]++;
        for (const f of r.verdict.flags) flagCounts[f]++;
      }
    }
    return { grades: s, flagCounts };
  }, [rows]);

  const visible = useMemo(() => {
    const index = new Map(rows.map((r, i) => [r.path, i]));
    const kept = rows.filter(r => {
      switch (filter) {
        case 'all': return true;
        case 'good': return r.verdict?.grade === 'good';
        case 'flagged': return (r.verdict?.flags.length ?? 0) > 0;
        case 'bad': return r.verdict?.grade === 'bad';
      }
    });
    const value = (r: FrameAnalysisRow): number => {
      switch (sort) {
        case 'score': return r.verdict?.score ?? -1;
        case 'time': return -(index.get(r.path) ?? 0);
        case 'stars': return r.metrics?.starCount ?? -1;
        case 'sharpness': return r.metrics?.fwhm != null ? -r.metrics.fwhm : -1000;
        case 'roundness': return r.metrics?.elongation != null ? -r.metrics.elongation : -1000;
      }
    };
    // Score, stars, sharpness and roundness list the best first; time lists the night in order.
    return [...kept].sort((a, b) => value(b) - value(a));
  }, [rows, filter, sort]);

  const toggle = (path: string) => setSelection(prev => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });

  const selectBad = () => setSelection(new Set(rows.filter(r => r.verdict?.grade === 'bad').map(r => r.path)));
  const selectFlagged = () => setSelection(new Set(rows.filter(r => (r.verdict?.flags.length ?? 0) > 0).map(r => r.path)));

  const selectedLinked = [...selection].filter(isLinkedPath).length;

  const discardSelected = async () => {
    setConfirmDiscard(false);
    setDiscarding(true);
    const failures: string[] = [];
    let removed = 0;
    for (const path of selection) {
      try {
        await deleteLibraryFile(path, { deleteLinked: isLinkedPath(path) });
        removed++;
        setSelection(prev => { const next = new Set(prev); next.delete(path); return next; });
        setReport(prev => prev && { ...prev, frames: prev.frames.filter(f => f.path !== path) });
      } catch (err) {
        failures.push(`${path.split('/').pop() ?? path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setDiscarding(false);
    if (removed > 0) {
      onFilesDeleted();
      try { setReport(await getFrameAnalysis(objectId, date, { includeVariants })); } catch { /* the list already dropped them */ }
    }
    if (failures.length > 0) {
      setDiscardReport(t('observationDetail.frameAnalysisModal.discardFailures', {
        removed, count: failures.length, details: failures.slice(0, 5).join('\n'),
      }));
    }
  };

  if (!isOpen) return null;

  const text = isDark ? 'text-slate-200' : 'text-slate-700';
  const muted = isDark ? 'text-slate-500' : 'text-slate-400';
  const border = isDark ? 'border-slate-800' : 'border-slate-200';
  const chip = isDark ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600';
  const gradeDot: Record<FrameGrade, string> = { good: 'bg-emerald-500', fair: 'bg-amber-500', bad: 'bg-red-500' };
  const buttonBase = `px-3 py-1.5 rounded-lg text-xs font-medium border transition disabled:opacity-40 disabled:cursor-not-allowed ${
    isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
  }`;
  const reference = report?.reference ?? null;
  const base = 'observationDetail.frameAnalysisModal';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t(`${base}.title`)}
      className={`relative w-full max-w-5xl h-[min(85vh,900px)] flex flex-col rounded-2xl overflow-hidden ${isDark ? 'bg-slate-900' : 'bg-white'}`}
    >
      {/* Header */}
      <div className={`flex-shrink-0 p-4 border-b ${border}`}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <ScanSearch className="w-5 h-5 text-accent-500 flex-shrink-0" />
            <div className="min-w-0">
              <span className={`font-medium text-sm block ${text}`}>{t(`${base}.title`)}</span>
              <span className={`text-xs block ${muted}`}>
                {analyzing
                  ? t(`${base}.measuring`, { done: progress.done, total: progress.total })
                  : t(`${base}.framesMeasured`, { count: measuredRows.length })}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {nights.length > 1 && (
              <label className="flex items-center gap-1.5 text-xs">
                <span className={muted}>{t(`${base}.nightLabel`)}</span>
                <select
                  value={date}
                  onChange={e => setDate(e.target.value)}
                  className={`rounded-lg border px-2 py-1.5 text-xs ${isDark ? 'bg-slate-900 border-slate-700 text-slate-300' : 'bg-white border-slate-200 text-slate-600'}`}
                >
                  {nights.map(n => (
                    <option key={n.date} value={n.date}>{t(`${base}.nightOption`, { date: n.date, count: n.count })}</option>
                  ))}
                </select>
              </label>
            )}
            {analyzing ? (
              <>
                <Loader2 className={`w-4 h-4 animate-spin ${muted}`} />
                <button onClick={stop} className={buttonBase}>{t(`${base}.stop`)}</button>
              </>
            ) : measuredRows.length > 0 && (
              <button onClick={() => void run(true)} title={t(`${base}.measureAgainTitle`)} className={`${buttonBase} flex items-center gap-1.5`}>
                <RotateCw className="w-3.5 h-3.5" />
                {t(`${base}.measureAgain`)}
              </button>
            )}
            <button
              onClick={onClose}
              aria-label={t(`${base}.close`)}
              className={`p-2 rounded-lg transition ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {analyzing && progress.total > 0 && (
          <div className={`mt-3 h-1 rounded-full overflow-hidden ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`}>
            <div
              className="h-full bg-accent-500 rounded-full transition-all duration-300"
              style={{ width: `${(progress.done / progress.total) * 100}%` }}
            />
          </div>
        )}

        {measuredRows.length > 0 && (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {(['good', 'fair', 'bad'] as const).map(g => (
                <span key={g} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs tabular-nums ${chip}`}>
                  <span className={`w-2 h-2 rounded-full ${gradeDot[g]}`} />
                  {t(`${base}.gradeCount.${g}`, { count: summary.grades[g] })}
                </span>
              ))}
              {FLAG_ORDER.filter(f => summary.flagCounts[f] > 0).map(f => {
                const Icon = FLAG_ICONS[f];
                return (
                  <span key={f} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs tabular-nums ${chip}`}>
                    <Icon className="w-3 h-3" />
                    {summary.flagCounts[f]} {t(`${base}.flags.${f}`)}
                  </span>
                );
              })}
              <span className="flex-1" />
              <div className={`flex rounded-lg border overflow-hidden ${isDark ? 'border-slate-700' : 'border-slate-200'}`} role="group" aria-label={t(`${base}.filterLabel`)}>
                {FILTERS.map(f => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    aria-pressed={filter === f}
                    className={`px-3 py-1.5 text-xs font-medium transition ${
                      filter === f
                        ? isDark ? 'bg-slate-700 text-slate-100' : 'bg-slate-200 text-slate-800'
                        : isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-50'
                    }`}
                  >
                    {t(`${base}.filters.${f}`)}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-1.5 text-xs">
                <span className={muted}>{t(`${base}.sortLabel`)}</span>
                <select
                  value={sort}
                  onChange={e => setSort(SORTS.find(s => s === e.target.value) ?? 'score')}
                  className={`rounded-lg border px-2 py-1.5 text-xs ${isDark ? 'bg-slate-900 border-slate-700 text-slate-300' : 'bg-white border-slate-200 text-slate-600'}`}
                >
                  {SORTS.map(s => <option key={s} value={s}>{t(`${base}.sorts.${s}`)}</option>)}
                </select>
              </label>
            </div>
            {reference && (
              <p className={`mt-2 text-xs ${muted}`}>
                {t(`${base}.typicalFrame`, {
                  stars: n0(reference.stars), fwhm: n1(reference.fwhm), elongation: formatNumber(reference.elongation, { maximumFractionDigits: 2 }),
                })}
              </p>
            )}
          </>
        )}
      </div>

      {/* List */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loadError && rows.length === 0 ? (
          <div className="p-10 text-center">
            <p className={`text-sm font-medium ${text}`}>{t(`${base}.loadFailed`)}</p>
            <p className={`text-xs mt-1 ${muted}`}>{loadError}</p>
          </div>
        ) : report && rows.length === 0 ? (
          <div className={`p-10 text-center text-sm ${muted}`}>{t(`${base}.noFrames`)}</div>
        ) : !report ? (
          <div className="p-10 flex justify-center"><Loader2 className={`w-6 h-6 animate-spin ${muted}`} /></div>
        ) : (
          <ul>
            {visible.map(row => (
              <li key={row.path} className={`border-b ${border}`}>
                <FrameRow
                  row={row}
                  selected={selection.has(row.path)}
                  onToggle={() => toggle(row.path)}
                  onView={() => setViewerIndex(visible.findIndex(v => v.path === row.path))}
                  placeholder={analyzing ? t(`${base}.waiting`) : t(`${base}.notMeasured`)}
                  failure={failed[row.path]}
                  t={t}
                  isDark={isDark}
                />
              </li>
            ))}
            {visible.length === 0 && (
              <li className={`p-10 text-center text-sm ${muted}`}>{t(`${base}.noMatch`)}</li>
            )}
          </ul>
        )}
      </div>

      {/* Footer */}
      <div className={`flex-shrink-0 flex flex-wrap items-center gap-2 px-5 py-3 border-t ${border}`}>
        <span className={`text-xs flex-1 min-w-[12rem] ${muted}`}>
          {discardReport
            ? discardReport
            : selection.size === 0
              ? t(`${base}.selectHint`)
              : t(`${base}.selectedCount`, { count: selection.size })}
        </span>
        <button onClick={selectBad} disabled={summary.grades.bad === 0} className={buttonBase}>{t(`${base}.selectBad`)}</button>
        <button onClick={selectFlagged} disabled={measuredRows.every(r => (r.verdict?.flags.length ?? 0) === 0)} className={buttonBase}>
          {t(`${base}.selectFlagged`)}
        </button>
        <button onClick={() => setSelection(new Set())} disabled={selection.size === 0} className={buttonBase}>{t(`${base}.clear`)}</button>
        <button
          onClick={() => { setDiscardReport(null); setConfirmDiscard(true); }}
          disabled={selection.size === 0 || discarding}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition disabled:opacity-40 disabled:cursor-not-allowed ${
            isDark ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30' : 'bg-red-50 text-red-700 hover:bg-red-100'
          }`}
        >
          {discarding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
          {t(`${base}.discard`)}
        </button>
      </div>

      <GalleryModal
        isOpen={viewerIndex !== null}
        items={visible.map((r): GalleryItem => ({ kind: 'file', file: r.file }))}
        defaultIndex={viewerIndex ?? 0}
        objectId={objectId}
        date={date}
        isAdmin
        objectName={objectName}
        frameReview={reviewFrame}
        onClose={() => {
          setViewerIndex(null);
          // A delete in the viewer must show up behind it.
          void getFrameAnalysis(objectId, date, { includeVariants }).then(setReport).catch(() => { /* the list stays as it was */ });
          onFilesDeleted();
        }}
        onEditImage={() => {}}
        onHeaderFileClick={() => {}}
        onSetAsGallery={() => {}}
        onDeleteProcessed={() => {}}
        settingGalleryId={null}
        deletingProcessedId={null}
        hideEditButton
      />

      {confirmDiscard && (
        <CloseConfirm
          isDark={isDark}
          message={
            selectedLinked > 0
              ? t(`${base}.confirmDiscardLinked`, { count: selection.size, linked: selectedLinked })
              : t(`${base}.confirmDiscard`, { count: selection.size })
          }
          cancelLabel={t(`${base}.keepFrames`)}
          onCancel={() => setConfirmDiscard(false)}
          onDiscard={() => void discardSelected()}
        />
      )}
    </Modal>
  );
}
