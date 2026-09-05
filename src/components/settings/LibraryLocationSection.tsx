import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, AlertTriangle, Loader2, Plug } from 'lucide-react';
import {
  getLibraryLocation, startLibraryMigration,
  type MigrationStatus,
} from '../../lib/api/storage';
import { Sec } from './SettingsUI';
import { formatBytes } from '../../lib/utils';
import { ChangeLocationModal } from '../ui/ChangeLocationModal';

const ACTIVE_PHASES: MigrationStatus['phase'][] = ['validating', 'copying', 'verifying', 'finalizing'];

export function LibraryLocationSection({ isDark }: { isDark: boolean }) {
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [resetModalOpen, setResetModalOpen] = useState(false);

  const { data, refetch } = useQuery({
    queryKey: ['library-location'],
    queryFn: getLibraryLocation,
    // Poll while a migration is running so progress stays live.
    refetchInterval: q =>
      q.state.data && ACTIVE_PHASES.includes(q.state.data.migration.phase) ? 1000 : false,
  });

  const location = data?.location;
  const migration = data?.migration;
  const migrating = migration ? ACTIVE_PHASES.includes(migration.phase) : false;

  // Show the verify-and-clean-up notice once a migration has completed, until
  // the user dismisses it (kept local; the server holds the last status only).
  const completionKey = migration?.completedAt ? `nebulis_migration_seen_${migration.completedAt}` : '';
  const [dismissedKeys, setDismissedKeys] = useState<Record<string, boolean>>({});
  const dismissed = completionKey
    ? (dismissedKeys[completionKey] ?? localStorage.getItem(completionKey) === '1')
    : false;
  function dismissNotice() {
    if (!completionKey) return;
    localStorage.setItem(completionKey, '1');
    setDismissedKeys(k => ({ ...k, [completionKey]: true }));
  }

  const heading = isDark ? 'text-white' : 'text-slate-800';
  const sub = isDark ? 'text-slate-500' : 'text-slate-400';
  const body = isDark ? 'text-slate-300' : 'text-slate-600';

  return (
    <Sec
      title="Library location"
      description="Where your imported images and sub-frames are stored."
      isDark={isDark}
    >
      <div className="p-4 sm:p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className={`text-xs font-medium uppercase tracking-wide ${sub}`}>Current location</div>
            <div className={`text-sm font-mono mt-1 break-all ${body}`}>
              {location?.path ?? 'Loading…'}
            </div>
            {location?.locationType === 'network' && location.network.host && (
              <div className={`text-xs font-mono mt-0.5 truncate ${sub}`}>
                {location.network.host}/{location.network.share}
              </div>
            )}
            <div className="flex items-center gap-2 mt-2">
              <span className={`text-xs px-2 py-0.5 rounded-full ${isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>
                {location?.isDefault ? 'Default location' : location?.locationType === 'network' ? 'Network share' : 'Custom drive'}
              </span>
              {location && !location.available && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-500 inline-flex items-center gap-1">
                  <Plug className="w-3 h-3" /> {location.locationType === 'network' ? 'Share not connected' : 'Drive not connected'}
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              disabled={migrating}
              className={`text-sm font-medium px-3.5 py-2 rounded-lg transition-colors ${
                migrating
                  ? 'opacity-50 cursor-not-allowed bg-slate-500/10 text-slate-400'
                  : 'bg-accent-500 text-white hover:bg-accent-600'
              }`}
            >
              Change location
            </button>
            {location && !location.isDefault && (
              <button
                type="button"
                onClick={() => setResetModalOpen(true)}
                disabled={migrating}
                className={`text-xs font-medium px-1 ${
                  migrating ? 'opacity-50 cursor-not-allowed' : `${sub} hover:opacity-80`
                }`}
              >
                Move back to default location
              </button>
            )}
          </div>
        </div>

        {location && !location.available && !migrating && (
          <div className="flex items-start gap-2.5 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20">
            <Plug className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
            <p className={`text-xs leading-relaxed ${body}`}>
              {location.locationType === 'network'
                ? 'Your library share is not reachable, so imports are paused and stored images cannot be opened. Check the server is online and try again. Nothing was lost.'
                : 'Your library drive is not connected, so imports are paused and stored images cannot be opened. Reconnect the drive to continue. Nothing was lost.'}
            </p>
          </div>
        )}

        {migrating && migration && <MigrationProgress migration={migration} isDark={isDark} />}

        {migration?.phase === 'error' && migration.error && (
          <div className="flex items-start gap-2.5 p-3 rounded-xl bg-red-500/10 border border-red-500/20">
            <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
            <p className={`text-xs leading-relaxed ${body}`}>
              The move did not finish: {migration.error} Your original library was not changed.
            </p>
          </div>
        )}

        {migration?.phase === 'complete' && migration.previousPath && !dismissed && (
          <div className="flex items-start gap-2.5 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
            <Check className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className={`text-sm font-medium ${heading}`}>Move complete</p>
              <p className={`text-xs leading-relaxed mt-1 ${body}`}>
                Your library now lives at <span className="font-mono break-all">{migration.toPath}</span>.
                Open a few observations to confirm everything looks right. The old copy was left in place and was not deleted.
                Once you have verified the new location, you can remove the old copy yourself at:
              </p>
              <p className={`text-xs font-mono mt-1.5 break-all px-2 py-1.5 rounded-lg ${isDark ? 'bg-slate-900 text-slate-300' : 'bg-white text-slate-600'}`}>
                {migration.previousPath}
              </p>
              <button
                type="button"
                onClick={dismissNotice}
                className={`text-xs font-medium mt-2.5 px-3 py-1.5 rounded-lg ${isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
              >
                Got it
              </button>
            </div>
          </div>
        )}
      </div>

      {modalOpen && (
        <ChangeLocationModal
          isDark={isDark}
          location={location}
          onClose={() => setModalOpen(false)}
          onStarted={() => {
            setModalOpen(false);
            queryClient.invalidateQueries({ queryKey: ['library-location'] });
            refetch();
          }}
        />
      )}

      {resetModalOpen && location && (
        <ResetToDefaultModal
          isDark={isDark}
          defaultPath={location.defaultPath}
          onClose={() => setResetModalOpen(false)}
          onStarted={() => {
            setResetModalOpen(false);
            queryClient.invalidateQueries({ queryKey: ['library-location'] });
            refetch();
          }}
        />
      )}
    </Sec>
  );
}

