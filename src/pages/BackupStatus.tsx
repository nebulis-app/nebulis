/**
 * Backup Status.
 *
 * The page answers three questions, in this order: is my library current, is
 * each telescope covered, and what has happened lately. That is why it is a
 * hero, a row of telescope cards, and a history list, rather than the three
 * equal-weight panels it used to be. The old page also carried a "Ready to
 * Sync" card that restated the header and a stat grid that only existed during
 * a run: both now live inside the hero, which is the one thing that changes
 * shape between idle and syncing.
 */
import { Link } from 'react-router-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, AlertTriangle, Ban, Telescope, Plus } from 'lucide-react';
import {
  getImportStatus, triggerImport, cancelImport, getImportHistory,
  type ImportHistoryEntry, type ImportSkip,
} from '../lib/api/library';
import { getAllTelescopeStatus, listTelescopes } from '../lib/api/telescopes';
import { useTheme } from '../hooks/useTheme';
import { SkippedNotice } from '../components/SkippedNotice';
import { BackupHero, type BackupRollup } from '../components/backup/BackupHero';
import { TelescopeCard, type TelescopeCardModel } from '../components/backup/TelescopeCard';
import { SyncHistoryPanel } from '../components/backup/SyncHistoryPanel';
import { SkippedFilesModal } from '../components/backup/SkippedFilesModal';
import { DeletedSessionsModal } from '../components/backup/DeletedSessionsModal';
import { formatRelativeTime } from '../lib/timeFormat';

/** How far back the hero's "recent" figures look, when history reaches that far. */
const WINDOW_DAYS = 30;
/** Server caps the history page at 50 rows; the rollup asks for all of them. */
const ROLLUP_ROWS = 50;

