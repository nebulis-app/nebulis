import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getRenestStatus, startRenest } from '../../lib/api/storage';
import { useAuth } from '../../contexts/AuthContext';
import { useWhatsNewGate } from '../../contexts/WhatsNewGateContext';
import { useTheme } from '../../hooks/useTheme';
import { Modal } from '../ui/Modal';

const DISMISSED_KEY = 'nebulis-layout-migration-dismissed';

function readDismissed(): boolean {
  try { return sessionStorage.getItem(DISMISSED_KEY) === '1'; } catch { return false; }
}

function writeDismissed(): void {
  try { sessionStorage.setItem(DISMISSED_KEY, '1'); } catch { /* the prompt just returns on the next load */ }
}

/**
 * One-time upgrade prompt for libraries still in the old flat layout.
 *
 * There is no "done" flag to keep in sync: an object is converted when its
 * `layout` column says `nested`, and the server counts the ones that are not.
 * Once that count reaches zero the prompt has nothing to show, on every device,
 * and a fresh install (all objects created nested) never sees it. An object
 * that fails to convert stays flat, so the prompt returns next session.
 *
 * "Remind me later" only lasts for the browser session, on purpose: a library
 * left half-converted keeps renaming files on every import.
 *
 * Waits for the What's New popup to settle so the two never stack.
 */
export function LayoutMigrationPrompt() {
  const { t } = useTranslation('settings');
  const { isDark } = useTheme();
  const { isAdmin } = useAuth();
  const { settled: whatsNewSettled } = useWhatsNewGate();
  const queryClient = useQueryClient();

  const [dismissed, setDismissed] = useState(readDismissed);
  // True once the user pressed the button in this tab. Gates the result panel,
  // because the server keeps the last run's summary in memory and it would
  // otherwise greet the next page load with an old "done".
  const [started, setStarted] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, refetch } = useQuery({
    queryKey: ['library-renest'],
    queryFn: getRenestStatus,
    enabled: isAdmin && whatsNewSettled && !dismissed,
    staleTime: 60_000,
    // Poll only while a run is in flight so progress stays live.
    refetchInterval: q => (q.state.data?.renest.running ? 750 : false),
  });

  const status = data?.renest;
  const flatObjects = data?.flatObjects ?? 0;
  const running = status?.running ?? false;
  const summary = status?.summary ?? null;

  // File paths moved, so anything holding a library path is stale.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) {
      void queryClient.invalidateQueries({ queryKey: ['library'] });
      void queryClient.invalidateQueries({ queryKey: ['observations'] });
      void queryClient.invalidateQueries({ queryKey: ['gallery'] });
    }
    wasRunning.current = running;
  }, [running, queryClient]);

  const run = async () => {
    if (starting || running) return;
    setStarting(true);
    setError(null);
    try {
      await startRenest();
      setStarted(true);
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('layoutMigration.startFailed'));
    } finally {
      setStarting(false);
    }
  };

  const dismiss = () => {
    writeDismissed();
    setDismissed(true);
  };

  const phase: 'intro' | 'running' | 'done' | 'failed' = running
    ? 'running'
    : started && summary
      ? (summary.failed > 0 ? 'failed' : 'done')
      : 'intro';

  const open = isAdmin && whatsNewSettled && !dismissed && (phase !== 'intro' || flatObjects > 0);
  if (!open) return null;

  const progressPct = status && status.objectsTotal > 0
    ? Math.round((status.objectsDone / status.objectsTotal) * 100)
    : 0;

  const title = phase === 'done'
    ? t('layoutMigration.doneTitle')
    : phase === 'failed'
      ? t('layoutMigration.failedTitle')
      : t('layoutMigration.title');

  const text = isDark ? 'text-slate-300' : 'text-slate-600';
  const btn = 'px-4 py-2 rounded-xl text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed';
  const primary = `${btn} bg-accent-500 text-white hover:bg-accent-600`;
  const secondary = `${btn} ${isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'}`;

  return (
    <Modal
      isOpen
      // A run in flight must not be walked away from by an Escape press.
      onClose={() => { if (phase !== 'running') dismiss(); }}
      title={title}
      className={`rounded-2xl border p-6 w-full max-w-md shadow-2xl mx-4 ${
        isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'
      }`}
    >
      <h2 className={`text-base font-semibold mb-3 ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
        {title}
      </h2>

      {phase === 'intro' && (
        <div className={`space-y-3 text-sm leading-relaxed ${text}`}>
          <p>{t('layoutMigration.intro')}</p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li>{t('layoutMigration.pointMoved')}</li>
            <li>{t('layoutMigration.pointNames')}</li>
            <li>{t('layoutMigration.pointWait')}</li>
          </ul>
          <p className={`text-[0.8125rem] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            {t('layoutMigration.countInfo', { count: flatObjects })}
          </p>
          {error && (
            <p role="alert" className={`text-[0.8125rem] ${isDark ? 'text-red-300' : 'text-red-700'}`}>{error}</p>
          )}
          <div className="flex flex-col gap-2 pt-2">
            <button onClick={run} disabled={starting} className={primary}>
              {starting ? t('layoutMigration.starting') : t('layoutMigration.start')}
            </button>
            <button onClick={dismiss} disabled={starting} className={secondary}>
              {t('layoutMigration.later')}
            </button>
          </div>
        </div>
      )}

      {phase === 'running' && status && (
        <div className="space-y-3" role="status" aria-live="polite">
          <p className={`text-sm ${text}`}>
            {t('layoutMigration.progress', { done: status.objectsDone, total: status.objectsTotal })}
            {status.currentObject ? t('layoutMigration.progressCurrent', { name: status.currentObject }) : ''}
          </p>
          <div className={`h-2 rounded-full overflow-hidden ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`}>
            <div className="h-full bg-accent-500 transition-all duration-300" style={{ width: `${progressPct}%` }} />
          </div>
          <p className={`text-[0.8125rem] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            {t('layoutMigration.pointWait')}
          </p>
        </div>
      )}

      {phase === 'done' && summary && (
        <div className="space-y-4">
          <p className={`text-sm leading-relaxed ${text}`}>
            {t('layoutMigration.doneBody', { count: summary.moved })}
          </p>
          <button onClick={dismiss} className={`${primary} w-full`}>{t('layoutMigration.close')}</button>
        </div>
      )}

      {phase === 'failed' && summary && (
        <div className="space-y-4">
          <p className={`text-sm leading-relaxed ${text}`}>
            {t('layoutMigration.failedBody', { count: summary.failed })}
          </p>
          <div className="flex flex-col gap-2">
            <button onClick={run} disabled={starting} className={primary}>
              {starting ? t('layoutMigration.starting') : t('layoutMigration.tryAgain')}
            </button>
            <button onClick={dismiss} className={secondary}>{t('layoutMigration.close')}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
