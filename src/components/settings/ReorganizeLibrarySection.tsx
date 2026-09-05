import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRenestStatus, startRenest } from '../../lib/api/storage';
import { Sec } from './SettingsUI';

/**
 * Converts library objects from the legacy flat layout (every night's files in
 * one folder, filenames rewritten to keep them apart) to the per-session layout
 * (one folder per session, filenames left alone).
 *
 * Presented as a one-time action rather than a setting on purpose: supporting
 * both layouts forever would mean maintaining two read paths across the whole
 * library. New objects are already created in the new layout, so this only
 * exists to bring older ones across.
 */
export function ReorganizeLibrarySection({ isDark }: { isDark: boolean }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const { data, refetch } = useQuery({
    queryKey: ['library-renest'],
    queryFn: getRenestStatus,
    // Poll only while a run is in flight so progress stays live.
    refetchInterval: q => (q.state.data?.renest.running ? 750 : false),
  });

  const status = data?.renest;
  const flatObjects = data?.flatObjects ?? 0;
  const running = status?.running ?? false;
  const summary = status?.summary;

  const run = async () => {
    if (starting || running) return;
    setStarting(true);
    setError(null);
    setConfirming(false);
    try {
      await startRenest();
      await refetch();
      // File paths moved, so anything holding a library path is now stale.
      await queryClient.invalidateQueries({ queryKey: ['library'] });
      await queryClient.invalidateQueries({ queryKey: ['observations'] });
      await queryClient.invalidateQueries({ queryKey: ['gallery'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reorganize failed');
    } finally {
      setStarting(false);
    }
  };

  const progressPct = status && status.objectsTotal > 0
    ? Math.round((status.objectsDone / status.objectsTotal) * 100)
    : 0;

  const btnBase = 'px-3.5 py-2 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

  return (
    <Sec
      title="Folder layout"
      description="How this library stores each object's files on disk."
      isDark={isDark}
    >
      <div className="px-5 py-5 space-y-4">
        {flatObjects === 0 && !running && !summary && (
          <p className={`text-[13px] ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
            Every object uses the current layout: one folder per session, with files kept
            under the names your telescope gave them. Nothing to do.
          </p>
        )}

        {flatObjects > 0 && !running && (
          <>
            <p className={`text-[13px] leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              {flatObjects === 1
                ? '1 object still uses the old layout,'
                : `${flatObjects} objects still use the old layout,`}{' '}
              where every night's files share a single folder. Reorganizing gives each session
              its own folder, so new imports into these objects can keep the file names your
              telescope uses.
            </p>
            <div
              className={`rounded-lg px-3.5 py-3 text-[12px] leading-relaxed ${
                isDark ? 'bg-amber-500/10 text-amber-200/90' : 'bg-amber-50 text-amber-900'
              }`}
            >
              Files already in your library keep the names they were given when they were
              imported. Those original names were not recorded at the time, so they cannot be
              restored. Re-importing from the telescope is the only way to get them back.
            </div>
          </>
        )}

        {running && status && (
          <div className="space-y-2">
            <div className={`text-[13px] ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              Reorganizing {status.objectsDone} of {status.objectsTotal}
              {status.currentObject ? `: ${status.currentObject}` : ''}
            </div>
            <div className={`h-2 rounded-full overflow-hidden ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`}>
              <div
                className="h-full bg-accent-500 transition-all duration-300"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        )}

        {summary && !running && (
          <div
            className={`rounded-lg px-3.5 py-3 text-[12px] leading-relaxed ${
              summary.failed > 0
                ? isDark ? 'bg-red-500/10 text-red-200/90' : 'bg-red-50 text-red-900'
                : isDark ? 'bg-emerald-500/10 text-emerald-200/90' : 'bg-emerald-50 text-emerald-900'
            }`}
          >
            Reorganized {summary.objects} {summary.objects === 1 ? 'object' : 'objects'},
            moving {summary.moved} {summary.moved === 1 ? 'file' : 'files'}.
            {summary.failed > 0 && (
              <>
                {' '}
                {summary.failed} {summary.failed === 1 ? 'object' : 'objects'} could not be
                converted and were left as they were. Check the server log, then run it again.
              </>
            )}
          </div>
        )}

        {error && (
          <div
            className={`rounded-lg px-3.5 py-3 text-[12px] ${
              isDark ? 'bg-red-500/10 text-red-200/90' : 'bg-red-50 text-red-900'
            }`}
          >
            {error}
          </div>
        )}

        {flatObjects > 0 && !running && (
          <div className="flex items-center gap-3">
            {confirming ? (
              <>
                <button
                  onClick={run}
                  disabled={starting || running}
                  className={`${btnBase} bg-accent-500 hover:bg-accent-600 text-white`}
                >
                  {starting ? 'Starting…' : 'Yes, reorganize'}
                </button>
                <button
                  onClick={() => setConfirming(false)}
                  className={`${btnBase} ${
                    isDark
                      ? 'bg-slate-800 hover:bg-slate-700 text-slate-200'
                      : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                  }`}
                >
                  Cancel
                </button>
                <span className={`text-[12px] ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  Files are moved, never deleted. You can keep using Nebulis afterwards as normal.
                </span>
              </>
            ) : (
              <button
                onClick={() => setConfirming(true)}
                className={`${btnBase} ${
                  isDark
                    ? 'bg-slate-800 hover:bg-slate-700 text-slate-200'
                    : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                }`}
              >
                Reorganize library
              </button>
            )}
          </div>
        )}
      </div>
    </Sec>
  );
}
