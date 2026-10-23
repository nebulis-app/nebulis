import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X, FolderOpen, Loader2 } from 'lucide-react';
import { getLibraryArchive, type ArchivedFolder } from '../../lib/api/library';
import type { TelescopeProfile } from '../../lib/api/telescopes';
import { Modal } from '../ui/Modal';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Read-only listing of one telescope's archived calibration frames
 * (CALI_FRAME, DWARF_DARK — see archiveFolders.ts). These are never library
 * objects; this is the only place in the UI they're visible at all, so the
 * absolute path is front and center for pointing Siril/PixInsight straight
 * at it. Unmatched RESTACKED leftovers are NOT telescope-scoped like these —
 * they land in a shared RESTACKED/ folder at the library root instead (see
 * getRestackArchiveDir), so they don't appear in this per-telescope view.
 */
export function ArchiveBrowserModal({
  telescope,
  isDark,
  onClose,
}: {
  telescope: TelescopeProfile;
  isDark: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('settings');
  const { data, isLoading } = useQuery({
    queryKey: ['telescope-archive', telescope.id],
    queryFn: () => getLibraryArchive(telescope.id),
  });
  const folders: ArchivedFolder[] = data?.folders ?? [];

  return (
    <Modal isOpen onClose={onClose} title={t('archiveBrowserModal.ariaLabel')}>
      <div
        className={`w-full max-w-lg rounded-2xl border shadow-xl ${
          isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
        }`}
      >
        <div className={`flex items-center justify-between px-5 py-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          <div>
            <h3 className={`text-base font-semibold ${isDark ? 'text-white' : 'text-slate-800'}`}>
              {t('archiveBrowserModal.title', { name: telescope.name })}
            </h3>
            <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {t('archiveBrowserModal.subtitle')}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label={t('archiveBrowserModal.close')}
            className={`p-1.5 rounded-lg transition shrink-0 ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 max-h-[60vh] overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center gap-2 py-6 justify-center">
              <Loader2 className={`w-4 h-4 animate-spin ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
              <span className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{t('archiveBrowserModal.loading')}</span>
            </div>
          ) : folders.length === 0 ? (
            <p className={`text-sm py-6 text-center ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{t('archiveBrowserModal.nothingArchived')}</p>
          ) : (
            <div className="space-y-2">
              {folders.map(f => (
                <div
                  key={f.name}
                  className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 ${
                    isDark ? 'border-slate-800 bg-slate-800/40' : 'border-slate-200 bg-slate-50'
                  }`}
                >
                  <FolderOpen className={`w-4 h-4 mt-0.5 shrink-0 ${isDark ? 'text-accent-400' : 'text-accent-600'}`} />
                  <div className="min-w-0 flex-1">
                    <div className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                      {f.name}
                    </div>
                    <div className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                      {t(f.fileCount === 1 ? 'archiveBrowserModal.fileCount_one' : 'archiveBrowserModal.fileCount_other', { count: f.fileCount })} · {formatBytes(f.bytes)}
                    </div>
                    <div className={`text-[0.6875rem] font-mono truncate mt-1 ${isDark ? 'text-slate-600' : 'text-slate-400'}`} title={f.path}>
                      {f.path}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className={`flex items-center justify-end gap-2 px-5 py-3 border-t ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-accent-500 text-white text-sm font-medium hover:bg-accent-600 transition"
          >
            {t('archiveBrowserModal.done')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
