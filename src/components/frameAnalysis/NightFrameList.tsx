/**
 * One night's raw sub-frames as a dense, sortable list: when it was taken, its score, what is wrong with it, how
 * many stars, how wide and how trailed they are. The numbers are what tell frames apart, not their pictures.
 *
 * Opening the list measures the night: the server queues every frame it has not measured and works through them
 * on a background worker, and the list polls its own report while that runs. Frames already measured show at
 * once. The same list sits on the object page's Subframes tab (under each night) and on the night page.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, ChevronUp, Download, Link2, Loader2, Maximize2, RotateCw } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { formatTimeAuto } from '../../lib/formatLocale';
import { formatDuration } from '../../lib/captureMetrics';
import {
  getFrameAnalysis, queueFrameMeasuring, setFrameReview, downloadFrameAnalysisCsv,
  type FrameAnalysisReport, type FrameAnalysisRow, type FrameFlag, type FrameGrade,
} from '../../lib/api/frameAnalysis';
import { GalleryModal, type GalleryItem } from '../GalleryModal';
import { SubframeSelectionBar } from '../objectMedia/SubframeSelectionBar';
import { formatNumber } from '../../lib/formatLocale';
import { FLAG_ICONS, n0, n1, reasonText } from './frameFormat';
import {
  captureTime, longestGap, orderRows, sharedPrefixLength, summaryOf, timelineTicks, type SortKey,
} from './frameListLogic';

const PREVIEWS_KEY = 'nebulis_frame_list_previews';
const BASE = 'observationDetail.frameList';
const MODAL = 'observationDetail.frameAnalysisModal';
const SORT_KEYS: SortKey[] = ['time', 'score', 'stars', 'fwhm', 'round', 'noise', 'snr', 'sky', 'flags', 'file'];

function readPreviews(): boolean {
  try { return localStorage.getItem(PREVIEWS_KEY) === '1'; } catch { return false; }
}

interface Props {
  /** The base object id; variants are folded in when `includeVariants` is set. */
  objectId: string;
  objectName: string;
  date: string;
  includeVariants?: boolean;
  isAdmin: boolean;
  /** Called after frames were deleted, so the page behind can refresh its own lists and counts. */
  onFramesDeleted?: () => void;
}

