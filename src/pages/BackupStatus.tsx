import { Link } from 'react-router-dom';
import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Download,
  Clock,
  HardDrive,
  FileStack,
  FileX,
  FolderSync,
  Telescope,
  XCircle,
  Ban,
  ChevronLeft,
  ChevronRight,
  Info,
  X,
  History,
  Usb,
  Network,
} from 'lucide-react';
import { getImportStatus, triggerImport, cancelImport, getImportHistory, formatTransport, type ImportHistoryEntry } from '../lib/api/library';
import { getAllTelescopeStatus } from '../lib/api/telescopes';
import { useTheme } from '../hooks/useTheme';
import { SkippedNotice } from '../components/SkippedNotice';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0)} ${sizes[i]}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return 'just started';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function BackupStatus() {
  const { isDark } = useTheme();
  const queryClient = useQueryClient();

  const { data: status } = useQuery({
    queryKey: ['import-status'],
    queryFn: getImportStatus,
    refetchInterval: (query) => query.state.data?.running ? 1000 : 10_000,
  });

  const { data: allTelescopeStatus } = useQuery({
    queryKey: ['all-telescope-status'],
    queryFn: getAllTelescopeStatus,
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  const anyOnline = allTelescopeStatus?.some(t => t.online) ?? false;

  const importMutation = useMutation({
    mutationFn: () => triggerImport(allTelescopeStatus && allTelescopeStatus.length > 1 ? { all: true } : {}),
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
  // click can't cancel a different run that raced in between this page's
  // last poll and the click (e.g. the auto-import scheduler firing).
  const cancelMutation = useMutation({
    mutationFn: (runId: string) => cancelImport(runId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['import-status'] });
    },
  });

  const isRunning = status?.running ?? false;

  // The finished run's history row is written server-side right as `running`
  // flips back to false, so catching that transition (already visible here
  // via the 1s status poll while a sync is active) is enough to refresh Sync
  // History the moment a run ends — no manual page reload needed, and no
  // polling of the history endpoint itself required.
  const wasRunningRef = useRef(isRunning);
  useEffect(() => {
    if (wasRunningRef.current && !isRunning) {
      queryClient.invalidateQueries({ queryKey: ['import-history'] });
    }
    wasRunningRef.current = isRunning;
  }, [isRunning, queryClient]);

  const isWarming = !!status?.warmingThumbnails;
  const fileProgress = status && status.objectsTotal > 0
    ? Math.min(
        100,
        Math.round(
          ((status.objectsDone +
            (status.currentObjectFilesTotal > 0
              ? status.currentObjectFilesDone / status.currentObjectFilesTotal
              : 0)) /
            status.objectsTotal) *
            100,
        ),
      )
    : isWarming ? 100 : 0;
  const elapsed = status?.startedAt
    ? Date.now() - new Date(status.startedAt).getTime()
    : 0;
  const transferRate = elapsed > 2000 && status
    ? status.bytesDone / (elapsed / 1000)
    : 0;
  const newFiles = status ? status.filesDone - status.skippedFiles : 0;

  return (
    <div className="space-y-8">
      {/* Breadcrumb */}
      <Link
        to="/"
        className={`inline-flex items-center gap-2 text-sm font-medium transition ${
          isDark ? 'text-slate-400 hover:text-accent-400' : 'text-slate-500 hover:text-accent-600'
        }`}
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Library
      </Link>

      {/* Page header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`p-2.5 rounded-xl ${
            isDark ? 'bg-accent-500/10' : 'bg-accent-50'
          }`}>
            <FolderSync className={`w-6 h-6 ${isDark ? 'text-accent-400' : 'text-accent-600'}`} />
          </div>
          <div>
            <h1 className={`font-display text-2xl font-bold tracking-tight ${
              isDark ? 'text-white' : 'text-slate-900'
            }`}>
              Backup Status
            </h1>
            <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              Sync images from your connected telescopes
            </p>
          </div>
        </div>

        {!isRunning && (
          <button
            onClick={() => importMutation.mutate()}
            disabled={importMutation.isPending || !anyOnline}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-all ${
              isDark
                ? 'bg-accent-500/15 text-accent-400 hover:bg-accent-500/25 border border-accent-500/30 disabled:opacity-40'
                : 'bg-accent-300 text-accent-700 hover:bg-accent-400 border border-accent-400 disabled:opacity-40'
            }`}
          >
            <Download className="w-4 h-4" />
            {/* Distinguished from the per-telescope buttons on the cards below,
                which would otherwise both read "Sync". */}
            {allTelescopeStatus && allTelescopeStatus.length > 1 ? 'Sync All' : 'Sync Now'}
          </button>
        )}
      </div>

      {/* Telescope connection cards */}
      {allTelescopeStatus && allTelescopeStatus.length > 0 && (
        <div className={`rounded-2xl border divide-y overflow-hidden ${
          isDark ? 'bg-slate-900 border-slate-800 divide-slate-800' : 'bg-white border-slate-200 divide-slate-100 shadow-sm'
        }`}>
          {allTelescopeStatus.map(t => (
            <div key={t.id} className="flex items-center gap-4 px-5 py-4">
              <div className={`p-2.5 rounded-xl ${
                t.online
                  ? isDark ? 'bg-emerald-500/10' : 'bg-emerald-50'
                  : isDark ? 'bg-slate-800' : 'bg-slate-100'
              }`}>
                <Telescope className={`w-4 h-4 ${
                  t.online ? 'text-emerald-500' : isDark ? 'text-slate-500' : 'text-slate-400'
                }`} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: t.color }}
                  />
                  <span className={`font-medium truncate ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                    {t.name}
                  </span>
                  {/* Transport pill: shows which method the probe is using
                      right now. Dims when offline so users can tell the
                      pill reflects a configured-but-unreachable transport. */}
                  {t.configured && (
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium border shrink-0 ${
                      !t.online
                        ? (isDark ? 'bg-slate-800/60 text-slate-500 border-slate-700/60' : 'bg-slate-100 text-slate-400 border-slate-200')
                        : t.transportKind === 'local'
                          ? (isDark ? 'bg-amber-500/15 text-amber-300 border-amber-500/30' : 'bg-amber-50 text-amber-700 border-amber-200')
                          : (isDark ? 'bg-sky-500/15 text-sky-300 border-sky-500/30' : 'bg-sky-50 text-sky-700 border-sky-200')
                    }`}>
                      {t.transportKind === 'local' ? <Usb className="w-2.5 h-2.5" /> : <Network className="w-2.5 h-2.5" />}
                      {formatTransport(t.transportKind)}
                    </span>
                  )}
                </div>
                {t.configured && (
                  <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    {t.hostname}
                    {t.online && t.latencyMs != null && ` · ${t.latencyMs}ms`}
                  </p>
                )}
              </div>
              <span className={`text-xs font-medium shrink-0 ${
                t.online
                  ? 'text-emerald-500'
                  : isDark ? 'text-slate-500' : 'text-slate-400'
              }`}>
                {t.online ? 'Online' : 'Offline'}
              </span>
              <TelescopeSyncButton
                telescope={t}
                isDark={isDark}
                // Imports hold a single global lock, so any run blocks all the
                // buttons; the one whose telescope is actually running says so.
                importRunning={isRunning}
                runningTelescopeId={status?.telescopeId ?? null}
                pending={singleImportMutation.isPending && singleImportMutation.variables === t.id}
                onSync={() => singleImportMutation.mutate(t.id)}
              />
            </div>
          ))}
        </div>
      )}

      {/* Active sync card */}
      {isRunning && status && (
        <div className={`rounded-2xl border p-6 space-y-6 ${
          isDark
            ? 'bg-gradient-to-br from-accent-500/5 to-slate-900 border-accent-500/20'
            : 'bg-gradient-to-br from-accent-50 to-white border-accent-200 shadow-sm'
        }`}>
          {/* Header */}
          <div className="flex items-center gap-3">
            <RefreshCw className={`w-5 h-5 animate-spin ${isDark ? 'text-accent-400' : 'text-accent-600'}`} />
            <div className="flex-1">
              <h2 className={`font-display font-semibold text-lg ${isDark ? 'text-white' : 'text-slate-900'}`}>
                {isWarming ? 'Generating Thumbnails' : 'Syncing in Progress'}
              </h2>
              {isWarming && status.warmingThumbnails ? (
                <p className={`text-sm ${isDark ? 'text-accent-400/70' : 'text-accent-600/70'}`}>
                  <span className="font-medium">{status.warmingThumbnails.done}</span> of <span className="font-medium">{status.warmingThumbnails.total}</span> objects
                </p>
              ) : status.currentObject ? (
                <p className={`text-sm ${isDark ? 'text-accent-400/70' : 'text-accent-600/70'}`}>
                  Currently importing <span className="font-medium">{status.currentObject}</span>
                  {status.telescopeName ? <> from <span className="font-medium">{status.telescopeName}</span></> : null}
                </p>
              ) : null}
            </div>
            {status.startedAt && (
              <div className={`flex items-center gap-1.5 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                <Clock className="w-3.5 h-3.5" />
                {formatDuration(elapsed)}
              </div>
            )}
            {/* Thumbnail warming is a quick, local, best-effort pass over
                already-downloaded files with no cancellation hook of its own
                (see pregenerateObjectThumbnails) — cancelling then would sit
                and do nothing until it finished anyway, so the button is
                only offered during the actual transfer. */}
            {!isWarming && status.runId && (
              <button
                onClick={() => cancelMutation.mutate(status.runId!)}
                disabled={cancelMutation.isPending}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition disabled:opacity-50 ${
                  isDark
                    ? 'border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                    : 'border-slate-200 text-slate-500 hover:bg-slate-100 hover:text-slate-700'
                }`}
              >
                <X className="w-3.5 h-3.5" />
                {cancelMutation.isPending ? 'Cancelling…' : 'Cancel'}
              </button>
            )}
          </div>

          {/* Main progress bar */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className={isDark ? 'text-slate-300' : 'text-slate-600'}>
                {isWarming ? 'Thumbnail Progress' : 'Overall Progress'}
              </span>
              <span className={`font-mono font-medium ${isDark ? 'text-accent-400' : 'text-accent-600'}`}>
                {isWarming && status.warmingThumbnails
                  ? `${status.warmingThumbnails.done} / ${status.warmingThumbnails.total}`
                  : `${fileProgress}%`}
              </span>
            </div>
            <div className={`h-3 rounded-full overflow-hidden ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`}>
              <div
                className="h-full rounded-full bg-gradient-to-r from-accent-500 to-accent-400 transition-all duration-700 ease-out"
                style={{
                  width: isWarming && status.warmingThumbnails
                    ? `${Math.round((status.warmingThumbnails.done / status.warmingThumbnails.total) * 100)}%`
                    : `${fileProgress}%`,
                }}
              />
            </div>
          </div>

          {/* Stats grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <StatBox
              icon={<FolderSync className="w-4 h-4" />}
              label="Objects"
              value={`${status.objectsDone} / ${status.objectsTotal}`}
              isDark={isDark}
            />
            <StatBox
              icon={<FileStack className="w-4 h-4" />}
              label="Files"
              value={`${status.filesDone} / ${status.filesTotal}`}
              sub={status.skippedFiles > 0 ? `${status.skippedFiles} already synced` : undefined}
              isDark={isDark}
            />
            <StatBox
              icon={<HardDrive className="w-4 h-4" />}
              label="Data"
              value={status.bytesTotal > 0
                ? `${formatBytes(status.bytesDone)} / ${formatBytes(status.bytesTotal)}`
                : 'Calculating...'
              }
              sub={transferRate > 0 ? `${formatBytes(transferRate)}/s` : undefined}
              isDark={isDark}
            />
            <StatBox
              icon={<Download className="w-4 h-4" />}
              label="New Files"
              value={String(newFiles > 0 ? newFiles : '-')}
              isDark={isDark}
            />
          </div>

          {/* What this run is leaving on the telescope, and why. Grows as the
              run walks each object, so it is worth showing mid-sync. */}
          <SkippedNotice
            skipped={status.skipped}
            isDark={isDark}
            heading={total => `${total.toLocaleString()} file${total !== 1 ? 's' : ''} on the telescope are being left out:`}
          />

          {/* Error / cancellation. A cancellation isn't a failure — it's
              amber and uses Ban rather than the red AlertTriangle a genuine
              error gets. */}
          {status.error && (
            <div className={`flex items-start gap-3 px-4 py-3 rounded-xl ${
              status.cancelled
                ? (isDark ? 'bg-amber-500/10 text-amber-400' : 'bg-amber-50 text-amber-700')
                : (isDark ? 'bg-red-500/10 text-red-400' : 'bg-red-50 text-red-600')
            }`}>
              {status.cancelled
                ? <Ban className="w-4 h-4 mt-0.5 shrink-0" />
                : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />}
              <p className="text-sm">{status.error}</p>
            </div>
          )}
        </div>
      )}

      {/* Sync History */}
      <SyncHistory isDark={isDark} />

      {/* Idle state */}
      {!isRunning && (
        <div className={`rounded-2xl border p-6 ${
          isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
        }`}>
          {status?.error ? (
            <div className="flex items-start gap-4">
              <div className={`p-3 rounded-xl ${
                status.cancelled
                  ? (isDark ? 'bg-amber-500/10' : 'bg-amber-50')
                  : (isDark ? 'bg-red-500/10' : 'bg-red-50')
              }`}>
                {status.cancelled
                  ? <Ban className="w-5 h-5 text-amber-500" />
                  : <XCircle className="w-5 h-5 text-red-500" />}
              </div>
              <div className="flex-1">
                <h2 className={`font-display font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                  {status.cancelled ? 'Last Sync Cancelled' : 'Last Sync Failed'}
                </h2>
                <p className={`text-sm mt-1 ${
                  status.cancelled
                    ? (isDark ? 'text-amber-400/80' : 'text-amber-700/80')
                    : (isDark ? 'text-red-400/80' : 'text-red-600/80')
                }`}>
                  {status.error}
                </p>
                {status.lastRun && (
                  <p className={`text-xs mt-2 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    Last attempted {formatRelativeTime(status.lastRun)}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-4">
              <div className={`p-3 rounded-xl ${isDark ? 'bg-emerald-500/10' : 'bg-emerald-50'}`}>
                <CheckCircle2 className="w-5 h-5 text-emerald-500" />
              </div>
              <div className="flex-1">
                <h2 className={`font-display font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                  Ready to Sync
                </h2>
                <p className={`text-sm mt-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  {status?.lastRun
                    ? `Last sync completed ${formatRelativeTime(status.lastRun)}`
                    : 'No sync has been run yet'}
                </p>
                {status && status.filesTotal > 0 && !status.running && (
                  <div className={`flex items-center gap-4 mt-3 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    <span className="flex items-center gap-1">
                      <FileStack className="w-3.5 h-3.5" />
                      {status.filesDone} files processed
                    </span>
                    {status.bytesTotal > 0 && (
                      <span className="flex items-center gap-1">
                        <HardDrive className="w-3.5 h-3.5" />
                        {formatBytes(status.bytesTotal)} total
                      </span>
                    )}
                  </div>
                )}
                {/* Kept on screen after the run ends: "why did it pull fewer
                    files than are on my telescope?" is asked once the sync is
                    over, not while it is running. */}
                {status && !status.running && (
                  <div className="mt-3">
                    <SkippedNotice
                      skipped={status.skipped}
                      isDark={isDark}
                      heading={total => `${total.toLocaleString()} file${total !== 1 ? 's' : ''} were left on the telescope:`}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const PAGE_SIZE = 10;

/**
 * Per-telescope sync trigger.
 *
 * Imports take a single global lock (one run at a time, server-side), so any
 * running import disables every button rather than only the one that started it.
 * The card whose telescope is actually mid-run says "Syncing" so the disabled
 * state is explained instead of just looking broken.
 */
function TelescopeSyncButton({
  telescope, isDark, importRunning, runningTelescopeId, pending, onSync,
}: {
  telescope: { id: string; online: boolean; configured: boolean };
  isDark: boolean;
  importRunning: boolean;
  runningTelescopeId: string | null;
  pending: boolean;
  onSync: () => void;
}) {
  const isThisOne = importRunning && runningTelescopeId === telescope.id;
  const disabled = !telescope.online || !telescope.configured || importRunning || pending;

  const title = !telescope.configured
    ? 'This telescope has no connection configured yet'
    : !telescope.online
      ? 'This telescope is offline'
      : importRunning && !isThisOne
        ? 'Another sync is running. Only one can run at a time.'
        : 'Sync this telescope now';

  return (
    <button
      onClick={onSync}
      disabled={disabled}
      title={title}
      aria-label={isThisOne ? 'Syncing this telescope' : 'Sync this telescope now'}
      className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
        disabled
          ? isDark
            ? 'bg-slate-800/60 text-slate-600 cursor-not-allowed'
            : 'bg-slate-100 text-slate-400 cursor-not-allowed'
          : isDark
            ? 'bg-slate-800 text-slate-200 hover:bg-slate-700'
            : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
      }`}
    >
      <RefreshCw className={`w-3.5 h-3.5 ${isThisOne || pending ? 'animate-spin' : ''}`} />
      {isThisOne ? 'Syncing' : 'Sync'}
    </button>
  );
}

function SyncHistory({ isDark }: { isDark: boolean }) {
  const [page, setPage] = useState(0);
  const [filesModal, setFilesModal] = useState<ImportHistoryEntry | null>(null);

  const { data } = useQuery({
    queryKey: ['import-history', page],
    queryFn: () => getImportHistory(PAGE_SIZE, page * PAGE_SIZE),
    staleTime: 30_000,
  });

  if (!data || data.total === 0) return null;

  const totalPages = Math.ceil(data.total / PAGE_SIZE);

  return (
    <>
      <div className={`rounded-2xl border p-6 ${
        isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
      }`}>
        <div className="flex items-center justify-between mb-4">
          <h2 className={`font-display font-semibold text-lg flex items-center gap-2 ${
            isDark ? 'text-white' : 'text-slate-900'
          }`}>
            <History className="w-5 h-5 text-accent-500" />
            Sync History
          </h2>
          {totalPages > 1 && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                className={`p-1.5 rounded-lg transition disabled:opacity-30 ${
                  isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'
                }`}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                {page + 1} / {totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className={`p-1.5 rounded-lg transition disabled:opacity-30 ${
                  isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'
                }`}
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>

        <div className="space-y-2">
          {data.entries.map(entry => (
            <div
              key={entry.id}
              className={`flex items-center gap-4 px-4 py-3 rounded-xl ${
                isDark ? 'bg-slate-800/50' : 'bg-slate-50'
              }`}
            >
              <div className={`p-1.5 rounded-lg ${
                entry.cancelled
                  ? isDark ? 'bg-amber-500/10' : 'bg-amber-50'
                  : entry.error
                    ? isDark ? 'bg-red-500/10' : 'bg-red-50'
                    : isDark ? 'bg-emerald-500/10' : 'bg-emerald-50'
              }`}>
                {entry.cancelled ? (
                  <Ban className="w-3.5 h-3.5 text-amber-500" />
                ) : entry.error ? (
                  <AlertTriangle className="w-3.5 h-3.5 text-red-500" />
                ) : (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                )}
              </div>

              <div className="flex-1 min-w-0">
                <div className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                  {new Date(entry.finishedAt).toLocaleDateString('en-US', {
                    weekday: 'short', month: 'short', day: 'numeric',
                  })}
                  <span className={`ml-2 font-normal ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    {new Date(entry.finishedAt).toLocaleTimeString('en-US', {
                      hour: 'numeric', minute: '2-digit',
                    })}
                  </span>
                </div>
                <div className={`flex items-center gap-3 text-xs mt-0.5 ${
                  isDark ? 'text-slate-500' : 'text-slate-400'
                }`}>
                  {entry.telescopeName && (
                    <span className="flex items-center gap-1 truncate">
                      <Telescope className="w-3 h-3" />
                      <span className="truncate">{entry.telescopeName}</span>
                      {entry.transportKind && (
                        // Amber marks the cable, sky marks the network. FTP is a
                        // network transport, so it groups with SMB rather than
                        // falling into the USB colour by being "not smb".
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 ml-1 rounded-full text-[10px] font-medium border ${
                          entry.transportKind === 'local'
                            ? (isDark ? 'bg-amber-500/15 text-amber-300 border-amber-500/30' : 'bg-amber-50 text-amber-700 border-amber-200')
                            : (isDark ? 'bg-sky-500/15 text-sky-300 border-sky-500/30' : 'bg-sky-50 text-sky-700 border-sky-200')
                        }`}>
                          {entry.transportKind === 'local' ? <Usb className="w-2.5 h-2.5" /> : <Network className="w-2.5 h-2.5" />}
                          {formatTransport(entry.transportKind)}
                        </span>
                      )}
                    </span>
                  )}
                  <span className="flex items-center gap-1">
                    <FileStack className="w-3 h-3" />
                    {entry.newFiles} new file{entry.newFiles !== 1 ? 's' : ''}
                  </span>
                  {entry.bytesNew > 0 && (
                    <span className="flex items-center gap-1">
                      <HardDrive className="w-3 h-3" />
                      {formatBytes(entry.bytesNew)}
                    </span>
                  )}
                  {entry.skipped && entry.skipped.length > 0 && (
                    <span className="flex items-center gap-1">
                      <FileX className="w-3 h-3" />
                      {entry.skipped.reduce((n, s) => n + s.count, 0).toLocaleString()} left out
                    </span>
                  )}
                  {entry.error && (
                    <span className={`truncate max-w-[200px] ${entry.cancelled ? 'text-amber-500' : 'text-red-500'}`}>
                      {entry.error}
                    </span>
                  )}
                </div>
              </div>

              {/* Failed runs carry no files and nothing skipped, so gating the
                  details button purely on content used to hide it from exactly
                  the rows worth inspecting. The row's error text is truncated,
                  so `error` alone is reason enough to open the modal. */}
              {(!!entry.error || (entry.files && entry.files.length > 0) || (entry.skipped && entry.skipped.length > 0)) && (
                <button
                  onClick={() => setFilesModal(entry)}
                  className={`p-1.5 rounded-lg transition ${
                    isDark ? 'hover:bg-slate-700 text-slate-500' : 'hover:bg-slate-200 text-slate-400'
                  }`}
                  title={entry.cancelled ? 'View cancellation details' : entry.error ? 'View error details' : 'View sync details'}
                >
                  <Info className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* File list modal */}
      {filesModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className={`w-full max-w-lg max-h-[70vh] flex flex-col rounded-2xl overflow-hidden ${
            isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white shadow-xl'
          }`}>
            <div className={`flex items-center justify-between px-5 py-4 border-b ${
              isDark ? 'border-slate-800' : 'border-slate-200'
            }`}>
              <div>
                <h3 className={`font-display font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                  Sync Details
                </h3>
                <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  {new Date(filesModal.finishedAt).toLocaleDateString('en-US', {
                    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                  })}
                  {' · '}{filesModal.newFiles} file{filesModal.newFiles !== 1 ? 's' : ''}
                  {filesModal.bytesNew > 0 && ` · ${formatBytes(filesModal.bytesNew)}`}
                </p>
              </div>
              <button
                onClick={() => setFilesModal(null)}
                className={`p-1.5 rounded-lg transition ${
                  isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'
                }`}
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-3 space-y-3">
              {/* First in the modal: on a failed run this is the whole story,
                  and the row above truncates it. Wraps and stays selectable so
                  the full host/share can be copied into a bug report. */}
              {filesModal.error && (
                <div className={`rounded-xl border p-3 ${
                  filesModal.cancelled
                    ? (isDark ? 'bg-amber-500/10 border-amber-500/20' : 'bg-amber-50 border-amber-200')
                    : (isDark ? 'bg-red-500/10 border-red-500/20' : 'bg-red-50 border-red-200')
                }`}>
                  <div className="flex items-start gap-2">
                    {filesModal.cancelled
                      ? <Ban className="w-4 h-4 shrink-0 mt-0.5 text-amber-500" />
                      : <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-red-500" />}
                    <div className="min-w-0 space-y-1.5">
                      <p className={`text-xs font-semibold ${
                        filesModal.cancelled
                          ? (isDark ? 'text-amber-300' : 'text-amber-700')
                          : (isDark ? 'text-red-300' : 'text-red-700')
                      }`}>
                        {filesModal.cancelled ? 'This sync was cancelled' : 'This sync failed'}
                      </p>
                      <p className={`text-xs leading-relaxed break-words select-text ${
                        filesModal.cancelled
                          ? (isDark ? 'text-amber-200/90' : 'text-amber-800')
                          : (isDark ? 'text-red-200/90' : 'text-red-800')
                      }`}>
                        {filesModal.error}
                      </p>
                      {filesModal.telescopeName && (
                        <p className={`text-[11px] ${
                          filesModal.cancelled
                            ? (isDark ? 'text-amber-300/60' : 'text-amber-600/80')
                            : (isDark ? 'text-red-300/60' : 'text-red-600/80')
                        }`}>
                          {filesModal.telescopeName}
                          {filesModal.transportKind && ` · ${formatTransport(filesModal.transportKind)}`}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Above the file list on purpose: a user who opens this is
                  usually looking for what is missing, not what arrived. */}
              <SkippedNotice
                skipped={filesModal.skipped}
                isDark={isDark}
                heading={total => `${total.toLocaleString()} file${total !== 1 ? 's' : ''} were left on the telescope:`}
              />
              <div className="space-y-1">
                {(filesModal.files ?? []).map((file, i) => (
                  <div
                    key={i}
                    className={`text-xs font-mono px-3 py-1.5 rounded-lg ${
                      isDark ? 'bg-slate-800/50 text-slate-400' : 'bg-slate-50 text-slate-500'
                    }`}
                  >
                    {file}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function StatBox({
  icon,
  label,
  value,
  sub,
  isDark,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  isDark: boolean;
}) {
  return (
    <div className={`rounded-xl p-4 ${isDark ? 'bg-slate-800/60' : 'bg-slate-50'}`}>
      <div className={`flex items-center gap-1.5 text-xs font-medium mb-1.5 ${
        isDark ? 'text-slate-500' : 'text-slate-400'
      }`}>
        {icon}
        {label}
      </div>
      <div className={`font-mono text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
        {value}
      </div>
      {sub && (
        <div className={`text-[11px] mt-1 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
          {sub}
        </div>
      )}
    </div>
  );
}
