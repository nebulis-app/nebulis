import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X, Loader2, ArrowRight } from 'lucide-react';
import { getFilterAliases, saveFilterAliases, type FilterAlias } from '../../lib/api/library';
import { useAuth } from '../../contexts/AuthContext';
import { Sec } from './SettingsUI';

/**
 * Filter name aliases for integration per filter: lets the user merge names
 * the capture software wrote differently ("H-alpha 7nm", "Ha7") into one
 * filter. Saved on its own button rather than through the page-wide settings
 * form, since aliases live in their own table, not in Settings.
 */
export function FilterAliasesSection({ isDark }: { isDark: boolean }) {
  const { t } = useTranslation('settings');
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();

  const { data: saved = [], isLoading } = useQuery({
    queryKey: ['filter-aliases'],
    queryFn: getFilterAliases,
  });

  const [drafts, setDrafts] = useState<(FilterAlias & { key: string })[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows = drafts ?? saved.map((a, i) => ({ ...a, key: `saved-${i}` }));
  const dirty = drafts !== null;

  const update = (i: number, patch: Partial<FilterAlias>) => {
    setDrafts(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };

  const save = async () => {
    if (!drafts || saving) return;
    setSaving(true);
    setError(null);
    try {
      await saveFilterAliases(
        drafts
          .map(({ alias, canonical }) => ({ alias: alias.trim(), canonical: canonical.trim() }))
          .filter(a => a.alias && a.canonical),
      );
      await queryClient.invalidateQueries({ queryKey: ['filter-aliases'] });
      await queryClient.invalidateQueries({ queryKey: ['integration-by-filter'] });
      await queryClient.invalidateQueries({ queryKey: ['integration-progress'] });
      setDrafts(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('librarySection.filterAliases.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const inputCls = `min-w-0 flex-1 px-3 py-2 rounded-lg border text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/30 disabled:opacity-60 ${
    isDark ? 'bg-slate-800/80 border-slate-700/80 text-slate-200 placeholder-slate-600' : 'bg-white border-slate-200 text-slate-800 placeholder-slate-400'
  }`;
  const buttonCls = `inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-lg transition disabled:opacity-50 ${
    isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
  }`;
  const muted = isDark ? 'text-slate-500' : 'text-slate-400';

  return (
    <Sec
      title={t('librarySection.filterAliases.title')}
      description={t('librarySection.filterAliases.description')}
      isDark={isDark}
    >
      <div className="p-4 space-y-2">
        {!isLoading && rows.length === 0 && (
          <p className={`text-sm ${muted}`}>{t('librarySection.filterAliases.empty')}</p>
        )}
        {rows.map((r, i) => (
          <div key={r.key} className="flex items-center gap-2">
            <input
              type="text"
              value={r.alias}
              maxLength={64}
              disabled={!isAdmin}
              placeholder={t('librarySection.filterAliases.aliasPlaceholder')}
              aria-label={t('librarySection.filterAliases.aliasPlaceholder')}
              onChange={e => update(i, { alias: e.target.value })}
              className={inputCls}
            />
            <ArrowRight className={`w-4 h-4 shrink-0 ${muted}`} />
            <input
              type="text"
              value={r.canonical}
              maxLength={64}
              disabled={!isAdmin}
              placeholder={t('librarySection.filterAliases.canonicalPlaceholder')}
              aria-label={t('librarySection.filterAliases.canonicalPlaceholder')}
              onChange={e => update(i, { canonical: e.target.value })}
              className={inputCls}
            />
            {isAdmin && (
              <button
                type="button"
                onClick={() => setDrafts(rows.filter((_, j) => j !== i))}
                className={`p-1.5 rounded-lg shrink-0 ${isDark ? 'text-slate-500 hover:bg-slate-800' : 'text-slate-400 hover:bg-slate-100'}`}
                aria-label={t('librarySection.filterAliases.remove')}
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        ))}
        {error && <p className={`text-xs ${isDark ? 'text-red-400' : 'text-red-600'}`}>{error}</p>}
        {isAdmin && (
          <div className="flex items-center gap-2 pt-2">
            <button
              type="button"
              onClick={() => setDrafts([...rows, { alias: '', canonical: '', key: `new-${Date.now()}` }])}
              className={buttonCls}
            >
              <Plus className="w-3.5 h-3.5" />
              {t('librarySection.filterAliases.add')}
            </button>
            <div className="flex-1" />
            {dirty && (
              <>
                <button type="button" onClick={() => { setDrafts(null); setError(null); }} disabled={saving} className={buttonCls}>
                  {t('librarySection.filterAliases.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={saving}
                  className="inline-flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-lg bg-accent-500 text-white hover:bg-accent-600 transition disabled:opacity-50"
                >
                  {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {t('librarySection.filterAliases.save')}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </Sec>
  );
}
