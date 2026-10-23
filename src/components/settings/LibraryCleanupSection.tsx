import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { getCleanupUsage, purgeAllSubframes } from '../../lib/api/storage';
import { formatBytes } from '../../lib/utils';
import { Sec } from './SettingsUI';
import { LibraryHealthSection } from './LibraryHealthSection';

/**
 * What the library's removable extras cost in disk space, with a one-click purge.
 * Sub-frames are the only category so far; each new one gets its own Sec.
 */
export function LibraryCleanupSection({ isDark }: { isDark: boolean }) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['library-cleanup'],
    queryFn: getCleanupUsage,
    staleTime: 15_000,
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const usage = data?.subframes;

  const purge = useMutation({
    mutationFn: purgeAllSubframes,
    onMutate: () => { setNotice(null); setError(null); },
    onSuccess: res => {
      setNotice(t('libraryCleanup.done', { count: res.deleted, size: formatBytes(res.freedBytes) })
        + (res.staleRemoved > 0 ? ' ' + t('libraryCleanup.staleRemoved', { count: res.staleRemoved }) : ''));
      // Sizes change on every surface that shows files or storage.
      for (const key of ['library-cleanup', 'library-objects', 'storage']) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
    onError: err => setError(err instanceof Error ? err.message : t('libraryCleanup.failed')),
  });

  const onPurge = () => {
    if (!usage) return;
    if (usage.files === 0) { purge.mutate(); return; }
    if (!window.confirm(t('libraryCleanup.confirm', { count: usage.files, size: formatBytes(usage.bytes) }))) return;
    purge.mutate();
  };

  const subtle = isDark ? 'text-slate-400' : 'text-slate-600';
  const strong = isDark ? 'text-slate-100' : 'text-slate-900';
  const stat = (label: string, value: string) => (
    <div className={`rounded-xl px-4 py-3 ${isDark ? 'bg-slate-800/60' : 'bg-slate-50'}`}>
      <div className={`text-[0.6875rem] uppercase tracking-wide ${subtle}`}>{label}</div>
      <div className={`mt-0.5 text-xl font-semibold tabular-nums ${strong}`}>{value}</div>
    </div>
  );

  return (
    <>
    <Sec
      title={t('libraryCleanup.subframesTitle')}
      description={t('libraryCleanup.subframesDescription')}
      isDark={isDark}
    >
      <div className="px-5 py-5 space-y-4">
        {notice && (
          <div className={`rounded-lg px-3.5 py-3 text-[0.75rem] ${isDark ? 'bg-emerald-500/10 text-emerald-200/90' : 'bg-emerald-50 text-emerald-900'}`}>
            {notice}
          </div>
        )}
        {error && (
          <div className={`rounded-lg px-3.5 py-3 text-[0.75rem] ${isDark ? 'bg-red-500/10 text-red-200/90' : 'bg-red-50 text-red-900'}`}>
            {error}
          </div>
        )}

        {isLoading || !usage ? (
          <p className={`text-[0.8125rem] ${subtle}`}>{t('libraryCleanup.loading')}</p>
        ) : usage.files === 0 ? (
          <p className={`text-[0.8125rem] ${subtle}`}>{t('libraryCleanup.none')}</p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3">
              {stat(t('libraryCleanup.spaceUsed'), formatBytes(usage.bytes))}
              {stat(t('libraryCleanup.files'), usage.files.toLocaleString())}
              {stat(t('libraryCleanup.objects'), usage.objects.toLocaleString())}
            </div>

            <div>
              <div className={`mb-1.5 text-[0.6875rem] uppercase tracking-wide ${subtle}`}>
                {t('libraryCleanup.largest')}
              </div>
              <ul className={`rounded-lg border divide-y ${isDark ? 'border-slate-800 divide-slate-800' : 'border-slate-200 divide-slate-100'}`}>
                {usage.topObjects.map(o => (
                  <li key={o.objectId} className="flex items-center gap-3 px-3.5 py-2.5 text-[0.8125rem]">
                    <span className={`min-w-0 flex-1 truncate font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                      {o.objectId}
                    </span>
                    <span className={`text-[0.75rem] ${subtle}`}>
                      {t('libraryCleanup.fileCount', { count: o.files })}
                    </span>
                    <span className={`w-20 text-right tabular-nums ${strong}`}>{formatBytes(o.bytes)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}

        {usage && usage.staleRecords > 0 && (
          <div className={`rounded-lg px-3.5 py-3 text-[0.75rem] leading-relaxed ${isDark ? 'bg-amber-500/10 text-amber-200/90' : 'bg-amber-50 text-amber-900'}`}>
            {t('libraryCleanup.stale', { count: usage.staleRecords })}
          </div>
        )}

        <p className={`text-[0.75rem] leading-relaxed ${subtle}`}>{t('libraryCleanup.note')}</p>

        <button
          onClick={onPurge}
          disabled={purge.isPending || !usage || (usage.files === 0 && usage.staleRecords === 0)}
          className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-[0.8125rem] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
            isDark ? 'bg-red-500/10 hover:bg-red-500/20 text-red-300' : 'bg-red-50 hover:bg-red-100 text-red-700'
          }`}
        >
          <Trash2 className="w-4 h-4" />
          {purge.isPending ? t('libraryCleanup.purging') : t('libraryCleanup.purge')}
        </button>
      </div>
    </Sec>
    <LibraryHealthSection isDark={isDark} />
    </>
  );
}
