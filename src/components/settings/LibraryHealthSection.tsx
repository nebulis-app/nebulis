import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Stethoscope } from 'lucide-react';
import {
  analyzeLibrary,
  repairLibrary,
  getRenestStatus,
  startRenest,
  type LibraryAnalysis,
  type RepairCategory,
} from '../../lib/api/storage';
import { Sec } from './SettingsUI';

/**
 * Library health: an on-demand scan for records that no longer match the disk.
 * Scanning changes nothing; every finding has its own repair button, so the
 * user chooses what to touch. Deliberately not automatic, since it walks the
 * whole library.
 */
export function LibraryHealthSection({ isDark }: { isDark: boolean }) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const [result, setResult] = useState<LibraryAnalysis | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fail = (err: unknown) => setError(err instanceof Error ? err.message : t('libraryHealth.failed'));

  const scan = useMutation({
    mutationFn: analyzeLibrary,
    onMutate: () => { setError(null); setNotice(null); },
    onSuccess: setResult,
    onError: fail,
  });

  const repair = useMutation({
    mutationFn: (c: RepairCategory) => repairLibrary(c),
    onMutate: () => { setError(null); setNotice(null); },
    onSuccess: async res => {
      const n = res.removed ?? res.retired ?? res.fixed ?? 0;
      setNotice(t('libraryHealth.repaired', { count: n }));
      for (const key of ['library-cleanup', 'library-objects', 'storage', 'all-library-images']) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
      scan.mutate();
    },
    onError: fail,
  });

  // Same status the upgrade prompt polls, so a run started from either place shows here.
  const { data: renest, refetch: refetchRenest } = useQuery({
    queryKey: ['library-renest'],
    queryFn: getRenestStatus,
    enabled: result !== null,
    refetchInterval: q => (q.state.data?.renest.running ? 1000 : false),
  });
  const renestRunning = renest?.renest.running ?? false;
  const startReorg = useMutation({
    mutationFn: () => startRenest(),
    onMutate: () => setError(null),
    onSuccess: () => { void refetchRenest(); },
    onError: fail,
  });

  const subtle = isDark ? 'text-slate-400' : 'text-slate-600';
  const busy = scan.isPending || repair.isPending;
  const btn = `px-3 py-1.5 rounded-lg text-[0.7812rem] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
    isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-200' : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
  }`;

  const row = (key: string, title: string, detail: string, count: number, action?: { label: string; run: () => void; disabled?: boolean }) => (
    <li key={key} className="flex items-center gap-3 px-3.5 py-3">
      {count === 0
        ? <CheckCircle2 className={`w-4 h-4 shrink-0 ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`} />
        : <span className={`w-4 h-4 shrink-0 rounded-full text-[0.625rem] font-bold flex items-center justify-center ${isDark ? 'bg-amber-500/20 text-amber-300' : 'bg-amber-100 text-amber-800'}`}>!</span>}
      <div className="min-w-0 flex-1">
        <div className={`text-[0.8125rem] font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
          {title} <span className={`tabular-nums ${subtle}`}>· {count.toLocaleString()}</span>
        </div>
        <div className={`text-[0.7188rem] ${subtle}`}>{detail}</div>
      </div>
      {count > 0 && action && (
        <button onClick={action.run} disabled={busy || action.disabled} className={btn}>{action.label}</button>
      )}
    </li>
  );

  return (
    <Sec
      title={t('libraryHealth.title')}
      description={t('libraryHealth.description')}
      isDark={isDark}
      actions={
        <button onClick={() => scan.mutate()} disabled={busy} className={`${btn} inline-flex items-center gap-2`}>
          <Stethoscope className="w-4 h-4" />
          {scan.isPending ? t('libraryHealth.scanning') : result ? t('libraryHealth.rescan') : t('libraryHealth.scan')}
        </button>
      }
    >
      <div className="px-5 py-5 space-y-4">
        {notice && (
          <div className={`rounded-lg px-3.5 py-3 text-[0.75rem] ${isDark ? 'bg-emerald-500/10 text-emerald-200/90' : 'bg-emerald-50 text-emerald-900'}`}>{notice}</div>
        )}
        {error && (
          <div className={`rounded-lg px-3.5 py-3 text-[0.75rem] ${isDark ? 'bg-red-500/10 text-red-200/90' : 'bg-red-50 text-red-900'}`}>{error}</div>
        )}
        {!result ? (
          <p className={`text-[0.8125rem] ${subtle}`}>{t('libraryHealth.intro')}</p>
        ) : (
          <>
            <ul className={`rounded-lg border divide-y ${isDark ? 'border-slate-800 divide-slate-800' : 'border-slate-200 divide-slate-100'}`}>
              {row('stale', t('libraryHealth.stale.title'),
                t('libraryHealth.stale.detail', { objects: result.staleRecords.objects }),
                result.staleRecords.count,
                { label: t('libraryHealth.stale.fix'), run: () => repair.mutate('staleRecords'), disabled: result.unreadable > 0 })}
              {row('processed', t('libraryHealth.processed.title'),
                t('libraryHealth.processed.detail', { objects: result.missingProcessed.objects }),
                result.missingProcessed.count,
                { label: t('libraryHealth.processed.fix'), run: () => repair.mutate('missingProcessed'), disabled: result.unreadable > 0 })}
              {row('missing', t('libraryHealth.missing.title'), t('libraryHealth.missing.detail'),
                result.missingObjectCount,
                { label: t('libraryHealth.missing.fix'), run: () => repair.mutate('missingObjects'), disabled: result.unreadable > 0 })}
              {row('drift', t('libraryHealth.drift.title'), t('libraryHealth.drift.detail'),
                result.layoutDrift,
                { label: t('libraryHealth.drift.fix'), run: () => repair.mutate('layoutDrift') })}
              {row('duplicates', t('libraryHealth.duplicates.title'),
                t('libraryHealth.duplicates.detail', { objects: result.duplicateFiles.objects }),
                result.duplicateFiles.count,
                { label: t('libraryHealth.duplicates.fix'), run: () => repair.mutate('duplicateFiles') })}
              {row('flat', t('libraryHealth.flat.title'),
                renestRunning && renest
                  ? t('libraryHealth.flat.progress', { done: renest.renest.objectsDone, total: renest.renest.objectsTotal })
                  : t('libraryHealth.flat.detail'),
                result.flatObjects,
                { label: t('libraryHealth.flat.fix'), run: () => startReorg.mutate(), disabled: renestRunning })}
            </ul>
            {result.missingObjects.length > 0 && (
              <p className={`text-[0.7188rem] ${subtle}`}>
                {t('libraryHealth.missing.list', { names: result.missingObjects.map(o => o.objectId).join(', ') })}
              </p>
            )}
            {result.unreadable > 0 && (
              <div className={`rounded-lg px-3.5 py-3 text-[0.75rem] ${isDark ? 'bg-amber-500/10 text-amber-200/90' : 'bg-amber-50 text-amber-900'}`}>
                {t('libraryHealth.unreadable', { count: result.unreadable })}
              </div>
            )}
            <p className={`text-[0.7188rem] ${subtle}`}>{t('libraryHealth.note')}</p>
          </>
        )}
      </div>
    </Sec>
  );
}
