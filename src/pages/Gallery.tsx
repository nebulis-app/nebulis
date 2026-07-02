import { useState, useMemo, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Search, Telescope, AlertCircle, Filter, Download, RotateCw, CheckCircle2, Upload, PlusCircle, Star, Library, ArrowUpDown, Check } from 'lucide-react';
import { getLibraryObjects, getLibraryObjectFilters, triggerImport, getImportStatus } from '../lib/api/library';
import { listTelescopes } from '../lib/api/telescopes';
import { ObjectCard } from '../components/ObjectCard';
import { ImportModal } from '../components/ImportModal';
import { FolderImportWizard } from '../components/folderImport/FolderImportWizard';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../contexts/AuthContext';

type SortKey = 'name-asc' | 'name-desc' | 'session-date-desc' | 'session-date-asc' | 'session-count-desc' | 'import-desc';

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'name-asc',           label: 'Name (A–Z)' },
  { value: 'name-desc',          label: 'Name (Z–A)' },
  { value: 'session-date-desc',  label: 'Latest observation' },
  { value: 'session-date-asc',   label: 'Oldest observation' },
  { value: 'session-count-desc', label: 'Most sessions' },
  { value: 'import-desc',        label: 'Recently imported' },
];

const SORT_STORAGE_KEY = 'nebulis-library-sort';

function readStoredSort(): SortKey {
  try {
    const v = localStorage.getItem(SORT_STORAGE_KEY);
    if (v && SORT_OPTIONS.some(o => o.value === v)) return v as SortKey;
  } catch { /* ignore */ }
  return 'name-asc';
}

const ALL_TELESCOPES_FILTER = '__all__';

// Catalog "family" keywords. Searching a bare family name (e.g. "Messier")
// surfaces every object in that catalog by testing its catalogId + aliases,
// so M81 ("Bode's Galaxy") shows up even though its name has no "Messier".
// `numbered` turns "messier 81" → "m81", "caldwell 20" → "c20", etc.
const CATALOG_FAMILIES: { name: string; prefix: string; test: (id: string) => boolean }[] = [
  { name: 'messier',   prefix: 'm',     test: id => /^M\d{1,3}$/i.test(id) },
  { name: 'caldwell',  prefix: 'c',     test: id => /^C\d{1,3}$/i.test(id) },
  { name: 'sharpless', prefix: 'sh2-',  test: id => /^SH2-\d+$/i.test(id) },
];

