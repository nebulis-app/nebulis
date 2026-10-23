import { useState } from 'react';
import { useQuery, skipToken } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Check, Database, Loader2, X } from 'lucide-react';

import {
  getArchivedFiles,
  getArchivedObjects,
  restoreArchivedFiles,
  type ArchivedFileEntry,
  type ArchivedObjectSummary,
} from '../../lib/api/storage';
import { formatBytes } from '../../lib/utils';
import { Modal } from '../ui/Modal';

/**
 * What is on the archive disk, and bringing it back.
 *
 * Two views in one modal, because the second is meaningless without the first: the
 * object list says which objects are on the disk and how many of their files are
 * missing locally, and selecting one shows the files themselves.
 *
 * Restore is the only destructive-direction action here (it writes into the library),
 * so its confirmation is driven by what the server actually reports rather than by a
 * guess made up front. The first call is made *without* overwrite; if the server comes
 * back with conflicts, those are named and the user is asked whether to replace them.
 * A local edit is therefore never lost without a question that mentioned it.
 *
 * Mirrors `ArchiveBrowserModal`'s shape, which is the existing read-only browser for
 * the unrelated calibration archive.
 */
export function ArchiveDiskModal({ isDark, onClose }: { isDark: boolean; onClose: () => void }) {
  const { t } = useTranslation('settings');

  const [folder, setFolder] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const objects = useQuery({ queryKey: ['archive-contents'], queryFn: getArchivedObjects });
  const files = useQuery({
    queryKey: ['archive-contents', folder],
    queryFn: folder !== null ? () => getArchivedFiles(folder) : skipToken,
    enabled: folder !== null,
  });

  const listedObjects: ArchivedObjectSummary[] = objects.data?.objects ?? [];
  const listedFiles: ArchivedFileEntry[] = files.data?.files ?? [];

  function toggle(relPath: string): void {
    setSelected(current => {
      const next = new Set(current);
      if (next.has(relPath)) next.delete(relPath);
      else next.add(relPath);
      return next;
    });
  }

  async function restore(): Promise<void> {
    if (folder === null || selected.size === 0) return;
    setBusy(true);
    setNotice('');
    setError('');
    try {
      const items = [...selected].map(relPath => ({ folderName: folder, relPath }));
      const first = await restoreArchivedFiles(items);

      let restored = first.restored;
      let skipped = first.skipped;
      let failures = first.failures;

      if (first.conflicts.length > 0) {
        // Named rather than counted: the user is agreeing to replace these specific
        // files, and those files are their only copy of whatever they changed.
        const confirmed = window.confirm(
          t('archiveDisk.overwriteConfirm', {
            count: first.conflicts.length,
            files: first.conflicts.slice(0, 5).join('\n'),
          }),
        );
        if (confirmed) {
          const retry = await restoreArchivedFiles(items, true);
          restored += retry.restored;
          skipped += retry.skipped;
          failures = [...failures, ...retry.failures];
        }
      }

      await Promise.all([objects.refetch(), files.refetch()]);
      setSelected(new Set());
      // Composed from two counted phrases rather than one sentence with two numbers
      // in it: i18next can pluralise one `count` per key, so a single key produced
      // "Restored 1, 0 already present." in every language. Each half now inflects.
      const restoredText = t('archiveDisk.restoredCount', { count: restored });
      const tail =
        failures.length > 0
          ? t('archiveDisk.failedCount', { count: failures.length })
          : t('archiveDisk.skippedPresent', { count: skipped });
      setNotice(`${restoredText}. ${tail}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('archiveDisk.restoreFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    // The panel classes go on `Modal`'s own dialog element, as every other modal in
    // this app does. Put on an inner `w-full` div instead, `w-full` resolves against a
    // shrink-to-fit parent and the dialog collapses to the width of its content: this
    // one rendered 252px wide against a `max-w-lg` that never applied.
    <Modal
      isOpen
      onClose={onClose}
      title={t('archiveDisk.ariaLabel')}
      className={`w-full max-w-lg rounded-2xl border shadow-xl ${
        isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
      }`}
    >
      <div className={`flex items-center justify-between px-5 py-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <div className="flex min-w-0 items-center gap-2">
          {folder !== null && (
            <button
              type="button"
              onClick={() => {
                setFolder(null);
                setSelected(new Set());
              }}
              aria-label={t('archiveDisk.back')}
              className={`shrink-0 rounded-lg p-1.5 transition ${
                isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'
              }`}
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <div className="min-w-0">
            <h3 className={`truncate text-base font-semibold ${isDark ? 'text-white' : 'text-slate-800'}`}>
              {folder ?? t('archiveDisk.title')}
            </h3>
            <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {folder === null ? t('archiveDisk.subtitle') : t('archiveDisk.filesSubtitle')}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('archiveDisk.close')}
          className={`shrink-0 rounded-lg p-1.5 transition ${
            isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'
          }`}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {(notice || error) && (
        <div className="space-y-2 px-5 pt-4">
          {notice && (
            <div
              className={`rounded-lg px-3.5 py-3 text-[0.75rem] leading-relaxed ${
                isDark ? 'bg-emerald-500/10 text-emerald-200/90' : 'bg-emerald-50 text-emerald-900'
              }`}
            >
              {notice}
            </div>
          )}
          {error && (
            <div
              className={`rounded-lg px-3.5 py-3 text-[0.75rem] leading-relaxed ${
                isDark ? 'bg-red-500/10 text-red-200/90' : 'bg-red-50 text-red-900'
              }`}
            >
              {error}
            </div>
          )}
        </div>
      )}

      <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
        {objects.isLoading || (folder !== null && files.isLoading) ? (
          <div className="flex items-center justify-center gap-2 py-6">
            <Loader2 className={`h-4 w-4 animate-spin ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
            <span className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{t('archiveDisk.loading')}</span>
          </div>
        ) : folder === null ? (
          listedObjects.length === 0 ? (
            <p className={`py-6 text-center text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {t('archiveDisk.nothingArchived')}
            </p>
          ) : (
            <div className="space-y-2">
              {listedObjects.map(object => (
                <button
                  key={object.folderName}
                  type="button"
                  onClick={() => setFolder(object.folderName)}
                  className={`flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
                    isDark ? 'border-slate-800 bg-slate-800/40 hover:bg-slate-800' : 'border-slate-200 bg-slate-50 hover:bg-slate-100'
                  }`}
                >
                  <Database className={`mt-0.5 h-4 w-4 shrink-0 ${isDark ? 'text-accent-400' : 'text-accent-600'}`} />
                  <span className="min-w-0 flex-1">
                    <span className={`block text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                      {object.folderName}
                    </span>
                    <span className={`block text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                      {t('archiveDisk.objectFiles', { count: object.filesTotal })}
                      {' · '}
                      {t('archiveDisk.objectSubframes', { count: object.subframes })}
                      {' · '}
                      {formatBytes(object.bytes)}
                    </span>
                    <span className={`mt-0.5 block text-[0.6875rem] ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                      {object.objectId === null
                        ? t('archiveDisk.notInLibrary')
                        : t('archiveDisk.missingLocally', { count: object.missingLocally })}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )
        ) : (
          <div className="space-y-1.5">
            {listedFiles.map(file => (
              <label
                key={file.relPath}
                className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 ${
                  isDark ? 'border-slate-800 bg-slate-800/30' : 'border-slate-200 bg-slate-50'
                }`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(file.relPath)}
                  onChange={() => toggle(file.relPath)}
                  className="h-4 w-4 shrink-0 rounded accent-accent-500"
                />
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-[0.8125rem] ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                    {file.relPath}
                  </span>
                  <span className={`block text-[0.6875rem] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    {formatBytes(file.bytes)}
                    {file.isSubframe ? ` · ${t('archiveDisk.subframe')}` : ''}
                    {file.presentLocally ? ` · ${t('archiveDisk.presentLocally')}` : ` · ${t('archiveDisk.missing')}`}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      {folder !== null && (
        <p className={`px-5 pb-3 text-[0.75rem] leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          {t('archiveDisk.restoreNote')}
        </p>
      )}

      <div className={`flex items-center justify-end gap-2 border-t px-5 py-3 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <button
          type="button"
          onClick={onClose}
          className={`rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
            isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'
          }`}
        >
          {t('archiveDisk.done')}
        </button>
        {folder !== null && (
          <button
            type="button"
            onClick={restore}
            disabled={busy || selected.size === 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" />
            {t('archiveDisk.restoreSelected', { count: selected.size })}
          </button>
        )}
      </div>
    </Modal>
  );
}
