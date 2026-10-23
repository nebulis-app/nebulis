import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link2, RotateCw, Pencil, Unlink, AlertTriangle } from 'lucide-react';
import {
  getLinkedSources,
  updateLinkedSource,
  rescanLinkedSource,
  unlinkSource,
  type LinkedSource,
  type RescanResult,
} from '../../lib/api/librarySources';
import { formatBytes } from '../../lib/utils';
import { activeLocale } from '../../lib/formatLocale';
import { REFRESH_CHOICES, DEFAULT_REFRESH_MINUTES } from '../../lib/linkRefresh';
import { Modal } from '../ui/Modal';
import { LinkRefreshChoice } from '../ui/LinkRefreshChoice';
import { Sec, getInputClass } from './SettingsUI';

/** The edit dialog's working copy of one source. */
interface EditDraft {
  id: string;
  rootPath: string;
  label: string;
  ongoing: boolean;
  minutes: number;
  /** Set when the last save failed, shown inside the dialog. */
  error: string | null;
}

/**
 * Folders linked in place. Nothing here is a copy: each row is a folder that
 * still lives where the user keeps it, indexed so its objects appear in the
 * library. Rescan picks up changes, edit sets the name and whether the folder
 * refreshes itself on a schedule, and unlink drops the index without touching
 * a single file on disk.
 */
