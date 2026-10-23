import { useState } from 'react';
import { useQuery, skipToken } from '@tanstack/react-query';
import { HardDrive, FolderOpen, ChevronRight, ArrowUp, RefreshCw, Telescope, CornerDownLeft, Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { listVolumes, browseDirectory, type VolumeInfo, type DirectoryEntry } from '../../lib/api/storage';
import { formatBytes } from '../../lib/utils';

const RECENT_PATHS_KEY = 'nebulis_import_recent_paths';
const MAX_RECENT_PATHS = 5;

function getRecentPaths(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_PATHS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

function rememberRecentPath(p: string): string[] {
  const next = [p, ...getRecentPaths().filter(x => x.toLowerCase() !== p.toLowerCase())].slice(0, MAX_RECENT_PATHS);
  try {
    localStorage.setItem(RECENT_PATHS_KEY, JSON.stringify(next));
  } catch {
    // Private mode or blocked storage: recent paths are a convenience, not
    // required. The typed path still works this session.
  }
  return next;
}

/**
 * Browse the server's own filesystem and select a folder to import in place.
 * This is the no-upload path: the chosen absolute path is handed straight to
 * the folder-import wizard (scan/commit), so nothing streams through the
 * browser. Reuses the same `/storage/volumes` + `/storage/browse` endpoints as
 * the library-location picker. `onChange` fires with the folder currently shown
 * (that is the folder that will be imported), or null before a drive is chosen.
 *
 * A path can also be typed or pasted directly. Network shares (`\\host\share`)
 * and mapped drive letters never show up in the drive list: a mapped letter
 * exists only inside the signed-in user's Windows session and Nebulis runs as a
 * service, so a UNC path is the only way to point the in-place import at a NAS.
 */
export function ServerFolderPicker({ isDark, onChange, suggestedPath }: {
  isDark: boolean;
  onChange: (path: string | null) => void;
  /** The selected telescope's local-mirror transport path, if it has one.
   *  Offered as a one-click starting point so the user doesn't have to hunt
   *  through drives for a folder Nebulis already knows about. */
  suggestedPath?: string | null;
}) {
  const [volume, setVolume] = useState<VolumeInfo | null>(null);
  const [browsePath, setBrowsePath] = useState<string | null>(null);
  const [manualPath, setManualPath] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);
  const [checkingManual, setCheckingManual] = useState(false);
  const [recentPaths, setRecentPaths] = useState<string[]>(getRecentPaths);
  const { t } = useTranslation('library');

  const { data: volumesData, isLoading: volumesLoading, refetch: refetchVolumes } = useQuery({
    queryKey: ['storage-volumes'],
    queryFn: listVolumes,
  });

  const { data: browseData } = useQuery({
    queryKey: ['storage-browse', browsePath],
    queryFn: browsePath ? () => browseDirectory(browsePath) : skipToken,
    enabled: !!browsePath,
  });

  const body = isDark ? 'text-slate-300' : 'text-slate-600';
  const sub = isDark ? 'text-slate-500' : 'text-slate-400';

  function goTo(path: string | null) {
    setBrowsePath(path);
    setManualError(null);
    onChange(path);
  }

  function pickVolume(v: VolumeInfo) {
    setVolume(v);
    goTo(v.path);
  }

  /** Jump straight to the telescope's known mirror path. A synthetic volume
   *  floor is set to that same path so "up" navigation stops there rather
   *  than climbing arbitrarily high — the same guarantee a real drive gives. */
  function useSuggestedPath() {
    if (!suggestedPath) return;
    setVolume({ path: suggestedPath, label: t('serverFolderPicker.telescopeFolder'), totalBytes: 0, freeBytes: 0, writable: true, external: true });
    goTo(suggestedPath);
  }

  /** Open a path the user typed or pasted (a drive path like D:\Astro, or a
   *  network path like \\server\share\folder). Verified against the server
   *  before it's accepted so a wrong or unreachable path shows why here rather
   *  than failing later in the scan. The server-normalized path becomes the
   *  synthetic volume floor. */
  async function goToTypedPath(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed || checkingManual) return;
    setCheckingManual(true);
    setManualError(null);
    try {
      const result = await browseDirectory(trimmed);
      setVolume({ path: result.path, label: t('serverFolderPicker.customPath'), totalBytes: 0, freeBytes: 0, writable: true, external: true });
      goTo(result.path);
      setRecentPaths(rememberRecentPath(result.path));
      setManualPath('');
    } catch (err) {
      setManualError(err instanceof Error ? err.message : t('serverFolderPicker.cannotReadFolder'));
    } finally {
      setCheckingManual(false);
    }
  }

  const atVolumeRoot = volume ? browsePath === volume.path : true;
  const canGoUp = !!volume && !atVolumeRoot;

  return (
    <div className="space-y-4">
      {suggestedPath && !volume && (
        <button
          type="button"
          onClick={useSuggestedPath}
          className={`w-full text-left px-3 py-2.5 rounded-xl border transition-colors ${
            isDark ? 'border-accent-500/40 bg-accent-500/10 hover:bg-accent-500/15' : 'border-accent-300 bg-accent-50 hover:bg-accent-100'
          }`}
        >
          <span className={`text-sm font-medium flex items-center gap-2 ${body}`}>
            <Telescope className="w-4 h-4 shrink-0 text-accent-500" />
            {t('serverFolderPicker.knownPath')}
          </span>
          <div className={`text-xs font-mono mt-0.5 truncate ${sub}`} title={suggestedPath}>{suggestedPath}</div>
        </button>
      )}

      {/* Drives */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className={`text-xs font-medium uppercase tracking-wide ${sub}`}>{t('serverFolderPicker.drives')}</span>
          <button
            type="button"
            onClick={() => refetchVolumes()}
            className={`text-xs inline-flex items-center gap-1 ${sub} hover:opacity-80`}
          >
            <RefreshCw className="w-3 h-3" /> {t('serverFolderPicker.refresh')}
          </button>
        </div>
        {volumesLoading ? (
          <div className={`text-sm ${sub}`}>{t('serverFolderPicker.lookingForDrives')}</div>
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
                  <span className={`text-sm font-medium truncate flex items-center gap-2 ${body}`} title={v.label}>
                    <HardDrive className="w-4 h-4 shrink-0 text-accent-500" />
                    {v.label}
                  </span>
                  <span className={`text-xs tabular-nums shrink-0 ${sub}`}>{t('serverFolderPicker.freeSpace', { amount: formatBytes(v.freeBytes) })}</span>
                </div>
                <div className={`text-xs font-mono mt-0.5 truncate ${sub}`} title={v.path}>{v.path}</div>
              </button>
            ))}
            {(volumesData?.volumes ?? []).length === 0 && (
              <div className={`text-sm ${sub}`}>{t('serverFolderPicker.noDrivesFound')}</div>
            )}
          </div>
        )}
      </div>

      {/* Enter a path directly. Network shares and mapped drives don't appear in
          the list above (a mapped letter only exists in the user's own Windows
          session, and Nebulis runs as a service), so a UNC path is the way to
          reach a NAS. */}
      <div>
        <span className={`text-xs font-medium uppercase tracking-wide ${sub}`}>{t('serverFolderPicker.orEnterPath')}</span>
        <form
          className="flex items-center gap-2 mt-2"
          onSubmit={e => { e.preventDefault(); void goToTypedPath(manualPath); }}
        >
          <input
            type="text"
            value={manualPath}
            onChange={e => { setManualPath(e.target.value); setManualError(null); }}
            placeholder={t('serverFolderPicker.pathPlaceholder')}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            className={`flex-1 min-w-0 px-3 py-2 rounded-lg border text-sm font-mono outline-none transition ${
              isDark
                ? 'bg-slate-800 border-slate-700 text-slate-200 placeholder:text-slate-600 focus:border-accent-500/60'
                : 'bg-white border-slate-200 text-slate-800 placeholder:text-slate-400 focus:border-accent-400'
            }`}
          />
          <button
            type="submit"
            disabled={!manualPath.trim() || checkingManual}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition disabled:opacity-50"
          >
            {checkingManual ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <CornerDownLeft className="w-3.5 h-3.5" />}
            {t('serverFolderPicker.open')}
          </button>
        </form>
        {manualError && <p className="text-xs text-red-500 mt-1.5">{manualError}</p>}
        {recentPaths.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 mt-2">
            <Clock className={`w-3 h-3 shrink-0 ${sub}`} />
            {recentPaths.map(p => (
              <button
                key={p}
                type="button"
                onClick={() => void goToTypedPath(p)}
                title={p}
                className={`max-w-[16rem] truncate px-2 py-1 rounded-md text-xs font-mono border transition ${
                  isDark ? 'border-slate-800 text-slate-400 hover:bg-slate-800/50' : 'border-slate-200 text-slate-500 hover:bg-slate-50'
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Folder navigation */}
      {volume && (
        <div>
          <span className={`text-xs font-medium uppercase tracking-wide ${sub}`}>{t('serverFolderPicker.folderToImport')}</span>
          <div className="flex items-center gap-2 mt-2 mb-2">
            <button
              type="button"
              disabled={!canGoUp}
              onClick={() => {
                if (!browsePath || !canGoUp) return;
                const parent = browsePath.replace(/[\\/][^\\/]+$/, '');
                goTo(parent || volume.path);
              }}
              className={`shrink-0 p-1.5 rounded-lg ${canGoUp ? (isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100') : 'opacity-40'}`}
              title={t('serverFolderPicker.upOneFolder')}
            >
              <ArrowUp className={`w-4 h-4 ${body}`} />
            </button>
            {/* Wraps rather than truncates: this is the folder that will be
                imported, so it is the one path the user must be able to read in
                full, however deeply nested the backup tree is. */}
            <span className={`text-xs font-mono break-all flex-1 ${body}`}>{browsePath}</span>
          </div>
          <div className={`${isDark ? 'bg-slate-800/40' : 'bg-slate-50'} rounded-xl max-h-72 overflow-y-auto`}>
            {(browseData?.directories ?? []).map((d: DirectoryEntry) => (
              <button
                type="button"
                key={d.path}
                onClick={() => goTo(d.path)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm ${body} ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
              >
                <FolderOpen className="w-4 h-4 text-accent-500 shrink-0" />
                <span className="truncate flex-1" title={d.name}>{d.name}</span>
                <ChevronRight className="w-3.5 h-3.5 opacity-40" />
              </button>
            ))}
            {(browseData?.directories ?? []).length === 0 && (
              <div className={`px-3 py-2.5 text-xs ${sub}`}>{t('serverFolderPicker.noSubfolders')}</div>
            )}
          </div>
          <p className={`text-xs mt-2 ${sub}`}>
            {t('serverFolderPicker.importHint')}
          </p>
        </div>
      )}
    </div>
  );
}
