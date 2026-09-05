/**
 * System Log — admin-only audit trail.
 *
 * Reads like Sync History (src/components/backup/SyncHistoryPanel.tsx): a
 * scannable list where the eye goes down the left edge for the level dot,
 * then reads the message. Filters (search, category, level) sit above the
 * list and reset the page back to one so a stale offset never returns an
 * out-of-range page against a narrower result set.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, ChevronLeft, ChevronRight, Info, KeyRound, RefreshCw,
  ScrollText, Search, Server, Settings as SettingsIcon, Smartphone, Telescope,
  HardDrive, Trash2, User, Loader2,
} from 'lucide-react';
import {
  getSystemLog, clearSystemLog, SYSTEM_LOG_CATEGORIES, SYSTEM_LOG_LEVELS,
  isSystemLogCategory, isSystemLogLevel,
  type SystemLogCategory, type SystemLogEntry, type SystemLogLevel,
} from '../../lib/api/systemLog';
import { getInputClass, Sec } from './SettingsUI';

const PAGE_SIZE = 10;

const CATEGORY_META: Record<SystemLogCategory, { label: string; icon: typeof User }> = {
  auth: { label: 'Sign-in', icon: KeyRound },
  user: { label: 'Users', icon: User },
  device: { label: 'Devices', icon: Smartphone },
  telescope: { label: 'Telescopes', icon: Telescope },
  sync: { label: 'Sync', icon: RefreshCw },
  storage: { label: 'Storage', icon: HardDrive },
  settings: { label: 'Settings', icon: SettingsIcon },
  system: { label: 'System', icon: Server },
};

export function SystemLogSection({ isDark }: { isDark: boolean }) {
  const queryClient = useQueryClient();
  const inputClass = getInputClass(isDark);

  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<SystemLogCategory | ''>('');
  const [level, setLevel] = useState<SystemLogLevel | ''>('');
  const [confirmClear, setConfirmClear] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['system-log', page, search, category, level],
    queryFn: () => getSystemLog({
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      search: search.trim() || undefined,
      category: category || undefined,
      level: level || undefined,
    }),
    placeholderData: prev => prev,
  });

  const clearMutation = useMutation({
    mutationFn: clearSystemLog,
    onSuccess: () => {
      setConfirmClear(false);
      setPage(0);
      queryClient.invalidateQueries({ queryKey: ['system-log'] });
    },
  });

  function updateFilter(fn: () => void) {
    fn();
    setPage(0);
  }

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;
  const hasFilters = search.trim() !== '' || category !== '' || level !== '';

  return (
    <Sec
      title="System Log"
      description="Sign-ins, user and telescope changes, syncs, and other administrative activity for this install."
      isDark={isDark}
      actions={
        confirmClear ? (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setConfirmClear(false)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
                isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'
              }`}
            >
              Cancel
            </button>
            <button
              onClick={() => clearMutation.mutate()}
              disabled={clearMutation.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500 text-white hover:bg-red-600 disabled:opacity-50"
            >
              {clearMutation.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
              Confirm clear
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmClear(true)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              isDark ? 'text-slate-400 hover:bg-slate-800 hover:text-red-400' : 'text-slate-500 hover:bg-slate-100 hover:text-red-600'
            }`}
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear log
          </button>
        )
      }
    >
      {/* Filters */}
      <div className={`flex flex-wrap items-center gap-2.5 border-b px-5 py-3.5 ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
        <div className="relative flex-1 min-w-[180px]">
          <Search className={`absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 ${isDark ? 'text-slate-600' : 'text-slate-400'}`} />
          <input
            type="text"
            value={search}
            onChange={e => updateFilter(() => setSearch(e.target.value))}
            placeholder="Search messages, users, events…"
            className={`${inputClass} !py-2 !pl-9 text-[13px]`}
          />
        </div>
        <select
          value={category}
          onChange={e => {
            // '' is the "All categories" option, and anything the guard
            // rejects falls back to it rather than being asserted into the union.
            const v = e.target.value;
            updateFilter(() => setCategory(isSystemLogCategory(v) ? v : ''));
          }}
          className={`${inputClass} !w-auto !py-2 text-[13px]`}
        >
          <option value="">All categories</option>
          {SYSTEM_LOG_CATEGORIES.map(c => (
            <option key={c} value={c}>{CATEGORY_META[c].label}</option>
          ))}
        </select>
        <select
          value={level}
          onChange={e => {
            const v = e.target.value;
            updateFilter(() => setLevel(isSystemLogLevel(v) ? v : ''));
          }}
          className={`${inputClass} !w-auto !py-2 text-[13px]`}
        >
          <option value="">All levels</option>
          {SYSTEM_LOG_LEVELS.map(l => (
            <option key={l} value={l}>{l[0].toUpperCase() + l.slice(1)}</option>
          ))}
        </select>

        {data && data.total > 0 && (
          <span className={`ml-auto text-xs tabular-nums ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {data.total.toLocaleString()}
          </span>
        )}
      </div>

      {isLoading && !data ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-4 h-4 animate-spin text-accent-500" />
        </div>
      ) : !data || data.entries.length === 0 ? (
        <p className={`px-5 py-6 text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          {hasFilters ? 'No log entries match these filters.' : 'Nothing logged yet. Sign-ins, user changes, and other admin activity will show up here.'}
        </p>
      ) : (
        <ul className={`divide-y ${isDark ? 'divide-slate-800/70' : 'divide-slate-100'}`}>
          {data.entries.map(entry => (
            <LogRow key={entry.id} entry={entry} isDark={isDark} />
          ))}
        </ul>
      )}

      {totalPages > 1 && (
        <div className={`flex items-center justify-center gap-1 border-t px-5 py-3 ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
          <button
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
            aria-label="Previous page"
            className={`rounded-lg p-1.5 transition disabled:opacity-30 ${
              isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'
            }`}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className={`text-xs tabular-nums ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {page + 1} / {totalPages}
          </span>
          <button
            onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            aria-label="Next page"
            className={`rounded-lg p-1.5 transition disabled:opacity-30 ${
              isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'
            }`}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
    </Sec>
  );
}

function LogRow({ entry, isDark }: { entry: SystemLogEntry; isDark: boolean }) {
  const meta = CATEGORY_META[entry.category] ?? { label: entry.category, icon: ScrollText };
  const Icon = meta.icon;
  const when = new Date(entry.createdAt);

  const dot = entry.level === 'error'
    ? (isDark ? 'bg-red-500/10 text-red-500' : 'bg-red-50 text-red-600')
    : entry.level === 'warning'
      ? (isDark ? 'bg-amber-500/10 text-amber-500' : 'bg-amber-50 text-amber-600')
      : (isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-500');

  const LevelIcon = entry.level === 'error' ? AlertTriangle : entry.level === 'warning' ? AlertTriangle : Info;

  return (
    <li className="flex items-start gap-3 px-5 py-3">
      <span className={`shrink-0 rounded-lg p-1.5 ${dot}`} title={entry.level}>
        <LevelIcon className="h-3.5 w-3.5" />
      </span>

      <span className="min-w-0 flex-1">
        <span className={`block text-sm ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
          {entry.message}
        </span>
        <span className={`mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          <span className="inline-flex items-center gap-1">
            <Icon className="h-3 w-3" />
            {meta.label}
          </span>
          <span>
            {when.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            {' · '}
            {when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
          </span>
          {entry.username && <span>{entry.username}</span>}
          {entry.ip && <span className="font-mono">{entry.ip}</span>}
        </span>
      </span>
    </li>
  );
}
