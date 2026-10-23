import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Activity, AlertTriangle, CheckCircle2, CheckSquare, Download, Loader2, MinusCircle, PackageCheck, Square, X, XCircle } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { useArchiveJob } from '../hooks/useArchiveJob';
import { useNightsFrameAnalysis } from '../hooks/useNightsFrameAnalysis';
import { useAuth } from '../contexts/AuthContext';
import { Modal } from './ui/Modal';
import { formatBytes } from '../lib/utils';
import { formatDate } from '../lib/formatLocale';
import {
  getLibrarySessions,
  getStackingPlan,
  startStackingExport,
  type StackingCalibration,
  type StackingIssue,
  type StackingLayout,
  type StackingPlanGroup,
} from '../lib/api/library';

/** Which calibration row an issue belongs to. */
const ISSUE_ROW: Record<StackingIssue['code'], 'dark' | 'flat' | 'flatDark' | 'bias' | null> = {
  no_dark: 'dark',
  dark_temp_far: 'dark',
  dark_expired: 'dark',
  no_flat: 'flat',
  flat_other_night: 'flat',
  no_flat_calibration: 'flatDark',
  bias_expired: 'bias',
  unknown_settings: null,
};

const ROWS = ['dark', 'flat', 'flatDark', 'bias'] as const;

