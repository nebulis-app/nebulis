/**
 * "Plan Tonight" for a single catalog.
 *
 * Picks the objects in this catalog the user hasn't imaged yet that are best
 * placed for the coming night (highest while clear of the moon), lets them
 * choose how many to include, and creates a planned session for each across
 * tonight's dark window.
 *
 * The ranking + scheduling runs server-side (POST /planner/plan) so it stays
 * consistent with "Plan My Night" on the planner page, and with every other
 * client.
 */
import { useCallback, useDeferredValue, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import SunCalc from 'suncalc';
import { Sparkles, Moon, ArrowUp, X, Telescope } from 'lucide-react';
import { formatObjectName } from '../../lib/utils';
import { getCatalogThumbnailUrl } from '../../lib/catalogImage';
import { generateNightPlan } from '../../lib/api/planner';
import type { PlanCandidate, PlanBlock } from '../../lib/planTypes';
import { nightWindowFor, formatPlannerDate, plannerToday, localDateKey } from '../../lib/nightWindow';
import { formatHm } from '../../lib/timeFormat';
import { createPlannedSession } from '../../lib/api/plannedSessions';
import type { CatalogProgressObject } from '../../lib/api/catalogs';

interface CatalogPlanModalProps {
  catalogLabel: string;
  objects: CatalogProgressObject[];
  observerLat: number;
  observerLon: number;
  minAlt: number;
  observerTimezone?: string;
  isDark: boolean;
  onClose: () => void;
}

/** The night the planner is currently showing, or the next one. Anchored to
 *  plannerToday() so we agree with the planner about which night "tonight" is:
 *  before the 07:00 rollover that's still the dark window in progress that began
 *  the previous evening, not the coming one. Roll forward only once that window
 *  has actually ended. */
function upcomingNight(lat: number, lon: number, timeZone?: string): { start: Date; end: Date } | null {
  const now = new Date();
  const anchor = plannerToday(now, timeZone);
  const current = nightWindowFor(anchor, lat, lon);
  if (current && current.end.getTime() > now.getTime()) return current;
  const next = new Date(anchor);
  next.setDate(next.getDate() + 1);
  return nightWindowFor(next, lat, lon);
}

export function CatalogPlanModal({
  catalogLabel,
  objects,
  observerLat,
  observerLon,
  minAlt,
  observerTimezone,
  isDark,
  onClose,
}: CatalogPlanModalProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [count, setCount] = useState(5);
  const [creating, setCreating] = useState(false);

  // Not-imaged candidates with real coordinates, mapped to the planner's shape.
  const candidates = useMemo<PlanCandidate[]>(
    () =>
      objects
        .filter(o => !o.isImaged && o.ra != null && o.dec != null)
        .map(o => ({
          id: o.id,
          name: o.name,
          type: o.type,
          ra: o.ra as number,
          dec: o.dec as number,
          magnitude: o.magnitude,
          majorAxisArcmin: o.majorAxisArcmin,
          constellation: o.constellation,
          commonNames: [],
          isAlreadyImaged: false,
        })),
    [objects],
  );

  const night = useMemo(
    () => upcomingNight(observerLat, observerLon, observerTimezone),
    [observerLat, observerLon, observerTimezone],
  );

  // Start at dusk, or "now" (rounded up to 5 min) when we're already into the
  // night, so we never schedule a block in the past.
  const planWindow = useMemo(() => {
    if (!night) return null;
    const nowMs = Date.now();
    const FIVE = 5 * 60_000;
    const startMs = nowMs > night.start.getTime() && nowMs < night.end.getTime()
      ? Math.ceil(nowMs / FIVE) * FIVE
      : night.start.getTime();
    return { start: new Date(startMs), end: night.end };
  }, [night]);

  const moonPct = useMemo(
    () => (planWindow ? Math.round(SunCalc.getMoonIllumination(planWindow.start).fraction * 100) : 0),
    [planWindow],
  );

  const maxCount = Math.min(8, Math.max(1, candidates.length));

  // Deferred so dragging the count slider coalesces into one request when it
  // settles rather than firing per tick.
  const deferredCount = useDeferredValue(count);
  const n = Math.min(deferredCount, maxCount);
  const candidateIds = candidates.map(c => c.id).join(',');
  const planKey = planWindow
    ? [planWindow.start.toISOString(), planWindow.end.toISOString()]
    : [null, null];

  const planQuery = useQuery({
    queryKey: ['catalog-night-plan', planKey[0], planKey[1], n, candidateIds, observerLat, observerLon, minAlt, moonPct],
    enabled: !!planWindow && candidates.length > 0,
    staleTime: 30_000,
    queryFn: () => {
      const windowMinutes = (planWindow!.end.getTime() - planWindow!.start.getTime()) / 60_000;
      const slotMinutes = Math.max(15, Math.floor(windowMinutes / Math.max(1, n)));
      return generateNightPlan({
        targets: candidates,
        observerLat,
        observerLon,
        windowStart: planWindow!.start,
        windowEnd: planWindow!.end,
        slotMinutes,
        maxObjects: n,
        minAlt,
        moonIllumination: moonPct,
        visibleSkyMap: null,
      });
    },
  });
  const blocks = useMemo<PlanBlock[]>(() => planQuery.data ?? [], [planQuery.data]);
  const blocksLoading = planQuery.isFetching;
  const blocksError = planQuery.isError;

  // formatHm already guards a bad/unrecognized timeZone rather than
  // duplicating that try/catch here.
  const fmtTime = (d: Date) => formatHm(d, observerTimezone);

  const nightLabel = night ? formatPlannerDate(night.start) : 'tonight';

  const handleCreate = useCallback(async () => {
    if (blocks.length === 0) return;
    setCreating(true);
    try {
      for (const b of blocks) {
        await createPlannedSession({
          objectId: b.target.id,
          objectName: b.target.name,
          ra: b.target.ra,
          dec: b.target.dec,
          startTime: b.start.toISOString(),
          endTime: b.end.toISOString(),
        });
      }
      await queryClient.invalidateQueries({ queryKey: ['planned-sessions'] });
      // Open the planner on the night we just scheduled into, not its own
      // default "today", so the new blocks are visible right away.
      navigate('/planner', night ? { state: { focusDate: localDateKey(night.start) } } : undefined);
    } finally {
      setCreating(false);
    }
  }, [blocks, queryClient, navigate, night]);

  const surface = isDark ? 'bg-slate-900 text-slate-100' : 'bg-white text-slate-900';
  const subtle = isDark ? 'text-slate-400' : 'text-slate-600';
  const chipIdle = isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-700 hover:bg-slate-200';

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
            Plan Tonight · {catalogLabel}
          </h2>
          <p className={`text-sm mt-1 ${subtle}`}>
            The {catalogLabel} objects you haven't imaged yet that climb highest on the night of{' '}
            {nightLabel}, picked to stay clear of the moon ({moonPct}% lit). Choose how many to
            include and we'll lay them out across the dark window.
          </p>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {!planWindow ? (
            <div className={`text-center py-10 ${subtle}`}>
              <Telescope className="w-8 h-8 mx-auto mb-3 opacity-50" />
              <p className="text-sm">No dark window is available for your location right now.</p>
            </div>
          ) : candidates.length === 0 ? (
            <div className={`text-center py-10 ${subtle}`}>
              <Telescope className="w-8 h-8 mx-auto mb-3 opacity-50" />
              <p className="text-sm">
                {objects.every(o => o.isImaged)
                  ? "You've already imaged every object in this catalog. Nice work."
                  : "None of the remaining objects in this catalog have coordinates we can plan with."}
              </p>
            </div>
          ) : (
            <>
              {/* Count slider */}
              <section className="space-y-2">
                <div className="flex items-center justify-between text-sm font-medium">
                  <span>How many objects?</span>
                  <span className={subtle}>{Math.min(count, maxCount)} of {candidates.length} left</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={maxCount}
                  step={1}
                  value={Math.min(count, maxCount)}
                  onChange={(e) => setCount(Number(e.target.value))}
                  className="w-full accent-amber-500"
                />
              </section>

              {/* Picked objects */}
              {blocksLoading ? (
                <div className={`text-center py-6 text-sm ${subtle}`}>Building plan…</div>
              ) : blocksError ? (
                <div className="text-center py-6 text-sm text-red-500">
                  Couldn't build a plan. Check your connection and try reopening this.
                </div>
              ) : blocks.length === 0 ? (
                <div className={`text-center py-6 text-sm ${subtle}`}>
                  <Moon className="w-7 h-7 mx-auto mb-2 opacity-50" />
                  Nothing in this catalog clears the moon and gets high enough on this night.
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
                          <span className="inline-flex items-center gap-1 text-amber-500">
                            <ArrowUp className="w-3 h-3" />
                            {Math.round(b.meanAlt)}°
                          </span>
                          <span
                            className={`inline-flex items-center gap-1 ${
                              b.moonVerdict === 'caution' ? 'text-orange-400' : subtle
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
            </>
          )}
        </div>

        {/* Footer */}
        <div className={`px-6 py-4 border-t flex items-center gap-2 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          <button onClick={onClose} className={`px-4 py-2 rounded-lg text-sm font-medium ${chipIdle}`}>
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={blocks.length === 0 || creating || blocksLoading}
            className="ml-auto px-5 py-2 rounded-lg text-sm font-semibold bg-accent-500 hover:bg-accent-600 disabled:opacity-50 disabled:cursor-not-allowed text-white inline-flex items-center gap-2"
          >
            {creating ? 'Creating…' : `Create plan (${blocks.length})`}
          </button>
        </div>
      </div>
    </div>
  );
}
