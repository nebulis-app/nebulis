import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import { X, Download, RotateCw, CheckSquare, Square, Layers, PackageCheck, XCircle, AlertCircle, Filter } from 'lucide-react';
import {
  getLibrarySessions,
  getSubframeFilters,
  startSubframesArchive,
  getSubframesArchiveStatus,
  cancelSubframesArchive,
  type SubframesArchiveStatus,
} from '../lib/api/library';
import { useTheme } from '../hooks/useTheme';
import { Modal } from './ui/Modal';
import { CloseConfirm } from './ui/CloseConfirm';
import { rememberCombinedSessions } from '../lib/lastCombinedSessions';
import { formatDate } from '../lib/formatLocale';

interface Props {
  objectId: string;
  onClose: () => void;
}

type Phase = 'select' | 'filter-select' | 'preparing' | 'done';
type TFunc = (key: string, opts?: Record<string, unknown>) => string;

// Filter codes are a fixed, known set reported by the telescope firmware, not
// free text, so each maps to its own translated key rather than being passed
// through t() directly.
const FILTER_LABEL_KEYS: Record<string, string> = {
  IRCUT: 'observationDetail.combineSubframesModal.filterLabels.ircut',
  LP: 'observationDetail.combineSubframesModal.filterLabels.lp',
  LPRO: 'observationDetail.combineSubframesModal.filterLabels.lpro',
  Ha: 'observationDetail.combineSubframesModal.filterLabels.ha',
  OIII: 'observationDetail.combineSubframesModal.filterLabels.oiii',
  SII: 'observationDetail.combineSubframesModal.filterLabels.sii',
  Astro: 'observationDetail.combineSubframesModal.filterLabels.astro',
  'Duo-Band': 'observationDetail.combineSubframesModal.filterLabels.duoBand',
  DualBand: 'observationDetail.combineSubframesModal.filterLabels.dualBand',
};

