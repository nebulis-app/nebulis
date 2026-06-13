import { Link } from 'react-router-dom';
import { useState } from 'react';
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
  FolderSync,
  Telescope,
  XCircle,
  ChevronLeft,
  ChevronRight,
  Info,
  X,
  History,
  Usb,
  Network,
} from 'lucide-react';
import { getImportStatus, triggerImport, getImportHistory, formatTransport, type ImportHistoryEntry } from '../lib/api/library';
import { getAllTelescopeStatus } from '../lib/api/telescopes';
import { useTheme } from '../hooks/useTheme';

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

  const isRunning = status?.running ?? false;
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
            Sync Now
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
                        : t.transportKind === 'smb'
                          ? (isDark ? 'bg-sky-500/15 text-sky-300 border-sky-500/30' : 'bg-sky-50 text-sky-700 border-sky-200')
                          : (isDark ? 'bg-amber-500/15 text-amber-300 border-amber-500/30' : 'bg-amber-50 text-amber-700 border-amber-200')
                    }`}>
                      {t.transportKind === 'local' ? <Usb className="w-2.5 h-2.5" /> : <Network className="w-2.5 h-2.5" />}
                      {t.transportKind === 'local' ? 'USB' : 'Wi-Fi'}
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

          {/* Error */}
          {status.error && (
            <div className={`flex items-start gap-3 px-4 py-3 rounded-xl ${
              isDark ? 'bg-red-500/10 text-red-400' : 'bg-red-50 text-red-600'
            }`}>
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
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
              <div className={`p-3 rounded-xl ${isDark ? 'bg-red-500/10' : 'bg-red-50'}`}>
                <XCircle className="w-5 h-5 text-red-500" />
              </div>
              <div className="flex-1">
                <h2 className={`font-display font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                  Last Sync Failed
                </h2>
                <p className={`text-sm mt-1 ${isDark ? 'text-red-400/80' : 'text-red-600/80'}`}>
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
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const PAGE_SIZE = 10;

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
                entry.error
                  ? isDark ? 'bg-red-500/10' : 'bg-red-50'
                  : isDark ? 'bg-emerald-500/10' : 'bg-emerald-50'
              }`}>
                {entry.error ? (
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
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 ml-1 rounded-full text-[10px] font-medium border ${
                          entry.transportKind === 'smb'
                            ? (isDark ? 'bg-sky-500/15 text-sky-300 border-sky-500/30' : 'bg-sky-50 text-sky-700 border-sky-200')
                            : (isDark ? 'bg-amber-500/15 text-amber-300 border-amber-500/30' : 'bg-amber-50 text-amber-700 border-amber-200')
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
                  {entry.error && (
                    <span className="text-red-500 truncate max-w-[200px]">{entry.error}</span>
                  )}
                </div>
              </div>

              {entry.files && entry.files.length > 0 && (
                <button
                  onClick={() => setFilesModal(entry)}
                  className={`p-1.5 rounded-lg transition ${
                    isDark ? 'hover:bg-slate-700 text-slate-500' : 'hover:bg-slate-200 text-slate-400'
                  }`}
                  title="View synced files"
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
                  Files Synced
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
            <div className="flex-1 overflow-y-auto px-5 py-3">
              <div className="space-y-1">
                {filesModal.files!.map((file, i) => (
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
