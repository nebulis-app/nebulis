/**
 * "Plan My Night" modal.
 *
 * A two-step, playful flow:
 *   1. Setup  — how long are you out, how to split the time, what to focus on.
 *   2. Preview — the generated plan with thumbnails, peak altitude, moon
 *      status and, when the forecast is used, cloud cover per block. Shuffle for a different take, then drop it onto the timeline.
 *
 * The actual scoring runs server-side (POST /planner/plan, see
 * server/lib/autoPlan.ts) so this matches what every other client produces
 * for the same inputs. This component only collects the knobs, renders the
 * result, and hands finished blocks back to the planner.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sparkles, Moon, ArrowUp, X, Shuffle, Clock, Hash, Telescope, Cloud, CloudOff, Wind, Hourglass, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatHm } from '../../lib/timeFormat';
import { formatObjectName } from '../../lib/utils';
import { getCatalogThumbnailUrl } from '../../lib/catalogImage';
import { generateNightPlanWithWeather } from '../../lib/api/planner';
import { ConfirmModal } from '../ConfirmModal';
import type { AutoPlanFocus, PlanBlock, PlanCandidate, PlanGoalsSummary, PlanWeatherSummary } from '../../lib/planTypes';
import { useIntegrationProgress } from '../../hooks/useIntegrationProgress';
import { formatDuration } from '../../lib/captureMetrics';
import { mergeSkipped } from '../../lib/planWeather';
import type { PlannerTarget } from '../../lib/api/planner';
import type { VisibleSkyMap } from '../../lib/visibilityCheck';

interface AutoPlanModalProps {
  targets: PlannerTarget[];
  observerLat: number;
  observerLon: number;
  /** Earliest a block may start (rounded "now" tonight, else dusk). */
  scheduleStart: Date;
  /** Latest a block may run to (the dark window's end). */
  scheduleHardEnd: Date;
  moonIllumination: number;
  minAlt: number;
  visibleSkyMap: VisibleSkyMap | null;
  observerTimezone?: string;
  /** "Tonight" or a formatted date, for the headline and confirm button. */
  nightLabel: string;
  /** Whether "clear existing blocks first" starts ticked. Off when filling a
   *  single gap, since the point there is to keep what is already scheduled. */
  defaultClearFirst?: boolean;
  /** How many blocks are already scheduled for this night. Drives the
   *  "replace existing plan" checkbox and the confirmation before a replace. */
  existingPlanCount?: number;
  isDark: boolean;
  /** Apply the plan: optionally clear the night first, then create blocks. */
  onApply: (blocks: PlanBlock[], clearFirst: boolean) => Promise<void> | void;
  onClose: () => void;
}

type SplitMode = 'perObject' | 'count';

/** Cloud-cover ceilings offered for "avoid cloudy hours". 60 % matches the
 *  server default. */
const CLOUD_THRESHOLDS = [30, 45, 60, 75] as const;

/** 7Timer seeing 1-5 → label key. */
function seeingKey(seeing: number): string {
  if (seeing <= 1.5) return 'autoPlanModal.seeingExcellent';
  if (seeing <= 2.5) return 'autoPlanModal.seeingGood';
  if (seeing <= 3.5) return 'autoPlanModal.seeingAverage';
  return 'autoPlanModal.seeingPoor';
}

const FOCUS_OPTIONS: { value: AutoPlanFocus; labelKey: string }[] = [
  { value: 'all', labelKey: 'autoPlanModal.focusAnything' },
  { value: 'galaxies', labelKey: 'autoPlanModal.focusGalaxies' },
  { value: 'nebulae', labelKey: 'autoPlanModal.focusNebulae' },
  { value: 'clusters', labelKey: 'autoPlanModal.focusClusters' },
];

const HALF_HOUR = 30 * 60_000;
/** The start/end selects reach this far before dusk and after dawn, so the user
 *  can image into twilight on either side of the dark window. */
const GRID_PAD = 2 * 60 * 60_000;

const alignCeil = (ms: number) => Math.ceil(ms / HALF_HOUR) * HALF_HOUR;
const alignFloor = (ms: number) => Math.floor(ms / HALF_HOUR) * HALF_HOUR;

/**
 * Epoch-ms marks on the :00 / :30 grid within [lo, hi]. Aligning to a 30-minute
 * epoch boundary lands on the hour and half hour in any whole/half-hour
 * timezone. Falls back to the raw bounds when the window is too short to hold
 * two distinct marks, so the start/end selects always have something to show.
 */
