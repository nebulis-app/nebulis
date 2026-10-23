import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';
import { SETTINGS_SEARCH_INDEX } from './settingsSearchIndex';
import { visibleSettingsNav } from './settingsNavItems';

export interface SettingsSearchTarget {
  group: string;
  section?: string;
  /** Row/section label to scroll to and flash once the pane has rendered. */
  label: string;
}

interface Result extends SettingsSearchTarget {
  key: string;
  trail: string;
}

const MAX_RESULTS = 8;

/** Lowercase and strip accents so "elevation" finds "Élévation". */
function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

interface Props {
  isDark: boolean;
  isAdmin: boolean;
  onSelect: (target: SettingsSearchTarget) => void;
}

/** Find-a-setting box. Matches the label of every setting (plus a few
 *  synonyms) and jumps to its pane. Rendered twice by SettingsNav, once in the
 *  desktop sidebar and once above the mobile tab strip, so `/` focuses
 *  whichever instance is actually on screen. */
export function SettingsSearch({ isDark, isAdmin, onSelect }: Props) {
  const { t } = useTranslation('settings');
  const { t: tCommon } = useTranslation('common');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  // Built per render of the language/role, not per keystroke.
  const entries = useMemo(() => {
    const nav = visibleSettingsNav(isAdmin);
    return SETTINGS_SEARCH_INDEX.flatMap(e => {
      const group = nav.find(g => g.id === e.group);
      if (!group) return [];
      const item = e.section ? group.items?.find(i => i.id === e.section) : undefined;
      // A section filtered out for this role (e.g. Users for a non-admin) hides its entries.
      if (e.section && group.items && !item) return [];
      const label = e.ns === 'common' ? tCommon(e.labelKey) : t(e.labelKey);
      const groupLabel = t(group.labelKey);
      const trail = item && group.items!.length > 1 ? `${groupLabel} › ${t(item.labelKey)}` : groupLabel;
      return [{
        key: `${e.group}/${e.section ?? ''}/${e.labelKey}`,
        group: e.group,
        section: e.section,
        label,
        trail,
        haystack: normalize(`${label} ${trail} ${e.keywords ?? ''}`),
        normLabel: normalize(label),
      }];
    });
  }, [isAdmin, t, tCommon]);

  const results: Result[] = useMemo(() => {
    const tokens = normalize(query).split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [];
    return entries
      .filter(e => tokens.every(tok => e.haystack.includes(tok)))
      .map(e => ({ e, rank: e.normLabel.startsWith(tokens[0]) ? 0 : e.normLabel.includes(tokens[0]) ? 1 : 2 }))
      .sort((a, b) => a.rank - b.rank)
      .slice(0, MAX_RESULTS)
      .map(({ e }) => ({ key: e.key, group: e.group, section: e.section, label: e.label, trail: e.trail }));
  }, [entries, query]);

  // `/` focuses the search box, like GitHub. Skipped while typing in a field
  // and for the hidden instance (offsetParent is null under `display: none`).
  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key !== '/' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const el = document.activeElement;
      if (el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      const input = inputRef.current;
      if (!input || input.offsetParent === null) return;
      ev.preventDefault();
      input.focus();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(ev: PointerEvent) {
      if (!rootRef.current?.contains(ev.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function choose(r: Result) {
    onSelect({ group: r.group, section: r.section, label: r.label });
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
  }

  function onKeyDown(ev: React.KeyboardEvent<HTMLInputElement>) {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      setOpen(true);
      setCursor(c => Math.min(c + 1, results.length - 1));
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      setCursor(c => Math.max(c - 1, 0));
    } else if (ev.key === 'Enter' && results[cursor]) {
      ev.preventDefault();
      choose(results[cursor]);
    } else if (ev.key === 'Escape') {
      if (query) setQuery('');
      else inputRef.current?.blur();
      setOpen(false);
    }
  }

  const showPanel = open && query.trim().length > 0;

  return (
    <div ref={rootRef} className="relative">
      <div className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 transition-colors focus-within:ring-2 focus-within:ring-accent-500/40 ${
        isDark ? 'border-slate-800 bg-slate-900 text-slate-400' : 'border-slate-200 bg-white text-slate-500'
      }`}>
        <Search className="w-3.5 h-3.5 shrink-0" aria-hidden />
        <input
          ref={inputRef}
          value={query}
          onChange={ev => { setQuery(ev.target.value); setCursor(0); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={showPanel}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label={t('search.label')}
          placeholder={t('search.placeholder')}
          className={`min-w-0 flex-1 bg-transparent text-[0.8125rem] outline-none ${
            isDark ? 'text-slate-200 placeholder:text-slate-600' : 'text-slate-800 placeholder:text-slate-400'
          }`}
        />
        {query ? (
          <button
            type="button"
            onClick={() => { setQuery(''); inputRef.current?.focus(); }}
            aria-label={t('search.clear')}
            className="shrink-0 rounded p-0.5 hover:text-accent-500"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        ) : (
          <kbd className={`hidden lg:block shrink-0 rounded border px-1.5 text-[0.625rem] font-medium ${
            isDark ? 'border-slate-700 text-slate-600' : 'border-slate-200 text-slate-400'
          }`}>/</kbd>
        )}
      </div>

      {showPanel && (
        <ul
          id={listId}
          role="listbox"
          className={`absolute left-0 right-0 z-40 mt-1.5 max-h-80 overflow-y-auto rounded-xl border py-1 shadow-xl ${
            isDark ? 'border-slate-700 bg-slate-900' : 'border-slate-200 bg-white'
          }`}
        >
          {results.length === 0 ? (
            <li className={`px-3 py-2.5 text-[0.8125rem] ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
              {t('search.noResults')}
            </li>
          ) : results.map((r, i) => (
            <li key={r.key} role="option" aria-selected={i === cursor}>
              <button
                type="button"
                onClick={() => choose(r)}
                onMouseEnter={() => setCursor(i)}
                className={`block w-full px-3 py-2 text-left ${
                  i === cursor ? (isDark ? 'bg-slate-800' : 'bg-slate-100') : ''
                }`}
              >
                <span className={`block text-[0.8125rem] font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>{r.label}</span>
                <span className={`block text-[0.7188rem] ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>{r.trail}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
