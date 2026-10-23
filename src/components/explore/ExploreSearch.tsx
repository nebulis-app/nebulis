import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Check, Loader2, Plus, Search, Sparkles, X } from 'lucide-react';
import { exploreSearch, type ExploreRow, type FovParam } from '../../lib/api/explore';
import { formatObjectName } from '../../lib/utils';
import { getCatalogThumbnailUrl } from '../../lib/catalogImage';
import { VisibilityChip } from './VisibilityChip';

interface Props {
  siteId: string | null;
  fov: FovParam | null;
  /** The night "up tonight" means, when Explore was opened from the Planner on one. */
  night?: string | null;
  upLabel?: string;
  ready: boolean;
  isDark: boolean;
  wishlistIds: Set<string>;
  onAdd: (row: ExploreRow) => void;
  onOpen: (row: ExploreRow) => void;
  /** Ref so the page can focus the box from the "/" shortcut. */
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

const MIN_CHARS = 1;
const DEBOUNCE_MS = 150;

/**
 * The global search: type a common name or any designation (M, NGC, IC,
 * Caldwell, Sharpless, Barnard) and pick from a dropdown. Enter opens the
 * highlighted object, Ctrl/Cmd+Enter adds it to the wishlist, Enter on a
 * bare query goes to the full results grid. A constellation name also offers
 * "best of <constellation>".
 */
export function ExploreSearch({ siteId, fov, night = null, upLabel, ready, isDark, wishlistIds, onAdd, onOpen, inputRef }: Props) {
  const { t } = useTranslation('catalogs');
  const navigate = useNavigate();
  const listId = useId();
  const localRef = useRef<HTMLInputElement | null>(null);
  const input = inputRef ?? localRef;
  const rootRef = useRef<HTMLDivElement>(null);

  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [text]);

  const enabled = ready && debounced.length >= MIN_CHARS;
  const query = useQuery({
    queryKey: ['explore-search', debounced, siteId, fov?.widthDeg, fov?.heightDeg, night],
    queryFn: () => exploreSearch(debounced, { siteId, fov, night }),
    enabled,
    staleTime: 60_000,
    placeholderData: prev => prev,
  });

  const rows = enabled ? query.data?.results ?? [] : [];
  const constellation = enabled ? query.data?.constellation ?? null : null;
  const total = enabled ? query.data?.total ?? 0 : 0;
  // Row 0 is the constellation hint when there is one, so keyboard indexes
  // run over [hint?, ...rows].
  const offset = constellation ? 1 : 0;
  const optionCount = offset + rows.length;

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  function seeAll() {
    if (!text.trim()) return;
    setOpen(false);
    navigate(`/explore/all?q=${encodeURIComponent(text.trim())}`);
  }

