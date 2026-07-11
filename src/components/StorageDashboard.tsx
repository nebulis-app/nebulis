import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { HardDrive, Trash2, Calendar, Image, AlertCircle, ArrowUpDown, Server, FolderOpen } from 'lucide-react';
import { getStorageStats, getSystemStorage, getLibraryStorage } from '../lib/api/storage';
import { useTheme } from '../hooks/useTheme';
import { formatBytes } from '../lib/utils';

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '--';
  // dateStr is a bare YYYY-MM-DD (see server/routes/storage.ts). Anchor at
  // noon rather than parsing as UTC midnight, which renders as the previous
  // calendar day for any user west of UTC.
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

type SortKey = 'name' | 'totalSize' | 'fileCount' | 'subFrameCount' | 'oldestFile' | 'newestFile';
type LibSortKey = 'name' | 'size' | 'fileCount';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE = 10;

export function StorageDashboard({ embedded = false }: { embedded?: boolean } = {}) {
  const { isDark } = useTheme();

  // Telescope table state
  const [sortKey, setSortKey] = useState<SortKey>('totalSize');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(0);

  // Library table state
  const [libSortKey, setLibSortKey] = useState<LibSortKey>('size');
  const [libSortDir, setLibSortDir] = useState<SortDir>('desc');
  const [libPage, setLibPage] = useState(0);

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

  const objects = data?.objects ?? [];
  const telescopeOnline = data?.telescopeOnline ?? false;
  const telescopeKind = data?.telescopeKind ?? null;
  const isSeestar = telescopeKind === 'seestar-s50' || telescopeKind === 'seestar-s30';

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

  const cardClass = `rounded-2xl border ${isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`;
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
        {pg * pageSize + 1}–{Math.min((pg + 1) * pageSize, total)} of {total}
      </span>
      <div className="flex items-center gap-2">
        <button
          onClick={onPrev}
          disabled={pg === 0}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            isDark ? 'bg-slate-700 text-slate-300 hover:bg-slate-600' : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50'
          }`}
        >
          Previous
        </button>
        <button
          onClick={onNext}
          disabled={pg >= tp - 1}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            isDark ? 'bg-slate-700 text-slate-300 hover:bg-slate-600' : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50'
          }`}
        >
          Next
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
              Storage Dashboard
            </h1>
          </div>
        )}
        <div className={`text-center py-16 space-y-4 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          <AlertCircle className="w-12 h-12 mx-auto text-accent-500/50" />
          <div>
            <p className={`text-lg font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>Failed to load storage data</p>
            <p className="mt-1 text-sm">{error instanceof Error ? error.message : 'An unexpected error occurred'}</p>
            <p className="mt-2 text-sm opacity-60">Refresh the page to try again.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Hero header — suppressed when embedded inside the Settings → Storage tab,
          which already renders its own page heading from the active-tab metadata. */}
      {!embedded && (
        <div className="text-center space-y-3">
          <h1 className={`font-display text-4xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
            Storage
          </h1>
          <p className={`text-lg max-w-2xl mx-auto ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            Disk usage for your local server and SeeStar telescope
          </p>
        </div>
      )}

      {/* ── Local Server Storage ──────────────────────────────────── */}
      <div className={cardClass + ' p-6 space-y-5'}>
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className={`p-2.5 rounded-xl ${isDark ? 'bg-teal-500/10' : 'bg-teal-50'}`}>
            <Server className="w-5 h-5 text-teal-500" />
          </div>
          <div className="flex-1">
            <h2 className={`font-display text-lg font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Local Server</h2>
            <p className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Host machine running this dashboard</p>
          </div>
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
            isDark ? 'bg-emerald-500/10 text-emerald-400' : 'bg-emerald-50 text-emerald-700'
          }`}>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            Online
          </span>
        </div>

        {systemStorage ? (
          <>
            {/* Disk usage bar */}
            {systemStorage.disk ? (
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className={isDark ? 'text-slate-300' : 'text-slate-700'}>
                    <span className="font-semibold">{systemStorage.disk.usedFormatted}</span> used of{' '}
                    <span className="font-semibold">{systemStorage.disk.totalFormatted}</span>
                  </span>
                  <span className={`font-mono font-semibold ${
                    systemStorage.disk.usedPercent >= 90 ? 'text-red-500'
                    : systemStorage.disk.usedPercent >= 75 ? 'text-yellow-500'
                    : 'text-emerald-500'
                  }`}>
                    {systemStorage.disk.usedPercent}%
                  </span>
                </div>
                <div className={`h-3 rounded-full overflow-hidden ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                  <div
                    className={`h-full rounded-full transition-all duration-700 ${
                      systemStorage.disk.usedPercent >= 90 ? 'bg-red-500'
                      : systemStorage.disk.usedPercent >= 75 ? 'bg-yellow-500'
                      : 'bg-emerald-500'
                    }`}
                    style={{ width: `${systemStorage.disk.usedPercent}%` }}
                  />
                </div>
                <div className={`flex justify-between text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  <span>{systemStorage.disk.freeFormatted} free</span>
                  <span>{systemStorage.disk.totalFormatted} total</span>
                </div>
              </div>
            ) : (
              <p className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Disk info unavailable on this platform</p>
            )}

            {/* Stat tiles */}
            <div className="grid grid-cols-3 gap-3">
              <div className={tileClass}>
                <p className={tileLabel}>Disk Total</p>
                <p className={tileValue}>{systemStorage.disk?.totalFormatted ?? '-'}</p>
              </div>
              <div className={tileClass}>
                <p className={tileLabel}>Disk Free</p>
                <p className={tileValue}>{systemStorage.disk?.freeFormatted ?? '-'}</p>
              </div>
              <div className={tileClass}>
                <p className={tileLabel}>App Data</p>
                <p className={tileValue}>{systemStorage.dataDir.sizeFormatted}</p>
              </div>
            </div>

            {/* Data directory path */}
            <div className={`flex items-center gap-3 p-3 rounded-xl ${isDark ? 'bg-slate-800' : 'bg-slate-50'}`}>
              <FolderOpen className="w-4 h-4 text-teal-400 shrink-0" />
              <div className="min-w-0">
                <p className={`text-xs font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Data directory</p>
                <p className={`text-sm font-mono truncate ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{systemStorage.dataDir.path}</p>
              </div>
            </div>
          </>
        ) : (
          <div className="space-y-3">
            <div className={`h-3 rounded-full ${isDark ? 'bg-slate-800' : 'bg-slate-100'} animate-pulse`} />
            <div className="grid grid-cols-3 gap-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className={`h-20 rounded-xl ${isDark ? 'bg-slate-800' : 'bg-slate-100'} animate-pulse`} />
              ))}
            </div>
          </div>
        )}

        {/* Library objects table */}
        {libSorted.length > 0 && (
          <div className={`-mx-6 -mb-6 mt-2 overflow-hidden rounded-b-2xl border-t ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className={isDark ? 'bg-slate-800/60' : 'bg-slate-50'}>
                    <LibSortHeader label="Object" field="name" />
                    <LibSortHeader label="Total Size" field="size" />
                    <LibSortHeader label="Files" field="fileCount" />
                  </tr>
                </thead>
                <tbody>
                  {libPaginated.map((obj, idx) => (
                    <tr
                      key={obj.objectId}
                      className={`transition-colors ${
                        isDark
                          ? `hover:bg-slate-800/50 ${idx !== libPaginated.length - 1 ? 'border-b border-slate-800/50' : ''}`
                          : `hover:bg-slate-50 ${idx !== libPaginated.length - 1 ? 'border-b border-slate-100' : ''}`
                      }`}
                    >
                      <td className={`px-4 py-3.5 font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                        <div className="flex items-center gap-2">
                          <Image className="w-4 h-4 text-teal-400 shrink-0" />
                          {obj.name}
                        </div>
                      </td>
                      <td className={`px-4 py-3.5 tabular-nums ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{obj.sizeFormatted}</td>
                      <td className={`px-4 py-3.5 tabular-nums ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{obj.fileCount.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {libTotalPages > 1 && (
              <Pagination
                page={libPage}
                totalPages={libTotalPages}
                onPrev={() => setLibPage(p => p - 1)}
                onNext={() => setLibPage(p => p + 1)}
                total={libSorted.length}
                pageSize={PAGE_SIZE}
              />
            )}
          </div>
        )}

        {libraryStorage && libSorted.length === 0 && (
          <div className={`text-center py-8 space-y-2 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            <Trash2 className="w-7 h-7 mx-auto opacity-30" />
            <p className="text-sm">No library objects found</p>
          </div>
        )}
      </div>

      {/* ── Library Drive ─────────────────────────────────────────────
          Shown only when the library has been moved to a separate drive.
          The Local Server card above covers the boot volume; this reports the
          external drive the library now lives on. */}
      {systemStorage?.libraryDisk && (
        <div className={cardClass + ' p-6 space-y-5'}>
          <div className="flex items-center gap-3">
            <div className={`p-2.5 rounded-xl ${isDark ? 'bg-blue-500/10' : 'bg-blue-50'}`}>
              <HardDrive className="w-5 h-5 text-blue-500" />
            </div>
            <div className="flex-1">
              <h2 className={`font-display text-lg font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Library Drive</h2>
              <p className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>External drive holding your relocated library</p>
            </div>
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
              isDark ? 'bg-emerald-500/10 text-emerald-400' : 'bg-emerald-50 text-emerald-700'
            }`}>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              Connected
            </span>
          </div>

          {/* Disk usage bar */}
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className={isDark ? 'text-slate-300' : 'text-slate-700'}>
                <span className="font-semibold">{systemStorage.libraryDisk.usedFormatted}</span> used of{' '}
                <span className="font-semibold">{systemStorage.libraryDisk.totalFormatted}</span>
              </span>
              <span className={`font-mono font-semibold ${
                systemStorage.libraryDisk.usedPercent >= 90 ? 'text-red-500'
                : systemStorage.libraryDisk.usedPercent >= 75 ? 'text-yellow-500'
                : 'text-emerald-500'
              }`}>
                {systemStorage.libraryDisk.usedPercent}%
              </span>
            </div>
            <div className={`h-3 rounded-full overflow-hidden ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
              <div
                className={`h-full rounded-full transition-all duration-700 ${
                  systemStorage.libraryDisk.usedPercent >= 90 ? 'bg-red-500'
                  : systemStorage.libraryDisk.usedPercent >= 75 ? 'bg-yellow-500'
                  : 'bg-emerald-500'
                }`}
                style={{ width: `${systemStorage.libraryDisk.usedPercent}%` }}
              />
            </div>
            <div className={`flex justify-between text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              <span>{systemStorage.libraryDisk.freeFormatted} free</span>
              <span>{systemStorage.libraryDisk.totalFormatted} total</span>
            </div>
          </div>

          {/* Stat tiles */}
          <div className="grid grid-cols-3 gap-3">
            <div className={tileClass}>
              <p className={tileLabel}>Disk Total</p>
              <p className={tileValue}>{systemStorage.libraryDisk.totalFormatted}</p>
            </div>
            <div className={tileClass}>
              <p className={tileLabel}>Disk Free</p>
              <p className={tileValue}>{systemStorage.libraryDisk.freeFormatted}</p>
            </div>
            <div className={tileClass}>
              <p className={tileLabel}>Library Size</p>
              <p className={tileValue}>{libraryStorage ? formatBytes(libSorted.reduce((s, o) => s + o.size, 0)) : '-'}</p>
            </div>
          </div>

          {/* Library path */}
          <div className={`flex items-center gap-3 p-3 rounded-xl ${isDark ? 'bg-slate-800' : 'bg-slate-50'}`}>
            <FolderOpen className="w-4 h-4 text-blue-400 shrink-0" />
            <div className="min-w-0">
              <p className={`text-xs font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Library location</p>
              <p className={`text-sm font-mono truncate ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{systemStorage.libraryDisk.path}</p>
            </div>
          </div>
        </div>
      )}

      {/* ── SeeStar Storage ────────────────────────────────────────── */}
      {isSeestar && (
      <div className={cardClass + ' p-6 space-y-5'}>
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className={`p-2.5 rounded-xl ${isDark ? 'bg-accent-500/10' : 'bg-accent-50'}`}>
            <HardDrive className="w-5 h-5 text-accent-500" />
          </div>
          <div className="flex-1">
            <h2 className={`font-display text-lg font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>SeeStar Telescope</h2>
            <p className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Objects on the telescope's SD card / internal share</p>
          </div>
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
            telescopeOnline
              ? isDark ? 'bg-emerald-500/10 text-emerald-400' : 'bg-emerald-50 text-emerald-700'
              : isDark ? 'bg-slate-700 text-slate-400' : 'bg-slate-100 text-slate-500'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${telescopeOnline ? 'bg-emerald-500' : 'bg-slate-400'}`} />
            {telescopeOnline ? 'Online' : 'Offline'}
          </span>
        </div>

        {telescopeOnline ? (
          <>
            {/* Stat tiles */}
            <div className="grid grid-cols-3 gap-3">
              <div className={tileClass}>
                <p className={tileLabel}>Total Size</p>
                <p className={tileValue}>{formatBytes(totalSize)}</p>
              </div>
              <div className={tileClass}>
                <p className={tileLabel}>Total Files</p>
                <p className={tileValue}>{totalFiles.toLocaleString()}</p>
              </div>
              <div className={tileClass}>
                <p className={tileLabel}>Objects</p>
                <p className={tileValue}>{objectCount}</p>
              </div>
            </div>

            {/* Per-object detail table */}
            {sorted.length > 0 && (
              <div className={`-mx-6 -mb-6 mt-2 overflow-hidden rounded-b-2xl border-t ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className={isDark ? 'bg-slate-800/60' : 'bg-slate-50'}>
                        <SortHeader label="Name" field="name" />
                        <SortHeader label="Total Size" field="totalSize" />
                        <SortHeader label="Files" field="fileCount" />
                        <SortHeader label="Sub-frames" field="subFrameCount" />
                        <SortHeader label="Oldest" field="oldestFile" />
                        <SortHeader label="Newest" field="newestFile" />
                      </tr>
                    </thead>
                    <tbody>
                      {paginated.map((obj, idx) => (
                        <tr
                          key={obj.id}
                          className={`transition-colors ${
                            isDark
                              ? `hover:bg-slate-800/50 ${idx !== paginated.length - 1 ? 'border-b border-slate-800/50' : ''}`
                              : `hover:bg-slate-50 ${idx !== paginated.length - 1 ? 'border-b border-slate-100' : ''}`
                          }`}
                        >
                          <td className={`px-4 py-3.5 font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                            <div className="flex items-center gap-2">
                              <Image className="w-4 h-4 text-accent-500 shrink-0" />
                              {obj.name}
                            </div>
                          </td>
                          <td className={`px-4 py-3.5 tabular-nums ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{formatBytes(obj.totalSize)}</td>
                          <td className={`px-4 py-3.5 tabular-nums ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{obj.fileCount.toLocaleString()}</td>
                          <td className={`px-4 py-3.5 tabular-nums ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{obj.subFrameCount.toLocaleString()}</td>
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
                {totalPages > 1 && (
                  <Pagination
                    page={page}
                    totalPages={totalPages}
                    onPrev={() => setPage(p => p - 1)}
                    onNext={() => setPage(p => p + 1)}
                    total={sorted.length}
                    pageSize={PAGE_SIZE}
                  />
                )}
              </div>
            )}

            {sorted.length === 0 && (
              <div className={`text-center py-10 space-y-3 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                <Trash2 className="w-8 h-8 mx-auto opacity-30" />
                <p className="text-sm">No storage data available</p>
              </div>
            )}
          </>
        ) : null}
      </div>
      )}
    </div>
  );
}
