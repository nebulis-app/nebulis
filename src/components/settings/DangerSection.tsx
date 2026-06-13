import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, RotateCw, CheckCircle2, AlertCircle, Bug, Download, X, Search } from 'lucide-react';
import {
  resetDatabase,
  getDebugLoggingStatus,
  enableDebugLogging,
  disableDebugLogging,
  downloadDebugLog,
} from '../../lib/api/settings';
import { purgeSubFramePreviews, type SubFramePreviewPurgeResult } from '../../lib/api/library';
import { Sec, Row } from './SettingsUI';

function DebugLoggingSection({ isDark }: { isDark: boolean }) {
  const queryClient = useQueryClient();
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const { data: status } = useQuery({
    queryKey: ['debug-logging-status'],
    queryFn: getDebugLoggingStatus,
    refetchInterval: (query) => (query.state.data?.enabled ? 5_000 : 30_000),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['debug-logging-status'] });

  const enableMutation = useMutation({ mutationFn: enableDebugLogging, onSuccess: invalidate });
  const disableMutation = useMutation({ mutationFn: disableDebugLogging, onSuccess: invalidate });

  const isEnabled = status?.enabled ?? false;
  const hasLog = status?.hasLog ?? false;
  const minutesRemaining = status?.minutesRemaining ?? 0;
  const isPending = enableMutation.isPending || disableMutation.isPending;

  const handleToggle = () => {
    setDownloadError(null);
    if (isEnabled) disableMutation.mutate();
    else enableMutation.mutate();
  };

  const handleDownload = async () => {
    setDownloadError(null);
    setDownloading(true);
    try {
      await downloadDebugLog();
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Sec
      title="Debug logging"
      description="Captures detailed logs from import runs: disk detection, network access, every file found and downloaded, and any errors. Active for 15 minutes or until you turn it off."
      isDark={isDark}
    >
      <Row
        label="Debug logging"
        description={
          isEnabled
            ? `Active. Turns off in ${minutesRemaining} min.`
            : 'Off. Turn on before running an import to capture the session.'
        }
        isDark={isDark}
      >
        <div className="flex items-center gap-3">
          {isEnabled && (
            <span className={`flex items-center gap-1.5 text-xs font-medium ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
              <Bug className="w-3.5 h-3.5" />
              Active
            </span>
          )}
          <button
            onClick={handleToggle}
            disabled={isPending}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm ${
              isEnabled
                ? isDark
                  ? 'bg-slate-700 text-slate-200 hover:bg-slate-600'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                : isDark
                  ? 'bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 shadow-amber-500/10'
                  : 'bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200'
            }`}
          >
            {isPending && <RotateCw className="w-4 h-4 animate-spin" />}
            {isEnabled ? 'Turn off' : 'Turn on'}
          </button>
        </div>
      </Row>

      <Row
        label="Download log"
        description="Download the current debug log as a compressed file. Only available after an import has run with debug logging on."
        isDark={isDark}
      >
        <div className="flex flex-col items-end gap-2">
          <button
            onClick={handleDownload}
            disabled={!hasLog || downloading}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed bg-slate-600 text-white hover:bg-slate-500 shadow-sm"
          >
            {downloading ? <RotateCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            Download .log.gz
          </button>
          {downloadError && (
            <p className="flex items-center gap-1.5 text-xs text-red-500">
              <AlertCircle className="w-3.5 h-3.5" />
              {downloadError}
            </p>
          )}
        </div>
      </Row>
    </Sec>
  );
}

function SubFramePreviewReviewModal({
  isDark,
  result,
  onClose,
  onDeleted,
}: {
  isDark: boolean;
  result: SubFramePreviewPurgeResult;
  onClose: () => void;
  onDeleted: (deleted: number) => void;
}) {
  const queryClient = useQueryClient();
  const purge = useMutation({
    mutationFn: () => purgeSubFramePreviews(false),
    onSuccess: (res) => {
      queryClient.invalidateQueries();
      onDeleted(res.deleted);
    },
  });

  const { matched, groups } = result;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={purge.isPending ? undefined : onClose} />
      <div className={`relative w-full max-w-lg max-h-[85vh] flex flex-col rounded-2xl shadow-2xl ${isDark ? 'bg-slate-900 border border-slate-700' : 'bg-white border border-slate-200'}`}>
        <div className="p-6 pb-4">
          {!purge.isPending && (
            <button
              onClick={onClose}
              className={`absolute top-4 right-4 p-1.5 rounded-lg transition-colors ${isDark ? 'text-slate-400 hover:text-slate-200 hover:bg-slate-800' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'}`}
            >
              <X className="w-4 h-4" />
            </button>
          )}
          <h3 className={`text-base font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
            Review files to delete
          </h3>
          <p className={`text-sm mt-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            {matched} preview file{matched === 1 ? '' : 's'} across {groups.length} folder{groups.length === 1 ? '' : 's'}.
            Raw <span className="font-mono text-xs">.fit</span> sub-frames and stacked images are not affected.
          </p>
        </div>

        {/* Grouped file list */}
        <div className={`flex-1 overflow-y-auto mx-6 rounded-xl border ${isDark ? 'border-slate-800 bg-slate-950/40' : 'border-slate-200 bg-slate-50'}`}>
          {groups.map((g) => (
            <div key={g.folder} className={`border-b last:border-b-0 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
              <div className={`flex items-center justify-between px-3 py-2 sticky top-0 ${isDark ? 'bg-slate-900/95 text-slate-200' : 'bg-white/95 text-slate-700'}`}>
                <span className="text-sm font-medium truncate">{g.folder}</span>
                <span className={`text-xs shrink-0 ml-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  {g.count} file{g.count === 1 ? '' : 's'}
                </span>
              </div>
              <ul className={`px-3 pb-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                {g.files.map((f) => (
                  <li key={f} className="font-mono text-[11px] leading-relaxed truncate">{f}</li>
                ))}
                {g.count > g.files.length && (
                  <li className="text-[11px] italic mt-0.5">…and {g.count - g.files.length} more</li>
                )}
              </ul>
            </div>
          ))}
        </div>

        <div className="p-6 pt-4 flex gap-3">
          <button
            onClick={() => !purge.isPending && onClose()}
            disabled={purge.isPending}
            className={`flex-1 px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${isDark ? 'bg-slate-700 text-slate-200 hover:bg-slate-600' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
          >
            Cancel
          </button>
          <button
            onClick={() => purge.mutate()}
            disabled={purge.isPending}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed bg-red-600 text-white hover:bg-red-700 shadow-sm shadow-red-500/20"
          >
            {purge.isPending
              ? <><RotateCw className="w-4 h-4 animate-spin" />Deleting…</>
              : <><Trash2 className="w-4 h-4" />Delete {matched} file{matched === 1 ? '' : 's'}</>}
          </button>
        </div>

        {purge.isError && (
          <p className="flex items-center gap-1.5 text-xs text-red-500 px-6 pb-4 -mt-2">
            <AlertCircle className="w-3.5 h-3.5" />
            {purge.error instanceof Error ? purge.error.message : 'Delete failed'}
          </p>
        )}
      </div>
    </div>
  );
}

function SubFramePreviewCleanup({ isDark }: { isDark: boolean }) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const [lastDeleted, setLastDeleted] = useState<number | null>(null);

  const scan = useMutation({
    mutationFn: () => purgeSubFramePreviews(true),
    onSuccess: (res) => {
      setLastDeleted(null);
      if (res.matched > 0) setReviewOpen(true);
    },
  });

  const noneFound = scan.isSuccess && scan.data.matched === 0 && lastDeleted === null;

  return (
    <Sec
      title="Clean up sub-frame previews"
      description="Older imports copied frame-named preview images (e.g. Light_*.jpg) out of the telescope's _sub folder into your library. This removes only those previews. Raw .fit sub-frames and stacked JPGs are not affected."
      isDark={isDark}
    >
      <Row
        label="Preview JPGs"
        description="Scan the library, review the matches, then remove the leftover Light_*.jpg previews."
        isDark={isDark}
      >
        <div className="flex flex-col items-end gap-2">
          {lastDeleted !== null ? (
            <span className="flex items-center gap-1.5 text-sm font-medium text-emerald-500">
              <CheckCircle2 className="w-4 h-4" />
              Removed {lastDeleted} file{lastDeleted === 1 ? '' : 's'}
            </span>
          ) : noneFound ? (
            <span className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              No preview files found.
            </span>
          ) : null}
          <button
            onClick={() => scan.mutate()}
            disabled={scan.isPending}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm ${
              isDark ? 'bg-slate-700 text-slate-200 hover:bg-slate-600' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            {scan.isPending ? <RotateCw className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            {lastDeleted !== null || noneFound ? 'Scan again' : 'Scan for previews'}
          </button>
          {scan.isError && (
            <p className="flex items-center gap-1.5 text-xs text-red-500">
              <AlertCircle className="w-3.5 h-3.5" />
              {scan.error instanceof Error ? scan.error.message : 'Scan failed'}
            </p>
          )}
        </div>
      </Row>

      {reviewOpen && scan.data && (
        <SubFramePreviewReviewModal
          isDark={isDark}
          result={scan.data}
          onClose={() => setReviewOpen(false)}
          onDeleted={(n) => { setLastDeleted(n); setReviewOpen(false); }}
        />
      )}
    </Sec>
  );
}

function DeleteConfirmModal({ isDark, onClose }: { isDark: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [confirmText, setConfirmText] = useState('');

  const resetDb = useMutation({
    mutationFn: resetDatabase,
    onSuccess: () => {
      queryClient.invalidateQueries();
    },
  });

  const canConfirm = confirmText === 'delete' && !resetDb.isPending && !resetDb.isSuccess;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={resetDb.isPending ? undefined : onClose} />
      <div className={`relative w-full max-w-md rounded-2xl shadow-2xl p-6 ${isDark ? 'bg-slate-900 border border-slate-700' : 'bg-white border border-slate-200'}`}>
        {!resetDb.isSuccess && !resetDb.isPending && (
          <button
            onClick={onClose}
            className={`absolute top-4 right-4 p-1.5 rounded-lg transition-colors ${isDark ? 'text-slate-400 hover:text-slate-200 hover:bg-slate-800' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'}`}
          >
            <X className="w-4 h-4" />
          </button>
        )}

        {resetDb.isSuccess ? (
          <div className="flex flex-col items-center gap-4 py-2 text-center">
            <CheckCircle2 className="w-10 h-10 text-emerald-500" />
            <div>
              <p className={`font-semibold text-base ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Data deleted</p>
              <p className={`text-sm mt-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Your settings and accounts were preserved.</p>
            </div>
            <button
              onClick={onClose}
              className="mt-2 px-5 py-2 rounded-lg text-sm font-semibold bg-slate-600 text-white hover:bg-slate-500 transition-colors"
            >
              Close
            </button>
          </div>
        ) : (
          <>
            <div className={`flex items-center gap-3 mb-5 p-3 rounded-xl ${isDark ? 'bg-red-500/10 border border-red-500/20' : 'bg-red-50 border border-red-200'}`}>
              <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
              <p className={`text-sm ${isDark ? 'text-red-300' : 'text-red-700'}`}>
                This permanently removes all imported images, observations, notes, wishlist items, favorites, cached images, and satellite data. This cannot be undone.
              </p>
            </div>

            <p className={`text-sm font-medium mb-2 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              Type <span className={`font-mono font-bold ${isDark ? 'text-red-400' : 'text-red-600'}`}>delete</span> to confirm
            </p>
            <input
              type="text"
              placeholder="delete"
              value={confirmText}
              onChange={e => setConfirmText(e.target.value)}
              disabled={resetDb.isPending}
              autoFocus
              className={`w-full px-3 py-2 rounded-lg border text-sm transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30 disabled:opacity-40 mb-4 ${
                isDark
                  ? 'bg-slate-800 border-red-500/20 text-slate-200 placeholder-slate-600 focus:border-red-500/40'
                  : 'bg-white border-red-200 text-slate-800 placeholder-slate-400 focus:border-red-400'
              }`}
            />

            <div className="flex gap-3">
              <button
                onClick={() => !resetDb.isPending && onClose()}
                disabled={resetDb.isPending}
                className={`flex-1 px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${isDark ? 'bg-slate-700 text-slate-200 hover:bg-slate-600' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
              >
                Cancel
              </button>
              <button
                onClick={() => resetDb.mutate()}
                disabled={!canConfirm}
                className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed bg-red-600 text-white hover:bg-red-700 shadow-sm shadow-red-500/20"
              >
                {resetDb.isPending ? (
                  <>
                    <RotateCw className="w-4 h-4 animate-spin" />
                    Deleting...
                  </>
                ) : (
                  <>
                    <Trash2 className="w-4 h-4" />
                    Delete all data
                  </>
                )}
              </button>
            </div>

            {resetDb.isError && (
              <p className="flex items-center gap-1.5 text-xs text-red-500 mt-3">
                <AlertCircle className="w-3.5 h-3.5" />
                {resetDb.error instanceof Error ? resetDb.error.message : 'Failed to reset database'}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function DangerSection({ isDark }: { isDark: boolean }) {
  const [showModal, setShowModal] = useState(false);

  return (
    <>
      <DebugLoggingSection isDark={isDark} />

      <SubFramePreviewCleanup isDark={isDark} />

      <Sec
        title="Delete all data"
        description="Permanently delete imported library data, observations, notes, wishlist items, favorites, cached images, and satellite data. Settings, accounts, and telescope profiles are preserved."
        isDark={isDark}
      >
        <Row label="Reset database" description="Removes everything listed above. Irreversible." isDark={isDark}>
          <button
            onClick={() => setShowModal(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-150 bg-red-600 text-white hover:bg-red-700 shadow-sm shadow-red-500/20"
          >
            <Trash2 className="w-4 h-4" />
            Delete all data
          </button>
        </Row>
      </Sec>

      {showModal && (
        <DeleteConfirmModal isDark={isDark} onClose={() => setShowModal(false)} />
      )}
    </>
  );
}