export function LinkedFoldersSection({ isDark }: { isDark: boolean }) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const { data: sources = [], isLoading, error } = useQuery({
    queryKey: ['linked-sources'],
    queryFn: getLinkedSources,
    staleTime: 15_000,
  });

  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, RescanResult>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['linked-sources'] });
    queryClient.invalidateQueries({ queryKey: ['library-objects'] });
  };
  const fail = (err: unknown, fallbackKey: string) =>
    setActionError(err instanceof Error ? err.message : t(fallbackKey));

  const rescan = useMutation({
    mutationFn: (id: string) => rescanLinkedSource(id),
    onMutate: () => setActionError(null),
    onSuccess: (res) => { setResults(prev => ({ ...prev, [res.sourceId]: res })); refresh(); },
    onError: err => fail(err, 'linkedFolders.rescanFailed'),
  });
  const save = useMutation({
    mutationFn: (d: EditDraft) => updateLinkedSource(d.id, {
      label: d.label.trim(),
      refreshIntervalMin: d.ongoing ? d.minutes : null,
    }),
    onSuccess: () => { setDraft(null); refresh(); },
    onError: (err, d) => setDraft(cur => (cur && cur.id === d.id
      ? { ...cur, error: err instanceof Error ? err.message : t('linkedFolders.updateFailed') }
      : cur)),
  });
  const unlink = useMutation({
    mutationFn: (id: string) => unlinkSource(id),
    onMutate: () => setActionError(null),
    onSuccess: () => { setConfirmingId(null); refresh(); },
    onError: err => fail(err, 'linkedFolders.unlinkFailed'),
  });

  const openEdit = (s: LinkedSource) => {
    save.reset();
    setDraft({
      id: s.id,
      rootPath: s.rootPath,
      label: s.label,
      ongoing: s.refreshIntervalMin !== null,
      minutes: s.refreshIntervalMin ?? DEFAULT_REFRESH_MINUTES,
      error: null,
    });
  };

  const btn = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.8125rem] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const neutral = isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-200' : 'bg-slate-100 hover:bg-slate-200 text-slate-700';
  const subtle = isDark ? 'text-slate-400' : 'text-slate-600';
  const faint = isDark ? 'text-slate-500' : 'text-slate-400';

  const summaryOf = (r: RescanResult): string => {
    if (r.offline) return t('linkedFolders.rescanOffline');
    return t('linkedFolders.rescanDone', { added: r.added, updated: r.updated, missing: r.missing, removed: r.removed });
  };
  const scheduleOf = (s: LinkedSource): string => {
    const choice = REFRESH_CHOICES.find(c => c.minutes === s.refreshIntervalMin);
    return choice ? t(choice.labelKey, { ns: 'library' }) : t('linkedFolders.refreshManual');
  };

  return (
    <Sec title={t('linkedFolders.title')} description={t('linkedFolders.description')} isDark={isDark}>
      <div className="px-5 py-5 space-y-4">
        <p className={`text-[0.8125rem] leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
          {t('linkedFolders.explanation')}
        </p>

        {actionError && (
          <div className={`rounded-lg px-3.5 py-3 text-[0.75rem] ${isDark ? 'bg-red-500/10 text-red-200/90' : 'bg-red-50 text-red-900'}`}>
            {actionError}
          </div>
        )}
        {error && (
          <div className={`rounded-lg px-3.5 py-3 text-[0.75rem] ${isDark ? 'bg-red-500/10 text-red-200/90' : 'bg-red-50 text-red-900'}`}>
            {error instanceof Error ? error.message : t('linkedFolders.loadFailed')}
          </div>
        )}

        {isLoading ? (
          <p className={`text-[0.8125rem] ${subtle}`}>{t('linkedFolders.loading')}</p>
        ) : sources.length === 0 ? (
          <p className={`text-[0.8125rem] ${subtle}`}>{t('linkedFolders.empty')}</p>
        ) : (
          <ul className={`rounded-lg border divide-y ${isDark ? 'border-slate-800 divide-slate-800' : 'border-slate-200 divide-slate-100'}`}>
            {sources.map((s: LinkedSource) => {
              const busy = (rescan.isPending && rescan.variables === s.id)
                || (unlink.isPending && unlink.variables === s.id);
              const result = results[s.id];
              return (
                <li key={s.id} className="px-3.5 py-3 space-y-2">
                  <div className="flex items-start gap-3">
                    <Link2 className={`w-4 h-4 mt-0.5 shrink-0 ${faint}`} />
                    <div className="min-w-0 flex-1">
                      <p className={`text-[0.8125rem] font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>{s.label}</p>
                      <p className={`mt-0.5 text-[0.6875rem] font-mono break-all ${faint}`}>{s.rootPath}</p>
                      <p className={`mt-0.5 text-[0.7188rem] ${subtle}`}>
                        {t('linkedFolders.counts', {
                          objects: t('linkedFolders.objectsCount', { count: s.objectCount }),
                          files: t('linkedFolders.filesCount', { count: s.fileCount }),
                          size: formatBytes(s.bytes),
                        })}
                        {' · '}
                        {s.lastScanAt
                          ? t('linkedFolders.lastScan', { when: new Date(s.lastScanAt).toLocaleString(activeLocale()) })
                          : t('linkedFolders.neverScanned')}
                      </p>
                      <p className={`mt-0.5 text-[0.7188rem] ${subtle}`}>
                        {t('linkedFolders.refreshSummary', { value: scheduleOf(s) })}
                      </p>
                      {s.offline && (
                        <p className={`mt-1 inline-flex items-center gap-1.5 text-[0.75rem] ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                          <AlertTriangle className="w-3.5 h-3.5" /> {t('linkedFolders.offline')}
                        </p>
                      )}
                      {s.missingCount > 0 && !s.offline && (
                        <p className={`mt-1 text-[0.75rem] ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                          {t('linkedFolders.missingFiles', { count: s.missingCount })}
                        </p>
                      )}
                      {result && <p className={`mt-1 text-[0.75rem] ${subtle}`}>{summaryOf(result)}</p>}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={() => rescan.mutate(s.id)}
                        disabled={busy}
                        title={t('linkedFolders.rescan')}
                        className={`${btn} ${neutral}`}
                      >
                        <RotateCw className={`w-4 h-4 ${rescan.isPending && rescan.variables === s.id ? 'animate-spin' : ''}`} />
                        <span className="hidden sm:inline">{t('linkedFolders.rescan')}</span>
                      </button>
                      <button
                        onClick={() => openEdit(s)}
                        disabled={busy}
                        title={t('linkedFolders.edit')}
                        aria-label={t('linkedFolders.edit')}
                        className={`${btn} ${neutral}`}
                      ><Pencil className="w-4 h-4" /></button>
                      <button
                        onClick={() => setConfirmingId(s.id)}
                        disabled={busy}
                        title={t('linkedFolders.unlink')}
                        aria-label={t('linkedFolders.unlink')}
                        className={`${btn} ${isDark ? 'bg-red-500/10 hover:bg-red-500/20 text-red-300' : 'bg-red-50 hover:bg-red-100 text-red-700'}`}
                      ><Unlink className="w-4 h-4" /></button>
                    </div>
                  </div>

                  {confirmingId === s.id && (
                    <div className={`rounded-lg px-3.5 py-3 text-[0.75rem] leading-relaxed ${isDark ? 'bg-slate-800 text-slate-300' : 'bg-slate-50 text-slate-700'}`}>
                      <p>{t('linkedFolders.unlinkConfirm')}</p>
                      <div className="mt-2 flex gap-2">
                        <button
                          onClick={() => unlink.mutate(s.id)}
                          disabled={unlink.isPending}
                          className={`${btn} ${isDark ? 'bg-red-500/20 text-red-200 hover:bg-red-500/30' : 'bg-red-600 text-white hover:bg-red-700'}`}
                        >{t('linkedFolders.unlinkConfirmButton')}</button>
                        <button onClick={() => setConfirmingId(null)} className={`${btn} ${neutral}`}>
                          {t('linkedFolders.keepLinked')}
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <p className={`text-[0.75rem] ${faint}`}>{t('linkedFolders.howToLink')}</p>
      </div>

      {draft && (
        <Modal
          isOpen
          onClose={() => { if (!save.isPending) setDraft(null); }}
          title={t('linkedFolders.editTitle')}
          className={`relative w-full max-w-lg max-h-[88vh] flex flex-col rounded-2xl border shadow-2xl ${
            isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
          }`}
        >
          <div className={`px-6 py-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
            <h2 className={`font-display font-semibold text-lg ${isDark ? 'text-white' : 'text-slate-900'}`}>
              {t('linkedFolders.editTitle')}
            </h2>
            <p className={`text-xs mt-0.5 font-mono break-all ${faint}`}>{draft.rootPath}</p>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
            <label className="block">
              <span className={`text-xs font-medium ${subtle}`}>{t('linkedFolders.nameLabel')}</span>
              <input
                value={draft.label}
                maxLength={120}
                disabled={save.isPending}
                onChange={e => setDraft({ ...draft, label: e.target.value, error: null })}
                className={`${getInputClass(isDark)} w-full mt-1`}
              />
            </label>
            <LinkRefreshChoice
              ongoing={draft.ongoing}
              minutes={draft.minutes}
              onOngoingChange={ongoing => setDraft({ ...draft, ongoing, error: null })}
              onMinutesChange={minutes => setDraft({ ...draft, minutes, error: null })}
              isDark={isDark}
              inputCls={getInputClass(isDark)}
              disabled={save.isPending}
            />
          </div>

          <div className={`flex items-center justify-between gap-3 px-6 py-4 border-t ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
            <p className="min-w-0 text-xs text-red-500">{draft.error}</p>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => setDraft(null)} disabled={save.isPending} className={`${btn} ${neutral}`}>
                {t('linkedFolders.cancel')}
              </button>
              <button
                onClick={() => save.mutate(draft)}
                disabled={save.isPending || draft.label.trim().length === 0}
                className={`${btn} bg-accent-500 text-white hover:bg-accent-600`}
              >
                {t('linkedFolders.save')}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </Sec>
  );
}
