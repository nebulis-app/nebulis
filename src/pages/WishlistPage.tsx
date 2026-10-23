/**
 * The wishlist as a full page — the "expand" destination from the Planner's
 * popup, and a landing zone in its own right for finding new things to
 * image (search-to-add) alongside managing what's already on the list.
 * Route: /wishlist. Also reachable directly from the top nav, where it is on
 * by default (turn it off in Settings -> General -> Navigation bar).
 *
 * The "Back to Planner" / "Minimize" row only makes sense when there's an
 * actual Planner popup underneath to return to, so it's gated on a
 * `location.state.fromPlanner` flag set by PlannerActions' onExpand — a
 * direct nav-bar visit, a shared link, or a refresh all render without it.
 *
 * Self-contained rather than fed by PlannerPage's props: navigating here
 * unmounts PlannerPage entirely, so scheduling needs its own read of
 * tonight's targets, dark window and busy sessions. `getPlannerTargets()`
 * already returns the resolved site's nightStart/nightEnd/observerLat/Lon in
 * one response, which is all `bestSlotFor` needs — this page has no
 * timeline UI to justify PlannerPage's extra twilight-buffer padding, so it
 * schedules straight into the dark window.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient, skipToken } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ArrowLeft, Download, Minimize2, Plus, Upload } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { useWishlist } from '../hooks/useWishlist';
import { getPlannerTargets, type PlannerTarget } from '../lib/api/planner';
import { listPlannedSessions, createPlannedSession } from '../lib/api/plannedSessions';
import { getSettings } from '../lib/api/settings';
import { bestSlotFor } from '../lib/plannerNight';
import { DEFAULT_BLOCK_MINUTES, MIN_BLOCK_MINUTES, clampTime, minutesBetween, snapToGrid } from '../components/planner/scheduleGeometry';
import { WishlistHero } from '../components/planner/WishlistHero';
import { WishlistList } from '../components/planner/WishlistList';
import { WISHLIST_PRIORITIES, type WishlistItem, type WishlistPriority } from '../lib/api/wishlist';
import { isOneOf, isRecord } from '../lib/typeGuards';

/** Portable shape for export/import: the server-assigned id and addedAt are
 *  left out on export (a re-import mints its own) and ignored on import if
 *  present, so a file exported from one install still imports cleanly into
 *  another. */
interface WishlistExportEntry {
  objectId: string;
  name: string;
  type?: string;
  constellation?: string | null;
  magnitude?: number | null;
  majorAxisArcmin?: number | null;
  priority?: WishlistPriority;
  notes?: string;
}

function isValidPriority(v: unknown): v is WishlistPriority {
  return typeof v === 'string' && isOneOf(WISHLIST_PRIORITIES, v);
}

function isExportEntry(v: unknown): v is WishlistExportEntry {
  return isRecord(v) && typeof v.objectId === 'string' && typeof v.name === 'string';
}