export function NightFrameList({ objectId, objectName, date, includeVariants = false, isAdmin, onFramesDeleted }: Props) {
  const { t } = useTranslation('observations');
  const { isDark } = useTheme();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['frame-analysis', objectId, date, includeVariants], [objectId, date, includeVariants]);

  const report = useQuery<FrameAnalysisReport>({
    queryKey,
    queryFn: ({ signal }) => getFrameAnalysis(objectId, date, { includeVariants, signal }),
    // While the server is still measuring, ask again; stop as soon as it is idle.
    refetchInterval: q => ((q.state.data?.pending ?? 0) > 0 ? 1500 : false),
    staleTime: 5_000,
  });
  const data = report.data;

  // ── Measuring: start it once per opening, for admins (measuring is CPU work the server rations). ──────────────
  const requested = useRef<string>('');
  const failureCount = data ? Object.keys(data.failures).length : 0;
  useEffect(() => {
    if (!isAdmin || !data) return;
    const missing = data.total - data.measured - failureCount;
    const key = queryKey.join('|');
    if (missing <= 0 || data.pending > 0 || requested.current === key) return;
    requested.current = key;
    void queueFrameMeasuring(objectId, date, { includeVariants })
      .then(() => queryClient.invalidateQueries({ queryKey }))
      .catch(() => { requested.current = ''; });
  }, [isAdmin, data, failureCount, queryKey, objectId, date, includeVariants, queryClient]);

  const measureAgain = useCallback(() => {
    void queueFrameMeasuring(objectId, date, { includeVariants, force: true })
      .then(() => queryClient.invalidateQueries({ queryKey }));
  }, [objectId, date, includeVariants, queryClient, queryKey]);

  // ── What is shown ─────────────────────────────────────────────────────────
  const rows = useMemo(() => data?.frames ?? [], [data]);
  const [sortKey, setSortKey] = useState<SortKey>('time');
  const [ascending, setAscending] = useState(true);
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [previews, setPreviews] = useState(readPreviews);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [peek, setPeek] = useState<{ row: FrameAnalysisRow; rect: DOMRect; x: number } | null>(null);
  const [menu, setMenu] = useState<{ row: FrameAnalysisRow; x: number; y: number } | null>(null);
  // What the viewer just marked, shown at once; the report behind it catches up when it refetches.
  const [reviewed, setReviewed] = useState<Record<string, 'keep' | 'reject' | null>>({});

  const shown = useMemo(() => orderRows(rows, { sortKey, ascending, flaggedOnly }), [rows, sortKey, ascending, flaggedOnly]);
  const summary = useMemo(() => summaryOf(rows), [rows]);
  const trim = useMemo(() => sharedPrefixLength(rows.map(r => r.name)), [rows]);
  const gap = useMemo(() => longestGap(rows), [rows]);

  const chooseSort = (key: SortKey) => {
    if (sortKey === key) setAscending(a => !a);
    else { setSortKey(key); setAscending(true); }
  };
  const togglePreviews = () => {
    setPreviews(p => {
      try { localStorage.setItem(PREVIEWS_KEY, p ? '0' : '1'); } catch { /* per-viewer convenience only */ }
      return !p;
    });
  };
  // `K` / `X` in the viewer: mark the frame, or go back to following the grade when it is already marked that way.
  const reviewFrame = useMemo(() => ({
    stateFor: (path: string): 'keep' | 'reject' | null =>
      path in reviewed ? reviewed[path] : rows.find(r => r.path === path)?.review ?? null,
    toggle: (path: string, which: 'keep' | 'reject') => {
      const current = path in reviewed ? reviewed[path] : rows.find(r => r.path === path)?.review ?? null;
      const next = current === which ? null : which;
      setReviewed(prev => ({ ...prev, [path]: next }));
      void setFrameReview(path, next === null ? null : next === 'keep')
        .then(() => queryClient.invalidateQueries({ queryKey }))
        .catch(() => setReviewed(prev => ({ ...prev, [path]: current })));
    },
  }), [reviewed, rows, queryClient, queryKey]);

  const toggle = useCallback((path: string) => setSelection(prev => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  }), []);

  // ── Viewer: every readable frame of the night, in capture order ───────────
  const galleryItems = useMemo<GalleryItem[]>(() => rows.map(r => ({ kind: 'file', file: r.file })), [rows]);
  const openFrame = useCallback((path: string) => {
    const i = rows.findIndex(r => r.path === path);
    if (i >= 0) setViewerIndex(i);
  }, [rows]);

  const text = isDark ? 'text-slate-200' : 'text-slate-700';
  const muted = isDark ? 'text-slate-500' : 'text-slate-400';
  const border = isDark ? 'border-slate-800' : 'border-slate-200';
  const grid = `grid items-center gap-3 px-3 ${previews ? 'grid-cols-[1.25rem_2.75rem_6rem_minmax(8rem,1.4fr)_minmax(3.5rem,1fr)_minmax(3.5rem,1fr)_minmax(3.5rem,1fr)_minmax(3.5rem,1fr)_minmax(3.5rem,1fr)_minmax(3.5rem,1fr)_minmax(6rem,2fr)_10rem]' : 'grid-cols-[1.25rem_6rem_minmax(8rem,1.4fr)_minmax(3.5rem,1fr)_minmax(3.5rem,1fr)_minmax(3.5rem,1fr)_minmax(3.5rem,1fr)_minmax(3.5rem,1fr)_minmax(3.5rem,1fr)_minmax(6rem,2fr)_10rem]'}`;

  if (report.isLoading) {
    return <div className="flex justify-center py-8"><Loader2 className={`h-5 w-5 animate-spin ${muted}`} /></div>;
  }
  if (report.isError || !data) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-red-500" role="alert">
        <AlertTriangle className="h-4 w-4" />
        {t(`${MODAL}.loadFailed`)}
      </div>
    );
  }
  if (data.total === 0) {
    return <p className={`py-6 text-center text-sm ${muted}`}>{t(`${MODAL}.noFrames`)}</p>;
  }

  const measuring = data.pending > 0;
  const summaryText = data.measured < data.total
    ? t(`${BASE}.measuredOf`, { measured: data.measured, total: data.total })
    : summary.flagged === 0
      ? t(`${BASE}.allClear`)
      : summary.bad > 0
        ? t(`${BASE}.flaggedAndBad`, { flagged: summary.flagged, bad: summary.bad })
        : t(`${BASE}.flagged`, { flagged: summary.flagged });

  return (
    <div className="space-y-3">
      {/* Timeline: one tick per frame, so a gap shows as an empty stretch. */}
      <Timeline rows={rows} isDark={isDark} />
      {gap && (
        <p className={`-mt-1 text-xs ${muted}`}>
          {t(`${BASE}.longestGap`, { duration: formatDuration(gap.seconds), time: formatTimeAuto(gap.at, { hour: '2-digit', minute: '2-digit' }) })}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className={`flex items-center gap-1.5 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`} role="status">
          {measuring && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {summaryText}
        </span>
        <span className="flex-1" />
        {summary.flagged > 0 && (
          <button
            type="button"
            onClick={() => setFlaggedOnly(v => !v)}
            aria-pressed={flaggedOnly}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${
              flaggedOnly
                ? isDark ? 'border-accent-500/50 bg-accent-500/15 text-accent-300' : 'border-accent-400 bg-accent-50 text-accent-700'
                : isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}
          >
            {t(`${BASE}.flaggedOnly`)}
          </button>
        )}
        <button
          type="button"
          onClick={togglePreviews}
          aria-pressed={previews}
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${
            previews
              ? isDark ? 'border-slate-600 bg-slate-700 text-slate-100' : 'border-slate-300 bg-slate-200 text-slate-800'
              : isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
          }`}
        >
          {t(`${BASE}.previews`)}
        </button>
        <button
          type="button"
          onClick={() => { void downloadFrameAnalysisCsv(objectId, date, includeVariants).catch(() => undefined); }}
          title={t(`${BASE}.exportCsvTitle`)}
          className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${
            isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
          }`}
        >
          <Download className="h-3.5 w-3.5" />
          {t(`${BASE}.exportCsv`)}
        </button>
        {isAdmin && !measuring && data.measured > 0 && (
          <button
            type="button"
            onClick={measureAgain}
            title={t(`${MODAL}.measureAgainTitle`)}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${
              isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}
          >
            <RotateCw className="h-3.5 w-3.5" />
            {t(`${MODAL}.measureAgain`)}
          </button>
        )}
      </div>

      <div className={`overflow-x-auto rounded-xl border ${border}`}>
        <div className="min-w-[56rem]">
          {/* Column headers: every one sorts. */}
          <div
            role="row"
            className={`${grid} sticky top-0 z-10 border-b py-2 text-[0.625rem] font-semibold uppercase tracking-wide ${border} ${
              isDark ? 'bg-slate-900' : 'bg-slate-50'
            }`}
          >
            <span />
            {previews && <span />}
            {SORT_KEYS.map(key => {
              const active = sortKey === key;
              const right = key === 'stars' || key === 'fwhm' || key === 'round' || key === 'noise' || key === 'snr' || key === 'sky' || key === 'file';
              return (
                <button
                  key={key}
                  type="button"
                  role="columnheader"
                  aria-sort={active ? (ascending ? 'ascending' : 'descending') : 'none'}
                  onClick={() => chooseSort(key)}
                  title={t(`${BASE}.sortHint.${key}`)}
                  className={`flex items-center gap-0.5 uppercase focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${
                    right ? 'justify-end' : 'justify-start'
                  } ${active ? (isDark ? 'text-slate-100' : 'text-slate-900') : muted}`}
                >
                  {t(`${BASE}.column.${key}`)}
                  {active && (ascending ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
                </button>
              );
            })}
          </div>

          <ul>
            {shown.map(row => (
              <FrameLine
                key={row.path}
                row={row}
                failure={data.failures[row.path]}
                trim={trim}
                previews={previews}
                selected={selection.has(row.path)}
                gridClass={grid}
                pendingMeasure={measuring}
                isDark={isDark}
                border={border}
                onToggle={toggle}
                onOpen={openFrame}
                onPeek={(r, rect, x) => setPeek(rect ? { row: r, rect, x: x ?? rect.left } : null)}
                onMenu={(r, x, y) => { setPeek(null); setMenu({ row: r, x, y }); }}
              />
            ))}
            {shown.length === 0 && (
              <li className={`py-8 text-center text-sm ${muted}`}>{t(`${MODAL}.noMatch`)}</li>
            )}
          </ul>
        </div>
      </div>

      {isAdmin && (
        <SubframeSelectionBar
          selection={selection}
          badCount={summary.badPaths.length}
          flaggedCount={summary.flaggedPaths.length}
          onSelectBad={() => setSelection(new Set(summary.badPaths))}
          onSelectFlagged={() => setSelection(new Set(summary.flaggedPaths))}
          onClear={() => setSelection(new Set())}
          onReview={async keep => {
            await Promise.allSettled([...selection].map(path => setFrameReview(path, keep)));
            await queryClient.invalidateQueries({ queryKey });
          }}
          onDeleted={() => {
            setSelection(new Set());
            void queryClient.invalidateQueries({ queryKey });
            onFramesDeleted?.();
          }}
        />
      )}

      <GalleryModal
        isOpen={viewerIndex !== null}
        items={galleryItems}
        defaultIndex={viewerIndex ?? 0}
        objectId={objectId}
        date={date}
        isAdmin={isAdmin}
        objectName={objectName}
        frameReview={reviewFrame}
        onClose={() => {
          setViewerIndex(null);
          // A delete in the viewer must show up behind it.
          void queryClient.invalidateQueries({ queryKey });
          onFramesDeleted?.();
        }}
        onEditImage={() => {}}
        onHeaderFileClick={() => {}}
        onSetAsGallery={() => {}}
        onDeleteProcessed={() => {}}
        settingGalleryId={null}
        deletingProcessedId={null}
        hideEditButton
      />
      {peek && !menu && <FramePeek row={peek.row} rect={peek.rect} pointerX={peek.x} isDark={isDark} />}
      {menu && (
        <FrameMenu
          row={menu.row}
          x={menu.x}
          y={menu.y}
          isDark={isDark}
          onOpen={() => openFrame(menu.row.path)}
          onClose={() => setMenu(null)}
        />
      )}
      <span className={`sr-only ${text}`}>{objectName}</span>
    </div>
  );
}

// ─── Rows ──────────────────────────────────────────────────────────────────

interface LineProps {
  row: FrameAnalysisRow;
  failure: string | undefined;
  trim: number;
  previews: boolean;
  selected: boolean;
  gridClass: string;
  pendingMeasure: boolean;
  isDark: boolean;
  border: string;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  /** The pointer rested on the row (with its box and where it was), or left it (null). */
  onPeek: (row: FrameAnalysisRow, rect: DOMRect | null, pointerX?: number) => void;
  onMenu: (row: FrameAnalysisRow, x: number, y: number) => void;
}

function FrameLine({ row, failure, trim, previews, selected, gridClass, pendingMeasure, isDark, border, onToggle, onOpen, onPeek, onMenu }: LineProps) {
  const { t } = useTranslation('observations');
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerX = useRef(0);
  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);
  const m = row.metrics;
  const v = row.verdict;
  const muted = isDark ? 'text-slate-500' : 'text-slate-400';
  const strong = isDark ? 'text-slate-100' : 'text-slate-900';
  const body = isDark ? 'text-slate-300' : 'text-slate-600';
  const bad = v?.grade === 'bad';
  const tinted = bad ? (isDark ? 'bg-red-500/10' : 'bg-red-50') : (v && v.flags.length > 0) ? 'bg-accent-500/10' : '';
  const tint = bad ? (isDark ? 'text-red-300' : 'text-red-700') : (isDark ? 'text-accent-300' : 'text-accent-700');
  const tintBg = bad ? (isDark ? 'bg-red-500/15' : 'bg-red-100') : (isDark ? 'bg-accent-500/15' : 'bg-accent-100');
  const when = captureTime(row.timestamp);
  const trailing = v?.flags.includes('trails') === true;
  const time = when ? formatTimeAuto(when, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '–';
  const shortName = trim > 0 ? row.name.slice(trim) : row.name;
  const flags = v?.flags ?? [];
  const tooltip = failure
    ? t(`${MODAL}.unreadable`, { reason: failure })
    : [row.name, ...(v ? [`${t(`${MODAL}.grades.${v.grade}`)} · ${v.score}`] : [])].join('\n');
  const gradeBar: Record<FrameGrade, string> = { good: 'bg-emerald-500', fair: 'bg-amber-500', bad: 'bg-red-500' };

  return (
    <li className={`border-b last:border-b-0 ${border}`}>
      <div
        className={`${gridClass} py-1.5 text-xs transition ${selected ? 'bg-accent-500/15' : tinted} ${isDark ? 'hover:bg-slate-800/60' : 'hover:bg-slate-50'}`}
        onMouseMove={e => { pointerX.current = e.clientX; }}
        onMouseEnter={e => {
          // Resting on a row for a moment shows the frame, so looking costs nothing. Not for touch, which has no rest.
          const el = e.currentTarget;
          pointerX.current = e.clientX;
          if (hoverTimer.current) clearTimeout(hoverTimer.current);
          hoverTimer.current = setTimeout(() => onPeek(row, el.getBoundingClientRect(), pointerX.current), 450);
        }}
        onMouseLeave={() => {
          if (hoverTimer.current) clearTimeout(hoverTimer.current);
          onPeek(row, null);
        }}
        onContextMenu={e => {
          e.preventDefault();
          if (hoverTimer.current) clearTimeout(hoverTimer.current);
          onMenu(row, e.clientX, e.clientY);
        }}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggle(row.path)}
          aria-label={t(`${MODAL}.selectFrame`, { name: row.name })}
          className="h-3.5 w-3.5 accent-accent-500"
        />
        {previews && (
          <button
            type="button"
            onClick={() => onOpen(row.path)}
            tabIndex={-1}
            aria-hidden
            className={`h-11 w-11 overflow-hidden rounded ${isDark ? 'bg-black' : 'bg-slate-100'}`}
          >
            {row.thumbUrl && <img src={row.thumbUrl} alt="" loading="lazy" className="h-full w-full object-contain" />}
          </button>
        )}
        <button
          type="button"
          onClick={() => onOpen(row.path)}
          title={tooltip}
          className={`col-span-1 text-left tabular-nums focus:outline-none focus-visible:underline ${strong}`}
        >
          {time}
        </button>

        <span className="flex items-center gap-2">
          {v ? (
            <>
              <span className={`w-6 text-right tabular-nums ${strong}`}>{v.score}</span>
              <span className={`h-1.5 max-w-40 flex-1 overflow-hidden rounded-full ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`}>
                <span className={`block h-full rounded-full ${gradeBar[v.grade]}`} style={{ width: `${Math.max(0, Math.min(100, v.score))}%` }} />
              </span>
            </>
          ) : failure ? (
            <AlertTriangle className="h-3.5 w-3.5 text-red-500" aria-label={t(`${MODAL}.unreadable`, { reason: failure })} />
          ) : pendingMeasure ? (
            <Loader2 className={`h-3 w-3 animate-spin ${muted}`} />
          ) : (
            <span className={muted}>{t(`${BASE}.notMeasured`)}</span>
          )}
        </span>

        <span className={`text-right tabular-nums ${body}`}>{m ? n0(m.starCount) : '–'}</span>
        <span className={`text-right tabular-nums ${body}`}>{m?.fwhm != null ? formatNumber(m.fwhm, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '–'}</span>
        <span className={`text-right tabular-nums ${trailing ? `font-semibold ${tint}` : body}`}>
          {m?.elongation != null ? formatNumber(m.elongation, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '–'}
        </span>
        <span className={`text-right tabular-nums ${body}`}>{m ? n1(m.noise) : '–'}</span>
        <span className={`text-right tabular-nums ${body}`}>{m?.peakSNR != null ? `${n0(m.peakSNR)}×` : '–'}</span>
        <span className={`text-right tabular-nums ${body}`}>{m ? n0(m.background) : '–'}</span>
        <span className="flex min-w-0 items-center gap-1.5" title={v?.reasons.length ? flags.map(f => t(`${MODAL}.flags.${f}`)).join(', ') : undefined}>
          {flags.slice(0, 2).map(f => <FlagChip key={f} flag={f} tint={tint} bg={tintBg} label={t(`${MODAL}.flags.${f}`)} />)}
          {flags.length > 2 && <span className={`text-[0.6562rem] font-medium ${tint}`}>{t(`${BASE}.moreFlags`, { count: flags.length - 2 })}</span>}
          {row.review && (
            <span className={`whitespace-nowrap rounded-full px-1.5 py-0.5 text-[0.6562rem] font-medium ${
              row.review === 'keep'
                ? isDark ? 'bg-emerald-500/15 text-emerald-300' : 'bg-emerald-50 text-emerald-700'
                : isDark ? 'bg-red-500/15 text-red-300' : 'bg-red-50 text-red-700'
            }`}>
              {t(`${BASE}.review.${row.review}`)}
            </span>
          )}
        </span>

        <span className={`truncate text-right ${muted}`} title={row.name}>{shortName}</span>
      </div>
    </li>
  );
}

function FlagChip({ flag, tint, bg, label }: { flag: FrameFlag; tint: string; bg: string; label: string }) {
  const Icon = FLAG_ICONS[flag];
  return (
    <span className={`flex items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[0.6562rem] font-medium ${tint} ${bg}`}>
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}

// ─── Timeline ──────────────────────────────────────────────────────────────

function Timeline({ rows, isDark }: { rows: FrameAnalysisRow[]; isDark: boolean }) {
  const { t } = useTranslation('observations');
  const stamped = rows.flatMap(r => { const d = captureTime(r.timestamp); return d ? [{ row: r, at: d.getTime() }] : []; });
  if (stamped.length < 2) return null;
  const first = Math.min(...stamped.map(s => s.at));
  const last = Math.max(...stamped.map(s => s.at));
  if (last <= first) return null;
  const color: Record<FrameGrade, string> = { good: 'bg-emerald-500', fair: 'bg-amber-500', bad: 'bg-red-500' };
  return (
    <div>
      <div
        className={`relative h-[18px] overflow-hidden rounded ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`}
        role="img"
        aria-label={t(`${BASE}.timelineLabel`)}
      >
        {stamped.map(({ row, at }) => (
          <span
            key={row.path}
            className={`absolute top-[2px] bottom-[2px] w-[2px] ${row.verdict ? color[row.verdict.grade] : isDark ? 'bg-slate-500' : 'bg-slate-400'}`}
            style={{ left: `calc(${((at - first) / (last - first)) * 100}% - 1px)` }}
          />
        ))}
      </div>
      {/* Round times along the axis, with a small tick under the bar for each. The first and last frames' times stay at the ends. */}
      <div className={`relative mt-1 h-7 text-[0.6562rem] tabular-nums ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
        <span className="absolute left-0 top-1.5">{formatTimeAuto(new Date(first), { hour: '2-digit', minute: '2-digit' })}</span>
        {timelineTicks(first, last).map((tick, i) => (
          // On a phone only every other label fits.
          <span key={tick.at} aria-hidden="true" className={`absolute top-0 -translate-x-1/2 ${i % 2 === 1 ? 'hidden sm:block' : ''}`} style={{ left: `${tick.fraction * 100}%` }}>
            <span className={`mx-auto block h-1 w-px ${isDark ? 'bg-slate-600' : 'bg-slate-300'}`} />
            <span className="block pt-0.5">{formatTimeAuto(new Date(tick.at), { hour: '2-digit', minute: '2-digit' })}</span>
          </span>
        ))}
        <span className="absolute right-0 top-1.5">{formatTimeAuto(new Date(last), { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
    </div>
  );
}

// ─── Peek and menu ─────────────────────────────────────────────────────────

const PEEK_WIDTH = 296;

/** What a resting pointer shows over a row: the frame larger, its grade, and every reason in words. */
function FramePeek({ row, rect, pointerX, isDark }: { row: FrameAnalysisRow; rect: DOMRect; pointerX: number; isDark: boolean }) {
  const { t } = useTranslation('observations');
  const v = row.verdict;
  const src = row.file.previewUrl ?? row.thumbUrl;
  // Just right of the pointer, so the time, score and flags to its left stay readable; on its left only when
  // there is no room. Never past the bottom of the window.
  const room = window.innerWidth - pointerX - 24;
  const left = room >= PEEK_WIDTH ? pointerX + 24 : Math.max(8, pointerX - PEEK_WIDTH - 24);
  const top = Math.min(Math.max(8, rect.top - 8), Math.max(8, window.innerHeight - 380));
  return createPortal(
    <div
      role="tooltip"
      className={`pointer-events-none fixed z-[70] rounded-xl border p-3 shadow-xl ${
        isDark ? 'border-slate-700 bg-slate-900 text-slate-200' : 'border-slate-200 bg-white text-slate-700'
      }`}
      style={{ left, top, width: PEEK_WIDTH }}
    >
      {src && <img src={src} alt="" className="mb-2 max-h-64 w-full rounded-md bg-black object-contain" />}
      <p className="truncate text-xs font-medium" title={row.name}>{row.name}</p>
      {v && (
        <>
          <p className="mt-1 text-xs font-semibold">{t(`${MODAL}.grades.${v.grade}`)} · {v.score}</p>
          <ul className={`mt-1 space-y-1 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            {v.reasons.map(r => <li key={r.flag}>{reasonText(t, r)}</li>)}
          </ul>
        </>
      )}
    </div>,
    document.body,
  );
}

/** The right-click menu of a row. Closes on Escape, on a click anywhere else, and on scroll. */
function FrameMenu({ row, x, y, isDark, onOpen, onClose }: {
  row: FrameAnalysisRow; x: number; y: number; isDark: boolean; onOpen: () => void; onClose: () => void;
}) {
  const { t } = useTranslation('observations');
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onClose, true);
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  const item = `flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition focus:outline-none ${
    isDark ? 'text-slate-200 hover:bg-slate-800 focus:bg-slate-800' : 'text-slate-700 hover:bg-slate-100 focus:bg-slate-100'
  }`;
  const copy = () => {
    const url = new URL(row.downloadUrl, window.location.origin).toString();
    void navigator.clipboard.writeText(url).then(() => { setCopied(true); setTimeout(onClose, 700); }, onClose);
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className={`fixed z-[70] min-w-[11rem] overflow-hidden rounded-lg border py-1 shadow-xl ${
        isDark ? 'border-slate-700 bg-slate-900' : 'border-slate-200 bg-white'
      }`}
      style={{ left: Math.min(x, window.innerWidth - 190), top: Math.min(y, window.innerHeight - 130) }}
    >
      <button role="menuitem" type="button" className={item} onClick={() => { onOpen(); onClose(); }}>
        <Maximize2 className="h-3.5 w-3.5" />
        {t(`${BASE}.menu.open`)}
      </button>
      <a role="menuitem" className={item} href={row.downloadUrl} download={row.name} onClick={onClose}>
        <Download className="h-3.5 w-3.5" />
        {t(`${BASE}.menu.download`)}
      </a>
      <button role="menuitem" type="button" className={item} onClick={copy}>
        <Link2 className="h-3.5 w-3.5" />
        {copied ? t(`${BASE}.menu.copied`) : t(`${BASE}.menu.copyLink`)}
      </button>
    </div>,
    document.body,
  );
}
