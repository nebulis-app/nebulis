import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { HardDrive, FolderOpen, ChevronRight, ArrowUp, RefreshCw } from 'lucide-react';
import { listVolumes, browseDirectory, type VolumeInfo, type DirectoryEntry } from '../../lib/api/storage';
import { formatBytes } from '../../lib/utils';

/**
 * Browse the server's own filesystem and select a folder to import in place.
 * This is the no-upload path: the chosen absolute path is handed straight to
 * the folder-import wizard (scan/commit), so nothing streams through the
 * browser. Reuses the same `/storage/volumes` + `/storage/browse` endpoints as
 * the library-location picker. `onChange` fires with the folder currently shown
 * (that is the folder that will be imported), or null before a drive is chosen.
 */
export function ServerFolderPicker({ isDark, onChange }: {
  isDark: boolean;
  onChange: (path: string | null) => void;
}) {
  const [volume, setVolume] = useState<VolumeInfo | null>(null);
  const [browsePath, setBrowsePath] = useState<string | null>(null);

  const { data: volumesData, isLoading: volumesLoading, refetch: refetchVolumes } = useQuery({
    queryKey: ['storage-volumes'],
    queryFn: listVolumes,
  });

  const { data: browseData } = useQuery({
    queryKey: ['storage-browse', browsePath],
    queryFn: () => browseDirectory(browsePath as string),
    enabled: !!browsePath,
  });

  const body = isDark ? 'text-slate-300' : 'text-slate-600';
  const sub = isDark ? 'text-slate-500' : 'text-slate-400';

  function goTo(path: string | null) {
    setBrowsePath(path);
    onChange(path);
  }

  function pickVolume(v: VolumeInfo) {
    setVolume(v);
    goTo(v.path);
  }

  const atVolumeRoot = volume ? browsePath === volume.path : true;
  const canGoUp = !!volume && !atVolumeRoot;

  return (
    <div className="space-y-4">
      {/* Drives */}
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
                  <span className={`text-sm font-medium truncate flex items-center gap-2 ${body}`}>
                    <HardDrive className="w-4 h-4 shrink-0 text-accent-500" />
                    {v.label}
                  </span>
                  <span className={`text-xs tabular-nums ${sub}`}>{formatBytes(v.freeBytes)} free</span>
                </div>
                <div className={`text-xs font-mono mt-0.5 truncate ${sub}`}>{v.path}</div>
              </button>
            ))}
            {(volumesData?.volumes ?? []).length === 0 && (
              <div className={`text-sm ${sub}`}>No drives found. Connect a drive and refresh.</div>
            )}
          </div>
        )}
      </div>

      {/* Folder navigation */}
      {volume && (
        <div>
          <span className={`text-xs font-medium uppercase tracking-wide ${sub}`}>Folder to import</span>
          <div className="flex items-center gap-2 mt-2 mb-2">
            <button
              type="button"
              disabled={!canGoUp}
              onClick={() => {
                if (!browsePath || !canGoUp) return;
                const parent = browsePath.replace(/[\\/][^\\/]+$/, '');
                goTo(parent || volume.path);
              }}
              className={`p-1.5 rounded-lg ${canGoUp ? (isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100') : 'opacity-40'}`}
              title="Up one folder"
            >
              <ArrowUp className={`w-4 h-4 ${body}`} />
            </button>
            <span className={`text-xs font-mono truncate flex-1 ${body}`}>{browsePath}</span>
          </div>
          <div className={`${isDark ? 'bg-slate-800/40' : 'bg-slate-50'} rounded-xl max-h-40 overflow-y-auto`}>
            {(browseData?.directories ?? []).map((d: DirectoryEntry) => (
              <button
                type="button"
                key={d.path}
                onClick={() => goTo(d.path)}
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
          <p className={`text-xs mt-2 ${sub}`}>
            Nebulis will import the folder shown above. Open a subfolder to go deeper, or use the up arrow.
          </p>
        </div>
      )}
    </div>
  );
}
