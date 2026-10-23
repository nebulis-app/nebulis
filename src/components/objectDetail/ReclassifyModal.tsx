import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Loader2, Search, X } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { useTheme } from '../../hooks/useTheme';
import { searchDsoCatalog, type DsoEntry } from '../../lib/api/planner';
import { getLibraryObjects, reclassifyObject } from '../../lib/api/library';

/** Every other name this object goes by, split so each kind gets its own pill
 *  style: catalog designations (M/NGC/IC/Caldwell/Sharpless) and common names. */
function otherNames(r: DsoEntry): { designations: string[]; common: string[] } {
  const seen = new Set([r.id.toLowerCase(), r.name.toLowerCase()]);
  const fresh = (n: string) => {
    const k = n.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };
  return {
    designations: (r.aliases ?? []).filter(fresh),
    common: (r.commonNames ?? []).filter(fresh),
  };
}

/** Title + pills for one catalog object. The id is a pill only when a common
 *  name takes the title, so a bare "NGC5980" is never printed twice. */
function ObjectNames({ entry, isDark }: { entry: DsoEntry; isDark: boolean }) {
  const { designations, common } = otherNames(entry);
  const hasName = entry.name.toLowerCase() !== entry.id.toLowerCase();
  const pill = 'inline-flex items-center rounded-full px-2 py-0.5 text-[0.6875rem] font-medium leading-4';
  const idCls = isDark ? 'bg-accent-500/15 text-accent-300' : 'bg-accent-500/10 text-accent-700';
  const desigCls = isDark ? 'bg-slate-700/70 text-slate-300' : 'bg-slate-200 text-slate-700';
  const commonCls = isDark ? 'bg-sky-500/15 text-sky-300' : 'bg-sky-100 text-sky-800';
  return (
    <>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={`text-sm font-medium ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
          {hasName ? entry.name : entry.id}
        </span>
        {hasName && <span className={`${pill} ${idCls}`}>{entry.id}</span>}
        <span className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          {entry.type}{entry.constellation ? ` · ${entry.constellation}` : ''}
        </span>
      </span>
      {(designations.length > 0 || common.length > 0) && (
        <span className="mt-1 flex flex-wrap gap-1">
          {designations.map(n => <span key={`d-${n}`} className={`${pill} ${desigCls}`}>{n}</span>)}
          {common.map(n => <span key={`c-${n}`} className={`${pill} ${commonCls}`}>{n}</span>)}
        </span>
      )}
    </>
  );
}

/**
 * "..." → Reclassify object. For when a target's designation was ambiguous
 * (several valid NGC/IC/Sharpless/Caldwell numbers for the same object) or
 * simply mis-picked on import, and everything currently under this object
 * really belongs under a different catalog identity.
 *
 * One search flow, not a "new vs existing" toggle: the server
 * (reclassifyObject in objects.ts) already auto-detects rename vs merge from
 * whether the picked catalog id has a library object yet, so the picker just
 * shows which outcome a given search result would produce.
 */
export function ReclassifyModal({
  objectId,
  displayName,
  onClose,
}: {
  objectId: string;
  displayName: string;
  onClose: () => void;
}) {
  const { isDark } = useTheme();
  const { t } = useTranslation('library');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [picked, setPicked] = useState<DsoEntry | null>(null);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Modal focuses its first control (the close button) on open; take focus
  // back so the user can type straight away.
  useEffect(() => {
    const id = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(id);
  }, []);

  const onType = (q: string) => {
    setQuery(q);
    setPicked(null);
    setError(null);
    if (timer.current) clearTimeout(timer.current);
    if (!q.trim()) { setDebounced(''); return; }
    timer.current = setTimeout(() => setDebounced(q.trim()), 250);
  };

  const { data: searchData, isFetching } = useQuery({
    queryKey: ['dso-search', debounced, 8],
    queryFn: () => searchDsoCatalog(debounced, 8),
    enabled: debounced.length > 0,
    staleTime: 30_000,
  });
  const results = (searchData?.results ?? []).filter(r => r.id !== objectId);

  // Shared with the Library grid / ObjectDetail's own variant lookup, so this
  // is a cache read in the common case, not a second fetch — used only to
  // tell the user up front whether picking a result will rename or merge.
  const { data: libraryObjects } = useQuery({
    queryKey: ['library-objects'],
    queryFn: getLibraryObjects,
    staleTime: 5 * 60 * 1000,
  });
  const existingTarget = picked ? libraryObjects?.find(o => o.id === picked.id) ?? null : null;

  const mutation = useMutation({
    mutationFn: () => {
      if (!picked) throw new Error(t('reclassifyModal.pickFirst'));
      return reclassifyObject(objectId, picked.id, remember);
    },
    onSuccess: result => {
      queryClient.invalidateQueries({ queryKey: ['library-objects'] });
      queryClient.invalidateQueries({ queryKey: ['catalog', objectId] });
      queryClient.invalidateQueries({ queryKey: ['catalog-info', objectId] });
      onClose();
      navigate(`/object/${encodeURIComponent(result.objectId)}`);
    },
    onError: (e: Error) => setError(e.message),
  });

  const inputCls = `px-2.5 py-1.5 rounded-lg border text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 ${
    isDark ? 'bg-slate-800 border-slate-700 text-slate-200' : 'bg-white border-slate-300 text-slate-800'
  }`;
  const mutedText = isDark ? 'text-slate-500' : 'text-slate-400';

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('reclassifyModal.title', { name: displayName })}
      className={`mx-4 w-full max-w-lg rounded-2xl border shadow-2xl ${
        isDark ? 'border-slate-700 bg-slate-900' : 'border-slate-200 bg-white'
      }`}
    >
      <div className={`flex items-center justify-between border-b px-5 py-3.5 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <h3 className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
          {t('reclassifyModal.title', { name: displayName })}
        </h3>
        <button
          onClick={onClose}
          className={`rounded-lg p-1.5 transition ${isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-400 hover:bg-slate-100'}`}
        >
          <X className="h-4 w-4" />
          <span className="sr-only">{t('reclassifyModal.close')}</span>
        </button>
      </div>

      <div className="space-y-4 px-5 py-4">
        <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
          {t('reclassifyModal.intro', { name: displayName })}
        </p>

        {picked ? (
          <div className={`rounded-xl border px-3.5 py-3 ${isDark ? 'border-slate-700 bg-slate-800/60' : 'border-slate-200 bg-slate-50'}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <ObjectNames entry={picked} isDark={isDark} />
                <p className={`mt-0.5 text-xs ${existingTarget ? (isDark ? 'text-amber-400' : 'text-amber-600') : (isDark ? 'text-emerald-400' : 'text-emerald-600')}`}>
                  {existingTarget
                    ? t('reclassifyModal.resultMergesInto', { count: existingTarget.sessionCount ?? 0 })
                    : t('reclassifyModal.resultBecomesNew')}
                </p>
              </div>
              <button
                onClick={() => { setPicked(null); setError(null); }}
                className={`shrink-0 text-xs font-medium ${isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'}`}
              >
                {t('reclassifyModal.change')}
              </button>
            </div>
          </div>
        ) : (
          <div>
            <div className="relative">
              <Search className={`absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 ${mutedText}`} />
              <input
                ref={inputRef}
                autoFocus
                value={query}
                onChange={e => onType(e.target.value)}
                placeholder={t('reclassifyModal.searchPlaceholder')}
                className={`${inputCls} w-full pl-8`}
              />
            </div>
            <div className="mt-2 max-h-48 space-y-0.5 overflow-y-auto">
              {isFetching && <p className={`px-1 text-xs ${mutedText}`}>{t('reclassifyModal.searching')}</p>}
              {!isFetching && debounced && results.length === 0 && (
                <p className={`px-1 text-xs ${mutedText}`}>{t('reclassifyModal.noMatches')}</p>
              )}
              {results.map(r => (
                <button
                  key={r.id}
                  onClick={() => { setPicked(r); setError(null); }}
                  className={`w-full rounded-lg px-2.5 py-1.5 text-left text-sm transition ${
                    isDark ? 'text-slate-200 hover:bg-slate-800' : 'text-slate-800 hover:bg-slate-100'
                  }`}
                >
                  <ObjectNames entry={r} isDark={isDark} />
                </button>
              ))}
            </div>
          </div>
        )}

        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={remember}
            onChange={e => setRemember(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-accent-500"
          />
          <span>
            <span className={`block text-sm ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
              {t('reclassifyModal.rememberLabel')}
            </span>
            <span className={`block text-xs ${mutedText}`}>
              {t('reclassifyModal.rememberHint', { designation: objectId })}
            </span>
          </span>
        </label>

        {error && (
          <p className={`text-sm ${isDark ? 'text-red-300' : 'text-red-600'}`} role="alert">{error}</p>
        )}
      </div>

      <div className={`flex items-center justify-end gap-2 border-t px-5 py-3 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <button
          onClick={onClose}
          className={`rounded-xl px-4 py-2 text-sm font-medium transition ${
            isDark ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          {t('reclassifyModal.cancel')}
        </button>
        <button
          onClick={() => mutation.mutate()}
          disabled={!picked || mutation.isPending}
          className="inline-flex items-center gap-2 rounded-xl bg-accent-500 px-4 py-2 text-sm font-medium text-white
            transition hover:bg-accent-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {mutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {mutation.isPending ? t('reclassifyModal.confirming') : t('reclassifyModal.confirm')}
        </button>
      </div>
    </Modal>
  );
}