function halfHourGrid(lo: number, hi: number): number[] {
  const first = alignCeil(lo);
  const out: number[] = [];
  for (let t = first; t <= hi; t += HALF_HOUR) out.push(t);
  return out.length >= 2 ? out : [lo, hi];
}

export function AutoPlanModal({
  targets,
  observerLat,
  observerLon,
  scheduleStart,
  scheduleHardEnd,
  moonIllumination,
  minAlt,
  visibleSkyMap,
  observerTimezone,
  nightLabel,
  defaultClearFirst = true,
  existingPlanCount = 0,
  isDark,
  onApply,
  onClose,
}: AutoPlanModalProps) {
  const { t } = useTranslation('planner');
  const [step, setStep] = useState<'setup' | 'preview'>('setup');
  // Start / end are stored as epoch ms picked from the night's time grid, so
  // they cross midnight and respect the observer timezone without any wall-clock
  // parsing. Default to the full available window.
  // Defaults sit on the actual dark window (dusk → dawn); the selects below let
  // the user pull each end up to 2 hours into twilight.
  const [startMs, setStartMs] = useState(() => alignCeil(scheduleStart.getTime()));
  const [endMs, setEndMs] = useState(() =>
    Math.max(alignFloor(scheduleHardEnd.getTime()), alignCeil(scheduleStart.getTime()) + HALF_HOUR),
  );
  const [splitMode, setSplitMode] = useState<SplitMode>('perObject');
  const [minutesPerObject, setMinutesPerObject] = useState(90);
  const [objectCount, setObjectCount] = useState(4);
  const [focus, setFocus] = useState<AutoPlanFocus>('all');
  const [unimagedOnly, setUnimagedOnly] = useState(false);
  const [avoidClouds, setAvoidClouds] = useState(true);
  const [maxCloudCover, setMaxCloudCover] = useState<number>(60);
  const [weather, setWeather] = useState<PlanWeatherSummary | null>(null);
  const [favorGoals, setFavorGoals] = useState(true);
  const [goalsSummary, setGoalsSummary] = useState<PlanGoalsSummary | null>(null);
  const [clearFirst, setClearFirst] = useState(defaultClearFirst);
  const [blocks, setBlocks] = useState<PlanBlock[]>([]);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);

  // Integration goals ride along with each candidate, so the server can
  // favour unfinished campaigns and leave finished ones out. The switch only
  // shows when at least one candidate has goals.
  const progressFor = useIntegrationProgress();
  const targetsWithGoals = useMemo<PlanCandidate[]>(
    () => targets.map(target => {
      const progress = progressFor(target.id);
      if (!progress) return target;
      return {
        ...target,
        goals: progress.filters.map(f => ({ filter: f.filter, goalSec: f.goalSec, remainingSec: f.remainingSec })),
      };
    }),
    [targets, progressFor],
  );
  const anyGoals = useMemo(() => targetsWithGoals.some(t => t.goals), [targetsWithGoals]);

  const build = useCallback(
    (jitter: number) => {
      const s = Math.min(startMs, endMs);
      const e = Math.max(startMs, endMs);
      const windowMinutes = (e - s) / 60_000;

      const slotMinutes =
        splitMode === 'perObject'
          ? minutesPerObject
          : Math.max(15, Math.round(windowMinutes / Math.max(1, objectCount) / 5) * 5);
      const maxObjects =
        splitMode === 'perObject'
          ? Math.max(1, Math.floor(windowMinutes / slotMinutes))
          : objectCount;

      return generateNightPlanWithWeather({
        targets: anyGoals && favorGoals ? targetsWithGoals : targets,
        observerLat,
        observerLon,
        windowStart: new Date(s),
        windowEnd: new Date(e),
        slotMinutes,
        maxObjects,
        minAlt,
        moonIllumination,
        visibleSkyMap,
        focus,
        unimagedOnly,
        jitter,
        useForecast: avoidClouds,
        maxCloudCover,
        favorGoals: anyGoals && favorGoals,
      });
    },
    [startMs, endMs, splitMode, minutesPerObject, objectCount, focus, unimagedOnly, avoidClouds, maxCloudCover, targets, targetsWithGoals, anyGoals, favorGoals, observerLat, observerLon, minAlt, moonIllumination, visibleSkyMap],
  );

  const handleBuild = useCallback(async () => {
    setBuilding(true);
    setBuildError(null);
    try {
      const result = await build(0);
      setBlocks(result.blocks);
      setWeather(result.weather);
      setGoalsSummary(result.goals);
      setStep('preview');
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : t('autoPlanModal.buildFailed'));
    } finally {
      setBuilding(false);
    }
  }, [build, t]);

  const handleShuffle = useCallback(async () => {
    setBuilding(true);
    setBuildError(null);
    try {
      const result = await build(8);
      setBlocks(result.blocks);
      setWeather(result.weather);
      setGoalsSummary(result.goals);
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : t('autoPlanModal.buildFailed'));
    } finally {
      setBuilding(false);
    }
  }, [build, t]);

  const runApply = useCallback(async () => {
    setApplying(true);
    setApplyError(null);
    try {
      await onApply(blocks, clearFirst);
      onClose();
    } catch (err) {
      // Without this a failed apply (a dropped request part-way through the
      // create loop) closed nothing and said nothing — a half-applied plan
      // looked done.
      setApplyError(err instanceof Error ? err.message : t('autoPlanModal.applyFailed'));
    } finally {
      setApplying(false);
      setConfirmReplace(false);
    }
  }, [blocks, clearFirst, onApply, onClose, t]);

  // Replacing an existing plan is destructive, so make the user say so first.
  // Merging (clearFirst off) or an empty night applies straight away.
  const handleApply = useCallback(() => {
    if (clearFirst && existingPlanCount > 0) {
      setConfirmReplace(true);
      return;
    }
    void runApply();
  }, [clearFirst, existingPlanCount, runApply]);

  // formatHm already guards a bad/unrecognized timeZone (see its own
  // comment) rather than duplicating that try/catch here.
  const fmtTime = (d: Date) => formatHm(d, observerTimezone);

  // :00 / :30 grid, labeled in the observer's local time, reaching 2 hours
  // before dusk and after dawn so twilight imaging can be scheduled.
  const timeOptions = useMemo(
    () => halfHourGrid(scheduleStart.getTime() - GRID_PAD, scheduleHardEnd.getTime() + GRID_PAD).map(ms => ({ ms, label: fmtTime(new Date(ms)) })),
    // fmtTime is pure given observerTimezone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scheduleStart, scheduleHardEnd, observerTimezone],
  );

  // Start can be any grid point except the last (need room for one block);
  // end must come after the chosen start.
  const startOptions = timeOptions.slice(0, -1);
  const endOptions = timeOptions.filter(o => o.ms > startMs);
  const durationHours = Math.max(0, (endMs - startMs) / 3_600_000);

  const handleStartChange = (v: number) => {
    setStartMs(v);
    if (v >= endMs) setEndMs(timeOptions.find(o => o.ms > v)?.ms ?? timeOptions[timeOptions.length - 1].ms);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const surface = isDark ? 'bg-slate-900 text-slate-100' : 'bg-white text-slate-900';
  const subtle = isDark ? 'text-slate-400' : 'text-slate-600';
  const chipIdle = isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-700 hover:bg-slate-200';
  const selectCls = `w-full px-3 py-2 rounded-lg text-sm outline-none cursor-pointer ${
    isDark ? 'bg-slate-800 text-slate-100 border border-slate-700 focus:border-accent-500' : 'bg-slate-100 text-slate-900 border border-slate-200 focus:border-accent-500'
  }`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className={`relative rounded-2xl shadow-2xl max-w-2xl w-full max-h-[92vh] overflow-hidden flex flex-col ${surface}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="relative px-6 py-5 border-b border-slate-700/40 bg-gradient-to-r from-accent-500/10 to-transparent">
          <button
            onClick={onClose}
            className="absolute top-4 right-4 p-2 rounded-lg hover:bg-white/10 transition"
            aria-label={t('autoPlanModal.close')}
          >
            <X className="w-5 h-5" />
          </button>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-accent-500" />
            {t('autoPlanModal.title')}
          </h2>
          <p className={`text-sm mt-1 ${subtle}`}>
            {step === 'setup'
              ? t('autoPlanModal.setupSubtitle', { nightLabel })
              : t('autoPlanModal.previewSubtitle', { count: blocks.length, nightLabel })}
          </p>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {step === 'setup' ? (
            <>
              {/* Start / end time */}
              <section className="space-y-2">
                <div className="text-sm font-medium flex items-center gap-2">
                  <Clock className="w-4 h-4 text-accent-500" />
                  {t('autoPlanModal.whenToImage')}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <label className="space-y-1 block">
                    <span className={`text-xs ${subtle}`}>{t('autoPlanModal.start')}</span>
                    <select
                      value={startMs}
                      onChange={(e) => handleStartChange(Number(e.target.value))}
                      className={selectCls}
                    >
                      {startOptions.map((o) => (
                        <option key={o.ms} value={o.ms}>{o.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1 block">
                    <span className={`text-xs ${subtle}`}>{t('autoPlanModal.end')}</span>
                    <select
                      value={endMs}
                      onChange={(e) => setEndMs(Number(e.target.value))}
                      className={selectCls}
                    >
                      {endOptions.map((o) => (
                        <option key={o.ms} value={o.ms}>{o.label}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className={`text-xs ${subtle}`}>
                  {t('autoPlanModal.durationHint', { hours: durationHours.toFixed(1) })}
                </div>
              </section>

              {/* Split mode */}
              <section className="space-y-3">
                <div className="text-sm font-medium">{t('autoPlanModal.howToSplit')}</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <SplitButton
                    active={splitMode === 'perObject'}
                    icon={<Clock className="w-4 h-4" />}
                    label={t('autoPlanModal.timePerObject')}
                    onClick={() => setSplitMode('perObject')}
                    isDark={isDark}
                  />
                  <SplitButton
                    active={splitMode === 'count'}
                    icon={<Hash className="w-4 h-4" />}
                    label={t('autoPlanModal.numberOfObjects')}
                    onClick={() => setSplitMode('count')}
                    isDark={isDark}
                  />
                </div>

                {splitMode === 'perObject' ? (
                  <div className="flex gap-1.5 flex-wrap">
                    {[30, 60, 90, 120, 150, 180].map((m) => (
                      <button
                        key={m}
                        onClick={() => setMinutesPerObject(m)}
                        className={`px-3 py-1.5 text-xs rounded-full transition ${
                          minutesPerObject === m ? 'bg-accent-500 text-white' : chipIdle
                        }`}
                      >
                        {t('autoPlanModal.minutesShort', { count: m })}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={1}
                      max={12}
                      step={1}
                      value={objectCount}
                      onChange={(e) => setObjectCount(Number(e.target.value))}
                      className="flex-1 accent-amber-500"
                    />
                    <span className="text-sm font-medium w-20 text-right">
                      {t('autoPlanModal.objectCount', { count: objectCount })}
                    </span>
                  </div>
                )}
              </section>

              {/* Focus */}
              <section className="space-y-2">
                <div className="text-sm font-medium flex items-center gap-2">
                  <Telescope className="w-4 h-4 text-accent-500" />
                  {t('autoPlanModal.focusPrompt')}
                </div>
                <div className="flex gap-1.5 flex-wrap">
                  {FOCUS_OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      onClick={() => setFocus(o.value)}
                      className={`px-3 py-1.5 text-xs rounded-full transition ${
                        focus === o.value ? 'bg-accent-500 text-white' : chipIdle
                      }`}
                    >
                      {t(o.labelKey)}
                    </button>
                  ))}
                </div>
              </section>

              {/* Unimaged only */}
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={unimagedOnly}
                  onChange={(e) => setUnimagedOnly(e.target.checked)}
                  className="accent-amber-500"
                />
                <span>{t('autoPlanModal.unimagedOnly')}</span>
              </label>

              {/* Integration goals: favour unfinished campaigns. */}
              {anyGoals && (
                <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={favorGoals}
                    onChange={(e) => setFavorGoals(e.target.checked)}
                    className="accent-amber-500"
                  />
                  <span>{t('autoPlanModal.favorGoals')}</span>
                </label>
              )}

              {/* Weather: skip slots the forecast says are cloudy. */}
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={avoidClouds}
                    onChange={(e) => setAvoidClouds(e.target.checked)}
                    className="accent-amber-500"
                  />
                  <span>{t('autoPlanModal.avoidClouds')}</span>
                </label>
                {avoidClouds && (
                  <select
                    value={maxCloudCover}
                    onChange={(e) => setMaxCloudCover(Number(e.target.value))}
                    aria-label={t('autoPlanModal.cloudThresholdLabel')}
                    className={`px-2 py-1 rounded-lg text-xs outline-none cursor-pointer ${
                      isDark ? 'bg-slate-800 text-slate-100 border border-slate-700' : 'bg-slate-100 text-slate-900 border border-slate-200'
                    }`}
                  >
                    {CLOUD_THRESHOLDS.map(v => (
                      <option key={v} value={v}>{t('autoPlanModal.cloudThreshold', { pct: v })}</option>
                    ))}
                  </select>
                )}
              </div>
              {buildError && <p className="text-xs text-red-500">{buildError}</p>}
            </>
          ) : (
            <>
              {weather?.requested && !weather.used && (
                <p className={`flex items-center gap-1.5 text-xs ${subtle}`}>
                  <CloudOff className="w-3.5 h-3.5 shrink-0" />
                  {t('autoPlanModal.forecastUnavailable')}
                </p>
              )}
              {weather?.used && weather.skippedSlots.length > 0 && (
                <div className={`rounded-xl px-3 py-2 text-xs ${isDark ? 'bg-slate-800/60 text-slate-300' : 'bg-slate-100 text-slate-700'}`}>
                  <div className="flex items-center gap-1.5 font-medium">
                    <Cloud className="w-3.5 h-3.5 shrink-0" />
                    {t('autoPlanModal.skippedCloudy', { pct: weather.maxCloudCover })}
                  </div>
                  <div className={`mt-0.5 tabular-nums ${subtle}`}>
                    {mergeSkipped(weather.skippedSlots)
                      .map(r => t('autoPlanModal.skippedRange', { start: fmtTime(r.start), end: fmtTime(r.end), pct: r.cloudCover }))
                      .join(' · ')}
                  </div>
                </div>
              )}
              {goalsSummary?.requested && goalsSummary.complete.length > 0 && (
                <p className={`flex items-center gap-1.5 text-xs ${subtle}`}>
                  <Check className="w-3.5 h-3.5 shrink-0 text-emerald-500" />
                  {t('autoPlanModal.goalsComplete', {
                    names: goalsSummary.complete.map(o => formatObjectName(o.id, o.name)).join(', '),
                  })}
                </p>
              )}
              {blocks.length === 0 ? (
                <div className={`text-center py-10 ${subtle}`}>
                  <Moon className="w-8 h-8 mx-auto mb-3 opacity-50" />
                  <p className="text-sm">
                    {weather?.used && weather.skippedSlots.length > 0
                      ? t('autoPlanModal.allCloudy')
                      : t('autoPlanModal.noFreshTargets')}
                  </p>
                  <p className="text-xs mt-1">{t('autoPlanModal.tryDifferent')}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {blocks.map((b) => (
                    <div
                      key={`${b.target.id}-${b.start.getTime()}`}
                      className={`flex items-center gap-3 rounded-xl p-2.5 border ${
                        isDark ? 'border-slate-800 bg-slate-800/40' : 'border-slate-200 bg-slate-50'
                      }`}
                    >
                      <img
                        src={getCatalogThumbnailUrl(b.target.id, b.target.majorAxisArcmin)}
                        alt=""
                        loading="lazy"
                        className="w-12 h-12 rounded-lg object-cover bg-slate-800 shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-sm truncate">
                          {formatObjectName(b.target.id, b.target.name)}
                        </div>
                        <div className={`text-xs truncate ${subtle}`}>
                          {b.target.type}
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-[0.6875rem]">
                          <span className="inline-flex items-center gap-1 text-accent-500">
                            <ArrowUp className="w-3 h-3" />
                            {Math.round(b.meanAlt)}°
                          </span>
                          <span
                            className={`inline-flex items-center gap-1 ${
                              b.moonVerdict === 'caution' ? 'text-amber-500' : isDark ? 'text-slate-400' : 'text-slate-500'
                            }`}
                          >
                            <Moon className="w-3 h-3" />
                            {b.moonSeparation === Infinity ? t('autoPlanModal.moonDown') : t('autoPlanModal.awayDeg', { deg: Math.round(b.moonSeparation) })}
                          </span>
                          {b.filterBand && (
                            <span
                              className={`rounded px-1 font-semibold ${
                                b.filterBand === 'narrowband'
                                  ? isDark ? 'bg-violet-500/15 text-violet-300' : 'bg-violet-50 text-violet-700'
                                  : isDark ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600'
                              }`}
                              title={t(`scheduledImagingBlock.band.${b.filterBand}`)}
                            >
                              {t(`scheduledImagingBlock.bandShort.${b.filterBand}`)}
                            </span>
                          )}
                          {b.filter !== undefined && b.filterRemainingSec !== undefined && (
                            <span
                              className={`inline-flex items-center gap-1 tabular-nums ${isDark ? 'text-accent-300' : 'text-accent-700'}`}
                              title={t('autoPlanModal.goalFilterTitle', {
                                filter: b.filter ?? t('integrationRemaining.noFilter'),
                                duration: formatDuration(b.filterRemainingSec),
                              })}
                            >
                              <Hourglass className="w-3 h-3" />
                              {t('integrationRemaining.left', {
                                duration: formatDuration(b.filterRemainingSec),
                                filter: b.filter ?? t('integrationRemaining.noFilter'),
                              })}
                            </span>
                          )}
                          {b.sky && (
                            <span
                              className={`inline-flex items-center gap-1 ${
                                b.sky.cloudCover > 30 ? 'text-amber-500' : isDark ? 'text-slate-400' : 'text-slate-500'
                              }`}
                              title={b.sky.dewRisk ? t('autoPlanModal.dewRisk') : undefined}
                            >
                              <Cloud className="w-3 h-3" />
                              {t('autoPlanModal.cloudPct', { pct: b.sky.cloudCover })}
                            </span>
                          )}
                          {b.sky?.seeing != null && (
                            <span className={`inline-flex items-center gap-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                              <Wind className="w-3 h-3" />
                              {t(seeingKey(b.sky.seeing))}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className={`text-right text-xs shrink-0 ${subtle}`}>
                        <div className="font-medium">{fmtTime(b.start)}</div>
                        <div className="opacity-70">{fmtTime(b.end)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {blocks.length > 0 && existingPlanCount > 0 && (
                <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={clearFirst}
                    onChange={(e) => setClearFirst(e.target.checked)}
                    className="accent-amber-500"
                  />
                  <span className={subtle}>
                    {t('autoPlanModal.replaceExisting', { count: existingPlanCount, nightLabel })}
                  </span>
                </label>
              )}
            </>
          )}
        </div>

        {applyError && (
          <p className="px-6 pb-2 -mt-1 text-xs text-red-500">{applyError}</p>
        )}

        {/* Footer */}
        <div className={`px-6 py-4 border-t flex items-center gap-2 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          {step === 'setup' ? (
            <>
              <button
                onClick={onClose}
                className={`px-4 py-2 rounded-lg text-sm font-medium ${chipIdle}`}
              >
                {t('autoPlanModal.cancel')}
              </button>
              <button
                onClick={handleBuild}
                disabled={building}
                className="ml-auto px-5 py-2 rounded-lg text-sm font-semibold bg-accent-500 hover:bg-accent-600 disabled:opacity-50 disabled:cursor-not-allowed text-white inline-flex items-center gap-2"
              >
                <Sparkles className="w-4 h-4" />
                {building ? t('autoPlanModal.building') : t('autoPlanModal.buildMyPlan')}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setStep('setup')}
                className={`px-4 py-2 rounded-lg text-sm font-medium ${chipIdle}`}
              >
                {t('autoPlanModal.back')}
              </button>
              {blocks.length > 0 && (
                <button
                  onClick={handleShuffle}
                  disabled={building}
                  className={`px-4 py-2 rounded-lg text-sm font-medium inline-flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed ${chipIdle}`}
                >
                  <Shuffle className="w-4 h-4" />
                  {t('autoPlanModal.shuffle')}
                </button>
              )}
              <button
                onClick={handleApply}
                disabled={blocks.length === 0 || applying || building}
                className="ml-auto px-5 py-2 rounded-lg text-sm font-semibold bg-accent-500 hover:bg-accent-600 disabled:opacity-50 disabled:cursor-not-allowed text-white inline-flex items-center gap-2"
              >
                {applying ? t('autoPlanModal.adding') : t('autoPlanModal.addTo', { nightLabel })}
              </button>
            </>
          )}
        </div>
      </div>

      {confirmReplace && (
        <ConfirmModal
          title={t('autoPlanModal.replaceTitle', { nightLabel })}
          message={t('autoPlanModal.replaceMessage', { count: existingPlanCount, nightLabel, newCount: blocks.length })}
          confirmLabel={t('autoPlanModal.replace')}
          pending={applying}
          onConfirm={() => { void runApply(); }}
          onCancel={() => setConfirmReplace(false)}
        />
      )}
    </div>
  );
}

function SplitButton({
  active,
  icon,
  label,
  onClick,
  isDark,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  isDark: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium border transition ${
        active
          ? 'border-accent-500 bg-accent-500/15 text-accent-500'
          : isDark
            ? 'border-slate-800 bg-slate-800/40 text-slate-300 hover:bg-slate-800'
            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
