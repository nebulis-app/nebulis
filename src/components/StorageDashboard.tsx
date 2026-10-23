import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Trash2, Calendar, Image, AlertCircle, ArrowUpDown, FolderOpen } from 'lucide-react';
import { getStorageStats, getSystemStorage, getLibraryStorage } from '../lib/api/storage';
import { useTheme } from '../hooks/useTheme';
import { formatBytes } from '../lib/utils';
import { formatDate as formatLocaleDate, formatNumber } from '../lib/formatLocale';
import { Sec } from './settings/SettingsUI';
import { isSeestarKind, toTelescopeKind } from '../lib/telescopePresets';

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '--';
  // dateStr is a bare YYYY-MM-DD (see server/routes/storage.ts). Anchor at
  // noon rather than parsing as UTC midnight, which renders as the previous
  // calendar day for any user west of UTC.
  const d = new Date(dateStr + 'T12:00:00');
  return formatLocaleDate(d, { year: 'numeric', month: 'short', day: 'numeric' });
}

type SortKey = 'name' | 'totalSize' | 'fileCount' | 'subFrameCount' | 'oldestFile' | 'newestFile';
type LibSortKey = 'name' | 'size' | 'fileCount';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE = 10;
// Rows shown before "Show all". Keeps each table from dominating the page.
const COLLAPSED_ROWS = 5;

interface DiskUsage {
  usedFormatted: string;
  totalFormatted: string;
  freeFormatted: string;
  usedPercent: number;
}

function usageColor(pct: number): 'red' | 'yellow' | 'emerald' {
  return pct >= 90 ? 'red' : pct >= 75 ? 'yellow' : 'emerald';
}

function DiskBar({ disk, isDark }: { disk: DiskUsage; isDark: boolean }) {
  const { t } = useTranslation('settings');
  const color = usageColor(disk.usedPercent);
  return (
    <div className="space-y-2">
      <div className="flex justify-between text-sm">
        <span className={isDark ? 'text-slate-300' : 'text-slate-700'}>
          <span className="font-semibold">{disk.usedFormatted}</span>{' '}
          {t('storageDashboard.usedOfMiddle')}{' '}
          <span className="font-semibold">{disk.totalFormatted}</span>
        </span>
        <span className={`font-mono font-semibold ${
          color === 'red' ? 'text-red-500' : color === 'yellow' ? 'text-yellow-500' : 'text-emerald-500'
        }`}>
          {disk.usedPercent}%
        </span>
      </div>
      <div className={`h-3 rounded-full overflow-hidden ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
        <div
          className={`h-full rounded-full transition-all duration-700 ${
            color === 'red' ? 'bg-red-500' : color === 'yellow' ? 'bg-yellow-500' : 'bg-emerald-500'
          }`}
          style={{ width: `${disk.usedPercent}%` }}
        />
      </div>
      <div className={`flex justify-between text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
        <span>{t('storageDashboard.free', { amount: disk.freeFormatted })}</span>
        <span>{t('storageDashboard.total', { amount: disk.totalFormatted })}</span>
      </div>
    </div>
  );
}

function StatLine({ label, value, note, isDark }: { label: string; value: string; note?: string; isDark: boolean }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className={`text-xs font-medium uppercase tracking-wider ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{label}</span>
        <span className={`text-lg font-bold font-display ${isDark ? 'text-white' : 'text-slate-900'}`}>{value}</span>
      </div>
      {note && <p className={`mt-1 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{note}</p>}
    </div>
  );
}