function ResetToDefaultModal({
  isDark, defaultPath, onClose, onStarted,
}: {
  isDark: boolean;
  defaultPath: string;
  onClose: () => void;
  onStarted: () => void;
}) {
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);

  const heading = isDark ? 'text-white' : 'text-slate-800';
  const body = isDark ? 'text-slate-300' : 'text-slate-600';
  const sub = isDark ? 'text-slate-500' : 'text-slate-400';

  async function handleConfirm() {
    setStarting(true);
    setError('');
    try {
      await startLibraryMigration(defaultPath);
      onStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the move');
      setStarting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div
        className={`w-full max-w-md rounded-2xl shadow-2xl ${isDark ? 'bg-slate-900' : 'bg-white'}`}
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-slate-500/10">
          <h3 className={`font-display text-lg font-semibold ${heading}`}>Move library back to default</h3>
          <p className={`text-xs mt-0.5 ${sub}`}>
            This is the location Nebulis used before you moved the library. Files are copied, never deleted.
          </p>
        </div>

        <div className="px-5 py-4 space-y-3">
          <p className={`text-sm ${body}`}>
            Your library will be stored in{' '}
            <span className={`font-mono text-xs break-all ${heading}`}>{defaultPath}</span>.
          </p>
          {error && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20">
              <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
              <p className={`text-xs ${body}`}>{error}</p>
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-slate-500/10 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className={`text-sm font-medium px-3.5 py-2 rounded-lg ${isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'}`}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={starting}
            onClick={handleConfirm}
            className={`text-sm font-medium px-3.5 py-2 rounded-lg inline-flex items-center gap-1.5 ${
              starting
                ? 'opacity-50 cursor-not-allowed bg-slate-500/10 text-slate-400'
                : 'bg-accent-500 text-white hover:bg-accent-600'
            }`}
          >
            {starting && <Loader2 className="w-4 h-4 animate-spin" />}
            Move library here
          </button>
        </div>
      </div>
    </div>
  );
}

function MigrationProgress({ migration, isDark }: { migration: MigrationStatus; isDark: boolean }) {
  const pct = migration.bytesTotal > 0
    ? Math.min(100, Math.round((migration.bytesCopied / migration.bytesTotal) * 100))
    : 0;
  const label: Record<MigrationStatus['phase'], string> = {
    idle: 'Preparing',
    validating: 'Checking the new location',
    copying: 'Copying files',
    verifying: 'Verifying the copy',
    finalizing: 'Finishing up',
    complete: 'Done',
    error: 'Move failed',
  };
  const body = isDark ? 'text-slate-300' : 'text-slate-600';
  return (
    <div className={`p-3.5 rounded-xl ${isDark ? 'bg-slate-800/60' : 'bg-slate-50'}`}>
      <div className="flex items-center gap-2 mb-2">
        <Loader2 className="w-4 h-4 text-accent-500 animate-spin" />
        <span className={`text-sm font-medium ${body}`}>{label[migration.phase]}</span>
      </div>
      <div className={`h-2 rounded-full overflow-hidden ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`}>
        <div className="h-full bg-accent-500 transition-all duration-300" style={{ width: `${pct}%` }} />
      </div>
      <div className={`flex justify-between text-xs mt-1.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
        <span>{migration.filesCopied} / {migration.filesTotal} files</span>
        <span>{formatBytes(migration.bytesCopied)} / {formatBytes(migration.bytesTotal)}</span>
      </div>
      <p className={`text-xs mt-2 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
        Keep this drive connected. Imports are paused until the move finishes.
      </p>
    </div>
  );
}