function downloadWishlist(items: WishlistItem[]) {
  const payload: WishlistExportEntry[] = items.map(i => ({
    objectId: i.objectId,
    name: i.name,
    type: i.type,
    constellation: i.constellation,
    magnitude: i.magnitude,
    majorAxisArcmin: i.majorAxisArcmin,
    priority: i.priority,
    notes: i.notes,
  }));
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `nebulis-wishlist-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function WishlistPage() {
  const { t } = useTranslation('planner');
  const { isDark, isNight, isSpace } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  // Only set when this page was reached via the Planner popup's "Open full
  // Wishlist" button (see PlannerActions/PlannerPage's onExpand). Arriving
  // any other way (top nav, a direct link, a refresh) means there's no
  // Planner popup underneath to return to or minimize back into, so that
  // row doesn't make sense.
  const navState: unknown = location.state;
  const fromPlanner = isRecord(navState) && Boolean(navState.fromPlanner);
  const queryClient = useQueryClient();
  const wishlist = useWishlist();
  const [addingAll, setAddingAll] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [scheduleWarning, setScheduleWarning] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const plannerQuery = useQuery({
    queryKey: ['planner-targets', 'wishlist-page'],
    queryFn: () => getPlannerTargets(),
    staleTime: 60_000,
  });
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: getSettings, staleTime: 5 * 60_000 });

  const planner = plannerQuery.data;
  const nightStart = planner?.nightStart ?? null;
  const nightEnd = planner?.nightEnd ?? null;
  const observerLat = planner?.observerLat ?? null;
  const observerLon = planner?.observerLon ?? null;
  const observerTimezone = planner?.observerTimezone ?? undefined;
  const minAlt = settingsQuery.data?.minAlt ?? 20;

  const sessionsQuery = useQuery({
    queryKey: ['planned-sessions', nightStart, nightEnd],
    queryFn: nightStart != null && nightEnd != null
      ? () => listPlannedSessions({ from: nightStart, to: nightEnd })
      : skipToken,
  });
  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);
  const scheduledIds = useMemo(() => new Set(sessions.map(s => s.objectId)), [sessions]);

  const targetsById = useMemo(() => {
    const map = new Map<string, PlannerTarget>();
    for (const target of planner?.targets ?? []) map.set(target.id, target);
    return map;
  }, [planner]);

  const heroStats = useMemo(() => ({
    total: wishlist.items.length,
    visibleTonight: wishlist.items.filter(i => targetsById.has(i.objectId)).length,
    highPriority: wishlist.items.filter(i => i.priority === 'high').length,
  }), [wishlist.items, targetsById]);

  /** Places one or more targets at their highest free point in tonight's dark
   *  window, sequentially, so a bulk call sees the slots it just placed
   *  rather than racing a stale busy list — same shape as PlannerPage's
   *  handleAddAllWishlistToPlan, just reading its window from this page's
   *  own query instead of PlannerPage's buffered timeline state.
   *
   *  A target with nowhere left to fit (most commonly: it's late enough that
   *  less than a 90-minute default block remains before the window closes)
   *  used to fail by simply not being scheduled, with no feedback at all —
   *  the button looked live and did nothing. `scheduleWarning` now reports
   *  exactly what got skipped and why, cleared automatically after a few
   *  seconds like the import-status line above it. */
  const scheduleTargets = useCallback(async (targets: PlannerTarget[]) => {
    setScheduleWarning(null);
    if (targets.length === 0) return;
    if (!nightStart || !nightEnd || observerLat == null || observerLon == null) {
      setScheduleWarning(t('wishlistPanel.scheduleFailedNoWindow'));
      return;
    }
    const windowStart = new Date(nightStart);
    const windowEnd = new Date(nightEnd);
    const FIVE = 5 * 60_000;
    const nowMs = Date.now();
    const earliest = nowMs > windowStart.getTime() && nowMs < windowEnd.getTime()
      ? new Date(Math.ceil(nowMs / FIVE) * FIVE)
      : windowStart;

    const skipped: string[] = [];
    const busy = sessions.map(s => ({ start: new Date(s.startTime).getTime(), end: new Date(s.endTime).getTime() }));
    for (const target of targets) {
      const slot = bestSlotFor({
        ra: target.ra,
        dec: target.dec,
        lat: observerLat,
        lon: observerLon,
        windowStart: earliest,
        windowEnd,
        durationMinutes: DEFAULT_BLOCK_MINUTES,
        busy,
        moonIllumination: planner?.moonIllumination,
      });
      if (!slot) { skipped.push(target.commonNames[0] ?? target.name); continue; }
      const start = clampTime(snapToGrid(slot.start), windowStart, windowEnd);
      const end = clampTime(new Date(start.getTime() + DEFAULT_BLOCK_MINUTES * 60_000), windowStart, windowEnd);
      if (minutesBetween(start, end) < MIN_BLOCK_MINUTES) { skipped.push(target.commonNames[0] ?? target.name); continue; }
      await createPlannedSession({
        objectId: target.id,
        objectName: target.name,
        ra: target.ra,
        dec: target.dec,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
      });
      busy.push({ start: start.getTime(), end: end.getTime() });
    }
    await queryClient.invalidateQueries({ queryKey: ['planned-sessions'] });

    if (skipped.length === targets.length && targets.length === 1) {
      setScheduleWarning(t('wishlistPanel.scheduleFailedNoRoom', { name: skipped[0] }));
    } else if (skipped.length > 0) {
      setScheduleWarning(t('wishlistPanel.scheduleFailedSomeNoRoom', { scheduled: targets.length - skipped.length, total: targets.length }));
    }
  }, [nightStart, nightEnd, observerLat, observerLon, sessions, planner?.moonIllumination, queryClient, t]);

  // Auto-clear the warning after a few seconds, same convention as importStatus.
  useEffect(() => {
    if (!scheduleWarning) return;
    const timer = setTimeout(() => setScheduleWarning(null), 8000);
    return () => clearTimeout(timer);
  }, [scheduleWarning]);

  const handleQuickAdd = useCallback((target: PlannerTarget) => { void scheduleTargets([target]); }, [scheduleTargets]);

  const handleAddAllVisibleToPlan = useCallback((items: WishlistItem[]) => {
    const targets = items.map(i => targetsById.get(i.objectId)).filter((t): t is PlannerTarget => !!t);
    setAddingAll(true);
    scheduleTargets(targets).finally(() => setAddingAll(false));
  }, [targetsById, scheduleTargets]);

  async function handleImportFile(file: File) {
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!Array.isArray(parsed)) throw new Error('not an array');
      const entries = parsed.filter(isExportEntry);
      for (const entry of entries) {
        wishlist.add({
          objectId: entry.objectId,
          name: entry.name,
          type: entry.type,
          constellation: entry.constellation,
          magnitude: entry.magnitude,
          majorAxisArcmin: entry.majorAxisArcmin,
          priority: isValidPriority(entry.priority) ? entry.priority : undefined,
          notes: typeof entry.notes === 'string' ? entry.notes : undefined,
        });
      }
      setImportStatus(t('wishlistPage.importedCount', { count: entries.length }));
    } catch {
      setImportStatus(t('wishlistPage.importFailed'));
    } finally {
      setTimeout(() => setImportStatus(null), 5000);
    }
  }

  return (
    <div className="space-y-5">
      {fromPlanner && (
        <div className="flex items-center justify-between gap-3">
          <Link
            to="/planner"
            className={`inline-flex items-center gap-2 text-sm font-medium transition ${
              isDark ? 'text-slate-400 hover:text-accent-400' : 'text-slate-500 hover:text-accent-600'
            }`}
          >
            <ArrowLeft className="h-4 w-4" />
            {t('wishlistPanel.backToPlanner')}
          </Link>
          <button
            onClick={() => navigate('/planner', { state: { openWishlist: true } })}
            className={`inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
              isDark ? 'text-slate-400 hover:bg-white/10 hover:text-slate-200' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
            }`}
            title={t('wishlistPage.minimize')}
          >
            <Minimize2 className="h-3.5 w-3.5" />
            {t('wishlistPage.minimize')}
          </button>
        </div>
      )}

      <WishlistHero
        total={heroStats.total}
        visibleTonight={heroStats.visibleTonight}
        highPriority={heroStats.highPriority}
        accent={isNight ? '#f87171' : isSpace ? '#a78bfa' : '#fbbf24'}
      />

      <div>
        {/* Page-level actions in one row: list title, and import/export/add.
            "Add target" opens Explore, the catalog-wide search and browse,
            rather than a search field here that would sit right on top of
            WishlistList's own "search your wishlist" filter. */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h2 className={`text-base font-semibold shrink-0 ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
            {t('wishlistPage.yourWishlist')}
          </h2>
          <div className="flex items-center gap-2">
            {importStatus && <span className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{importStatus}</span>}
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleImportFile(file);
                e.target.value = '';
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition ${
                isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              <Upload className="w-4 h-4" />
              {t('wishlistPage.import')}
            </button>
            <button
              onClick={() => downloadWishlist(wishlist.items)}
              disabled={wishlist.items.length === 0}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition disabled:opacity-40 disabled:cursor-not-allowed ${
                isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              <Download className="w-4 h-4" />
              {t('wishlistPage.export')}
            </button>
            <button
              onClick={() => navigate('/explore')}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold bg-amber-500 hover:bg-amber-600 text-white transition"
            >
              <Plus className="w-4 h-4" />
              {t('wishlistPage.addTarget')}
            </button>
          </div>
        </div>

        {scheduleWarning && (
          <div className={`mb-3 flex items-center gap-2 rounded-xl px-3 py-2 text-sm ${
            isDark ? 'bg-amber-950/30 text-amber-400 border border-amber-800/40' : 'bg-amber-50 text-amber-700 border border-amber-200'
          }`}>
            <AlertCircle className="h-4 w-4 shrink-0" />
            {scheduleWarning}
          </div>
        )}

        <WishlistList
          items={wishlist.items}
          layout="grid"
          targets={planner?.targets ?? []}
          scheduledIds={scheduledIds}
          observerLat={observerLat}
          observerLon={observerLon}
          minAlt={minAlt}
          moonIllumination={planner?.moonIllumination}
          observerTimezone={observerTimezone}
          isDark={isDark}
          isNight={isNight}
          isSpace={isSpace}
          onSetPriority={wishlist.setPriority}
          onSetNotes={wishlist.setNotes}
          onRemove={wishlist.remove}
          onQuickAdd={nightStart && nightEnd ? handleQuickAdd : undefined}
          onAddAllVisibleToPlan={handleAddAllVisibleToPlan}
          addingAll={addingAll}
        />
      </div>

    </div>
  );
}