function PathRow({ label, path, iconClass, isDark }: { label: string; path: string; iconClass: string; isDark: boolean }) {
  return (
    <div className={`flex items-center gap-3 p-3 rounded-xl ${isDark ? 'bg-slate-800' : 'bg-slate-50'}`}>
      <FolderOpen className={`w-4 h-4 shrink-0 ${iconClass}`} />
      <div className="min-w-0">
        <p className={`text-xs font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{label}</p>
        <p className={`text-sm font-mono truncate ${isDark ? 'text-slate-300' : 'text-slate-700'}`} title={path}>{path}</p>
      </div>
    </div>
  );
}

function ExpandToggle({ expanded, total, onToggle, isDark }: { expanded: boolean; total: number; onToggle: () => void; isDark: boolean }) {
  const { t } = useTranslation('settings');
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className={`w-full px-4 py-3 text-xs font-medium border-t transition-colors ${
        isDark
          ? 'border-slate-800 text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
          : 'border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700'
      }`}
    >
      {expanded ? t('storageDashboard.showFewer') : t('storageDashboard.showAll', { count: total })}
    </button>
  );
}

export function StorageDashboard({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useTranslation('settings');
  const { isDark } = useTheme();

  // Telescope table state
  const [sortKey, setSortKey] = useState<SortKey>('totalSize');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(0);

  // Library table state
  const [libSortKey, setLibSortKey] = useState<LibSortKey>('size');
  const [libSortDir, setLibSortDir] = useState<SortDir>('desc');
  const [libPage, setLibPage] = useState(0);
  const [libExpanded, setLibExpanded] = useState(false);
  const [telExpanded, setTelExpanded] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['storage-stats'],
    queryFn: getStorageStats,
    staleTime: 5 * 60 * 1000,
  });

  const { data: systemStorage } = useQuery({
    queryKey: ['system-storage'],
    queryFn: getSystemStorage,
    staleTime: 60 * 1000,
  });

  const { data: libraryStorage } = useQuery({
    queryKey: ['library-storage'],
    queryFn: getLibraryStorage,
    staleTime: 5 * 60 * 1000,
  });

  // Memoized (not a bare `?? []`) because `objects` is itself a dependency of
  // the three useMemo hooks below: a fresh `[]` reference on every render
  // while `data` is still loading would defeat their memoization entirely.
  const objects = useMemo(() => data?.objects ?? [], [data?.objects]);
  const telescopeOnline = data?.telescopeOnline ?? false;
  const telescopeKind = data?.telescopeKind ?? null;
  const isSeestar = telescopeKind !== null && isSeestarKind(toTelescopeKind(telescopeKind));

  const totalSize = useMemo(() => objects.reduce((sum, o) => sum + o.totalSize, 0), [objects]);
  const totalFiles = useMemo(() => objects.reduce((sum, o) => sum + o.fileCount, 0), [objects]);
  const objectCount = objects.length;

  // Telescope sort
  const sorted = useMemo(() => {
    return [...objects].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'name':          cmp = a.name.localeCompare(b.name); break;
        case 'totalSize':     cmp = a.totalSize - b.totalSize; break;
        case 'fileCount':     cmp = a.fileCount - b.fileCount; break;
        case 'subFrameCount': cmp = a.subFrameCount - b.subFrameCount; break;
        case 'oldestFile':    cmp = (a.oldestFile ?? '').localeCompare(b.oldestFile ?? ''); break;
        case 'newestFile':    cmp = (a.newestFile ?? '').localeCompare(b.newestFile ?? ''); break;
        default: {
          // Compile-time exhaustiveness: a new SortKey has to be sorted here,
          // rather than silently comparing every row as equal.
          const _exhaustive: never = sortKey;
          void _exhaustive;
        }
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [objects, sortKey, sortDir]);

  // Library sort
  const libSorted = useMemo(() => {
    const rows = libraryStorage?.objects ?? [];
    return [...rows].sort((a, b) => {
      let cmp = 0;
      switch (libSortKey) {
        case 'name':      cmp = a.name.localeCompare(b.name); break;
        case 'size':      cmp = a.size - b.size; break;
        case 'fileCount': cmp = a.fileCount - b.fileCount; break;
        default: {
          const _exhaustive: never = libSortKey;
          void _exhaustive;
        }
      }
      return libSortDir === 'asc' ? cmp : -cmp;
    });
  }, [libraryStorage, libSortKey, libSortDir]);

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
    setPage(0);
  }

  function handleLibSort(key: LibSortKey) {
    if (libSortKey === key) setLibSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setLibSortKey(key); setLibSortDir('desc'); }
    setLibPage(0);
  }

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const paginated = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const libTotalPages = Math.ceil(libSorted.length / PAGE_SIZE);
  const libPaginated = libSorted.slice(libPage * PAGE_SIZE, (libPage + 1) * PAGE_SIZE);
  const libVisible = libExpanded ? libPaginated : libSorted.slice(0, COLLAPSED_ROWS);
  const telVisible = telExpanded ? paginated : sorted.slice(0, COLLAPSED_ROWS);

  const cardClass = `rounded-2xl border ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200 shadow-sm'}`;
  const tileClass = `p-4 rounded-xl ${isDark ? 'bg-slate-800' : 'bg-slate-50'}`;
  const tileLabel = `text-xs font-medium uppercase tracking-wider mb-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`;
  const tileValue = `text-xl font-bold font-display ${isDark ? 'text-white' : 'text-slate-900'}`;

  const SortHeader = ({ label, field, className }: { label: string; field: SortKey; className?: string }) => (
    <th
      className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider cursor-pointer select-none ${
        isDark ? 'text-slate-400' : 'text-slate-500'
      } ${className ?? ''}`}
      onClick={() => handleSort(field)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <ArrowUpDown className={`w-3 h-3 ${sortKey === field ? 'text-accent-500' : 'opacity-30'}`} />
      </span>
    </th>
  );

  const LibSortHeader = ({ label, field, className }: { label: string; field: LibSortKey; className?: string }) => (
    <th
      className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider cursor-pointer select-none ${
        isDark ? 'text-slate-400' : 'text-slate-500'
      } ${className ?? ''}`}
      onClick={() => handleLibSort(field)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <ArrowUpDown className={`w-3 h-3 ${libSortKey === field ? 'text-teal-400' : 'opacity-30'}`} />
      </span>
    </th>
  );

  const Pagination = ({
    page: pg, totalPages: tp, onPrev, onNext, total, pageSize,
  }: { page: number; totalPages: number; onPrev: () => void; onNext: () => void; total: number; pageSize: number }) => (
    <div className={`flex items-center justify-between px-4 py-3 border-t ${isDark ? 'border-slate-800 bg-slate-800/40' : 'border-slate-200 bg-slate-50'}`}>
      <span className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
        {t('storageDashboard.pageRange', { from: pg * pageSize + 1, to: Math.min((pg + 1) * pageSize, total), total })}
      </span>
      <div className="flex items-center gap-2">
        <button
          onClick={onPrev}
          disabled={pg === 0}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            isDark ? 'bg-slate-700 text-slate-300 hover:bg-slate-600' : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50'
          }`}
        >
          {t('storageDashboard.previous')}
        </button>
        <button
          onClick={onNext}
          disabled={pg >= tp - 1}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            isDark ? 'bg-slate-700 text-slate-300 hover:bg-slate-600' : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50'
          }`}
        >
          {t('storageDashboard.next')}
        </button>
      </div>
    </div>
  );

  if (isLoading) {
    return (
      <div className="space-y-8">
        {!embedded && (
          <div className="text-center space-y-3">
            <div className={`h-9 w-64 mx-auto rounded-lg ${isDark ? 'bg-slate-800' : 'bg-slate-100'} animate-pulse`} />
            <div className={`h-5 w-96 mx-auto rounded-lg ${isDark ? 'bg-slate-800' : 'bg-slate-100'} animate-pulse`} />
          </div>
        )}
        <div className={`${cardClass} p-6 space-y-4`}>
          <div className={`h-5 w-40 rounded ${isDark ? 'bg-slate-800' : 'bg-slate-100'} animate-pulse`} />
          <div className="grid grid-cols-3 gap-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className={`h-20 rounded-xl ${isDark ? 'bg-slate-800' : 'bg-slate-100'} animate-pulse`} />
            ))}
          </div>
        </div>
        <div className={`${cardClass} p-6 space-y-4`}>
          <div className={`h-5 w-40 rounded ${isDark ? 'bg-slate-800' : 'bg-slate-100'} animate-pulse`} />
          <div className="grid grid-cols-3 gap-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className={`h-20 rounded-xl ${isDark ? 'bg-slate-800' : 'bg-slate-100'} animate-pulse`} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-8">
        {!embedded && (
          <div className="text-center space-y-3">
            <h1 className={`font-display text-4xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
              {t('storageDashboard.loadingTitle')}
            </h1>
          </div>
        )}
        <div className={`text-center py-16 space-y-4 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          <AlertCircle className="w-12 h-12 mx-auto text-accent-500/50" />
          <div>
            <p className={`text-lg font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{t('storageDashboard.loadFailed')}</p>
            <p className="mt-1 text-sm">{error instanceof Error ? error.message : t('storageDashboard.unexpectedError')}</p>
            <p className="mt-2 text-sm opacity-60">{t('storageDashboard.refreshToRetry')}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    // Fragment, not a div: when embedded, this sits right after
    // LibraryLocationSection's own Sec(s) as a sibling (StorageLocationSection
    // composes them with no wrapping element of its own). A div here would
    // make "Local Server" the first *DOM* child of a new parent, so its
    // `first:mt-0` would fire even though it isn't the first section on the
    // page — collapsing the gap after Library location. No space-y either:
    // every section below is a `Sec` (SettingsUI.tsx), which already carries
    // its own `mt-10 first:mt-0` for card-to-card spacing.
    <>
      {/* Hero header — suppressed when embedded inside the Settings → Storage tab,
          which already renders its own page heading from the active-tab metadata. */}
      {!embedded && (
        <div className="text-center space-y-3">
          <h1 className={`font-display text-4xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
            {t('storageDashboard.title')}
          </h1>
          <p className={`text-lg max-w-2xl mx-auto ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            {t('storageDashboard.subtitle')}
          </p>
        </div>
      )}

      {/* ── Disks ─────────────────────────────────────────────────────
          Local Server and Library Drive are the same kind of card (a disk and
          how full it is), so they sit side by side. The Library Drive card
          only exists once the library has been moved to a separate drive; with
          one card the grid simply has one column. */}
      <div className="mt-10 first:mt-0 grid gap-x-6 lg:grid-cols-2">
        <div>
          <Sec
            title={t('storageDashboard.localServer.title')}
            description={t('storageDashboard.localServer.description')}
            isDark={isDark}
            actions={
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                isDark ? 'bg-emerald-500/10 text-emerald-400' : 'bg-emerald-50 text-emerald-700'
              }`}>
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                {t('storageDashboard.online')}
              </span>
            }
          >
            <div className="p-5 space-y-4">
              {systemStorage ? (
                <>
                  {systemStorage.disk ? (
                    <DiskBar disk={systemStorage.disk} isDark={isDark} />
                  ) : (
                    <p className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{t('storageDashboard.diskInfoUnavailable')}</p>
                  )}
                  {/* App Data only counts what Nebulis itself keeps in its data folder, so
                      it legitimately reads far below "used" on a nearly full disk.
                      The note says where the rest went. */}
                  <StatLine
                    isDark={isDark}
                    label={t('storageDashboard.appData')}
                    value={systemStorage.dataDir.sizeFormatted}
                    note={t('storageDashboard.localServer.appDataNote')}
                  />
                  <PathRow isDark={isDark} label={t('storageDashboard.dataDirectory')} path={systemStorage.dataDir.path} iconClass="text-teal-400" />
                </>
              ) : (
                <div className="space-y-3">
                  <div className={`h-3 rounded-full ${isDark ? 'bg-slate-800' : 'bg-slate-100'} animate-pulse`} />
                  <div className={`h-12 rounded-xl ${isDark ? 'bg-slate-800' : 'bg-slate-100'} animate-pulse`} />
                </div>
              )}
            </div>
          </Sec>
        </div>

        {systemStorage?.libraryDisk && (
          <div className="mt-10 lg:mt-0">
            <Sec
              title={t('storageDashboard.libraryDrive.title')}
              description={t('storageDashboard.libraryDrive.description')}
              isDark={isDark}
              actions={
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                  isDark ? 'bg-emerald-500/10 text-emerald-400' : 'bg-emerald-50 text-emerald-700'
                }`}>
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  {t('storageDashboard.connected')}
                </span>
              }
            >
              <div className="p-5 space-y-4">
                <DiskBar disk={systemStorage.libraryDisk} isDark={isDark} />
                {/* Library Size only ever covers this app's own library folder,
                    so it legitimately reads far below the drive's Total/Free
                    when the drive also holds unrelated data. The note says so
                    it isn't mistaken for a miscalculation. */}
                <StatLine
                  isDark={isDark}
                  label={t('storageDashboard.librarySize')}
                  value={libraryStorage ? formatBytes(libSorted.reduce((s, o) => s + o.size, 0)) : '-'}
                  note={t('storageDashboard.libraryDrive.librarySizeNote')}
                />
                <PathRow isDark={isDark} label={t('storageDashboard.libraryLocation')} path={systemStorage.libraryDisk.path} iconClass="text-blue-400" />
              </div>
            </Sec>
          </div>
        )}
      </div>

      {/* ── Library contents ──────────────────────────────────────────
          What is stored in the library, per object. It used to sit inside the
          Local Server card, which read as if these were files on the host disk
          even when the library lives on a separate drive. */}
      {libraryStorage && (
        <Sec
          title={t('storageDashboard.libraryContents.title')}
          description={t('storageDashboard.libraryContents.description')}
          isDark={isDark}
        >
          {libSorted.length > 0 ? (
            <div className="overflow-hidden rounded-2xl">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className={isDark ? 'bg-slate-800/60' : 'bg-slate-50'}>
                      <LibSortHeader label={t('storageDashboard.libraryTable.object')} field="name" />
                      <LibSortHeader label={t('storageDashboard.libraryTable.totalSize')} field="size" />
                      <LibSortHeader label={t('storageDashboard.libraryTable.files')} field="fileCount" />
                    </tr>
                  </thead>
                  <tbody>
                    {libVisible.map((obj, idx) => (
                      <tr
                        key={obj.objectId}
                        className={`transition-colors ${
                          isDark
                            ? `hover:bg-slate-800/50 ${idx !== libVisible.length - 1 ? 'border-b border-slate-800/50' : ''}`
                            : `hover:bg-slate-50 ${idx !== libVisible.length - 1 ? 'border-b border-slate-100' : ''}`
                        }`}
                      >
                        <td className={`px-4 py-3.5 font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                          <div className="flex items-center gap-2">
                            <Image className="w-4 h-4 text-teal-400 shrink-0" />
                            <Link
                              to={`/object/${encodeURIComponent(obj.objectId)}`}
                              className={`truncate rounded transition-colors hover:underline ${
                                isDark ? 'hover:text-accent-300' : 'hover:text-accent-700'
                              }`}
                            >
                              {obj.name}
                            </Link>
                          </div>
                        </td>
                        <td className={`px-4 py-3.5 tabular-nums ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{obj.sizeFormatted}</td>
                        <td className={`px-4 py-3.5 tabular-nums ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{formatNumber(obj.fileCount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {libExpanded && libTotalPages > 1 && (
                <Pagination
                  page={libPage}
                  totalPages={libTotalPages}
                  onPrev={() => setLibPage(p => p - 1)}
                  onNext={() => setLibPage(p => p + 1)}
                  total={libSorted.length}
                  pageSize={PAGE_SIZE}
                />
              )}
              {libSorted.length > COLLAPSED_ROWS && (
                <ExpandToggle
                  isDark={isDark}
                  expanded={libExpanded}
                  total={libSorted.length}
                  onToggle={() => { setLibExpanded(e => !e); setLibPage(0); }}
                />
              )}
            </div>
          ) : (
            <div className={`text-center py-8 space-y-2 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              <Trash2 className="w-7 h-7 mx-auto opacity-30" />
              <p className="text-sm">{t('storageDashboard.libraryTable.noObjects')}</p>
            </div>
          )}
        </Sec>
      )}

      {/* ── SeeStar Storage ────────────────────────────────────────── */}
      {isSeestar && (
      <Sec
        title={t('storageDashboard.seestarTelescope.title')}
        description={t('storageDashboard.seestarTelescope.description')}
        isDark={isDark}
        actions={
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
            telescopeOnline
              ? isDark ? 'bg-emerald-500/10 text-emerald-400' : 'bg-emerald-50 text-emerald-700'
              : isDark ? 'bg-slate-700 text-slate-400' : 'bg-slate-100 text-slate-500'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${telescopeOnline ? 'bg-emerald-500' : 'bg-slate-400'}`} />
            {telescopeOnline ? t('storageDashboard.online') : t('storageDashboard.offline')}
          </span>
        }
      >
      <div className="p-5 space-y-5">
        {telescopeOnline ? (
          <>
            {/* Stat tiles */}
            <div className="grid grid-cols-3 gap-3">
              <div className={tileClass}>
                <p className={tileLabel}>{t('storageDashboard.telescopeTable.totalSize')}</p>
                <p className={tileValue}>{formatBytes(totalSize)}</p>
              </div>
              <div className={tileClass}>
                <p className={tileLabel}>{t('storageDashboard.telescopeTable.totalFiles')}</p>
                <p className={tileValue}>{formatNumber(totalFiles)}</p>
              </div>
              <div className={tileClass}>
                <p className={tileLabel}>{t('storageDashboard.telescopeTable.objects')}</p>
                <p className={tileValue}>{objectCount}</p>
              </div>
            </div>

            {/* Per-object detail table */}
            {sorted.length > 0 && (
              <div className={`-mx-5 -mb-5 mt-2 overflow-hidden rounded-b-2xl border-t ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className={isDark ? 'bg-slate-800/60' : 'bg-slate-50'}>
                        <SortHeader label={t('storageDashboard.telescopeTable.name')} field="name" />
                        <SortHeader label={t('storageDashboard.telescopeTable.totalSize')} field="totalSize" />
                        <SortHeader label={t('storageDashboard.telescopeTable.files')} field="fileCount" />
                        <SortHeader label={t('storageDashboard.telescopeTable.subFrames')} field="subFrameCount" />
                        <SortHeader label={t('storageDashboard.telescopeTable.oldest')} field="oldestFile" />
                        <SortHeader label={t('storageDashboard.telescopeTable.newest')} field="newestFile" />
                      </tr>
                    </thead>
                    <tbody>
                      {telVisible.map((obj, idx) => (
                        <tr
                          key={obj.id}
                          className={`transition-colors ${
                            isDark
                              ? `hover:bg-slate-800/50 ${idx !== telVisible.length - 1 ? 'border-b border-slate-800/50' : ''}`
                              : `hover:bg-slate-50 ${idx !== telVisible.length - 1 ? 'border-b border-slate-100' : ''}`
                          }`}
                        >
                          <td className={`px-4 py-3.5 font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                            <div className="flex items-center gap-2">
                              <Image className="w-4 h-4 text-accent-500 shrink-0" />
                              <Link
                                to={`/object/${encodeURIComponent(obj.id)}`}
                                className={`truncate rounded transition-colors hover:underline ${
                                  isDark ? 'hover:text-accent-300' : 'hover:text-accent-700'
                                }`}
                              >
                                {obj.name}
                              </Link>
                            </div>
                          </td>
                          <td className={`px-4 py-3.5 tabular-nums ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{formatBytes(obj.totalSize)}</td>
                          <td className={`px-4 py-3.5 tabular-nums ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{formatNumber(obj.fileCount)}</td>
                          <td className={`px-4 py-3.5 tabular-nums ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{formatNumber(obj.subFrameCount)}</td>
                          <td className={`px-4 py-3.5 whitespace-nowrap ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                            <div className="flex items-center gap-1.5">
                              <Calendar className="w-3.5 h-3.5 shrink-0" />
                              {formatDate(obj.oldestFile)}
                            </div>
                          </td>
                          <td className={`px-4 py-3.5 whitespace-nowrap ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                            <div className="flex items-center gap-1.5">
                              <Calendar className="w-3.5 h-3.5 shrink-0" />
                              {formatDate(obj.newestFile)}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {telExpanded && totalPages > 1 && (
                  <Pagination
                    page={page}
                    totalPages={totalPages}
                    onPrev={() => setPage(p => p - 1)}
                    onNext={() => setPage(p => p + 1)}
                    total={sorted.length}
                    pageSize={PAGE_SIZE}
                  />
                )}
                {sorted.length > COLLAPSED_ROWS && (
                  <ExpandToggle
                    isDark={isDark}
                    expanded={telExpanded}
                    total={sorted.length}
                    onToggle={() => { setTelExpanded(e => !e); setPage(0); }}
                  />
                )}
              </div>
            )}

            {sorted.length === 0 && (
              <div className={`text-center py-10 space-y-3 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                <Trash2 className="w-8 h-8 mx-auto opacity-30" />
                <p className="text-sm">{t('storageDashboard.telescopeTable.noData')}</p>
              </div>
            )}
          </>
        ) : null}
      </div>
      </Sec>
      )}
    </>
  );
}
