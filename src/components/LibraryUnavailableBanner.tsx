import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Plug, Loader2, AlertTriangle } from 'lucide-react';
import { getLibraryLocation, resetLibraryLocation } from '../lib/api/storage';
import { useTheme } from '../hooks/useTheme';

/**
 * App-wide banner shown when the library lives on a drive or path that is not
 * currently reachable. The database stays local, so the rest of the app works;
 * this tells the user why images won't open and that nothing was lost.
 *
 * When the location is a relocation stored in the database (not a network
 * share), it also offers a one-click "Reset to default folder" that forgets the
 * old path without copying anything, for the case where that drive or machine
 * is gone for good.
 */
export function LibraryUnavailableBanner() {
  const { isDark } = useTheme();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const { data } = useQuery({
    queryKey: ['library-location'],
    queryFn: getLibraryLocation,
    refetchInterval: 15000,
  });

  const reset = useMutation({
    mutationFn: resetLibraryLocation,
    onSuccess: () => {
      setConfirming(false);
      queryClient.invalidateQueries({ queryKey: ['library-location'] });
    },
  });

  const location = data?.location;
  const migrating = data?.migration
    ? ['validating', 'copying', 'verifying', 'finalizing'].includes(data.migration.phase)
    : false;

  if (!location || location.available || migrating) return null;

  // A relocation (local path or network share) can be forgotten from here when
  // the location it points at is gone for good. A pinned location can't.
  const canReset = !location.pinned;

  const strong = isDark ? 'text-amber-200' : 'text-amber-800';
  const soft = isDark ? 'text-amber-200/70' : 'text-amber-700';

  return (
    <div className={`mb-6 flex items-start gap-3 rounded-xl border px-4 py-3 ${
      isDark ? 'bg-amber-500/10 border-amber-500/25' : 'bg-amber-50 border-amber-200'
    }`}>
      <Plug className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className={`text-sm font-medium ${strong}`}>
          {location.locationType === 'network' ? 'Reconnect your library share' : 'Reconnect your library drive'}
        </p>
        <p className={`text-xs mt-0.5 leading-relaxed ${soft}`}>
          Your images are stored at a location that is not connected, so they cannot be opened and imports are paused.
          {' '}
          {location.locationType === 'network'
            ? 'Check the server is online.'
            : 'Plug the drive back in.'}
          {' '}Nothing was lost. You can change the location in{' '}
          <Link to="/settings" className="underline font-medium">Settings, Storage</Link>.
        </p>

        {canReset && !confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className={`mt-2 text-xs font-medium underline ${strong} hover:opacity-80`}
          >
            {location.locationType === 'network' ? 'That share is gone' : 'That drive is gone'}. Reset to the default folder.
          </button>
        )}

        {canReset && confirming && (
          <div className={`mt-2 rounded-lg p-2.5 ${isDark ? 'bg-amber-500/10' : 'bg-amber-100/60'}`}>
            <p className={`text-xs leading-relaxed ${soft}`}>
              This points Nebulis back at its built-in library folder
              (<span className="font-mono break-all">{location.defaultPath}</span>).
              Files at the old location are <span className="font-medium">not</span> copied.
              Use this only if that {location.locationType === 'network' ? 'share' : 'drive'} is gone for
              good and your images are already in the default folder (or you will re-import them).
            </p>
            {reset.isError && (
              <p className="text-xs mt-1.5 text-red-500 inline-flex items-center gap-1">
                <AlertTriangle className="w-3.5 h-3.5" />
                {reset.error instanceof Error ? reset.error.message : 'Could not reset the location'}
              </p>
            )}
            <div className="flex items-center gap-2 mt-2">
              <button
                type="button"
                disabled={reset.isPending}
                onClick={() => reset.mutate()}
                className={`text-xs font-medium px-2.5 py-1.5 rounded-md inline-flex items-center gap-1.5 ${
                  reset.isPending
                    ? 'opacity-50 cursor-not-allowed bg-slate-500/10 text-slate-400'
                    : 'bg-amber-500 text-white hover:bg-amber-600'
                }`}
              >
                {reset.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Reset to default folder
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className={`text-xs font-medium px-2.5 py-1.5 rounded-md ${isDark ? 'text-amber-200/70 hover:bg-amber-500/10' : 'text-amber-700 hover:bg-amber-100'}`}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
