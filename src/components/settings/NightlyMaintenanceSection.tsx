import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Play, Info } from 'lucide-react';
import type { Settings as SettingsType } from '../../types';
import { runNightlyMaintenanceNow } from '../../lib/api/settings';
import { formatDate, formatRelativeDuration } from '../../lib/formatLocale';
import { Sec, Toggle } from './SettingsUI';

function formatShortDate(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return formatRelativeDuration(Math.floor(diff / 60_000), 'minute', 'narrow');
  if (diff < 86_400_000) return formatRelativeDuration(Math.floor(diff / 3_600_000), 'hour', 'narrow');
  if (diff < 7 * 86_400_000) return formatRelativeDuration(Math.floor(diff / 86_400_000), 'day', 'narrow');
  return formatDate(new Date(ms), { month: 'short', day: 'numeric', year: '2-digit' });
}

/** The tasks that run each night. Kept in one list so the (i) reveal and the
 *  toggle stay the single source of truth: maintenance on = all of these run.
 *  labelKey/descriptionKey rather than literal text: this array is built at
 *  module load, before any component's useTranslation() hook exists. */
const TASKS = [
  {
    labelKey: 'nightlyMaintenance.tasks.plannerPrefetch.label',
    descriptionKey: 'nightlyMaintenance.tasks.plannerPrefetch.description',
    lastRunKey: 'plannerPrefetchLastRun',
  },
  {
    labelKey: 'nightlyMaintenance.tasks.catalogData.label',
    descriptionKey: 'nightlyMaintenance.tasks.catalogData.description',
    lastRunKey: null,
  },
  {
    labelKey: 'nightlyMaintenance.tasks.housekeeping.label',
    descriptionKey: 'nightlyMaintenance.tasks.housekeeping.description',
    lastRunKey: 'nightlyHousekeepingLastRun',
  },
  {
    labelKey: 'nightlyMaintenance.tasks.forecast.label',
    descriptionKey: 'nightlyMaintenance.tasks.forecast.description',
    lastRunKey: 'nightlyForecastLastRun',
  },
] as const satisfies ReadonlyArray<{
  labelKey: string;
  descriptionKey: string;
  /** A Settings field holding the task's last-run epoch ms, or null if none. */
  lastRunKey: { [K in keyof SettingsType]: SettingsType[K] extends number | null ? K : never }[keyof SettingsType] | null;
}>;

