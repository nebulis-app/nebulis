import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Trash2 } from 'lucide-react';
import {
  getDatabaseBackups,
  createDatabaseBackup,
  deleteDatabaseBackup,
  downloadDatabaseBackup,
  type DatabaseBackupInfo,
} from '../../lib/api/storage';
import { formatBytes } from '../../lib/utils';
import { Sec } from './SettingsUI';

/**
 * Pre-upgrade database snapshots.
 *
 * The server copies nebulis.db into {DATA_DIR}/backups/ automatically at boot
 * whenever the version changed, before it runs any schema migration. This
 * screen shows what's kept, lets an admin take one on demand, and lets them
 * download one to keep permanently or hand to a restore.
 */
export function DatabaseBackupsSection({ isDark }: { isDark: boolean }) {
  const { data, refetch, isLoading } = useQuery({
    queryKey: ['db-backups'],
    queryFn: getDatabaseBackups,
    staleTime: 15_000,
  });

  const [busy, setBusy] = useState<null | 'create' | string>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const backups = data?.backups ?? [];
  const keep = data?.maxRetainedPerKind ?? 3;
  const failed = data?.lastAttempt?.status === 'failed' ? data.lastAttempt : null;

  const runCreate = async () => {
    setBusy('create');
    setError(null);
    setNotice(null);
    try {
      const res = await createDatabaseBackup();
      setNotice(`Saved ${res.backup.name} (${formatBytes(res.backup.sizeBytes)}).`);
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Backup failed');
    } finally {
      setBusy(null);
    }
  };

  const runDownload = async (b: DatabaseBackupInfo) => {
    setBusy(b.name);
    setError(null);
    try {
      await downloadDatabaseBackup(b.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setBusy(null);
    }
  };

  const runDelete = async (b: DatabaseBackupInfo) => {
    if (!window.confirm(`Delete ${b.name}? This cannot be undone.`)) return;
    setBusy(b.name);
    setError(null);
    setNotice(null);
    try {
      await deleteDatabaseBackup(b.name);
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusy(null);
    }
  };

  const btnBase =
    'px-3.5 py-2 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const subtle = isDark ? 'text-slate-400' : 'text-slate-600';

  return (
    <Sec
      title="Database backups"
      description="Automatic snapshots taken before each version upgrade."
      isDark={isDark}
    >
      <div className="px-5 py-5 space-y-4">
        <p className={`text-[13px] leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
          Just before applying a new version, Nebulis copies its database so you can return to an
          older release if you need to. The {keep} newest of each type are kept. Downloading a
          backup keeps it even after it would otherwise be removed. This does not include your
          images or library folder.
        </p>

        {failed && (
          <div
            className={`rounded-lg px-3.5 py-3 text-[12px] leading-relaxed ${
              isDark ? 'bg-red-500/10 text-red-200/90' : 'bg-red-50 text-red-900'
            }`}
          >
            The last automatic backup, before version {failed.toVersion}, failed: {failed.error}.
            The server started anyway. Free up disk space and restart to try again, or take one now.
          </div>
        )}

        {notice && (
          <div
            className={`rounded-lg px-3.5 py-3 text-[12px] ${
              isDark ? 'bg-emerald-500/10 text-emerald-200/90' : 'bg-emerald-50 text-emerald-900'
            }`}
          >
            {notice}
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

        {isLoading ? (
          <p className={`text-[13px] ${subtle}`}>Loading...</p>
        ) : backups.length === 0 ? (
          <p className={`text-[13px] ${subtle}`}>
            No backups yet. One is created automatically the next time you upgrade, or take one now.
          </p>
        ) : (
          <ul className={`rounded-lg border divide-y ${isDark ? 'border-slate-800 divide-slate-800' : 'border-slate-200 divide-slate-100'}`}>
            {backups.map(b => (
              <li key={b.name} className="flex items-center gap-3 px-3.5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`text-[13px] font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                      {b.version ? `v${b.version}` : 'Unknown version'}
                    </span>
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${
                        b.kind === 'upgrade'
                          ? isDark ? 'bg-accent-500/15 text-accent-300' : 'bg-accent-100 text-accent-700'
                          : isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-500'
                      }`}
                    >
                      {b.kind}
                    </span>
                  </div>
                  <div className={`mt-0.5 text-[11.5px] ${subtle}`}>
                    {new Date(b.createdAt).toLocaleString()} · {formatBytes(b.sizeBytes)}
                  </div>
                  <div className={`mt-0.5 text-[11px] font-mono break-all ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                    {b.name}
                  </div>
                </div>
                <button
                  onClick={() => runDownload(b)}
                  disabled={busy !== null}
                  title="Download"
                  className={`${btnBase} ${isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-200' : 'bg-slate-100 hover:bg-slate-200 text-slate-700'}`}
                >
                  <Download className="w-4 h-4" />
                </button>
                <button
                  onClick={() => runDelete(b)}
                  disabled={busy !== null}
                  title="Delete"
                  className={`${btnBase} ${isDark ? 'bg-red-500/10 hover:bg-red-500/20 text-red-300' : 'bg-red-50 hover:bg-red-100 text-red-700'}`}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {data?.dir && (
          <p className={`text-[11px] font-mono break-all ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
            {data.dir}
          </p>
        )}

        <button
          onClick={runCreate}
          disabled={busy !== null}
          className={`${btnBase} ${isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-200' : 'bg-slate-100 hover:bg-slate-200 text-slate-700'}`}
        >
          {busy === 'create' ? 'Backing up...' : 'Back up now'}
        </button>
      </div>
    </Sec>
  );
}