export function BackupStatus() {
  const { isDark, isNight, isSpace } = useTheme();
  // The hero is night-side in every theme (a picture of the sky), so it takes
  // the bright accent hex directly rather than the light-mode-darkened token,
  // matching the Library, Gallery and Observations banners.
  const accent = isNight ? '#f87171' : isSpace ? '#a78bfa' : '#fbbf24';
  const queryClient = useQueryClient();

  const [inspectSkip, setInspectSkip] = useState<ImportSkip | null>(null);
  const [showDeletedSessions, setShowDeletedSessions] = useState(false);

  const { data: status } = useQuery({
    queryKey: ['import-status'],
    queryFn: getImportStatus,
    refetchInterval: (query) => query.state.data?.running ? 1000 : 10_000,
  });

  const { data: allTelescopeStatus } = useQuery({
    // Shared with Layout / ConnectionSection / SettingsHero. Must match the key
    // those use (and that AddTelescopeModal / ConnectionSection invalidate)
    // so adding or removing a telescope updates this page's cards immediately
    // instead of after this query's own 30s tick.
    queryKey: ['telescope-status-all'],
    queryFn: getAllTelescopeStatus,
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  // Profiles, purely for the auto-sync cadence: the status endpoint reports
  // reachability but not whether the scheduler will pick this telescope up on
  // its own, which is the difference between "I must click Sync" and "it is
  // already handled".
  const { data: profiles } = useQuery({
    queryKey: ['telescopes'],
    queryFn: listTelescopes,
    staleTime: 60_000,
  });

  // Recent runs, for the hero figures and each card's "last synced". Shares the
  // ['import-history', ...] prefix with the history list so one invalidation
  // refreshes both.
  const { data: recentHistory } = useQuery({
    queryKey: ['import-history', 'recent'],
    queryFn: () => getImportHistory(ROLLUP_ROWS, 0),
    staleTime: 30_000,
  });

  const isRunning = status?.running ?? false;
  const anyOnline = allTelescopeStatus?.some(t => t.online) ?? false;
  const multiple = (allTelescopeStatus?.length ?? 0) > 1;

  const importMutation = useMutation({
    mutationFn: () => triggerImport(multiple ? { all: true } : {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['import-status'] });
    },
  });

  /** Sync one telescope. Separate from the sync-all mutation above so the card
   *  that was clicked can show its own pending state, and so a failure on one
   *  telescope is reported against that card rather than the page header. */
  const singleImportMutation = useMutation({
    mutationFn: (telescopeId: string) => triggerImport({ telescopeId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['import-status'] });
    },
  });

  // Scoped to the runId of the sync currently shown on this page, so a stray
  // click can't cancel a different run that raced in between this page's last
  // poll and the click (e.g. the auto-import scheduler firing).
  const cancelMutation = useMutation({
    mutationFn: (runId: string) => cancelImport(runId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['import-status'] });
    },
  });

  // The finished run's history row is written server-side right as `running`
  // flips back to false, so catching that transition (already visible here via
  // the 1s status poll while a sync is active) is enough to refresh the history
  // and the hero figures the moment a run ends. No manual reload, and no
  // polling of the history endpoint itself.
  const wasRunningRef = useRef(isRunning);
  useEffect(() => {
    if (wasRunningRef.current && !isRunning) {
      queryClient.invalidateQueries({ queryKey: ['import-history'] });
    }
    wasRunningRef.current = isRunning;
  }, [isRunning, queryClient]);

  const rollup = useMemo(() => summarize(recentHistory?.entries ?? [], recentHistory?.total ?? 0), [recentHistory]);

  const cards: TelescopeCardModel[] = useMemo(() => {
    const entries = recentHistory?.entries ?? [];
    return (allTelescopeStatus ?? []).map(t => {
      const profile = profiles?.find(p => p.id === t.id);
      return {
        ...t,
        lastSyncAt: lastSuccessFor(entries, t.id),
        autoSync: profile
          ? { enabled: profile.autoImportEnabled ?? false, intervalMinutes: profile.autoImportInterval ?? 60 }
          : undefined,
      };
    });
  }, [allTelescopeStatus, profiles, recentHistory]);

  const lastFailure = !isRunning && status?.error ? status : null;

  return (
    <div className="space-y-6">
      <Link
        to="/"
        className={`inline-flex items-center gap-2 text-sm font-medium transition ${
          isDark ? 'text-slate-400 hover:text-accent-400' : 'text-slate-500 hover:text-accent-600'
        }`}
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Library
      </Link>

      <BackupHero
        status={status}
        accent={accent}
        telescopesOnline={allTelescopeStatus?.filter(t => t.online).length ?? 0}
        telescopesTotal={allTelescopeStatus?.length ?? 0}
        rollup={rollup}
        syncLabel={multiple ? 'Sync All' : 'Sync Now'}
        syncDisabled={importMutation.isPending || !anyOnline}
        syncPending={importMutation.isPending}
        onSync={() => importMutation.mutate()}
        onCancel={() => status?.runId && cancelMutation.mutate(status.runId)}
        cancelPending={cancelMutation.isPending}
      />

      {/* The full text of a failed or cancelled run. The hero only flags that it
          happened: an SMB error runs long, and it reads far better on a panel
          than reversed out over artwork. */}
      {lastFailure && (
        <div className={`flex items-start gap-3 rounded-2xl border p-4 ${
          lastFailure.cancelled
            ? (isDark ? 'bg-amber-500/10 border-amber-500/25' : 'bg-amber-50 border-amber-200')
            : (isDark ? 'bg-red-500/10 border-red-500/25' : 'bg-red-50 border-red-200')
        }`}>
          {lastFailure.cancelled
            ? <Ban className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />}
          <div className="min-w-0 space-y-1">
            <p className={`text-sm font-semibold ${
              lastFailure.cancelled
                ? (isDark ? 'text-amber-300' : 'text-amber-800')
                : (isDark ? 'text-red-300' : 'text-red-800')
            }`}>
              {lastFailure.cancelled ? 'Last sync was cancelled' : 'Last sync failed'}
            </p>
            <p className={`select-text break-words text-sm ${
              lastFailure.cancelled
                ? (isDark ? 'text-amber-200/85' : 'text-amber-700')
                : (isDark ? 'text-red-200/85' : 'text-red-700')
            }`}>
              {lastFailure.error}
            </p>
            {lastFailure.lastRun && (
              <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                Attempted {formatRelativeTime(lastFailure.lastRun)}
              </p>
            )}
          </div>
        </div>
      )}

      <section className="space-y-3">
        <h2 className={`font-display flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.12em] ${
          isDark ? 'text-slate-500' : 'text-slate-400'
        }`}>
          <Telescope className="h-4 w-4" />
          Telescopes
        </h2>

        {cards.length === 0 ? (
          <div className={`rounded-2xl border p-6 text-center ${
            isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
          }`}>
            <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              No telescope is set up yet. Add one and its captures will sync here.
            </p>
            <Link
              to="/settings?tab=hardware"
              className={`mt-3 inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium transition-colors ${
                isDark ? 'bg-slate-800 text-slate-200 hover:bg-slate-700' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              <Plus className="h-3.5 w-3.5" />
              Add a telescope
            </Link>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {cards.map(t => (
              <TelescopeCard
                key={t.id}
                telescope={t}
                isDark={isDark}
                importRunning={isRunning}
                runningTelescopeId={status?.telescopeId ?? null}
                pending={singleImportMutation.isPending && singleImportMutation.variables === t.id}
                onSync={() => singleImportMutation.mutate(t.id)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Why the run brought fewer files than the telescope holds. A footnote to
          the figures above, so it sits after the sources rather than wedged
          between the hero and them. Shown in both states: it grows as a run
          walks each object, and the question is asked just as often once the
          run is over. Renders nothing when there is nothing to explain. */}
      <SkippedNotice
        skipped={status?.skipped}
        isDark={isDark}
        heading={total => isRunning
          ? `${total.toLocaleString()} file${total !== 1 ? 's' : ''} on the telescope are being left out:`
          : `${total.toLocaleString()} file${total !== 1 ? 's' : ''} were left on the telescope:`}
        onInspect={setInspectSkip}
        onReviewDeletedSessions={() => setShowDeletedSessions(true)}
      />

      <SyncHistoryPanel isDark={isDark} />

      <SkippedFilesModal skip={inspectSkip} isDark={isDark} onClose={() => setInspectSkip(null)} />
      <DeletedSessionsModal
        isOpen={showDeletedSessions}
        isDark={isDark}
        onClose={() => setShowDeletedSessions(false)}
      />
    </div>
  );
}

/** Finish time of the most recent successful run for one telescope. */
function lastSuccessFor(entries: ImportHistoryEntry[], telescopeId: string): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const e of entries) {
    if (e.error || e.telescopeId !== telescopeId) continue;
    const ms = Date.parse(e.finishedAt);
    if (!Number.isNaN(ms) && ms > bestMs) { bestMs = ms; best = e.finishedAt; }
  }
  return best;
}

/**
 * Roll the recent runs up into the figures the hero shows.
 *
 * `total` is the server's full history count. When it exceeds the rows we
 * fetched, the window may not actually reach back 30 days, so the label is
 * narrowed to the span we really have rather than claiming a month and
 * undercounting it.
 */
function summarize(entries: ImportHistoryEntry[], total: number): BackupRollup {
  const now = Date.now();
  const cutoff = now - WINDOW_DAYS * 86_400_000;

  let lastSuccessAt: string | null = null;
  let lastSuccessMs = -Infinity;
  let oldestMs = now;
  let windowFiles = 0;
  let windowBytes = 0;
  let windowFailures = 0;

  for (const e of entries) {
    const ms = Date.parse(e.finishedAt);
    if (Number.isNaN(ms)) continue;
    if (ms < oldestMs) oldestMs = ms;
    if (!e.error && ms > lastSuccessMs) { lastSuccessMs = ms; lastSuccessAt = e.finishedAt; }
    if (ms < cutoff) continue;
    windowFiles += e.newFiles;
    windowBytes += e.bytesNew;
    // A cancellation is a choice the user made, not a fault to report back.
    if (e.error && !e.cancelled) windowFailures += 1;
  }

  const spanDays = Math.max(1, Math.ceil((now - oldestMs) / 86_400_000));
  const truncated = total > entries.length;

  return {
    lastSuccessAt,
    windowFiles,
    windowBytes,
    windowFailures,
    windowDays: truncated ? Math.min(WINDOW_DAYS, spanDays) : WINDOW_DAYS,
  };
}