const nightLabel = (night: string) => formatDate(new Date(`${night}T12:00:00`), { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * Export an object's kept lights for the chosen nights with the darks,
 * flats, flat darks and bias that match them, as a ZIP laid out for
 * PixInsight WBPP or Siril. Opened from the object page; every night with
 * sub-frames is selected to start with. The plan is shown first so missing
 * or doubtful calibration is visible before downloading gigabytes.
 */
export function StackingExportModal({ objectId, onClose }: { objectId: string; onClose: () => void }) {
  const { t } = useTranslation('observations');
  const { isDark } = useTheme();
  // null = every night (the default); a set once the user unticks one.
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [includeNotKept, setIncludeNotKept] = useState(false);
  const [layout, setLayout] = useState<StackingLayout>('wbpp');
  const job = useArchiveJob();

  const { data: sessions } = useQuery({
    queryKey: ['library-sessions', objectId],
    queryFn: () => getLibrarySessions(objectId),
  });
  const nights = useMemo(
    () => (sessions ?? [])
      .filter(s => s.subFrameCount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(s.date))
      .sort((a, b) => b.date.localeCompare(a.date)),
    [sessions],
  );
  const dates = useMemo(
    () => nights.map(s => s.date).filter(d => picked === null || picked.has(d)).sort(),
    [nights, picked],
  );
  const toggleNight = (d: string) => setPicked(prev => {
    const next = new Set(prev ?? nights.map(s => s.date));
    if (next.has(d)) next.delete(d); else next.add(d);
    return next;
  });
  const allPicked = dates.length === nights.length;

  const { data: plan, isFetching, error: planError } = useQuery({
    queryKey: ['stacking-plan', objectId, dates.join(','), includeNotKept],
    queryFn: () => getStackingPlan(objectId, dates, includeNotKept),
    enabled: dates.length > 0,
    placeholderData: prev => prev,
    // Always rebuilt on open: a Keep decision changed on the observation page
    // must show up here straight away.
    staleTime: 0,
  });

  // Keep decisions only exist for measured nights: offer to measure the
  // others, and rebuild the plan once the measurement is done.
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const refreshPlan = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: ['stacking-plan', objectId] }),
    [queryClient, objectId],
  );
  const quality = useNightsFrameAnalysis(objectId, dates, refreshPlan);

  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const strong = isDark ? 'text-slate-100' : 'text-slate-800';
  const segment = (active: boolean) => `px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
    active
      ? isDark ? 'bg-accent-500/15 text-accent-300' : 'bg-accent-50 text-accent-700'
      : isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'
  }`;
  const segmentGroup = `inline-flex overflow-hidden rounded-lg border ${isDark ? 'border-slate-700' : 'border-slate-200'}`;

  const running = job.phase === 'running';
  const pct = job.status && job.status.filesTotal > 0 ? Math.round((job.status.filesDone / job.status.filesTotal) * 100) : 0;
  const requestClose = () => { if (running) job.cancel(); onClose(); };

  return (
    <Modal
      isOpen
      onClose={requestClose}
      title={t('stackingExport.title')}
      className={`relative flex max-h-[90dvh] w-full max-w-3xl flex-col rounded-2xl shadow-2xl ${
        isDark ? 'border border-slate-800 bg-slate-900' : 'bg-white'
      }`}
    >
      <div className={`flex items-center justify-between border-b px-5 py-4 ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
        <div className="flex items-center gap-2">
          <PackageCheck className="h-4 w-4 text-accent-500" aria-hidden="true" />
          <h2 className={`font-display text-base font-semibold ${strong}`}>{t('stackingExport.title')}</h2>
        </div>
        <button
          type="button"
          onClick={requestClose}
          aria-label={t('stackingExport.close')}
          className={`rounded-lg p-1.5 transition ${isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'}`}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <p className={`text-xs ${muted}`}>{t('stackingExport.intro')}</p>

        <fieldset>
          <legend className={`mb-1.5 flex w-full items-center justify-between text-xs font-medium ${strong}`}>
            {t('stackingExport.nights')}
            {nights.length > 1 && (
              <button
                type="button"
                onClick={() => setPicked(allPicked ? new Set() : null)}
                className={`text-[0.6875rem] font-normal underline ${muted}`}
              >
                {allPicked ? t('stackingExport.selectNone') : t('stackingExport.selectAll')}
              </button>
            )}
          </legend>
          {sessions && nights.length === 0 && <p className={`text-xs ${muted}`}>{t('stackingExport.noNights')}</p>}
          <div className="flex flex-wrap gap-1.5">
            {nights.map(s => {
              const on = picked === null || picked.has(s.date);
              return (
                <button
                  key={s.date}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => toggleNight(s.date)}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition ${
                    on
                      ? isDark ? 'border-accent-500/40 bg-accent-500/10 text-slate-100' : 'border-accent-300 bg-accent-50 text-accent-800'
                      : isDark ? 'border-slate-700 text-slate-400 hover:bg-slate-800' : 'border-slate-200 text-slate-500 hover:bg-slate-50'
                  }`}
                >
                  {on ? <CheckSquare className="h-3.5 w-3.5 text-accent-500" /> : <Square className="h-3.5 w-3.5" />}
                  {nightLabel(s.date)}
                  <span className={`tabular-nums ${muted}`}>{s.subFrameCount}</span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <div className={segmentGroup} role="group" aria-label={t('stackingExport.layout')}>
            <button type="button" className={segment(layout === 'wbpp')} aria-pressed={layout === 'wbpp'} onClick={() => setLayout('wbpp')}>
              {t('stackingExport.wbpp')}
            </button>
            <button type="button" className={segment(layout === 'siril')} aria-pressed={layout === 'siril'} onClick={() => setLayout('siril')}>
              {t('stackingExport.siril')}
            </button>
          </div>
          <label className={`inline-flex cursor-pointer items-center gap-1.5 text-xs ${muted}`}>
            <input type="checkbox" checked={includeNotKept} onChange={e => setIncludeNotKept(e.target.checked)} className="accent-amber-500" />
            {t('stackingExport.includeNotKept')}
          </label>
        </div>
        <p className={`text-[0.6875rem] ${muted}`}>{t(layout === 'wbpp' ? 'stackingExport.wbppHint' : 'stackingExport.sirilHint')}</p>

        {dates.length > 0 && (quality.measuring || quality.unmeasuredNights.length > 0) && (
          <div
            className={`rounded-xl border px-3 py-2.5 text-xs ${
              isDark ? 'border-amber-500/30 bg-amber-500/10 text-amber-200' : 'border-amber-300 bg-amber-50 text-amber-800'
            }`}
            role="status"
          >
            {quality.measuring ? (
              <div className="flex items-center gap-3">
                <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" aria-hidden="true" />
                <span className="flex-shrink-0">{t('stackingExport.measuring', { done: quality.done, total: quality.total })}</span>
                <div className={`h-1.5 flex-1 overflow-hidden rounded-full ${isDark ? 'bg-amber-500/20' : 'bg-amber-200'}`}>
                  <div
                    className="h-full rounded-full bg-amber-500 transition-all"
                    style={{ width: `${quality.total ? (quality.done / quality.total) * 100 : 0}%` }}
                  />
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Activity className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  {t('stackingExport.notMeasured', {
                    count: quality.unmeasuredNights.length,
                    nights: quality.unmeasuredNights.map(nightLabel).join(', '),
                  })}
                  {!isAdmin && ` ${t('stackingExport.notMeasuredViewer')}`}
                </span>
                {isAdmin && (
                  <button
                    type="button"
                    disabled={quality.starting}
                    onClick={() => void quality.measure()}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-medium transition disabled:opacity-50 ${
                      isDark ? 'bg-amber-500/20 text-amber-100 hover:bg-amber-500/30' : 'bg-amber-200 text-amber-900 hover:bg-amber-300'
                    }`}
                  >
                    {quality.starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Activity className="h-3.5 w-3.5" />}
                    {t('stackingExport.measure', { count: quality.unmeasuredFrames })}
                  </button>
                )}
              </div>
            )}
            {quality.error && <p className={`mt-1 ${isDark ? 'text-red-300' : 'text-red-700'}`}>{quality.error}</p>}
          </div>
        )}

        {planError && (
          <p className={`text-xs ${isDark ? 'text-red-400' : 'text-red-600'}`}>
            {planError instanceof Error ? planError.message : t('stackingExport.planFailed')}
          </p>
        )}

        {!plan && !planError && dates.length > 0 && (
          <div className={`flex items-center gap-2 py-8 text-xs ${muted}`}>
            <Loader2 className="h-4 w-4 animate-spin" /> {t('stackingExport.matching')}
          </div>
        )}

        {plan && dates.length > 0 && (
          <div className={`space-y-3 transition-opacity ${isFetching ? 'opacity-60' : ''}`}>
            <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-xs ${muted}`}>
              <span className={`font-medium ${strong}`}>
                {t('stackingExport.summary', {
                  lights: plan.totals.lights,
                  calibration: plan.totals.calibrationFrames,
                  size: formatBytes(plan.totals.bytes),
                })}
              </span>
              {plan.totals.excluded > 0 && <span>{t('stackingExport.excluded', { count: plan.totals.excluded })}</span>}
              {plan.totals.errors === 0
                ? <span className={isDark ? 'text-emerald-400' : 'text-emerald-700'}>{t('stackingExport.ready')}</span>
                : <span className={isDark ? 'text-red-400' : 'text-red-700'}>{t('stackingExport.problems', { count: plan.totals.errors })}</span>}
            </div>

            {plan.groups.map(g => <GroupCard key={g.id} group={g} includeNotKept={plan.includeNotKept} multiNight={plan.nights.length > 1} />)}

            {plan.totals.errors > 0 && (
              <p className={`text-xs ${muted}`}>
                {t('stackingExport.fixHint')}{' '}
                <Link to="/calibrations" className="text-accent-500 underline hover:text-accent-400">{t('stackingExport.openLibrary')}</Link>
              </p>
            )}
          </div>
        )}
      </div>

      <div className={`flex flex-wrap items-center gap-3 border-t px-5 py-3 ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
        {running ? (
          <>
            <div
              className={`h-1.5 min-w-[8rem] flex-1 overflow-hidden rounded-full ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              aria-label={t('stackingExport.building')}
            >
              <div className="h-full rounded-full bg-accent-500 transition-all" style={{ width: `${pct}%` }} />
            </div>
            <span className={`text-xs tabular-nums ${muted}`}>
              {t('stackingExport.progress', { done: job.status?.filesDone ?? 0, total: job.status?.filesTotal ?? 0 })}
            </span>
            <button type="button" onClick={job.cancel} className={`text-xs underline ${muted}`}>{t('stackingExport.cancel')}</button>
          </>
        ) : (
          <>
            <span className={`flex-1 text-xs ${job.phase === 'error' ? (isDark ? 'text-red-400' : 'text-red-600') : muted}`}>
              {job.phase === 'done' && t('stackingExport.started')}
              {job.phase === 'error' && (job.error ?? t('stackingExport.failed'))}
            </span>
            <button
              type="button"
              disabled={!plan || dates.length === 0 || plan.totals.lights === 0 || isFetching || quality.measuring}
              onClick={() => void job.start(() => startStackingExport(objectId, dates, includeNotKept, layout))}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent-500 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-accent-600 disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" />
              {t('stackingExport.download')}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

export function GroupCard({ group: g, includeNotKept, multiNight }: { group: StackingPlanGroup; includeNotKept: boolean; multiNight: boolean }) {
  const { t } = useTranslation('observations');
  const { isDark } = useTheme();
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const settings = [
    g.exposureSec !== null ? `${g.exposureSec}s` : null,
    g.gain !== null ? t('stackingExport.gain', { value: g.gain }) : null,
    g.binning !== null ? `bin ${g.binning}` : null,
    g.sensorTempC !== null ? `${g.sensorTempC} °C` : null,
  ].filter(Boolean).join(' · ');
  const groupIssues = g.issues.filter(i => ISSUE_ROW[i.code] === null);

  return (
    <section className={`rounded-xl border p-3 ${isDark ? 'border-slate-800 bg-slate-950/40' : 'border-slate-200 bg-slate-50/60'}`}>
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
        {multiNight && <span className={`font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{nightLabel(g.night)}</span>}
        <span className={`rounded px-1.5 py-0.5 font-semibold ${isDark ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-800 ring-1 ring-slate-200'}`}>
          {g.filter ?? t('stackingExport.noFilter')}
        </span>
        <span className={muted}>{settings}</span>
        <span className={`ml-auto tabular-nums ${muted}`}>
          {includeNotKept ? t('stackingExport.lights', { count: g.frames }) : t('stackingExport.lightsKept', { kept: g.kept, total: g.frames })}
        </span>
      </header>
      <dl className="mt-2 grid gap-1 text-xs">
        {ROWS.map(row => (
          <CalibrationRow key={row} row={row} group={g} issues={g.issues.filter(i => ISSUE_ROW[i.code] === row)} />
        ))}
      </dl>
      {groupIssues.map(i => (
        <p key={i.code} className={`mt-1 text-[0.6875rem] ${isDark ? 'text-amber-400' : 'text-amber-700'}`}>{t(`stackingExport.issue.${i.code}`, i.params)}</p>
      ))}
    </section>
  );
}

function CalibrationRow({ row, group: g, issues }: { row: typeof ROWS[number]; group: StackingPlanGroup; issues: StackingIssue[] }) {
  const { t } = useTranslation('observations');
  const { isDark } = useTheme();
  const pick: StackingCalibration | null = g[row];
  const muted = isDark ? 'text-slate-500' : 'text-slate-400';
  const error = issues.find(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');
  // Bias and flat darks stand in for each other on the flats.
  const notNeeded = !pick && !error && (row === 'bias' ? !!g.flatDark : row === 'flatDark' ? !!g.bias : false) && !!g.flat;

  const chips: string[] = [];
  if (pick) {
    chips.push(t('stackingExport.frames', { count: pick.fileCount }));
    if (pick.deltaTempC !== undefined && pick.deltaTempC > 0) chips.push(`Δ ${pick.deltaTempC} °C`);
    if (pick.source === 'attached') chips.push(t('stackingExport.attached'));
    if ((row === 'flat' || row === 'flatDark') && pick.deltaDays === 0) chips.push(t('stackingExport.sameNight'));
  }

  return (
    <div className="grid grid-cols-[4.75rem_1fr] items-start gap-2 sm:grid-cols-[6.5rem_1fr]">
      <dt className={`pt-px ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{t(`stackingExport.row.${row}`)}</dt>
      <dd className="min-w-0">
        {pick ? (
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="flex min-w-0 max-w-full items-center gap-1.5">
              {warnings.length > 0
                ? <AlertTriangle className={`h-3.5 w-3.5 flex-shrink-0 ${isDark ? 'text-amber-400' : 'text-amber-600'}`} aria-hidden="true" />
                : <CheckCircle2 className={`h-3.5 w-3.5 flex-shrink-0 ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`} aria-hidden="true" />}
              <span className={`truncate font-mono text-[0.6875rem] ${isDark ? 'text-slate-200' : 'text-slate-700'}`} title={pick.name}>{pick.name}</span>
            </span>
            <span className={muted}>{chips.join(' · ')}</span>
          </span>
        ) : notNeeded ? (
          <span className={`inline-flex items-center gap-1.5 ${muted}`}>
            <MinusCircle className="h-3.5 w-3.5" aria-hidden="true" />
            {t(row === 'bias' ? 'stackingExport.biasNotNeeded' : 'stackingExport.flatDarkNotNeeded')}
          </span>
        ) : error ? (
          <span className={`inline-flex items-center gap-1.5 ${isDark ? 'text-red-400' : 'text-red-700'}`}>
            <XCircle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            {t(`stackingExport.issue.${error.code}`, { ...error.params, exposure: g.exposureSec ?? '?', gain: g.gain ?? '?', bin: g.binning ?? '?', filter: g.filter ?? '?' })}
          </span>
        ) : (
          <span className={muted}>–</span>
        )}
        {warnings.map(w => (
          <span key={w.code} className={`block text-[0.6875rem] ${isDark ? 'text-amber-400' : 'text-amber-700'}`}>
            {t(`stackingExport.issue.${w.code}`, w.params)}
          </span>
        ))}
      </dd>
    </div>
  );
}
