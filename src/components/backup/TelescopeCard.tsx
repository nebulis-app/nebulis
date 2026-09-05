/**
 * One telescope, as a backup source.
 *
 * The old row said whether the telescope answered a ping and offered a Sync
 * button. That leaves out the two things people came here to check: when this
 * particular telescope last handed files over, and whether it will do it again
 * on its own. Both are added here, so a card answers "is this one covered?"
 * without cross-referencing the history list underneath.
 */
import { RefreshCw, Telescope as TelescopeIcon, Usb, Network, Timer, History } from 'lucide-react';
import { formatTransport } from '../../lib/api/library';
import type { ConnectionType } from '../../lib/api/telescopes';
import { formatInterval, formatRelativeTime } from '../../lib/timeFormat';

export interface TelescopeCardModel {
  id: string;
  name: string;
  color: string;
  hostname: string;
  configured: boolean;
  online: boolean;
  latencyMs: number | null;
  transportKind: ConnectionType;
  /** Finish time of the most recent successful sync for this telescope, from
   *  sync history. Null when it has never completed one. */
  lastSyncAt: string | null;
  /** Scheduler settings from the telescope profile. Undefined while the profile
   *  list is still loading, which reads as "not shown" rather than "off". */
  autoSync?: { enabled: boolean; intervalMinutes: number };
}

interface Props {
  telescope: TelescopeCardModel;
  isDark: boolean;
  /** Imports hold one global lock, so any running import disables every button.
   *  The card whose telescope is mid-run says so, rather than looking broken. */
  importRunning: boolean;
  runningTelescopeId: string | null;
  pending: boolean;
  onSync: () => void;
}

export function TelescopeCard({
  telescope: t, isDark, importRunning, runningTelescopeId, pending, onSync,
}: Props) {
  const isThisOne = importRunning && runningTelescopeId === t.id;
  const disabled = !t.online || !t.configured || importRunning || pending;

  const title = !t.configured
    ? 'This telescope has no connection configured yet'
    : !t.online
      ? 'This telescope is not reachable right now'
      : importRunning && !isThisOne
        ? 'Another sync is running. Only one can run at a time.'
        : 'Sync this telescope now';

  return (
    <div className={`rounded-2xl border p-4 transition-colors ${
      isDark
        ? isThisOne ? 'bg-slate-900 border-accent-500/40' : 'bg-slate-900 border-slate-800'
        : isThisOne ? 'bg-white border-accent-400 shadow-sm' : 'bg-white border-slate-200 shadow-sm'
    }`}>
      <div className="flex items-start gap-3">
        <div className={`shrink-0 rounded-xl p-2.5 ${
          t.online
            ? isDark ? 'bg-emerald-500/10' : 'bg-emerald-50'
            : isDark ? 'bg-slate-800' : 'bg-slate-100'
        }`}>
          <TelescopeIcon className={`h-4 w-4 ${
            t.online ? 'text-emerald-500' : isDark ? 'text-slate-500' : 'text-slate-400'
          }`} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: t.color }} />
            <span className={`truncate font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
              {t.name}
            </span>
          </div>
          {t.configured && (
            <p className={`mt-0.5 truncate text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {t.hostname}
              {t.online && t.latencyMs != null && ` · ${t.latencyMs} ms`}
            </p>
          )}
        </div>

        <StatusPill online={t.online} configured={t.configured} isDark={isDark} />
      </div>

      {/* Facts about this telescope as a backup source, kept on one line each so
          the card stays the same height whether or not it has ever synced. */}
      <div className={`mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs ${
        isDark ? 'text-slate-500' : 'text-slate-400'
      }`}>
        {t.configured && (
          <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
            !t.online
              ? (isDark ? 'bg-slate-800/60 text-slate-500 border-slate-700/60' : 'bg-slate-100 text-slate-400 border-slate-200')
              : t.transportKind === 'local'
                ? (isDark ? 'bg-amber-500/15 text-amber-300 border-amber-500/30' : 'bg-amber-50 text-amber-700 border-amber-200')
                : (isDark ? 'bg-sky-500/15 text-sky-300 border-sky-500/30' : 'bg-sky-50 text-sky-700 border-sky-200')
          }`}>
            {t.transportKind === 'local' ? <Usb className="h-2.5 w-2.5" /> : <Network className="h-2.5 w-2.5" />}
            {formatTransport(t.transportKind)}
          </span>
        )}

        <span className="inline-flex items-center gap-1">
          <History className="h-3 w-3" />
          {t.lastSyncAt ? `Synced ${formatRelativeTime(t.lastSyncAt)}` : 'Never synced'}
        </span>

        {t.autoSync && (
          <span className="inline-flex items-center gap-1">
            <Timer className="h-3 w-3" />
            {t.autoSync.enabled
              ? `Auto every ${formatInterval(t.autoSync.intervalMinutes)}`
              : 'Auto sync off'}
          </span>
        )}
      </div>

      <button
        onClick={onSync}
        disabled={disabled}
        title={title}
        aria-label={isThisOne ? `Syncing ${t.name}` : `Sync ${t.name} now`}
        className={`mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium transition-colors ${
          disabled
            ? isDark
              ? 'bg-slate-800/60 text-slate-600 cursor-not-allowed'
              : 'bg-slate-100 text-slate-400 cursor-not-allowed'
            : isDark
              ? 'bg-slate-800 text-slate-200 hover:bg-slate-700'
              : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
        }`}
      >
        <RefreshCw className={`h-3.5 w-3.5 ${isThisOne || pending ? 'animate-spin' : ''}`} />
        {isThisOne ? 'Syncing' : 'Sync'}
      </button>
    </div>
  );
}

function StatusPill({ online, configured, isDark }: { online: boolean; configured: boolean; isDark: boolean }) {
  if (!configured) {
    return (
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
        isDark ? 'bg-slate-800 text-slate-500' : 'bg-slate-100 text-slate-400'
      }`}>
        Not set up
      </span>
    );
  }
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
      online
        ? isDark ? 'bg-emerald-500/10 text-emerald-400' : 'bg-emerald-50 text-emerald-700'
        : isDark ? 'bg-slate-800 text-slate-500' : 'bg-slate-100 text-slate-500'
    }`}>
      <span className={`h-1.5 w-1.5 rounded-full ${online ? 'bg-emerald-500' : isDark ? 'bg-slate-600' : 'bg-slate-400'}`} />
      {online ? 'Online' : 'Offline'}
    </span>
  );
}