  function openConstellation() {
    if (!constellation) return;
    setOpen(false);
    navigate(`/explore/all?constellation=${encodeURIComponent(constellation.name)}`);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive(a => (optionCount === 0 ? -1 : (a + 1) % optionCount));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(a => (optionCount === 0 ? -1 : (a <= 0 ? optionCount - 1 : a - 1)));
    } else if (e.key === 'Escape') {
      if (open) { setOpen(false); setActive(-1); } else setText('');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active < 0) { seeAll(); return; }
      if (constellation && active === 0) { openConstellation(); return; }
      const row = rows[active - offset];
      if (!row) return;
      if (e.metaKey || e.ctrlKey) { if (!wishlistIds.has(row.id)) onAdd(row); }
      else { setOpen(false); onOpen(row); }
    }
  }

  const showList = open && enabled && (rows.length > 0 || constellation !== null || query.isFetched);
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';

  return (
    <div ref={rootRef} className="relative w-full">
      <div className="relative">
        <Search className="pointer-events-none absolute left-4 top-1/2 z-10 h-5 w-5 -translate-y-1/2 text-white/60" aria-hidden />
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          aria-label={t('explore.search.label')}
          value={text}
          onChange={e => { setText(e.target.value); setOpen(true); setActive(-1); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={t('explore.search.placeholder')}
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-2xl border border-white/15 bg-black/45 py-4 pl-12 pr-24 text-base text-white placeholder:text-white/50 outline-none backdrop-blur transition focus:border-accent-400 focus:bg-black/60"
        />
        <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-2">
          {query.isFetching && enabled && <Loader2 className="h-4 w-4 animate-spin text-white/60" aria-hidden />}
          {text ? (
            <button
              type="button"
              onClick={() => { setText(''); setActive(-1); input.current?.focus(); }}
              aria-label={t('explore.search.clear')}
              className="rounded-full p-1 text-white/60 transition hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          ) : (
            <kbd className="hidden rounded border border-white/25 px-1.5 py-0.5 text-[0.6875rem] text-white/60 sm:block" aria-hidden>/</kbd>
          )}
        </div>
      </div>

      {showList && (
        <ul
          id={listId}
          role="listbox"
          aria-label={t('explore.search.results')}
          className={`absolute left-0 right-0 top-full z-30 mt-2 max-h-[70vh] overflow-y-auto rounded-2xl border shadow-2xl ${
            isDark ? 'border-slate-700 bg-slate-900 text-slate-100' : 'border-slate-200 bg-white text-slate-900'
          }`}
        >
          {constellation && (
            <li
              id={`${listId}-0`}
              role="option"
              aria-selected={active === 0}
              onMouseEnter={() => setActive(0)}
              onClick={openConstellation}
              className={`flex cursor-pointer items-center gap-3 px-4 py-3 ${active === 0 ? (isDark ? 'bg-slate-800' : 'bg-slate-100') : ''}`}
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-500/15 text-accent-500"><Sparkles className="h-5 w-5" /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{t('explore.search.bestOfConstellation', { name: constellation.name })}</span>
                <span className={`block text-xs ${muted}`}>{t('explore.search.constellationCount', { count: constellation.count })}</span>
              </span>
            </li>
          )}
          {rows.map((row, i) => {
            const idx = i + offset;
            const added = wishlistIds.has(row.id);
            const name = formatObjectName(row.id, row.name);
            return (
              <li
                key={row.id}
                id={`${listId}-${idx}`}
                role="option"
                aria-selected={active === idx}
                onMouseEnter={() => setActive(idx)}
                onClick={() => { setOpen(false); onOpen(row); }}
                className={`flex cursor-pointer items-center gap-3 px-4 py-2.5 ${active === idx ? (isDark ? 'bg-slate-800' : 'bg-slate-100') : ''}`}
              >
                <img
                  src={getCatalogThumbnailUrl(row.id, row.majorAxisArcmin, 96, 96)}
                  alt=""
                  loading="lazy"
                  className="h-10 w-10 shrink-0 rounded-lg bg-slate-950 object-cover"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{name}</span>
                  <span className={`block truncate text-xs ${muted}`}>
                    {[row.designation, ...row.aliases.slice(0, 2), row.constellation].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className="hidden shrink-0 sm:block"><VisibilityChip visibility={row.visibility} isDark={isDark} upLabel={upLabel} /></span>
                <button
                  type="button"
                  disabled={added}
                  onClick={e => { e.stopPropagation(); onAdd(row); }}
                  aria-label={added ? t('explore.card.added') : t('explore.search.addNamed', { name })}
                  title={t('explore.search.addHint')}
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition ${
                    added ? 'bg-emerald-500/15 text-emerald-500' : 'bg-accent-500 text-white hover:bg-accent-600'
                  }`}
                >
                  {added ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                </button>
              </li>
            );
          })}
          {rows.length === 0 && !constellation && (
            <li className={`px-4 py-6 text-center text-sm ${muted}`} role="presentation">{t('explore.search.noResults', { query: debounced })}</li>
          )}
          {total > rows.length && (
            <li role="presentation" className={`border-t ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
              <button type="button" onClick={seeAll} className="w-full px-4 py-3 text-left text-sm font-medium text-accent-500 hover:underline">
                {t('explore.search.seeAll', { count: total })}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
