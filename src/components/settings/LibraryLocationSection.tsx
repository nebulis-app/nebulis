import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  HardDrive, FolderOpen, ChevronRight, ArrowUp, Check,
  AlertTriangle, Loader2, RefreshCw, Plug,
} from 'lucide-react';
import {
  getLibraryLocation, listVolumes, browseDirectory,
  startLibraryMigration,
  type VolumeInfo, type DirectoryEntry, type MigrationStatus,
} from '../../lib/api/storage';
import { getCardClass, getInputClass } from './SettingsUI';
import { formatBytes } from '../../lib/utils';

// Join a server-side path with a folder name using that path's own separator
// (so Windows D:\ and macOS /Volumes both render correctly). The server
// normalizes the result, so this only needs to be good enough to display.
function joinPath(base: string, name: string): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${sep}${name}`;
}

const ACTIVE_PHASES: MigrationStatus['phase'][] = ['validating', 'copying', 'verifying', 'finalizing'];

export function LibraryLocationSection({ isDark }: { isDark: boolean }) {
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);

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

  const cardCls = getCardClass(isDark);
  const heading = isDark ? 'text-white' : 'text-slate-800';
  const sub = isDark ? 'text-slate-500' : 'text-slate-400';
  const body = isDark ? 'text-slate-300' : 'text-slate-600';

  return (
    <div>
      <div className="flex items-center gap-3 mb-5">
        <div className={`p-2 rounded-xl ${isDark ? 'bg-blue-500/10' : 'bg-blue-50'}`}>
          <HardDrive className="w-5 h-5 text-blue-500" />
        </div>
        <div>
          <h2 className={`font-display text-[17px] font-semibold tracking-tight ${heading}`}>
            Library location
          </h2>
          <p className={`text-[13px] mt-0.5 ${sub}`}>
            Where your imported images and sub-frames are stored
          </p>
        </div>
      </div>

      <div className={`${cardCls} space-y-4`}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className={`text-xs font-medium uppercase tracking-wide ${sub}`}>Current location</div>
            <div className={`text-sm font-mono mt-1 break-all ${body}`}>
              {location?.path ?? 'Loading...'}
            </div>
            <div className="flex items-center gap-2 mt-2">
              <span className={`text-xs px-2 py-0.5 rounded-full ${isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>
                {location?.isDefault ? 'Default location' : 'Custom drive'}
              </span>
              {location && !location.available && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-500 inline-flex items-center gap-1">
                  <Plug className="w-3 h-3" /> Drive not connected
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            disabled={migrating}
            className={`shrink-0 text-sm font-medium px-3.5 py-2 rounded-lg transition-colors ${
              migrating
                ? 'opacity-50 cursor-not-allowed bg-slate-500/10 text-slate-400'
                : 'bg-accent-500 text-white hover:bg-accent-600'
            }`}
          >
            Change location
          </button>
        </div>

        {location && !location.available && !migrating && (
          <div className="flex items-start gap-2.5 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20">
            <Plug className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
            <p className={`text-xs leading-relaxed ${body}`}>
              Your library drive is not connected, so imports are paused and stored images cannot be opened.
              Reconnect the drive to continue. Nothing was lost.
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
          onClose={() => setModalOpen(false)}
          onStarted={() => {
            setModalOpen(false);
            queryClient.invalidateQueries({ queryKey: ['library-location'] });
            refetch();
          }}
        />
      )}
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
    error: 'Error',
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

export function ChangeLocationModal({
  isDark, onClose, onStarted,
}: {
  isDark: boolean;
  onClose: () => void;
  onStarted: () => void;
}) {
  const [volume, setVolume] = useState<VolumeInfo | null>(null);
  const [browsePath, setBrowsePath] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('Nebulis');
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);

  const { data: volumesData, isLoading: volumesLoading, refetch: refetchVolumes } = useQuery({
    queryKey: ['storage-volumes'],
    queryFn: listVolumes,
  });

  const { data: browseData } = useQuery({
    queryKey: ['storage-browse', browsePath],
    queryFn: () => browseDirectory(browsePath as string),
    enabled: !!browsePath,
  });

  const heading = isDark ? 'text-white' : 'text-slate-800';
  const body = isDark ? 'text-slate-300' : 'text-slate-600';
  const sub = isDark ? 'text-slate-500' : 'text-slate-400';

  function pickVolume(v: VolumeInfo) {
    setVolume(v);
    setBrowsePath(v.path);
    setError('');
  }

  // The destination is the chosen location plus the folder name. The move
  // creates this folder itself, so there is no separate "create" step. An
  // empty name means "use the folder shown" as-is.
  const folderName = newFolderName.trim();
  const nameError = folderName && (/[\\/]/.test(folderName) || folderName === '.' || folderName === '..')
    ? 'Folder name cannot contain slashes.'
    : '';
  const targetPath = browsePath && !nameError
    ? (folderName ? joinPath(browsePath, folderName) : browsePath)
    : null;

  async function handleStart() {
    if (!targetPath) return;
    setStarting(true);
    setError('');
    try {
      await startLibraryMigration(targetPath);
      onStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the move');
      setStarting(false);
    }
  }

  const atVolumeRoot = volume ? browsePath === volume.path : true;
  const canGoUp = !!volume && !atVolumeRoot;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div
        className={`w-full max-w-lg rounded-2xl shadow-2xl ${isDark ? 'bg-slate-900' : 'bg-white'} max-h-[85vh] flex flex-col`}
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-slate-500/10">
          <h3 className={`font-display text-lg font-semibold ${heading}`}>Move library to a new drive</h3>
          <p className={`text-xs mt-0.5 ${sub}`}>
            Pick a connected drive and an empty folder. Your files are copied, never deleted.
          </p>
        </div>

        <div className="px-5 py-4 overflow-y-auto space-y-4">
          {/* Volumes */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className={`text-xs font-medium uppercase tracking-wide ${sub}`}>Drives</span>
              <button
                type="button"
                onClick={() => refetchVolumes()}
                className={`text-xs inline-flex items-center gap-1 ${sub} hover:opacity-80`}
              >
                <RefreshCw className="w-3 h-3" /> Refresh
              </button>
            </div>
            {volumesLoading ? (
              <div className={`text-sm ${sub}`}>Looking for drives...</div>
            ) : (
              <div className="space-y-1.5">
                {(volumesData?.volumes ?? []).map(v => (
                  <button
                    type="button"
                    key={v.path}
                    onClick={() => pickVolume(v)}
                    className={`w-full text-left px-3 py-2.5 rounded-xl border transition-colors ${
                      volume?.path === v.path
                        ? isDark ? 'bg-accent-500/10 border-accent-500/40' : 'bg-accent-50 border-accent-300'
                        : isDark ? 'border-slate-800 hover:bg-slate-800/50' : 'border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className={`text-sm font-medium truncate ${body}`}>{v.label}</span>
                      <span className={`text-xs tabular-nums ${sub}`}>{formatBytes(v.freeBytes)} free</span>
                    </div>
                    <div className={`text-xs font-mono mt-0.5 truncate ${sub}`}>{v.path}</div>
                  </button>
                ))}
                {(volumesData?.volumes ?? []).length === 0 && (
                  <div className={`text-sm ${sub}`}>No drives found. Connect a USB or external drive and refresh.</div>
                )}
              </div>
            )}
          </div>

          {/* Location + folder name */}
          {volume && (
            <div>
              <span className={`text-xs font-medium uppercase tracking-wide ${sub}`}>Location</span>
              <div className="flex items-center gap-2 mt-2 mb-2">
                <button
                  type="button"
                  disabled={!canGoUp}
                  onClick={() => {
                    if (!browsePath || !canGoUp) return;
                    const parent = browsePath.replace(/[\\/][^\\/]+$/, '');
                    setBrowsePath(parent || volume.path);
                  }}
                  className={`p-1.5 rounded-lg ${canGoUp ? (isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100') : 'opacity-40'}`}
                  title="Up one folder"
                >
                  <ArrowUp className={`w-4 h-4 ${body}`} />
                </button>
                <span className={`text-xs font-mono truncate flex-1 ${body}`}>{browsePath}</span>
              </div>
              <div className={`${isDark ? 'bg-slate-800/40' : 'bg-slate-50'} rounded-xl max-h-36 overflow-y-auto`}>
                {(browseData?.directories ?? []).map((d: DirectoryEntry) => (
                  <button
                    type="button"
                    key={d.path}
                    onClick={() => setBrowsePath(d.path)}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm ${body} ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
                  >
                    <FolderOpen className="w-4 h-4 text-accent-500 shrink-0" />
                    <span className="truncate flex-1">{d.name}</span>
                    <ChevronRight className="w-3.5 h-3.5 opacity-40" />
                  </button>
                ))}
                {(browseData?.directories ?? []).length === 0 && (
                  <div className={`px-3 py-2.5 text-xs ${sub}`}>This folder has no subfolders.</div>
                )}
              </div>

              <label className={`block text-xs font-medium uppercase tracking-wide mt-3 mb-1.5 ${sub}`}>
                Folder name
              </label>
              <input
                value={newFolderName}
                onChange={e => setNewFolderName(e.target.value)}
                placeholder="Nebulis"
                className={`${getInputClass(isDark)} w-full`}
              />
              {nameError ? (
                <p className="text-xs mt-1.5 text-red-500">{nameError}</p>
              ) : targetPath && (
                <p className={`text-xs mt-1.5 ${sub}`}>
                  Your library will be stored in{' '}
                  <span className={`font-mono ${body}`}>{targetPath}</span>.
                  {folderName ? ' This folder is created automatically if it does not exist.' : ''}
                </p>
              )}
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20">
              <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
              <p className={`text-xs ${body}`}>{error}</p>
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-slate-500/10 flex items-center justify-between gap-3">
          <span className={`text-xs truncate ${sub}`}>
            {targetPath ? <>Move to <span className="font-mono">{targetPath}</span></> : 'Pick a drive to begin'}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className={`text-sm font-medium px-3.5 py-2 rounded-lg ${isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'}`}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!targetPath || starting}
              onClick={handleStart}
              className={`text-sm font-medium px-3.5 py-2 rounded-lg inline-flex items-center gap-1.5 ${
                !targetPath || starting
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
    </div>
  );
}
