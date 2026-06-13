import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Plug } from 'lucide-react';
import { getLibraryLocation } from '../lib/api/storage';
import { useTheme } from '../hooks/useTheme';

/**
 * App-wide banner shown when the library lives on a drive that is not currently
 * connected. The database stays local, so the rest of the app works; this tells
 * the user why images won't open and that nothing was lost.
 */
export function LibraryUnavailableBanner() {
  const { isDark } = useTheme();
  const { data } = useQuery({
    queryKey: ['library-location'],
    queryFn: getLibraryLocation,
    refetchInterval: 15000,
  });

  const location = data?.location;
  const migrating = data?.migration
    ? ['validating', 'copying', 'verifying', 'finalizing'].includes(data.migration.phase)
    : false;

  if (!location || location.available || migrating) return null;

  return (
    <div className={`mb-6 flex items-start gap-3 rounded-xl border px-4 py-3 ${
      isDark ? 'bg-amber-500/10 border-amber-500/25' : 'bg-amber-50 border-amber-200'
    }`}>
      <Plug className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className={`text-sm font-medium ${isDark ? 'text-amber-200' : 'text-amber-800'}`}>
          Reconnect your library drive
        </p>
        <p className={`text-xs mt-0.5 leading-relaxed ${isDark ? 'text-amber-200/70' : 'text-amber-700'}`}>
          Your images are stored on a drive that is not connected, so they cannot be opened and imports are paused.
          Plug the drive back in. Nothing was lost. You can change the location in{' '}
          <Link to="/settings" className="underline font-medium">Settings, Storage</Link>.
        </p>
      </div>
    </div>
  );
}
