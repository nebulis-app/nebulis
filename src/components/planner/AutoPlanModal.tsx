/**
 * "Plan My Night" modal.
 *
 * A two-step, playful flow:
 *   1. Setup  — how long are you out, how to split the time, what to focus on.
 *   2. Preview — the generated plan with thumbnails, peak altitude, and moon
 *      status. Shuffle for a different take, then drop it onto the timeline.
 *
 * The actual scoring lives in lib/autoPlan.ts. This component only collects the
 * knobs, renders the result, and hands finished blocks back to the planner.
 */
import { useCallback, useMemo, useState } from 'react';
import { Sparkles, Moon, ArrowUp, X, Shuffle, Clock, Hash, Telescope } from 'lucide-react';
import { formatObjectName } from '../../lib/utils';
import { getCatalogThumbnailUrl } from '../../lib/catalogImage';
import { generateNightPlan, type AutoPlanFocus, type PlanBlock } from '../../lib/autoPlan';
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
  isDark: boolean;
  /** Apply the plan: optionally clear the night first, then create blocks. */
  onApply: (blocks: PlanBlock[], clearFirst: boolean) => Promise<void> | void;
  onClose: () => void;
}

type SplitMode = 'perObject' | 'count';

const FOCUS_OPTIONS: { value: AutoPlanFocus; label: string }[] = [
  { value: 'all', label: 'Anything' },
  { value: 'galaxies', label: 'Galaxies' },
  { value: 'nebulae', label: 'Nebulae' },
  { value: 'clusters', label: 'Clusters' },
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
  isDark,
  onApply,
  onClose,
}: AutoPlanModalProps) {
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
  const [clearFirst, setClearFirst] = useState(true);
  const [blocks, setBlocks] = useState<PlanBlock[]>([]);
  const [applying, setApplying] = useState(false);

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

      return generateNightPlan({
        targets,
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
      });
    },
    [startMs, endMs, splitMode, minutesPerObject, objectCount, focus, unimagedOnly, targets, observerLat, observerLon, minAlt, moonIllumination, visibleSkyMap],
  );

  const handleBuild = useCallback(() => {
    setBlocks(build(0));
    setStep('preview');
  }, [build]);

  const handleShuffle = useCallback(() => {
    setBlocks(build(8));
  }, [build]);

  const handleApply = useCallback(async () => {
    setApplying(true);
    try {
      await onApply(blocks, clearFirst);
      onClose();
    } finally {
      setApplying(false);
    }
  }, [blocks, clearFirst, onApply, onClose]);

  const fmtTime = (d: Date) =>
    d.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      ...(observerTimezone ? { timeZone: observerTimezone } : {}),
    });

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
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-accent-500" />
            Plan My Night
          </h2>
          <p className={`text-sm mt-1 ${subtle}`}>
            {step === 'setup'
              ? `Fresh targets for ${nightLabel.toLowerCase()}, picked for height and clear of the moon.`
              : `${blocks.length} target${blocks.length === 1 ? '' : 's'} lined up for ${nightLabel.toLowerCase()}.`}
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
                  When do you want to image?
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <label className="space-y-1 block">
                    <span className={`text-xs ${subtle}`}>Start</span>
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
                    <span className={`text-xs ${subtle}`}>End</span>
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
                  {durationHours.toFixed(1)} hours of imaging, in your local time.
                </div>
              </section>

              {/* Split mode */}
              <section className="space-y-3">
                <div className="text-sm font-medium">How should I split the time?</div>
                <div className="grid grid-cols-2 gap-2">
                  <SplitButton
                    active={splitMode === 'perObject'}
                    icon={<Clock className="w-4 h-4" />}
                    label="Time per object"
                    onClick={() => setSplitMode('perObject')}
                    isDark={isDark}
                  />
                  <SplitButton
                    active={splitMode === 'count'}
                    icon={<Hash className="w-4 h-4" />}
                    label="Number of objects"
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
                        {m} min
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
                      {objectCount} object{objectCount === 1 ? '' : 's'}
                    </span>
                  </div>
                )}
              </section>

              {/* Focus */}
              <section className="space-y-2">
                <div className="text-sm font-medium flex items-center gap-2">
                  <Telescope className="w-4 h-4 text-accent-500" />
                  Anything you're in the mood for?
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
                      {o.label}
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
                <span>Only include targets I haven't imaged yet</span>
              </label>
            </>
          ) : (
            <>
              {blocks.length === 0 ? (
                <div className={`text-center py-10 ${subtle}`}>
                  <Moon className="w-8 h-8 mx-auto mb-3 opacity-50" />
                  <p className="text-sm">
                    Couldn't find fresh targets that clear the moon and your sky tonight.
                  </p>
                  <p className="text-xs mt-1">Try a different focus, fewer hours, or a future night.</p>
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
                          {b.target.constellation ? ` · ${b.target.constellation}` : ''}
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-[11px]">
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
                            {b.moonSeparation === Infinity ? 'moon down' : `${Math.round(b.moonSeparation)}° away`}
                          </span>
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

              {blocks.length > 0 && (
                <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={clearFirst}
                    onChange={(e) => setClearFirst(e.target.checked)}
                    className="accent-amber-500"
                  />
                  <span className={subtle}>Clear existing blocks for this night first</span>
                </label>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className={`px-6 py-4 border-t flex items-center gap-2 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          {step === 'setup' ? (
            <>
              <button
                onClick={onClose}
                className={`px-4 py-2 rounded-lg text-sm font-medium ${chipIdle}`}
              >
                Cancel
              </button>
              <button
                onClick={handleBuild}
                className="ml-auto px-5 py-2 rounded-lg text-sm font-semibold bg-accent-500 hover:bg-accent-600 text-white inline-flex items-center gap-2"
              >
                <Sparkles className="w-4 h-4" />
                Build my plan
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setStep('setup')}
                className={`px-4 py-2 rounded-lg text-sm font-medium ${chipIdle}`}
              >
                Back
              </button>
              {blocks.length > 0 && (
                <button
                  onClick={handleShuffle}
                  className={`px-4 py-2 rounded-lg text-sm font-medium inline-flex items-center gap-2 ${chipIdle}`}
                >
                  <Shuffle className="w-4 h-4" />
                  Shuffle
                </button>
              )}
              <button
                onClick={handleApply}
                disabled={blocks.length === 0 || applying}
                className="ml-auto px-5 py-2 rounded-lg text-sm font-semibold bg-accent-500 hover:bg-accent-600 disabled:opacity-50 disabled:cursor-not-allowed text-white inline-flex items-center gap-2"
              >
                {applying ? 'Adding…' : `Add to ${nightLabel}`}
              </button>
            </>
          )}
        </div>
      </div>
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
