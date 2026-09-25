/**
 * Tonight's easy targets — photo tile grid for the Home dashboard.
 *
 * Design tokens are aligned with NightOverview ("What's Up Tonight") and
 * WeatherNight ("Weather Tonight"):
 *   - Same outer background (`bg-[#0e1117]` dark / `bg-slate-50` light)
 *   - Same border shade (`border-slate-700/50` dark / `border-slate-200` light)
 *   - Same header: amber circle icon badge + `text-lg font-bold` title +
 *     `text-[12px]` subtitle, with a `border-b` separator
 *   - Loading / error / empty states rendered inside the card body
 *
 * Features
 * ────────
 * • Add to schedule button on each tile (admin only): creates a planned-session
 *   block for tonight using the target's rise→set window capped to the dark
 *   window. Invalidates `['planned-sessions']` so the Planner page reflects the
 *   new block immediately.
 * • Shuffle button in the header right — picks a fresh diverse mix each click.
 * • Type-diversity selection: round-robin across nebula / galaxy / cluster /
 *   supernova / double / other so the grid always shows a varied showcase.
 */
import { useState, useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Telescope, RotateCw, AlertCircle, Shuffle,
  CalendarPlus, CalendarCheck,
} from 'lucide-react';
import { getPlannerTargets, type PlannerTarget } from '../../lib/api/planner';
import { createPlannedSession, listPlannedSessions } from '../../lib/api/plannedSessions';
import { bestSlotFor, type Interval } from '../../lib/plannerNight';
import { DEFAULT_BLOCK_MINUTES } from '../planner/scheduleGeometry';
import { formatTime } from '../../lib/forecastScore';
import { getCatalogStaticThumbnailUrl, getCatalogThumbnailUrl } from '../../lib/catalogImage';
import { useAuth } from '../../contexts/AuthContext';

// ─── Props ────────────────────────────────────────────────────────────────

interface Props {
  siteId: string | null;
  timeZone?: string;
  isDark: boolean;
  /** Observer latitude — required by `bestSlotFor` to compute per-slot altitude. */
  observerLat: number | null;
  /** Observer longitude — required by `bestSlotFor` to compute per-slot altitude. */
  observerLon: number | null;
  /** ISO string for the start of tonight's dark window. */
  darkWindowStart: string | null;
  /** ISO string for the end of tonight's dark window. */
  darkWindowEnd: string | null;
}

// ─── Type badge ───────────────────────────────────────────────────────────

function typeColor(type: string): string {
  const l = type.toLowerCase();
  if (l.includes('galaxy'))     return 'bg-violet-500/80 text-violet-50';
  if (l.includes('globular'))   return 'bg-amber-500/80  text-amber-50';
  if (l.includes('open'))       return 'bg-emerald-500/80 text-emerald-50';
  if (l.includes('planetary'))  return 'bg-cyan-500/80    text-cyan-50';
  if (l.includes('supernova'))  return 'bg-orange-500/80  text-orange-50';
  if (l.includes('emission'))   return 'bg-rose-500/80    text-rose-50';
  if (l.includes('reflection')) return 'bg-sky-500/80     text-sky-50';
  if (l.includes('nebula'))     return 'bg-rose-400/80    text-rose-50';
  if (l.includes('cluster'))    return 'bg-emerald-400/80 text-emerald-50';
  if (l.includes('double'))     return 'bg-slate-500/80   text-slate-50';
  return 'bg-slate-600/80 text-slate-50';
}

