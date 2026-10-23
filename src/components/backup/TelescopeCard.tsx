/**
 * One telescope, as a backup source.
 *
 * The old row said whether the telescope answered a ping and offered a Sync
 * button. That leaves out the two things people came here to check: when this
 * particular telescope last handed files over, and whether it will do it again
 * on its own. Both are added here, so a card answers "is this one covered?"
 * without cross-referencing the history list underneath.
 */
import { useTranslation } from 'react-i18next';
import { RefreshCw, Telescope as TelescopeIcon, Usb, Network, Timer, History } from 'lucide-react';
import { formatTransport } from '../../lib/api/library';
import type { ConnectionType } from '../../lib/api/telescopes';
import { formatInterval, formatRelativeTime } from '../../lib/timeFormat';
import { formatNumber } from '../../lib/formatLocale';
import { useTheme } from '../../hooks/useTheme';
import { nightSafeColor } from '../../lib/nightSafeColor';

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
  telescope: tel, isDark, importRunning, runningTelescopeId, pending, onSync,
}: Props) {
  const { t } = useTranslation('library');
  const { isNight } = useTheme();
  const isThisOne = importRunning && runningTelescopeId === tel.id;
  const disabled = !tel.online || !tel.configured || importRunning || pending;

  const title = !tel.configured
    ? t('telescopeCard.notConfigured')
    : !tel.online
      ? t('telescopeCard.unreachable')
      : importRunning && !isThisOne
        ? t('telescopeCard.anotherSyncRunning')
        : t('telescopeCard.syncNow');

  return (
    <div className={`rounded-2xl border p-4 transition-colors ${
      isDark
        ? isThisOne ? 'bg-slate-900 border-accent-500/40' : 'bg-slate-900 border-slate-800'
        : isThisOne ? 'bg-white border-accent-400 shadow-sm' : 'bg-white border-slate-200 shadow-sm'
    }`}>
      <div className="flex items-start gap-3">
        <div className={`shrink-0 rounded-xl p-2.5 ${
          tel.online
            ? isDark ? 'bg-emerald-500/10' : 'bg-emerald-50'
            : isDark ? 'bg-slate-800' : 'bg-slate-100'
        }`}>
          <TelescopeIcon className={`h-4 w-4 ${
            tel.online ? 'text-emerald-500' : isDark ? 'text-slate-500' : 'text-slate-400'
          }`} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: nightSafeColor(tel.color, isNight) }} />
            <span className={`truncate font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
              {tel.name}
            </span>
          </div>
          {tel.configured && (
            <p className={`mt-0.5 truncate text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {tel.hostname}
              {tel.online && tel.latencyMs != null && ` · ${t('telescopeCard.latencyMs', { value: formatNumber(tel.latencyMs) })}`}
            </p>
          )}
        </div>

        <StatusPill online={tel.online} configured={tel.configured} isDark={isDark} />
      </div>

      {/* Facts about this telescope as a backup source, kept on one line each so
          the card stays the same height whether or not it has ever synced. */}
      <div className={`mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs ${
        isDark ? 'text-slate-500' : 'text-slate-400'
      }`}>
        {tel.configured && (
          <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[0.625rem] font-medium ${
            !tel.online
              ? (isDark ? 'bg-slate-800/60 text-slate-500 border-slate-700/60' : 'bg-slate-100 text-slate-400 border-slate-200')
              : tel.transportKind === 'local'
                ? (isDark ? 'bg-amber-500/15 text-amber-300 border-amber-500/30' : 'bg-amber-50 text-amber-700 border-amber-200')
                : (isDark ? 'bg-sky-500/15 text-sky-300 border-sky-500/30' : 'bg-sky-50 text-sky-700 border-sky-200')
          }`}>
            {tel.transportKind === 'local' ? <Usb className="h-2.5 w-2.5" /> : <Network className="h-2.5 w-2.5" />}
            {formatTransport(tel.transportKind)}
          </span>
        )}

        <span className="inline-flex items-center gap-1">
          <History className="h-3 w-3" />
          {tel.lastSyncAt ? t('telescopeCard.syncedAt', { time: formatRelativeTime(tel.lastSyncAt) }) : t('telescopeCard.neverSynced')}
        </span>

        {tel.autoSync && (
          <span className="inline-flex items-center gap-1">
            <Timer className="h-3 w-3" />
            {tel.autoSync.enabled
              ? t('telescopeCard.autoEvery', { interval: formatInterval(tel.autoSync.intervalMinutes) })
              : t('telescopeCard.autoOff')}
          </span>
        )}
      </div>

      <button
        onClick={onSync}
        disabled={disabled}
        title={title}
        aria-label={isThisOne ? t('telescopeCard.syncingName', { name: tel.name }) : t('telescopeCard.syncNameNow', { name: tel.name })}
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
        {isThisOne ? t('telescopeCard.syncing') : t('telescopeCard.sync')}
      </button>
    </div>
  );
}

function StatusPill({ online, configured, isDark }: { online: boolean; configured: boolean; isDark: boolean }) {
  const { t } = useTranslation('library');
  if (!configured) {
    return (
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wider ${
        isDark ? 'bg-slate-800 text-slate-500' : 'bg-slate-100 text-slate-400'
      }`}>
        {t('telescopeCard.notSetUp')}
      </span>
    );
  }
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wider ${
      online
        ? isDark ? 'bg-emerald-500/10 text-emerald-400' : 'bg-emerald-50 text-emerald-700'
        : isDark ? 'bg-slate-800 text-slate-500' : 'bg-slate-100 text-slate-500'
    }`}>
      <span className={`h-1.5 w-1.5 rounded-full ${online ? 'bg-emerald-500' : isDark ? 'bg-slate-600' : 'bg-slate-400'}`} />
      {online ? t('telescopeCard.online') : t('telescopeCard.offline')}
    </span>
  );
}
