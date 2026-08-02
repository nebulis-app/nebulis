import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import type { Settings as SettingsType } from '../../types';
import { runNightlyMaintenanceNow } from '../../lib/api/settings';
import { Sec, Row, Toggle } from './SettingsUI';

function formatShortDate(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

interface TaskRowProps {
  isDark: boolean;
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  lastRun: number | null;
}

/** One maintenance task, as a standard settings row. The per-task icon was
 *  dropped along with the nested card: four icons in a column read as a legend
 *  the reader has to decode, and none of them named anything the label did not
 *  already say. */
function TaskRow({ isDark, label, description, checked, onChange, lastRun }: TaskRowProps) {
  return (
    <Row
      label={label}
      description={lastRun !== null ? `${description} Last run ${formatShortDate(lastRun)}.` : description}
      isDark={isDark}
    >
      <Toggle checked={checked} onChange={onChange} />
    </Row>
  );
}

export function NightlyMaintenanceSection({
  isDark,
  form,
  setForm,
}: {
  isDark: boolean;
  form: Partial<SettingsType>;
  setForm: React.Dispatch<React.SetStateAction<Partial<SettingsType>>>;
}) {
  const plannerEnabled = form.plannerPrefetchEnabled ?? true;
  const catalogCheckEnabled = form.nightlyCatalogPackCheckEnabled ?? true;
  const housekeepingEnabled = form.nightlyHousekeepingEnabled ?? true;
  const forecastEnabled = form.nightlyForecastPrefetchEnabled ?? true;
  const time = form.plannerPrefetchTime ?? '03:00';
  const anyEnabled = plannerEnabled || catalogCheckEnabled || housekeepingEnabled || forecastEnabled;

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

  return (
    <Sec
      title="Nightly maintenance"
      description="Tasks the server runs on its own each night."
      isDark={isDark}
    >
      <TaskRow
        isDark={isDark}
        label="Planner pre-cache"
        description="Downloads thumbnails for every object visible from your location, so the Planner opens instantly."
        checked={plannerEnabled}
        onChange={v => setForm(f => ({ ...f, plannerPrefetchEnabled: v }))}
        lastRun={form.plannerPrefetchLastRun ?? null}
      />
      <TaskRow
        isDark={isDark}
        label="Catalog pack updates"
        description="Checks nebulis.app for newer asset packs and downloads them in the background."
        checked={catalogCheckEnabled}
        onChange={v => setForm(f => ({ ...f, nightlyCatalogPackCheckEnabled: v }))}
        lastRun={null}
      />
      <TaskRow
        isDark={isDark}
        label="Library housekeeping"
        description="Removes junk files, such as macOS resource forks and stale upload temp folders."
        checked={housekeepingEnabled}
        onChange={v => setForm(f => ({ ...f, nightlyHousekeepingEnabled: v }))}
        lastRun={form.nightlyHousekeepingLastRun ?? null}
      />
      <TaskRow
        isDark={isDark}
        label="Forecast pre-warm"
        description="Refreshes the weather and seeing cache, so conditions load instantly at night."
        checked={forecastEnabled}
        onChange={v => setForm(f => ({ ...f, nightlyForecastPrefetchEnabled: v }))}
        lastRun={form.nightlyForecastLastRun ?? null}
      />

      {anyEnabled && (
        <div className={`px-5 py-4 flex items-center gap-3 flex-wrap border-t ${
          isDark ? 'border-slate-800/70' : 'border-slate-100'
        }`}>
            <label className={`text-xs font-medium ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
              Run at
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
              local time
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
              title="Run the enabled tasks now instead of waiting for the scheduled time"
            >
              <Play className="w-3 h-3" />
              {runNow.isPending ? 'Starting…' : 'Run now'}
            </button>

          {justStarted && (
            <span className={`text-xs w-full ${isDark ? 'text-accent-400' : 'text-accent-600'}`}>
              Maintenance started. Tasks are running in the background.
            </span>
          )}
          {runNow.isError && (
            <span className={`text-xs w-full ${isDark ? 'text-red-400' : 'text-red-600'}`}>
              {runNow.error instanceof Error ? runNow.error.message : 'Could not start maintenance.'}
            </span>
          )}
        </div>
      )}
    </Sec>
  );
}