function shortType(type: string): string {
  const l = type.toLowerCase();
  if (l.includes('galaxy'))     return 'galaxy';
  if (l.includes('globular'))   return 'globular cluster';
  if (l.includes('open'))       return 'open cluster';
  if (l.includes('planetary'))  return 'planetary nebula';
  if (l.includes('supernova'))  return 'supernova remnant';
  if (l.includes('emission'))   return 'emission nebula';
  if (l.includes('reflection')) return 'reflection nebula';
  if (l.includes('nebula'))     return 'nebula';
  if (l.includes('cluster'))    return 'cluster';
  if (l.includes('double'))     return 'double star';
  return type.toLowerCase();
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function fmtTime(iso: string | null, tz?: string): string {
  return iso ? formatTime(iso, tz) : '–';
}

function durationLabel(from: string | null, to: string | null): string {
  if (!from || !to) return '–';
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (ms <= 0) return '–';
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Diversity picker ─────────────────────────────────────────────────────

type ObjectFamily = 'nebula' | 'cluster' | 'galaxy' | 'supernova' | 'double' | 'other';

function familyOf(type: string): ObjectFamily {
  const l = type.toLowerCase();
  if (l.includes('galaxy'))    return 'galaxy';
  if (l.includes('supernova')) return 'supernova';
  if (l.includes('double') || l.includes('star')) return 'double';
  if (l.includes('cluster'))   return 'cluster';
  if (l.includes('nebula') || l.includes('emission') ||
      l.includes('reflection') || l.includes('planetary')) return 'nebula';
  return 'other';
}

function diversePick(pool: PlannerTarget[], n: number): PlannerTarget[] {
  const FAMILY_ORDER: ObjectFamily[] = ['nebula', 'galaxy', 'cluster', 'supernova', 'double', 'other'];
  const buckets = new Map<ObjectFamily, PlannerTarget[]>();
  for (const f of FAMILY_ORDER) buckets.set(f, []);
  for (const t of pool) buckets.get(familyOf(t.type))!.push(t);

  const result: PlannerTarget[] = [];
  const taken = new Map<ObjectFamily, number>(FAMILY_ORDER.map(f => [f, 0]));

  while (result.length < n) {
    let pickedAny = false;
    for (const f of FAMILY_ORDER) {
      if (result.length >= n) break;
      const bucket = buckets.get(f)!;
      const idx = taken.get(f)!;
      if (idx < bucket.length) {
        result.push(bucket[idx]);
        taken.set(f, idx + 1);
        pickedAny = true;
      }
    }
    if (!pickedAny) break;
  }
  return result;
}

// ─── Stat cell ────────────────────────────────────────────────────────────

function StatCell({
  label,
  value,
  isDark,
}: {
  label: string;
  value: React.ReactNode;
  isDark: boolean;
}) {
  return (
    <div className={`flex flex-col gap-0.5 p-3 rounded-lg ${
      isDark ? 'bg-slate-800/50' : 'bg-slate-100/70'
    }`}>
      <span className={`text-[9.5px] font-semibold uppercase tracking-[0.16em] ${
        isDark ? 'text-slate-500' : 'text-slate-400'
      }`}>
        {label}
      </span>
      <span className={`text-sm font-bold leading-tight ${
        isDark ? 'text-slate-100' : 'text-slate-800'
      }`}>
        {value}
      </span>
    </div>
  );
}

// ─── Single DSO tile ──────────────────────────────────────────────────────

function TargetTile({
  target,
  timeZone,
  isDark,
  isAdmin,
  isScheduled,
  isScheduling,
  onSchedule,
}: {
  target: PlannerTarget;
  timeZone?: string;
  isDark: boolean;
  isAdmin: boolean;
  /** True when this object has already been added to tonight's schedule. */
  isScheduled: boolean;
  /** True while the network request for this tile is in flight. */
  isScheduling: boolean;
  onSchedule: (target: PlannerTarget) => void;
}) {
  const staticUrl = getCatalogStaticThumbnailUrl(target.id);
  const apiUrl    = getCatalogThumbnailUrl(target.id, target.majorAxisArcmin);

  const displayName = target.commonNames[0] ?? target.ngcName ?? target.name;
  const catalogId   = target.ngcName !== displayName ? target.ngcName : null;

  const altColor =
    target.maxAlt >= 60 ? 'text-emerald-500' :
    target.maxAlt >= 30 ? (isDark ? 'text-slate-200' : 'text-slate-700') :
    'text-amber-500';

  const tileBg = isDark
    ? 'bg-slate-800/60 border-slate-700/60'
    : 'bg-white border-slate-200 shadow-sm';

  return (
    <div className={`flex flex-col rounded-xl overflow-hidden border ${tileBg}`}>
      {/* Photo */}
      <div className="relative aspect-[4/3] bg-slate-950 overflow-hidden">
        <img
          src={staticUrl}
          onError={(e) => {
            const img = e.currentTarget;
            if (img.src !== apiUrl) img.src = apiUrl;
          }}
          alt=""
          aria-hidden="true"
          loading="lazy"
          className="w-full h-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-transparent to-transparent" />

        {/* Type badge */}
        <div className="absolute top-2.5 left-2.5">
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-semibold backdrop-blur-sm ${typeColor(target.type)}`}>
            {shortType(target.type)}
          </span>
        </div>

        {/* Add to schedule — admin only */}
        {isAdmin && (
          <button
            onClick={() => onSchedule(target)}
            disabled={isScheduled || isScheduling}
            title={isScheduled ? 'Already in tonight\'s schedule' : 'Add to tonight\'s schedule'}
            aria-label={isScheduled ? `${displayName} is in tonight's schedule` : `Add ${displayName} to tonight's schedule`}
            className={`absolute top-2.5 right-2.5 flex h-7 w-7 items-center justify-center rounded-full backdrop-blur-sm transition-all ${
              isScheduled
                ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/40 ring-2 ring-emerald-400/60'
                : isScheduling
                ? 'bg-slate-950/60 text-white/40 ring-1 ring-white/15 opacity-60'
                : 'bg-slate-950/60 text-white/70 hover:bg-slate-950/80 hover:text-emerald-400 ring-1 ring-white/15'
            }`}
          >
            {isScheduling
              ? <RotateCw className="h-3 w-3 animate-spin" strokeWidth={2.5} />
              : isScheduled
              ? <CalendarCheck className="h-3.5 w-3.5" strokeWidth={2.5} />
              : <CalendarPlus  className="h-3.5 w-3.5" strokeWidth={2.5} />
            }
          </button>
        )}

        {/* Constellation */}
        {target.constellation && (
          <span className="absolute bottom-2.5 right-2.5 text-[10.5px] font-medium text-white/70 tracking-wide">
            {target.constellation}
          </span>
        )}
      </div>

      {/* Caption */}
      <div className="px-3 pt-3 pb-1">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className={`font-display text-[14px] font-bold leading-tight truncate ${
            isDark ? 'text-slate-100' : 'text-slate-800'
          }`}>
            {displayName}
          </h3>
          {catalogId && (
            <span className={`text-[10.5px] font-mono shrink-0 ${
              isDark ? 'text-slate-500' : 'text-slate-400'
            }`}>
              {catalogId}
            </span>
          )}
        </div>
      </div>

      {/* Stats 2×2 */}
      <div className="px-3 pb-3 pt-2 grid grid-cols-2 gap-1.5">
        <StatCell
          label="Max alt"
          value={<span className={altColor}>{Math.round(target.maxAlt)}°</span>}
          isDark={isDark}
        />
        <StatCell
          label="Window"
          value={
            <span className="tabular-nums text-xs font-semibold">
              {fmtTime(target.risesAt, timeZone)}
              <span className={`mx-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>–</span>
              {fmtTime(target.setsAt, timeZone)}
            </span>
          }
          isDark={isDark}
        />
        <StatCell
          label="Duration"
          value={durationLabel(target.risesAt, target.setsAt)}
          isDark={isDark}
        />
        <StatCell
          label="Magnitude"
          value={
            target.magnitude != null
              ? target.magnitude.toFixed(1)
              : <span className={isDark ? 'text-slate-600' : 'text-slate-400'}>–</span>
          }
          isDark={isDark}
        />
      </div>
    </div>
  );
}

// ─── Section ──────────────────────────────────────────────────────────────

export function TonightTargets({
  siteId, timeZone, isDark,
  observerLat, observerLon,
  darkWindowStart, darkWindowEnd,
}: Props) {
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();

  const [shuffledIds,  setShuffledIds ] = useState<string[] | null>(null);
  const [schedulingId, setSchedulingId] = useState<string | null>(null);

  // ── Tonight's planned sessions — persistent across navigation ─────────
  // Queried from the global ['planned-sessions'] cache (same key as
  // PlannerPage) so the green "scheduled" state survives unmount/remount.
  // Enabled only when the dark window is known.
  const sessionsQuery = useQuery({
    queryKey: ['planned-sessions', darkWindowStart, darkWindowEnd],
    queryFn: () =>
      darkWindowStart && darkWindowEnd
        ? listPlannedSessions({ from: darkWindowStart, to: darkWindowEnd })
        : Promise.resolve([]),
    enabled: darkWindowStart != null && darkWindowEnd != null,
    staleTime: 0, // always fresh — we invalidate on every add
  });

  // Set of objectIds already scheduled tonight — survives page navigation.
  const scheduledIds = useMemo<Set<string>>(
    () => new Set((sessionsQuery.data ?? []).map(s => s.objectId)),
    [sessionsQuery.data],
  );

  const { data, isLoading, error } = useQuery({
    queryKey: ['planner-tonight-home', siteId],
    queryFn: () => getPlannerTargets({ limit: 200, siteId: siteId ?? undefined }),
    staleTime: 600_000,
    enabled: siteId != null,
  });

  const allTargets = useMemo<PlannerTarget[]>(
    () => data
      ? [...data.targets].sort((a, b) => (b.bestTonightScore ?? 0) - (a.bestTonightScore ?? 0))
      : [],
    [data],
  );

  const displayed = useMemo<PlannerTarget[]>(
    () => shuffledIds != null
      ? shuffledIds.flatMap(id => {
          const t = allTargets.find(x => x.id === id);
          return t ? [t] : [];
        })
      : diversePick(allTargets, 10),
    [shuffledIds, allTargets],
  );

  const handleShuffle = useCallback(() => {
    if (allTargets.length <= 10) return;
    const currentSet = new Set(displayed.map(t => t.id));
    const pool = allTargets.filter(t => !currentSet.has(t.id));
    const source = pool.length >= 10 ? pool : allTargets;
    setShuffledIds(diversePick(shuffle(source), 10).map(t => t.id));
  }, [allTargets, displayed]);

  // ── Add to tonight's schedule, collision-free ─────────────────────────
  // Strategy (mirrors PlannerPage's handleQuickAdd):
  //   1. Fetch existing planned sessions for tonight's window.
  //   2. Build a `busy: Interval[]` list from them.
  //   3. Call `bestSlotFor` — it finds the `DEFAULT_BLOCK_MINUTES`-long slot
  //      with the highest mean altitude that doesn't overlap any busy interval,
  //      within the dark window.  If every free slot is taken it returns the
  //      best slot anyway (with `clashes: true`) so the user can drag it later.
  //   4. If no slot of any kind fits, surface a clear error.
  const scheduleMut = useMutation({
    mutationFn: async (target: PlannerTarget) => {
      if (!darkWindowStart || !darkWindowEnd) {
        throw new Error('No dark window available tonight — cannot schedule.');
      }
      if (observerLat == null || observerLon == null) {
        throw new Error('Observer location is required to find the best slot.');
      }

      const windowStart = new Date(darkWindowStart);
      const windowEnd   = new Date(darkWindowEnd);

      // Fetch existing blocks for the night to build the busy list.
      const existing = await listPlannedSessions({
        from: windowStart.toISOString(),
        to:   windowEnd.toISOString(),
      });
      const busy: Interval[] = existing.map(s => ({
        start: new Date(s.startTime).getTime(),
        end:   new Date(s.endTime).getTime(),
      }));

      // Find the best non-overlapping slot for this target.
      const slot = bestSlotFor({
        ra:              target.ra,
        dec:             target.dec,
        lat:             observerLat,
        lon:             observerLon,
        windowStart,
        windowEnd,
        durationMinutes: DEFAULT_BLOCK_MINUTES,
        busy,
      });

      if (!slot) {
        throw new Error(
          `Cannot fit ${target.commonNames[0] ?? target.ngcName} into tonight's dark window ` +
          `(${DEFAULT_BLOCK_MINUTES} min block doesn't fit between ${darkWindowStart} and ${darkWindowEnd}).`,
        );
      }

      return createPlannedSession({
        objectId:   target.id,
        objectName: target.commonNames[0] ?? target.ngcName ?? target.name,
        ra:         target.ra,
        dec:        target.dec,
        startTime:  slot.start.toISOString(),
        endTime:    slot.end.toISOString(),
      });
    },

    onSuccess: () => {
      // Invalidate ALL planned-sessions queries — this refreshes both the
      // Planner page's timeline and our own sessionsQuery above, so the
      // green state is derived from real server data and survives navigation.
      queryClient.invalidateQueries({ queryKey: ['planned-sessions'] });
    },

    onSettled: () => {
      setSchedulingId(null);
    },
  });

  const handleSchedule = useCallback((target: PlannerTarget) => {
    if (schedulingId != null) return;
    setSchedulingId(target.id);
    scheduleMut.mutate(target);
  }, [schedulingId, scheduleMut]);

  // ── Design tokens ──────────────────────────────────────────────────────
  const outerBg   = isDark ? 'bg-[#0e1117] border-slate-700/50' : 'bg-slate-50 border-slate-200 shadow-sm';
  const headerBdr = isDark ? 'border-slate-700/60' : 'border-slate-200';
  const footerBdr = isDark ? 'border-slate-700/60 text-slate-600' : 'border-slate-200 text-slate-400';
  const canShuffle = allTargets.length > 10;

  return (
    <section
      aria-label="Tonight's easy targets"
      className={`rounded-2xl border overflow-hidden ${outerBg}`}
    >
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className={`px-5 pt-5 pb-4 border-b ${headerBdr} flex flex-wrap items-center justify-between gap-3`}>
        <div className="flex items-center gap-3">
          <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
            isDark ? 'bg-amber-500/15' : 'bg-amber-50'
          }`}>
            <Telescope className={`h-4 w-4 ${isDark ? 'text-amber-400' : 'text-amber-500'}`} />
          </div>
          <div>
            <h2 className={`font-display text-lg font-bold leading-tight ${
              isDark ? 'text-slate-100' : 'text-slate-800'
            }`}>
              Tonight's Easy Targets
            </h2>
            <p className={`text-[12px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {shuffledIds ? 'Shuffled mix' : 'Best per type'} · nebulae, clusters, galaxies &amp; more
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {data && (
            <span className={`text-[11px] tabular-nums ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
              {data.totalVisible} visible tonight
            </span>
          )}
          {canShuffle && (
            <button
              onClick={handleShuffle}
              title="Show a different random selection from tonight's catalog"
              aria-label="Shuffle targets"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all ${
                isDark
                  ? 'bg-slate-800/80 text-slate-400 hover:bg-slate-700 hover:text-slate-200'
                  : 'bg-slate-200/70 text-slate-500 hover:bg-slate-200 hover:text-slate-700'
              }`}
            >
              <Shuffle className="h-3.5 w-3.5" />
              Shuffle
            </button>
          )}
        </div>
      </div>

      {/* ── Body ────────────────────────────────────────────────────────── */}
      <div className="px-5 py-5">

        {/* Scheduling error toast */}
        {scheduleMut.isError && (
          <div className={`flex items-center gap-2 mb-4 px-3 py-2 rounded-xl text-xs ${
            isDark ? 'bg-red-950/40 text-red-400 border border-red-800/40' : 'bg-red-50 text-red-600 border border-red-200'
          }`}>
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {scheduleMut.error instanceof Error ? scheduleMut.error.message : 'Failed to add to schedule.'}
          </div>
        )}

        {/* Loading */}
        {isLoading && (
          <div className="flex items-center justify-center py-10">
            <RotateCw className={`h-5 w-5 animate-spin ${isDark ? 'text-slate-600' : 'text-slate-400'}`} />
          </div>
        )}

        {/* Error */}
        {error && !isLoading && (
          <div className={`flex items-center gap-2 text-sm ${isDark ? 'text-red-400' : 'text-red-600'}`}>
            <AlertCircle className="h-4 w-4 shrink-0" />
            Failed to load tonight's targets.
          </div>
        )}

        {/* No location */}
        {!siteId && !isLoading && (
          <p className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            Set an observing site in Settings to see tonight's targets.
          </p>
        )}

        {/* Tile grid */}
        {displayed.length > 0 && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {displayed.map(target => (
              <TargetTile
                key={target.id}
                target={target}
                timeZone={timeZone}
                isDark={isDark}
                isAdmin={isAdmin}
                isScheduled={scheduledIds.has(target.id)}
                isScheduling={schedulingId === target.id}
                onSchedule={handleSchedule}
              />
            ))}
          </div>
        )}

        {/* Empty */}
        {siteId && !isLoading && !error && displayed.length === 0 && data && (
          <p className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            No targets visible above the horizon tonight.
          </p>
        )}
      </div>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <div className={`px-5 py-3 text-[11px] border-t ${footerBdr}`}>
        Best {displayed.length} of {data?.totalVisible ?? '…'} objects visible tonight · satellite imagery via DSS2
      </div>
    </section>
  );
}
