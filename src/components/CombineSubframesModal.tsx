import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Download, RotateCw, CheckSquare, Square, Layers, PackageCheck, XCircle, AlertCircle } from 'lucide-react';
import {
  getLibrarySessions,
  startSubframesArchive,
  getSubframesArchiveStatus,
  type SubframesArchiveStatus,
} from '../lib/api/library';
import { useTheme } from '../hooks/useTheme';
import { Modal } from './ui/Modal';
import { CloseConfirm } from './ui/CloseConfirm';

interface Props {
  objectId: string;
  onClose: () => void;
}

type Phase = 'select' | 'preparing' | 'done';


function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function CombineSubframesModal({ objectId, onClose }: Props) {
  const { isDark } = useTheme();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<Phase>('select');
  const [zipSize, setZipSize] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [jobStatus, setSubframesArchiveStatus] = useState<SubframesArchiveStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelledRef = useRef(false);

  const { data: sessions, isLoading } = useQuery({
    queryKey: ['library-sessions', objectId],
    queryFn: () => getLibrarySessions(objectId),
  });

  const sessionsWithSubs = (sessions ?? []).filter(s => s.subFrameCount > 0);

  // Stop polling on unmount
  useEffect(() => () => {
    cancelledRef.current = true;
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  function toggleAll() {
    if (selected.size === sessionsWithSubs.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(sessionsWithSubs.map(s => s.date)));
    }
  }

  function toggle(date: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  }

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  function handleCancel() {
    cancelledRef.current = true;
    stopPolling();
    setPhase('select');
    setSubframesArchiveStatus(null);
  }

  async function pollStatus(jobId: string) {
    try {
      const status = await getSubframesArchiveStatus(jobId);
      if (cancelledRef.current) return;

      setSubframesArchiveStatus(status);

      if (status.status === 'done') {
        stopPolling();
        setZipSize(status.size ?? 0);
        setPhase('done');
        const a = document.createElement('a');
        a.href = `/api/library/download/tmp/${status.token}`;
        a.click();
      } else if (status.status === 'error') {
        stopPolling();
        setError(status.error ?? 'Archive failed');
        setPhase('select');
        setSubframesArchiveStatus(null);
      }
    } catch {
      // network hiccup — keep polling
    }
  }

  async function handleDownload() {
    if (selected.size === 0) return;

    cancelledRef.current = false;
    setPhase('preparing');
    setError(null);
    setSubframesArchiveStatus(null);

    try {
      const { jobId, filesTotal } = await startSubframesArchive(objectId, Array.from(selected));
      if (cancelledRef.current) return;

      setSubframesArchiveStatus({ status: 'running', filesTotal, filesDone: 0, elapsedMs: 0 });
      pollRef.current = setInterval(() => pollStatus(jobId), 500);
    } catch (err) {
      if (!cancelledRef.current) {
        setError(err instanceof Error ? err.message : 'Download failed');
        setPhase('select');
      }
    }
  }

  const allSelected = sessionsWithSubs.length > 0 && selected.size === sessionsWithSubs.length;

  const totalSubFrames = sessionsWithSubs
    .filter(s => selected.has(s.date))
    .reduce((sum, s) => sum + s.subFrameCount, 0);

  const pct = jobStatus && jobStatus.filesTotal > 0
    ? Math.round((jobStatus.filesDone / jobStatus.filesTotal) * 100)
    : 0;

  const etaMs = jobStatus && jobStatus.filesDone > 0
    ? (jobStatus.elapsedMs / jobStatus.filesDone) * (jobStatus.filesTotal - jobStatus.filesDone)
    : null;

  // Treat the modal as dirty during selection when the user has picked
  // sessions to combine. Closing in 'preparing' or 'done' phases is already
  // gated by the existing onClose guard above.
  const isDirty = phase === 'select' && selected.size > 0;
  const [confirmingClose, setConfirmingClose] = useState(false);
  const requestClose = () => {
    if (phase !== 'select') return;
    if (isDirty) setConfirmingClose(true);
    else onClose();
  };

  return (
    <Modal
      isOpen
      onClose={requestClose}
      title="Combine Subframes and Download"
      className={`relative w-full max-w-lg rounded-2xl shadow-2xl flex flex-col ${
        isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white shadow-xl'
      }`}
    >
        {/* Header */}
        <div className={`flex items-center justify-between px-5 py-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-accent-500" />
            <h2 className={`font-display font-semibold text-base ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
              Combine Subframes &amp; Download
            </h2>
          </div>
          {phase === 'select' && (
            <button
              onClick={requestClose}
              className={`p-1.5 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Body */}
        {phase === 'select' ? (
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2 max-h-96">
            {isLoading ? (
              <div className="flex items-center justify-center py-10">
                <RotateCw className={`w-5 h-5 animate-spin ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
              </div>
            ) : sessionsWithSubs.length === 0 ? (
              <div className={`text-center py-10 text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                No sessions with downloaded subframes found.
              </div>
            ) : (
              <>
                <button
                  onClick={toggleAll}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition ${
                    isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-50 text-slate-500'
                  }`}
                >
                  {allSelected
                    ? <CheckSquare className="w-4 h-4 text-accent-500 shrink-0" />
                    : <Square className="w-4 h-4 shrink-0" />}
                  Select all
                </button>

                <div className={`border-t ${isDark ? 'border-slate-800' : 'border-slate-100'}`} />

                {sessionsWithSubs.map(session => {
                  const isChecked = selected.has(session.date);
                  const label = session.date !== 'unknown'
                    ? new Date(session.date + 'T12:00:00').toLocaleDateString('en-US', {
                        year: 'numeric', month: 'long', day: 'numeric',
                      })
                    : 'Unknown date';

                  return (
                    <button
                      key={session.date}
                      onClick={() => toggle(session.date)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition ${
                        isChecked
                          ? isDark ? 'bg-accent-500/10 text-slate-100' : 'bg-accent-300 text-accent-700'
                          : isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-50 text-slate-700'
                      }`}
                    >
                      {isChecked
                        ? <CheckSquare className="w-4 h-4 text-accent-500 shrink-0" />
                        : <Square className={`w-4 h-4 shrink-0 ${isDark ? 'text-slate-600' : 'text-slate-300'}`} />}
                      <span className="flex-1 text-left">{label}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-md ${
                        isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-500'
                      }`}>
                        {session.subFrameCount} subframe{session.subFrameCount !== 1 ? 's' : ''}
                      </span>
                    </button>
                  );
                })}
              </>
            )}
          </div>
        ) : phase === 'preparing' ? (
          <div className="px-5 py-8 space-y-5">
            <div className="flex flex-col items-center gap-3 text-center">
              <div className={`w-12 h-12 rounded-full flex items-center justify-center ${isDark ? 'bg-accent-500/15' : 'bg-accent-50'}`}>
                <RotateCw className="w-5 h-5 text-accent-500 animate-spin" />
              </div>
              <div>
                <p className={`font-medium text-sm ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
                  Building Archive…
                </p>
                <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  {jobStatus
                    ? `${jobStatus.filesDone} of ${jobStatus.filesTotal} files packed`
                    : `Preparing ${totalSubFrames} subframe${totalSubFrames !== 1 ? 's' : ''}…`}
                </p>
              </div>
            </div>

            {/* Progress bar */}
            <div className="space-y-1.5">
              <div className={`w-full h-2.5 rounded-full overflow-hidden ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                <div
                  className="h-full rounded-full bg-accent-500 transition-all duration-300"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className={isDark ? 'text-slate-400' : 'text-slate-500'}>
                  {pct}%
                </span>
                <span className={isDark ? 'text-slate-500' : 'text-slate-400'}>
                  {jobStatus && jobStatus.elapsedMs > 0 ? (
                    etaMs !== null && etaMs > 500
                      ? `~${formatTime(etaMs)} remaining`
                      : `${formatTime(jobStatus.elapsedMs)} elapsed`
                  ) : null}
                </span>
              </div>
            </div>

            <p className={`text-center text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              The browser will start downloading once the archive is ready.
            </p>

            <div className="flex justify-center">
              <button
                onClick={handleCancel}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition ${
                  isDark
                    ? 'border border-slate-700 text-slate-300 hover:bg-slate-800'
                    : 'border border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                <XCircle className="w-4 h-4" />
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="px-5 py-8 flex flex-col items-center gap-3 text-center">
            <div className={`w-12 h-12 rounded-full flex items-center justify-center ${isDark ? 'bg-emerald-500/15' : 'bg-emerald-50'}`}>
              <PackageCheck className="w-5 h-5 text-emerald-500" />
            </div>
            <div>
              <p className={`font-medium text-sm ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
                Download started
              </p>
              <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                {zipSize > 0 ? `${formatBytes(zipSize)} ZIP` : 'Your ZIP file'} is downloading via your browser.
              </p>
            </div>
            <button
              onClick={onClose}
              className="mt-2 px-4 py-2 rounded-xl text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition"
            >
              Close
            </button>
          </div>
        )}

        {/* Footer — select phase only */}
        {phase === 'select' && (
          <div className={`px-5 py-4 border-t flex items-center justify-between gap-3 ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
            {error ? (
              <p className="text-xs text-red-500 flex items-center gap-1.5 flex-1">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                {error}
              </p>
            ) : (
              <p className={`text-xs flex-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                {selected.size > 0
                  ? `${selected.size} session${selected.size !== 1 ? 's' : ''} · ${totalSubFrames} subframe${totalSubFrames !== 1 ? 's' : ''}`
                  : 'Select sessions to combine'}
              </p>
            )}
            <div className="flex gap-2 shrink-0">
              <button
                onClick={requestClose}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition ${
                  isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'
                }`}
              >
                Cancel
              </button>
              <button
                onClick={handleDownload}
                disabled={selected.size === 0}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Download className="w-4 h-4" />
                Combine &amp; Download
              </button>
            </div>
          </div>
        )}
        {confirmingClose && (
          <CloseConfirm
            message="Discard your session selection?"
            onCancel={() => setConfirmingClose(false)}
            onDiscard={() => { setConfirmingClose(false); onClose(); }}
          />
        )}
    </Modal>
  );
}