export function NightlyMaintenanceSection({
  isDark,
  form,
  setForm,
}: {
  isDark: boolean;
  form: Partial<SettingsType>;
  setForm: React.Dispatch<React.SetStateAction<Partial<SettingsType>>>;
}) {
  const { t } = useTranslation('settings');
  const time = form.plannerPrefetchTime ?? '03:00';
  // One master switch gates the whole batch server-side. On means every task
  // runs; off means none do (and the scheduler no-ops).
  const maintenanceEnabled = form.nightlyMaintenanceEnabled ?? true;

  const [showTasks, setShowTasks] = useState(false);

  const queryClient = useQueryClient();
  const [justStarted, setJustStarted] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timerRef.current.forEach(clearTimeout), []);

  const runNow = useMutation({
    mutationFn: runNightlyMaintenanceNow,
    onSuccess: () => {
      // The batch runs in the background. Show a brief confirmation, then
      // refetch settings so the quick tasks' last-run times update.
      setJustStarted(true);
      timerRef.current.push(setTimeout(() => setJustStarted(false), 4000));
      timerRef.current.push(setTimeout(() => queryClient.invalidateQueries({ queryKey: ['settings'] }), 5000));
    },
  });

  const setMaintenance = (v: boolean) => {
    setForm(f => ({ ...f, nightlyMaintenanceEnabled: v }));
  };

  return (
    <Sec
      title={t('nightlyMaintenance.title')}
      description={t('nightlyMaintenance.description')}
      isDark={isDark}
    >
      {/* Master toggle. The (i) reveals the task list below; there are no
          per-task toggles — everything runs whenever maintenance is on. */}
      <div
        className={`grid grid-cols-1 md:grid-cols-[minmax(220px,2fr)_minmax(0,1fr)] gap-4 md:gap-8 px-5 py-3.5 ${
          showTasks || maintenanceEnabled ? 'border-b' : ''
        } ${isDark ? 'border-slate-800/70' : 'border-slate-100'}`}
      >
        <div className="min-w-0 flex items-center gap-1.5">
          <div className={`text-[0.8125rem] font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
            {t('nightlyMaintenance.runNightly')}
          </div>
          <button
            type="button"
            aria-label={t('nightlyMaintenance.seeWhichTasks')}
            aria-expanded={showTasks}
            onClick={() => setShowTasks(s => !s)}
            className={`flex items-center justify-center w-4 h-4 rounded-full transition-colors ${
              isDark ? 'text-slate-600 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            <Info className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="min-w-0 flex items-center justify-start md:justify-end">
          <Toggle checked={maintenanceEnabled} onChange={setMaintenance} />
        </div>
      </div>

      {showTasks && (
        <div
          className={`px-5 py-4 ${
            maintenanceEnabled ? 'border-b' : ''
          } ${isDark ? 'border-slate-800/70 bg-slate-950/40' : 'border-slate-100 bg-slate-50/70'}`}
        >
          <div className={`text-[0.625rem] font-semibold uppercase tracking-[0.1em] mb-2 ${
            isDark ? 'text-slate-500' : 'text-slate-400'
          }`}>
            {t('nightlyMaintenance.runsEachNight')}
          </div>
          <ul className="space-y-2.5">
            {TASKS.map(task => {
              const lastRun = task.lastRunKey ? form[task.lastRunKey] ?? null : null;
              return (
                <li key={task.labelKey} className="flex items-start gap-2.5">
                  <span className={`mt-1 h-1 w-1 shrink-0 rounded-full ${isDark ? 'bg-accent-400' : 'bg-accent-500'}`} />
                  <div className="min-w-0">
                    <div className={`text-[0.8125rem] font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                      {t(task.labelKey)}
                    </div>
                    <div className={`text-xs mt-0.5 leading-relaxed ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                      {t(task.descriptionKey)}
                      {lastRun !== null && (
                        <span className={`ml-1.5 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                          {t('nightlyMaintenance.lastRun', { time: formatShortDate(lastRun) })}
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {maintenanceEnabled && (
        <div className="px-5 py-4 flex items-center gap-3 flex-wrap">
            <label className={`text-xs font-medium ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
              {t('nightlyMaintenance.runAt')}
            </label>
            <input
              type="time"
              value={time}
              onChange={e => setForm(f => ({ ...f, plannerPrefetchTime: e.target.value }))}
              className={`text-xs rounded-lg border px-2 py-1 font-mono tabular-nums ${
                isDark
                  ? 'bg-slate-800 border-slate-700 text-slate-200'
                  : 'bg-white border-slate-200 text-slate-700'
              }`}
            />
            <span className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {t('nightlyMaintenance.localTime')}
            </span>

            <button
              type="button"
              onClick={() => runNow.mutate()}
              disabled={runNow.isPending}
              className={`ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                isDark
                  ? 'border-slate-700 text-slate-200 hover:bg-slate-800'
                  : 'border-slate-200 text-slate-700 hover:bg-slate-50'
              } disabled:opacity-50`}
              title={t('nightlyMaintenance.runNowTitle')}
            >
              <Play className="w-3 h-3" />
              {runNow.isPending ? t('nightlyMaintenance.starting') : t('nightlyMaintenance.runNow')}
            </button>

          {justStarted && (
            <span className={`text-xs w-full ${isDark ? 'text-accent-400' : 'text-accent-600'}`}>
              {t('nightlyMaintenance.started')}
            </span>
          )}
          {runNow.isError && (
            <span className={`text-xs w-full ${isDark ? 'text-red-400' : 'text-red-600'}`}>
              {runNow.error instanceof Error ? runNow.error.message : t('nightlyMaintenance.startFailed')}
            </span>
          )}
        </div>
      )}
    </Sec>
  );
}