export function Gallery() {
  const { isDark, isNight, isSpace } = useTheme();
  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500';
  const { isAdmin } = useAuth();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('All');
  const [telescopeFilter, setTelescopeFilter] = useState<string>(ALL_TELESCOPES_FILTER);
  const [showImportModal, setShowImportModal] = useState(false);
  const [wizardPath, setWizardPath] = useState<string | null>(null);
  const [wizardSubframes, setWizardSubframes] = useState(false);
  const [wizardFits, setWizardFits] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>(readStoredSort);
  const [sortOpen, setSortOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const { data: objects, isLoading, error } = useQuery({
    queryKey: ['library-objects'],
    queryFn: getLibraryObjects,
    // Building this list does a DB read plus a stat per object server-side, so
    // avoid refetching it on every navigation back to the library. Favorite and
    // import mutations invalidate this key explicitly when the data changes.
    staleTime: 60_000,
  });

  const { data: objectFilters = [] } = useQuery({
    queryKey: ['library-object-filters'],
    queryFn: getLibraryObjectFilters,
  });

  const { data: telescopes = [] } = useQuery({
    queryKey: ['telescopes'],
    queryFn: listTelescopes,
  });
  const showTelescopeUI = telescopes.length >= 2;
  // Reset the filter if the selected scope is deleted; otherwise the library
  // shows zero results until the user manually clicks "All scopes".
  useEffect(() => {
    if (telescopeFilter === ALL_TELESCOPES_FILTER) return;
    if (!telescopes.some(t => t.id === telescopeFilter)) {
      setTelescopeFilter(ALL_TELESCOPES_FILTER);
    }
  }, [telescopes, telescopeFilter]);

  useEffect(() => {
    if (!sortOpen) return;
    function handleClick(e: MouseEvent) {
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) {
        setSortOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [sortOpen]);

  function applySort(key: SortKey) {
    setSortKey(key);
    setSortOpen(false);
    try { localStorage.setItem(SORT_STORAGE_KEY, key); } catch { /* ignore */ }
  }



  const { data: importStatus, isLoading: statusLoading } = useQuery({
    queryKey: ['import-status'],
    queryFn: getImportStatus,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.running ? 2000 : false;
    },
  });

  // Auto-import-enabled scopes drive the manual import default. With one
  // scope this matches the legacy single-scope behavior; with several, the
  // button kicks off a sequential fan-out across every enabled scope so the
  // user doesn't have to switch the active telescope and click again.
  const enabledTelescopes = telescopes.filter(t => t.autoImportEnabled);
  const importsAllScopes = enabledTelescopes.length >= 2;

  const importResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (importResetTimerRef.current) clearTimeout(importResetTimerRef.current); }, []);

  const importMutation = useMutation({
    mutationFn: () => triggerImport(importsAllScopes ? { all: true } : undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['import-status'] });
      // Reset success state after 3 seconds so the checkmark doesn't persist forever
      importResetTimerRef.current = setTimeout(() => importMutation.reset(), 3000);
    },
  });

  const filtered = useMemo(() => {
    const s = search.toLowerCase().trim();
    // "messier 81" → "m81", "caldwell 20" → "c20", "sharpless 298" → "sh2-298"
    const numbered = s.match(/^(messier|caldwell|sharpless)\s*(\d+)$/);
    const effectiveTerm = numbered
      ? `${CATALOG_FAMILIES.find(f => f.name === numbered[1])!.prefix}${numbered[2]}`
      : s;
    // Bare family keyword (≥3 chars, no number) → show the whole catalog.
    const family = !numbered && s.length >= 3
      ? CATALOG_FAMILIES.find(f => f.name.startsWith(s))
      : undefined;

    const list = objects?.filter(obj => {
      const matchesFamily = family
        ? [obj.catalogId, ...(obj.aliases ?? [])].some(id => family.test(id))
        : false;
      const matchesSearch =
        !search ||
        matchesFamily ||
        obj.name.toLowerCase().includes(effectiveTerm) ||
        obj.catalogId.toLowerCase().includes(effectiveTerm) ||
        obj.constellation.toLowerCase().includes(effectiveTerm) ||
        (obj.aliases ?? []).some(a => a.toLowerCase().startsWith(effectiveTerm));

      const selectedFilter = objectFilters.find(filter => filter.label === typeFilter);
      const matchesType =
        typeFilter === 'All' ? true :
        typeFilter === 'Favorites' ? Boolean(obj.isFavorite) :
        selectedFilter
          ? obj.filterTags?.includes(selectedFilter.id) ?? false
          : obj.type.toLowerCase().includes(typeFilter.toLowerCase());

      const matchesTelescope =
        telescopeFilter === ALL_TELESCOPES_FILTER ||
        (obj.telescopeIds?.includes(telescopeFilter) ?? false);

      return matchesSearch && matchesType && matchesTelescope;
    });

    if (!list) return list;

    return [...list].sort((a, b) => {
      switch (sortKey) {
        case 'name-asc':
          return a.name.localeCompare(b.name);
        case 'name-desc':
          return b.name.localeCompare(a.name);
        case 'session-date-desc':
          return (b.lastSessionDate ?? '').localeCompare(a.lastSessionDate ?? '');
        case 'session-date-asc':
          return (a.lastSessionDate ?? '').localeCompare(b.lastSessionDate ?? '');
        case 'session-count-desc':
          return (b.sessionCount ?? 0) - (a.sessionCount ?? 0);
        case 'import-desc':
          return (b.lastImport ?? '').localeCompare(a.lastImport ?? '');
        default:
          return 0;
      }
    });
  }, [objects, search, typeFilter, telescopeFilter, objectFilters, sortKey]);

  const isImporting = importStatus?.running ?? false;
  const importProgress = importStatus && importStatus.objectsTotal > 0
    ? Math.round((importStatus.objectsDone / importStatus.objectsTotal) * 100)
    : null;

  return (
    <div className="space-y-8">
      {/* Hero header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <h1 className={`font-display text-3xl font-bold tracking-tight flex items-center gap-3 ${
            isDark ? 'text-white' : 'text-slate-900'
          }`}>
            <Library className={`w-7 h-7 ${accentText}`} />
            Library
          </h1>
        </div>
      </div>

      {/* Import status bar */}
      {isImporting && (
        <div className={`flex items-center gap-4 px-5 py-3 rounded-xl border ${
          isDark ? 'bg-accent-500/5 border-accent-500/20 text-accent-400' : 'bg-accent-100 border-accent-300 text-accent-700'
        }`}>
          <RotateCw className="w-4 h-4 animate-spin shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium">
              {importStatus?.currentObject
                ? `Importing ${importStatus.currentObject}${importStatus.telescopeName ? ` from ${importStatus.telescopeName}` : ''}`
                : importStatus?.telescopeName
                  ? `Importing from ${importStatus.telescopeName}`
                  : 'Importing from telescope'}
            </span>
            {importProgress !== null && (
              <span className={`ml-3 text-xs ${isDark ? 'text-accent-500/70' : 'text-accent-600/70'}`}>
                {importStatus?.objectsDone}/{importStatus?.objectsTotal} objects &bull; {importStatus?.filesDone}/{importStatus?.filesTotal} files
              </span>
            )}
          </div>
          <div className={`w-32 h-1.5 rounded-full ${isDark ? 'bg-slate-700' : 'bg-accent-200'}`}>
            <div
              className="h-full rounded-full bg-accent-500 transition-all duration-500"
              style={{ width: `${importProgress ?? 0}%` }}
            />
          </div>
        </div>
      )}

      {/* Search and action buttons */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className={`relative flex-1 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
          <Search className={`absolute left-4 top-1/2 -translate-y-1/2 w-4.5 h-4.5 ${
            isDark ? 'text-slate-500' : 'text-slate-400'
          }`} />
          <input
            type="text"
            placeholder="Search objects, constellations..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className={`w-full pl-11 pr-4 py-3 rounded-xl border text-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 ${
              isDark
                ? 'bg-slate-900 border-slate-800 placeholder-slate-600 focus:border-accent-500/50'
                : 'bg-white border-slate-200 placeholder-slate-400 focus:border-accent-400'
            }`}
          />
        </div>

        {/* Import buttons — admin only */}
        {!isImporting && isAdmin && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => importMutation.mutate()}
              disabled={importMutation.isPending || statusLoading}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap transition-all ${
                isDark
                  ? 'bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700'
                  : 'bg-white text-slate-600 hover:bg-slate-50 border border-slate-200 shadow-sm'
              }`}
            >
              {importMutation.isSuccess ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              ) : (
                <Download className="w-4 h-4" />
              )}
              {importsAllScopes ? `From all ${enabledTelescopes.length} telescopes` : 'From Telescope'}
            </button>
            <button
              onClick={() => setShowImportModal(true)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap transition-all ${
                isDark
                  ? 'bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700'
                  : 'bg-white text-slate-600 hover:bg-slate-50 border border-slate-200 shadow-sm'
              }`}
            >
              <Upload className="w-4 h-4" />
              Upload Files
            </button>
            <Link
              to="/observations/new"
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap transition-all ${
                isDark
                  ? 'bg-accent-500/15 text-accent-400 hover:bg-accent-500/25 border border-accent-500/30'
                  : 'bg-accent-300 text-accent-700 hover:bg-accent-400 border border-accent-400'
              }`}
            >
              <PlusCircle className="w-4 h-4" />
              New Observation
            </Link>
          </div>
        )}
      </div>

      {/* Object type filter bar */}
      <div className={`flex items-center gap-2 flex-wrap ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
        <Filter className="w-4 h-4 shrink-0" />
        {/* Favorites filter — special case that checks isFavorite */}
        <button
          onClick={() => setTypeFilter(typeFilter === 'Favorites' ? 'All' : 'Favorites')}
          className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${
            typeFilter === 'Favorites'
              ? isDark
                ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                : 'bg-amber-100 text-amber-700 border border-amber-300'
              : isDark
                ? 'hover:bg-slate-800 border border-transparent'
                : 'hover:bg-slate-100 border border-transparent'
          }`}
        >
          <Star className={`w-3.5 h-3.5 ${typeFilter === 'Favorites' ? 'fill-current' : ''}`} />
          Favorites
        </button>
        {objectFilters.map(filter => (
          <button
            key={filter.id}
            onClick={() => setTypeFilter(filter.label)}
            className={`px-3.5 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${
              typeFilter === filter.label
                ? isDark
                  ? 'bg-accent-500/15 text-accent-400 border border-accent-500/30'
                  : 'bg-accent-300 text-accent-700 border border-accent-400'
                : isDark
                  ? 'hover:bg-slate-800 border border-transparent'
                  : 'hover:bg-slate-100 border border-transparent'
              }`}
          >
            {filter.label}
          </button>
        ))}
        {/* Telescope facet — only when more than one telescope is configured */}
        {showTelescopeUI && (
          <div className={`flex items-center gap-1.5 ml-2 pl-2 border-l ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
            <button
              onClick={() => setTelescopeFilter(ALL_TELESCOPES_FILTER)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-all border ${
                telescopeFilter === ALL_TELESCOPES_FILTER
                  ? isDark
                    ? 'bg-accent-500/15 text-accent-400 border-accent-500/30'
                    : 'bg-accent-300 text-accent-700 border-accent-400'
                  : isDark
                    ? 'hover:bg-slate-800 border-transparent'
                    : 'hover:bg-slate-100 border-transparent'
              }`}
            >
              All scopes
            </button>
            {telescopes.map(t => {
              const selected = telescopeFilter === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setTelescopeFilter(t.id)}
                  title={t.name}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-all border ${
                    selected
                      ? isDark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-slate-100 border-slate-300 text-slate-900'
                      : isDark
                        ? 'hover:bg-slate-800 border-transparent'
                        : 'hover:bg-slate-100 border-transparent'
                  }`}
                >
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: t.color }}
                    aria-hidden="true"
                  />
                  <span className="truncate max-w-[8rem]">{t.name}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className={`rounded-2xl overflow-hidden border ${
                isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
              }`}
            >
              <div className={`h-48 img-placeholder ${isDark ? '' : 'bg-gradient-to-br from-slate-100 to-slate-200'}`} />
              <div className="p-5 space-y-3">
                <div className={`h-5 rounded w-3/4 ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`} />
                <div className={`h-4 rounded w-1/2 ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`} />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <div className={`text-center py-16 space-y-4 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          <AlertCircle className="w-12 h-12 mx-auto text-accent-500/50" />
          <div>
            <p className={`text-lg font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
              Unable to load library
            </p>
            <p className="mt-1 text-sm">
              {error instanceof Error ? error.message : "We couldn't reach your library. Check that the Nebulis server is running, then refresh to try again."}
            </p>
          </div>
        </div>
      ) : filtered && filtered.length > 0 ? (
        <>
          <div className="flex items-center justify-between">
            <p className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {filtered.length} object{filtered.length !== 1 ? 's' : ''} in library
            </p>
            <div ref={sortRef} className="relative">
              <button
                onClick={() => setSortOpen(o => !o)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all border ${
                  isDark
                    ? 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-300'
                    : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700'
                }`}
              >
                <ArrowUpDown className="w-3.5 h-3.5" />
                {SORT_OPTIONS.find(o => o.value === sortKey)?.label}
              </button>
              {sortOpen && (
                <div className={`absolute right-0 top-full mt-1.5 z-20 w-52 rounded-xl border shadow-lg overflow-hidden ${
                  isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
                }`}>
                  {SORT_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => applySort(opt.value)}
                      className={`w-full flex items-center justify-between px-4 py-2.5 text-sm text-left transition-colors ${
                        sortKey === opt.value
                          ? isDark
                            ? 'bg-slate-800 text-white'
                            : 'bg-slate-50 text-slate-900'
                          : isDark
                            ? 'text-slate-300 hover:bg-slate-800'
                            : 'text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {opt.label}
                      {sortKey === opt.value && <Check className="w-3.5 h-3.5 shrink-0" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-6">
            {filtered.map(obj => (
              <ObjectCard key={obj.id} object={obj} isDark={isDark} telescopes={telescopes} />
            ))}
          </div>
        </>
      ) : (
        <div className={`text-center py-20 space-y-6 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          <div className={`inline-flex p-6 rounded-full ${isDark ? 'bg-slate-900' : 'bg-slate-100'}`}>
            <Telescope className="w-12 h-12 opacity-40" />
          </div>
          <div className="space-y-2">
            <p className={`text-xl font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
              {typeFilter === 'Favorites'
                ? 'No favorites yet'
                : search || typeFilter !== 'All'
                  ? 'No objects match your search'
                  : 'Your library is empty'}
            </p>
            {typeFilter === 'Favorites' && (
              <p className="text-sm max-w-sm mx-auto">
                Star an object from its detail page to add it to your favorites.
              </p>
            )}
            {!search && typeFilter === 'All' && (
              <p className="text-sm max-w-sm mx-auto">
                Import images from your SeeStar to build your local library. Configure your telescope connection in Settings first.
              </p>
            )}
          </div>
          {!search && typeFilter === 'All' && isAdmin && (
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                onClick={() => importMutation.mutate()}
                disabled={isImporting || importMutation.isPending}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-accent-500 text-white font-medium text-sm hover:bg-accent-600 transition disabled:opacity-50"
              >
                {isImporting ? <RotateCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                {importsAllScopes ? `Import from all ${enabledTelescopes.length} telescopes` : 'Import from Telescope'}
              </button>
              <button
                onClick={() => setShowImportModal(true)}
                className={`inline-flex items-center gap-2 px-6 py-3 rounded-xl font-medium text-sm transition border ${
                  isDark
                    ? 'border-slate-700 text-slate-300 hover:bg-slate-800'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                <Upload className="w-4 h-4" />
                Upload Observation
              </button>
              <a
                href="/settings"
                className={`inline-flex items-center gap-2 px-6 py-3 rounded-xl font-medium text-sm transition border ${
                  isDark
                    ? 'border-slate-700 text-slate-300 hover:bg-slate-800'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                Configure Settings
              </a>
            </div>
          )}
        </div>
      )}

      {/* Import modal — drop zone → review wizard */}
      {showImportModal && (
        <ImportModal
          onClose={() => setShowImportModal(false)}
          onReview={(folderPath, includeSubframes, includeFits) => {
            setShowImportModal(false);
            setWizardSubframes(includeSubframes);
            setWizardFits(includeFits);
            setWizardPath(folderPath);
          }}
        />
      )}

      {/* Guided folder-import wizard (scan → review sessions → commit) */}
      {wizardPath && (
        <FolderImportWizard
          rootPath={wizardPath}
          includeSubframes={wizardSubframes}
          includeFits={wizardFits}
          onClose={() => setWizardPath(null)}
          onDone={() => queryClient.invalidateQueries({ queryKey: ['library-objects'] })}
        />
      )}


    </div>
  );
}
