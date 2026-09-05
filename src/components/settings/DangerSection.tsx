import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, RotateCw, CheckCircle2, AlertCircle, Bug, Download, X } from 'lucide-react';
import {
  resetDatabase,
  getDebugLoggingStatus,
  enableDebugLogging,
  disableDebugLogging,
  downloadDebugLog,
} from '../../lib/api/settings';
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
            : 'Off. Turn on before an import to capture the session.'
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
        description="Compressed debug log. Available after a logged import run."
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
                    Deleting…
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
                {resetDb.error instanceof Error ? resetDb.error.message : 'The reset did not finish. Your data has not been changed. Try again, or check the system log.'}
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