function filterLabel(t: TFunc, f: string): string {
  const key = FILTER_LABEL_KEYS[f];
  return key ? t(key) : f;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(t: TFunc, ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return t('observationDetail.combineSubframesModal.durationSeconds', { count: s });
  return t('observationDetail.combineSubframesModal.durationMinutesSeconds', { minutes: Math.floor(s / 60), seconds: s % 60 });
}

export function CombineSubframesModal({ objectId, onClose }: Props) {
  const { isDark } = useTheme();
  const { t } = useTranslation('observations');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<Phase>('select');
  const [zipSize, setZipSize] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [jobStatus, setSubframesArchiveStatus] = useState<SubframesArchiveStatus | null>(null);
  const [selectedFilters, setSelectedFilters] = useState<Set<string>>(new Set());
  const [sirilLayout, setSirilLayout] = useState(false);
  const [keptOnly, setKeptOnly] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelledRef = useRef(false);
  // The in-flight ZIP job id, so cancel / unmount can stop the server-side
  // build (not just the poll). Cleared once the job reaches a terminal state.
  const jobIdRef = useRef<string | null>(null);
  // Guards against request pile-up: if the server is slow (e.g. mid zip of a
  // large archive) and one status check takes longer than the 500ms interval,
  // every tick would otherwise stack another concurrent request against the
  // machine already busy doing the zip.
  const pollInFlightRef = useRef(false);

  // A mosaic/Ha/etc. variant's sub-frames live under that variant's own
  // object id, not the base object's, so this must pull sessions across the
  // whole variant family — same as what the object page's Observations grid
  // shows — or a mosaic-only target (all subs under `<name>_Mosaic`) looks
  // like it has nothing to combine.
  const { data: sessions, isLoading } = useQuery({
    queryKey: ['library-sessions', objectId, 'includeVariants'],
    queryFn: () => getLibrarySessions(objectId, { includeVariants: true }),
  });

  const sessionsWithSubs = (sessions ?? []).filter(s => s.subFrameCount > 0);

  const selectedDates = Array.from(selected);

  const { data: filtersData, isFetching: filtersLoading } = useQuery({
    queryKey: ['subframe-filters', objectId, selectedDates.join(',')],
    queryFn: () => getSubframeFilters(objectId, selectedDates, true),
    enabled: selectedDates.length > 0,
    staleTime: 30_000,
  });

  const availableFilters = filtersData?.filters ?? [];
  const availableFiltersKey = availableFilters.join(',');

  // Keep selectedFilters in sync when available filters change. Keyed on the
  // joined content, not the array itself: `?? []` hands back a fresh array
  // reference every render even when the underlying filters have not changed,
  // which would otherwise re-run this and stomp the user's own selection.
  useEffect(() => {
    if (availableFilters.length > 0) {
      setSelectedFilters(new Set(availableFilters));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableFiltersKey]);

  // Stop polling AND the server-side build on unmount — otherwise the ZIP of
  // tens of GB keeps being written to the tmp dir after the modal is gone.
  useEffect(() => () => {
    cancelledRef.current = true;
    if (pollRef.current) clearInterval(pollRef.current);
    if (jobIdRef.current) {
      void cancelSubframesArchive(jobIdRef.current).catch(() => {});
      jobIdRef.current = null;
    }
  }, []);

  function toggleAll() {
    if (selected.size === sessionsWithSubs.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(sessionsWithSubs.map(s => s.date)));
    }
  }

  function toggle(date: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  }

  function toggleFilter(f: string) {
    setSelectedFilters(prev => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  }

  function toggleAllFilters() {
    if (selectedFilters.size === availableFilters.length) {
      setSelectedFilters(new Set());
    } else {
      setSelectedFilters(new Set(availableFilters));
    }
  }

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  function handleCancel() {
    cancelledRef.current = true;
    stopPolling();
    if (jobIdRef.current) {
      void cancelSubframesArchive(jobIdRef.current).catch(() => {});
      jobIdRef.current = null;
    }
    setPhase('select');
    setSubframesArchiveStatus(null);
  }

  async function pollStatus(jobId: string) {
    if (pollInFlightRef.current) return;
    pollInFlightRef.current = true;
    try {
      const status = await getSubframesArchiveStatus(jobId);
      if (cancelledRef.current) return;

      setSubframesArchiveStatus(status);

      if (status.status === 'done') {
        stopPolling();
        jobIdRef.current = null;
        setZipSize(status.size ?? 0);
        setPhase('done');
        // Hand these nights to UploadProcessedModal so bringing the external
        // stack back in doesn't require re-picking the same sessions.
        rememberCombinedSessions(objectId, Array.from(selected));
        const a = document.createElement('a');
        a.href = `/api/library/download/tmp/${status.token}`;
        a.click();
      } else if (status.status === 'error' || status.status === 'cancelled') {
        stopPolling();
        jobIdRef.current = null;
        if (status.status === 'error') setError(status.error ?? t('observationDetail.combineSubframesModal.archiveFailed'));
        setPhase('select');
        setSubframesArchiveStatus(null);
      }
    } catch {
      // network hiccup — keep polling
    } finally {
      pollInFlightRef.current = false;
    }
  }

  async function startArchive(filters?: string[]) {
    cancelledRef.current = false;
    pollInFlightRef.current = false;
    setPhase('preparing');
    setError(null);
    setSubframesArchiveStatus(null);

    try {
      const { jobId, filesTotal } = await startSubframesArchive(objectId, Array.from(selected), filters, true, sirilLayout, keptOnly);
      if (cancelledRef.current) {
        void cancelSubframesArchive(jobId).catch(() => {});
        return;
      }
      jobIdRef.current = jobId;

      setSubframesArchiveStatus({ status: 'running', filesTotal, filesDone: 0, elapsedMs: 0 });
      pollRef.current = setInterval(() => pollStatus(jobId), 500);
    } catch (err) {
      if (!cancelledRef.current) {
        setError(err instanceof Error ? err.message : t('observationDetail.combineSubframesModal.downloadFailed'));
        setPhase('select');
      }
    }
  }

  function handleDownload() {
    if (selected.size === 0) return;

    // If there are multiple distinct filter types, show the filter selection step
    if (availableFilters.length > 1) {
      setPhase('filter-select');
      return;
    }

    // Single filter or no filters: proceed directly
    void startArchive();
  }

  function handleFilterDownload() {
    const filters = availableFilters.length > 1 ? Array.from(selectedFilters) : undefined;
    void startArchive(filters);
  }

  const allSelected = sessionsWithSubs.length > 0 && selected.size === sessionsWithSubs.length;
  const allFiltersSelected = availableFilters.length > 0 && selectedFilters.size === availableFilters.length;

  const totalSubFrames = sessionsWithSubs
    .filter(s => selected.has(s.date))
    .reduce((sum, s) => sum + s.subFrameCount, 0);

  const pct = jobStatus && jobStatus.filesTotal > 0
    ? Math.round((jobStatus.filesDone / jobStatus.filesTotal) * 100)
    : 0;

  const etaMs = jobStatus && jobStatus.filesDone > 0
    ? (jobStatus.elapsedMs / jobStatus.filesDone) * (jobStatus.filesTotal - jobStatus.filesDone)
    : null;

  const isDirty = phase === 'select' && selected.size > 0;
  const [confirmingClose, setConfirmingClose] = useState(false);
  const requestClose = () => {
    if (phase === 'preparing') return;
    if (isDirty) setConfirmingClose(true);
    else onClose();
  };

  return (
    <Modal
      isOpen
      onClose={requestClose}
      title={t('observationDetail.combineSubframesModal.title')}
      className={`relative w-full max-w-lg rounded-2xl shadow-2xl flex flex-col ${
        isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white shadow-xl'
      }`}
    >
        {/* Header */}
        <div className={`flex items-center justify-between px-5 py-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
          <div className="flex items-center gap-2">
            {phase === 'filter-select'
              ? <Filter className="w-4 h-4 text-accent-500" />
              : <Layers className="w-4 h-4 text-accent-500" />}
            <h2 className={`font-display font-semibold text-base ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
              {phase === 'filter-select' ? t('observationDetail.combineSubframesModal.selectFilterTypes') : t('observationDetail.combineSubframesModal.headerTitle')}
            </h2>
          </div>
          {(phase === 'select' || phase === 'filter-select') && (
            <button
              onClick={requestClose}
              className={`p-1.5 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Body */}
        {phase === 'select' ? (
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2 max-h-96">
            {isLoading ? (
              <div className="flex items-center justify-center py-10">
                <RotateCw className={`w-5 h-5 animate-spin ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
              </div>
            ) : sessionsWithSubs.length === 0 ? (
              <div className={`text-center py-10 text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                {t('observationDetail.combineSubframesModal.noSessionsFound')}
              </div>
            ) : (
              <>
                <button
                  onClick={toggleAll}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition ${
                    isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-50 text-slate-500'
                  }`}
                >
                  {allSelected
                    ? <CheckSquare className="w-4 h-4 text-accent-500 shrink-0" />
                    : <Square className="w-4 h-4 shrink-0" />}
                  {t('observationDetail.combineSubframesModal.selectAll')}
                </button>

                <div className={`border-t ${isDark ? 'border-slate-800' : 'border-slate-100'}`} />

                {sessionsWithSubs.map(session => {
                  const isChecked = selected.has(session.date);
                  const label = session.date !== 'unknown'
                    ? formatDate(new Date(session.date + 'T12:00:00'), {
                        year: 'numeric', month: 'long', day: 'numeric',
                      })
                    : t('observationDetail.combineSubframesModal.unknownDate');

                  return (
                    <button
                      key={session.date}
                      onClick={() => toggle(session.date)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition ${
                        isChecked
                          ? isDark ? 'bg-accent-500/10 text-slate-100' : 'bg-accent-300 text-accent-700'
                          : isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-50 text-slate-700'
                      }`}
                    >
                      {isChecked
                        ? <CheckSquare className="w-4 h-4 text-accent-500 shrink-0" />
                        : <Square className={`w-4 h-4 shrink-0 ${isDark ? 'text-slate-600' : 'text-slate-300'}`} />}
                      <span className="flex-1 text-left">{label}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-md ${
                        isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-500'
                      }`}>
                        {t('observationDetail.combineSubframesModal.subframeCount', { count: session.subFrameCount })}
                      </span>
                    </button>
                  );
                })}
              </>
            )}
          </div>
        ) : phase === 'filter-select' ? (
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2 max-h-96">
            <p className={`text-xs pb-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              {t('observationDetail.combineSubframesModal.multipleFilterTypesHint')}
            </p>

            <button
              onClick={toggleAllFilters}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition ${
                isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-50 text-slate-500'
              }`}
            >
              {allFiltersSelected
                ? <CheckSquare className="w-4 h-4 text-accent-500 shrink-0" />
                : <Square className="w-4 h-4 shrink-0" />}
              {t('observationDetail.combineSubframesModal.selectAll')}
            </button>

            <div className={`border-t ${isDark ? 'border-slate-800' : 'border-slate-100'}`} />

            {availableFilters.map(f => {
              const isChecked = selectedFilters.has(f);
              return (
                <button
                  key={f}
                  onClick={() => toggleFilter(f)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition ${
                    isChecked
                      ? isDark ? 'bg-accent-500/10 text-slate-100' : 'bg-accent-300 text-accent-700'
                      : isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-50 text-slate-700'
                  }`}
                >
                  {isChecked
                    ? <CheckSquare className="w-4 h-4 text-accent-500 shrink-0" />
                    : <Square className={`w-4 h-4 shrink-0 ${isDark ? 'text-slate-600' : 'text-slate-300'}`} />}
                  <span className="flex-1 text-left">{filterLabel(t, f)}</span>
                  <span className={`text-xs font-mono px-2 py-0.5 rounded-md ${
                    isDark ? 'bg-slate-800 text-slate-500' : 'bg-slate-100 text-slate-400'
                  }`}>
                    {f}
                  </span>
                </button>
              );
            })}
          </div>
        ) : phase === 'preparing' ? (
          <div className="px-5 py-8 space-y-5">
            <div className="flex flex-col items-center gap-3 text-center">
              <div className={`w-12 h-12 rounded-full flex items-center justify-center ${isDark ? 'bg-accent-500/15' : 'bg-accent-50'}`}>
                <RotateCw className="w-5 h-5 text-accent-500 animate-spin" />
              </div>
              <div>
                <p className={`font-medium text-sm ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
                  {t('observationDetail.combineSubframesModal.buildingArchive')}
                </p>
                <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  {jobStatus
                    ? t('observationDetail.combineSubframesModal.filesPacked', { done: jobStatus.filesDone, total: jobStatus.filesTotal })
                    : t('observationDetail.combineSubframesModal.preparingSubframes', { count: totalSubFrames })}
                </p>
              </div>
            </div>

            {/* Progress bar */}
            <div className="space-y-1.5">
              <div className={`w-full h-2.5 rounded-full overflow-hidden ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                <div
                  className="h-full rounded-full bg-accent-500 transition-all duration-300"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className={isDark ? 'text-slate-400' : 'text-slate-500'}>
                  {pct}%
                </span>
                <span className={isDark ? 'text-slate-500' : 'text-slate-400'}>
                  {jobStatus && jobStatus.elapsedMs > 0 ? (
                    etaMs !== null && etaMs > 500
                      ? t('observationDetail.combineSubframesModal.timeRemaining', { time: formatTime(t, etaMs) })
                      : t('observationDetail.combineSubframesModal.timeElapsed', { time: formatTime(t, jobStatus.elapsedMs) })
                  ) : null}
                </span>
              </div>
            </div>

            <p className={`text-center text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {t('observationDetail.combineSubframesModal.browserWillDownload')}
            </p>

            <div className="flex justify-center">
              <button
                onClick={handleCancel}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition ${
                  isDark
                    ? 'border border-slate-700 text-slate-300 hover:bg-slate-800'
                    : 'border border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                <XCircle className="w-4 h-4" />
                {t('confirmModal.cancel', { ns: 'common' })}
              </button>
            </div>
          </div>
        ) : (
          <div className="px-5 py-8 flex flex-col items-center gap-3 text-center">
            <div className={`w-12 h-12 rounded-full flex items-center justify-center ${isDark ? 'bg-emerald-500/15' : 'bg-emerald-50'}`}>
              <PackageCheck className="w-5 h-5 text-emerald-500" />
            </div>
            <div>
              <p className={`font-medium text-sm ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
                {t('observationDetail.combineSubframesModal.downloadStarted')}
              </p>
              <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                {zipSize > 0
                  ? t('observationDetail.combineSubframesModal.zipDownloadingSized', { size: formatBytes(zipSize) })
                  : t('observationDetail.combineSubframesModal.zipDownloadingGeneric')}
              </p>
            </div>
            <button
              onClick={onClose}
              className="mt-2 px-4 py-2 rounded-xl text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition"
            >
              {t('observationDetail.combineSubframesModal.closeButton')}
            </button>
          </div>
        )}

        {/* Siril layout option — session select phase */}
        {phase === 'select' && sessionsWithSubs.length > 0 && (
          <div className={`px-5 pt-3 pb-1 border-t ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
            <button
              onClick={() => setKeptOnly(v => !v)}
              className={`w-full flex items-start gap-3 px-3 py-2.5 rounded-xl text-sm text-left transition ${
                keptOnly
                  ? isDark ? 'bg-accent-500/10 text-slate-100' : 'bg-accent-300 text-accent-700'
                  : isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-50 text-slate-700'
              }`}
            >
              {keptOnly
                ? <CheckSquare className="w-4 h-4 text-accent-500 shrink-0 mt-0.5" />
                : <Square className={`w-4 h-4 shrink-0 mt-0.5 ${isDark ? 'text-slate-600' : 'text-slate-300'}`} />}
              <span className="flex-1">
                <span className="block font-medium">{t('observationDetail.combineSubframesModal.keptOnlyOption')}</span>
                <span className={`block text-xs mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  {t('observationDetail.combineSubframesModal.keptOnlyHint')}
                </span>
              </span>
            </button>
            <button
              onClick={() => setSirilLayout(v => !v)}
              className={`w-full flex items-start gap-3 px-3 py-2.5 rounded-xl text-sm text-left transition ${
                sirilLayout
                  ? isDark ? 'bg-accent-500/10 text-slate-100' : 'bg-accent-300 text-accent-700'
                  : isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-50 text-slate-700'
              }`}
            >
              {sirilLayout
                ? <CheckSquare className="w-4 h-4 text-accent-500 shrink-0 mt-0.5" />
                : <Square className={`w-4 h-4 shrink-0 mt-0.5 ${isDark ? 'text-slate-600' : 'text-slate-300'}`} />}
              <span className="flex-1">
                <span className="block font-medium">{t('observationDetail.combineSubframesModal.sirilLayoutOption')}</span>
                <span className={`block text-xs mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  <Trans
                    i18nKey="observationDetail.combineSubframesModal.sirilLayoutHint"
                    ns="observations"
                    values={{ path: `${objectId}/lights/` }}
                    components={{ 1: <span className="font-mono" /> }}
                  />
                </span>
              </span>
            </button>
          </div>
        )}

        {/* Footer — session select phase */}
        {phase === 'select' && (
          <div className={`px-5 py-4 border-t flex items-center justify-between gap-3 ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
            {error ? (
              <p className="text-xs text-red-500 flex items-center gap-1.5 flex-1">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                {error}
              </p>
            ) : (
              <p className={`text-xs flex-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                {selected.size > 0
                  ? `${t('observationDetail.combineSubframesModal.sessionsSelectedCount', { count: selected.size })} · ${t('observationDetail.combineSubframesModal.subframeCount', { count: totalSubFrames })}`
                  : t('observationDetail.combineSubframesModal.selectSessionsPrompt')}
              </p>
            )}
            <div className="flex gap-2 shrink-0">
              <button
                onClick={requestClose}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition ${
                  isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'
                }`}
              >
                {t('confirmModal.cancel', { ns: 'common' })}
              </button>
              <button
                onClick={handleDownload}
                disabled={selected.size === 0 || filtersLoading}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {filtersLoading && selected.size > 0
                  ? <RotateCw className="w-4 h-4 animate-spin" />
                  : <Download className="w-4 h-4" />}
                {t('observationDetail.combineSubframesModal.combineAndDownload')}
              </button>
            </div>
          </div>
        )}

        {/* Footer — filter select phase */}
        {phase === 'filter-select' && (
          <div className={`px-5 py-4 border-t flex items-center justify-between gap-3 ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
            <p className={`text-xs flex-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {selectedFilters.size > 0
                ? t('observationDetail.combineSubframesModal.filterTypesSelected', { count: availableFilters.length, selected: selectedFilters.size })
                : t('observationDetail.combineSubframesModal.selectAtLeastOneFilter')}
            </p>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => setPhase('select')}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition ${
                  isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'
                }`}
              >
                {t('observationDetail.combineSubframesModal.back')}
              </button>
              <button
                onClick={handleFilterDownload}
                disabled={selectedFilters.size === 0}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Download className="w-4 h-4" />
                {t('observationDetail.combineSubframesModal.combineAndDownload')}
              </button>
            </div>
          </div>
        )}

        {confirmingClose && (
          <CloseConfirm
            message={t('observationDetail.combineSubframesModal.discardSelection')}
            onCancel={() => setConfirmingClose(false)}
            onDiscard={() => { setConfirmingClose(false); onClose(); }}
            isDark={isDark}
          />
        )}
    </Modal>
  );
}
