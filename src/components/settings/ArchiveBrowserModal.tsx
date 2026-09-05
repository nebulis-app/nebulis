import { useQuery } from '@tanstack/react-query';
import { X, FolderOpen, Loader2 } from 'lucide-react';
import { getLibraryArchive, type ArchivedFolder } from '../../lib/api/library';
import type { TelescopeProfile } from '../../lib/api/telescopes';

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
  const { data, isLoading } = useQuery({
    queryKey: ['telescope-archive', telescope.id],
    queryFn: () => getLibraryArchive(telescope.id),
  });
  const folders: ArchivedFolder[] = data?.folders ?? [];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Archived calibration data"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className={`w-full max-w-lg rounded-2xl border shadow-xl ${
          isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
        }`}
      >
        <div className={`flex items-center justify-between px-5 py-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          <div>
            <h3 className={`text-base font-semibold ${isDark ? 'text-white' : 'text-slate-800'}`}>
              Archived from {telescope.name}
            </h3>
            <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              Calibration frames with nowhere else to go — kept, never modeled as objects.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className={`p-1.5 rounded-lg transition shrink-0 ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 max-h-[60vh] overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center gap-2 py-6 justify-center">
              <Loader2 className={`w-4 h-4 animate-spin ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
              <span className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Loading…</span>
            </div>
          ) : folders.length === 0 ? (
            <p className={`text-sm py-6 text-center ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Nothing archived yet.</p>
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
                      {f.fileCount} file{f.fileCount === 1 ? '' : 's'} · {formatBytes(f.bytes)}
                    </div>
                    <div className={`text-[11px] font-mono truncate mt-1 ${isDark ? 'text-slate-600' : 'text-slate-400'}`} title={f.path}>
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
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
