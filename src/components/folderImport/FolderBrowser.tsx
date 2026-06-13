import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { HardDrive, FolderOpen, ChevronRight, ArrowLeft, RefreshCw, Check } from 'lucide-react';
import { listVolumes, browseDirectory, type VolumeInfo, type DirectoryEntry } from '../../lib/api/storage';
import { useTheme } from '../../hooks/useTheme';
import { Modal } from '../ui/Modal';

/**
 * Server-side folder picker. Lists the drives the server can see and lets the
 * user browse into subfolders, then hands the chosen absolute path back via
 * onSelect. Used by the import flow so the user never types a path. The path
 * is resolved on the server (same source as the library-location picker), so
 * it works for the folder-scan/commit endpoints which read server-side.
 */
export function FolderBrowser({
  onClose,
  onSelect,
  title = 'Choose a folder to import',
}: {
  onClose: () => void;
  onSelect: (path: string) => void;
  title?: string;
}) {
  const { isDark } = useTheme();
  const [volume, setVolume] = useState<VolumeInfo | null>(null);
  const [browsePath, setBrowsePath] = useState<string | null>(null);

  const { data: volumesData, isLoading: volumesLoading, refetch: refetchVolumes } = useQuery({
    queryKey: ['storage-volumes'],
    queryFn: listVolumes,
  });
  const { data: browseData, isFetching: browseFetching } = useQuery({
    queryKey: ['storage-browse', browsePath],
    queryFn: () => browseDirectory(browsePath as string),
    enabled: !!browsePath,
  });

  const card = isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200';
  const heading = isDark ? 'text-white' : 'text-slate-900';
  const body = isDark ? 'text-slate-300' : 'text-slate-600';
  const sub = isDark ? 'text-slate-500' : 'text-slate-400';
  const border = isDark ? 'border-slate-800' : 'border-slate-200';

  const atVolumeRoot = volume ? browsePath === volume.path : true;

  // Back steps up the folder tree; from a drive's root it returns to the
  // drive list. So a single control covers "go up some" and "pick another drive".
  function goBack() {
    if (!volume || !browsePath) return;
    if (atVolumeRoot) {
      setVolume(null);
      setBrowsePath(null);
      return;
    }
    const parent = browsePath.replace(/[\\/][^\\/]+$/, '');
    setBrowsePath(parent || volume.path);
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={title}
      className={`relative w-full max-w-lg max-h-[85vh] flex flex-col rounded-2xl border shadow-2xl ${card}`}
    >
      <div className={`px-5 py-4 border-b ${border}`}>
        <h3 className={`font-display text-lg font-semibold ${heading}`}>{title}</h3>
        <p className={`text-xs mt-0.5 ${sub}`}>
          Pick the folder that holds your library. One subfolder per object works best.
        </p>
      </div>

      <div className="px-5 py-4 overflow-y-auto space-y-3">
        {/* Screen 1: pick a drive */}
        {!volume && (
          <>
            <div className="flex items-center justify-between mb-1">
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
                    onClick={() => { setVolume(v); setBrowsePath(v.path); }}
                    className={`w-full text-left px-3 py-2.5 rounded-xl border transition-colors ${
                      isDark ? 'border-slate-800 hover:bg-slate-800/50' : 'border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <HardDrive className={`w-4 h-4 shrink-0 ${sub}`} />
                      <span className={`text-sm font-medium truncate flex-1 ${body}`}>{v.label}</span>
                      <span className={`text-xs tabular-nums ${sub}`}>{formatBytes(v.freeBytes)} free</span>
                      <ChevronRight className="w-3.5 h-3.5 opacity-40 shrink-0" />
                    </div>
                    <div className={`text-xs font-mono mt-0.5 truncate ${sub}`}>{v.path}</div>
                  </button>
                ))}
                {(volumesData?.volumes ?? []).length === 0 && (
                  <div className={`text-sm ${sub}`}>No drives found. Connect a drive and refresh.</div>
                )}
              </div>
            )}
          </>
        )}

        {/* Screen 2: browse the chosen drive */}
        {volume && (
          <>
            <button
              type="button"
              onClick={goBack}
              className={`inline-flex items-center gap-1.5 text-sm font-medium ${isDark ? 'text-slate-300 hover:text-white' : 'text-slate-600 hover:text-slate-900'}`}
            >
              <ArrowLeft className="w-4 h-4" />
              {atVolumeRoot ? 'All drives' : 'Back'}
            </button>
            <div className={`flex items-center gap-2 px-3 py-2 rounded-lg ${isDark ? 'bg-slate-800/60' : 'bg-slate-100'}`}>
              <HardDrive className={`w-4 h-4 shrink-0 ${sub}`} />
              <span className={`text-xs font-mono truncate flex-1 ${body}`}>{browsePath}</span>
            </div>
            <div className={`rounded-xl max-h-64 overflow-y-auto ${isDark ? 'bg-slate-800/40' : 'bg-slate-50'}`}>
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
              {browseFetching && (
                <div className={`px-3 py-2.5 text-xs ${sub}`}>Loading...</div>
              )}
              {!browseFetching && (browseData?.directories ?? []).length === 0 && (
                <div className={`px-3 py-2.5 text-xs ${sub}`}>This folder has no subfolders. You can still import it.</div>
              )}
            </div>
          </>
        )}
      </div>

      <div className={`px-5 py-4 border-t ${border} flex items-center justify-between gap-3`}>
        <span className={`text-xs truncate ${sub}`}>
          {browsePath ? <>Import <span className="font-mono">{browsePath}</span></> : 'Pick a drive to begin'}
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
            disabled={!browsePath}
            onClick={() => browsePath && onSelect(browsePath)}
            className="text-sm font-medium px-3.5 py-2 rounded-lg inline-flex items-center gap-1.5 bg-accent-500 text-white hover:bg-accent-600 disabled:opacity-50"
          >
            <Check className="w-4 h-4" /> Select this folder
          </button>
        </div>
      </div>
    </Modal>
  );
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}
