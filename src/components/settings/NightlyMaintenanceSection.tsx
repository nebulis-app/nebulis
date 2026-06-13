import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Telescope, HardDrive, Cloud, Package, Play } from 'lucide-react';
import type { Settings as SettingsType } from '../../types';
import { runNightlyMaintenanceNow } from '../../lib/api/settings';
import { Sec, getCardClass } from './SettingsUI';
import { Toggle } from './SettingsUI';

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
  icon: React.ReactNode;
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  lastRun: number | null;
}

function TaskRow({ isDark, icon, label, description, checked, onChange, lastRun }: TaskRowProps) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="flex items-start gap-3 min-w-0">
        <div className={`mt-0.5 shrink-0 ${checked ? (isDark ? 'text-accent-400' : 'text-accent-500') : (isDark ? 'text-slate-600' : 'text-slate-400')}`}>
          {icon}
        </div>
        <div className="min-w-0">
          <p className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{label}</p>
          <p className={`text-xs mt-0.5 leading-relaxed ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{description}</p>
          {lastRun !== null && (
            <p className={`text-[11px] mt-1 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
              Last run: {formatShortDate(lastRun)}
            </p>
          )}
        </div>
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
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
  const runNow = useMutation({
    mutationFn: runNightlyMaintenanceNow,
    onSuccess: () => {
      // The batch runs in the background. Show a brief confirmation, then
      // refetch settings so the quick tasks' last-run times update.
      setJustStarted(true);
      setTimeout(() => setJustStarted(false), 4000);
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ['settings'] }), 5000);
    },
  });

  return (
    <Sec
      title="Nightly Maintenance"
      description="Tasks the server runs automatically each night while you sleep."
      isDark={isDark}
    >
      <div className={`${getCardClass(isDark)} divide-y ${isDark ? 'divide-slate-800/70' : 'divide-slate-100'}`}>
        <TaskRow
          isDark={isDark}
          icon={<Telescope className="w-4 h-4" />}
          label="Planner Pre-cache"
          description="Pre-downloads thumbnails for every object visible from your location so the Planner opens instantly."
          checked={plannerEnabled}
          onChange={v => setForm(f => ({ ...f, plannerPrefetchEnabled: v }))}
          lastRun={form.plannerPrefetchLastRun ?? null}
        />
        <TaskRow
          isDark={isDark}
          icon={<Package className="w-4 h-4" />}
          label="Catalog Pack Updates"
          description="Checks nebulis.app for newer versions of installed asset packs and downloads updates silently."
          checked={catalogCheckEnabled}
          onChange={v => setForm(f => ({ ...f, nightlyCatalogPackCheckEnabled: v }))}
          lastRun={null}
        />
        <TaskRow
          isDark={isDark}
          icon={<HardDrive className="w-4 h-4" />}
          label="Library Housekeeping"
          description="Purges junk files (macOS resource forks, stale upload temp dirs) from the library folder."
          checked={housekeepingEnabled}
          onChange={v => setForm(f => ({ ...f, nightlyHousekeepingEnabled: v }))}
          lastRun={form.nightlyHousekeepingLastRun ?? null}
        />
        <TaskRow
          isDark={isDark}
          icon={<Cloud className="w-4 h-4" />}
          label="Forecast Pre-warm"
          description="Refreshes the weather and seeing forecast cache so conditions load instantly when you open the app at night."
          checked={forecastEnabled}
          onChange={v => setForm(f => ({ ...f, nightlyForecastPrefetchEnabled: v }))}
          lastRun={form.nightlyForecastLastRun ?? null}
        />

        {anyEnabled && (
          <div className={`pt-3 flex items-center gap-3 flex-wrap`}>
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
      </div>
    </Sec>
  );
}
