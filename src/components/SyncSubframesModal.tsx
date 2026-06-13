import { useEffect, useRef, useState } from 'react';
import {
  X, Minus, Download, CheckCircle, AlertCircle, Layers,
  WifiOff, RotateCw,
} from 'lucide-react';
import { syncSessionSubFrames, getImportStatus, cancelImport, formatTransportSuffix, type ImportStatus } from '../lib/api/library';
import { useTheme } from '../hooks/useTheme';
import { Modal } from './ui/Modal';
import { CloseConfirm } from './ui/CloseConfirm';

interface SyncSubframesModalProps {
  objectId: string;
  sessionId: string;
  /** Called when the modal closes after a completed sync, so the parent can refetch. */
  onComplete: () => void;
  onClose: () => void;
}

type Phase = 'starting' | 'waiting' | 'syncing' | 'done' | 'empty' | 'error';

export function SyncSubframesModal({ objectId, sessionId, onComplete, onClose }: SyncSubframesModalProps) {
  const { isDark } = useTheme();
  const [phase, setPhase] = useState<Phase>('starting');
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const completedRef = useRef(false);
  // Refs capture prop values at mount so the one-shot effect needs no deps.
  const objectIdRef = useRef(objectId);
  const sessionIdRef = useRef(sessionId);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function start() {
      // If another sync is already running, wait for it to finish then retry.
      // This handles the auto-import scheduler firing at the same moment.
      let attempt = 0;
      while (true) {
        try {
          await syncSessionSubFrames(objectIdRef.current, sessionIdRef.current);
          break; // lock acquired, sync started
        } catch (err) {
          if (cancelled) return;
          const msg = err instanceof Error ? err.message : '';
          const isLocked = msg.toLowerCase().includes('already in progress');
          if (isLocked && attempt < 20) {
            attempt++;
            setPhase('waiting');
            // Poll until the running sync finishes, then retry
            await new Promise<void>(resolve => {
              const id = setInterval(async () => {
                if (cancelled) { clearInterval(id); resolve(); return; }
                try {
                  const s = await getImportStatus();
                  if (!s.running) { clearInterval(id); resolve(); }
                } catch { /* network hiccup, keep waiting */ }
              }, 2000);
            });
            if (cancelled) return;
            continue;
          }
          setPhase('error');
          setErrorMsg(msg || 'Failed to start sync');
          return;
        }
      }

      if (cancelled) return;
      setPhase('syncing');

      let consecutiveErrors = 0;

      pollRef.current = setInterval(async () => {
        if (cancelled) { stopPolling(); return; }
        try {
          const s = await getImportStatus();
          consecutiveErrors = 0;
          if (cancelled) return;
          setStatus(s);
          if (!s.running) {
            stopPolling();
            completedRef.current = true;
            if (s.error) {
              setPhase('error');
              setErrorMsg(s.error);
            } else if (s.filesDone === 0) {
              setPhase('empty');
            } else {
              setPhase('done');
            }
            onCompleteRef.current();
          }
        } catch {
          consecutiveErrors++;
          if (!cancelled && consecutiveErrors >= 3) {
            stopPolling();
            setPhase('error');
            setErrorMsg('Lost connection while checking sync status.');
          }
        }
      }, 1500);
    }

    start();

    return () => {
      cancelled = true;
      stopPolling();
      // Cancel any in-flight server sync so the lock is released promptly.
      // This also handles React StrictMode's double-invoke (dev only), where
      // the first effect claims the lock and the second would otherwise block.
      if (!completedRef.current) {
        cancelImport().catch(() => {});
      }
    };
  }, []);

  const isFinished = phase === 'done' || phase === 'empty' || phase === 'error';
  const isActive = phase === 'starting' || phase === 'waiting' || phase === 'syncing';

  function handleClose() {
    stopPolling();
    if (!isFinished) {
      cancelImport().catch(() => {});
    }
    onClose();
  }

  // Subframes sync only ever runs against a single session, so basing
  // progress on filesDone / filesTotal matches the "128 / 392" count shown
  // in the header. The previous formula relied on the multi-object fields
  // (currentObjectFilesTotal / currentObjectFilesDone), which the subframe
  // sync path never populates — so the bar was stuck at 0% even while
  // files were ticking through.
  const progressPct = status && status.filesTotal > 0
    ? Math.round((status.filesDone / status.filesTotal) * 100)
    : null;

  // ── Minimized pill ────────────────────────────────────────────────────────
  if (minimized) {
    return (
      <button
        onClick={() => setMinimized(false)}
        className={`fixed bottom-5 right-5 z-[60] flex items-center gap-2.5 px-4 py-2.5 rounded-full shadow-xl border transition-all hover:scale-105 ${
          phase === 'error'
            ? isDark ? 'bg-red-950 border-red-800 text-red-300' : 'bg-red-50 border-red-300 text-red-700'
            : phase === 'done'
              ? isDark ? 'bg-green-950 border-green-800 text-green-300' : 'bg-green-50 border-green-300 text-green-700'
              : isDark ? 'bg-slate-900 border-slate-700 text-slate-300' : 'bg-white border-slate-300 text-slate-700'
        }`}
      >
        {phase === 'error' ? (
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
        ) : phase === 'done' ? (
          <CheckCircle className="w-4 h-4 flex-shrink-0" />
        ) : (
          <RotateCw className="w-4 h-4 flex-shrink-0 animate-spin" />
        )}
        <span className="text-sm font-medium">
          {phase === 'starting' && 'Connecting…'}
          {phase === 'waiting' && 'Waiting for sync…'}
          {phase === 'syncing' && (
            progressPct !== null ? `Syncing ${progressPct}%` : 'Syncing sub-frames…'
          )}
          {phase === 'done' && `${status?.filesDone ?? ''} files synced`}
          {phase === 'empty' && 'No new sub-frames'}
          {phase === 'error' && 'Sync error'}
        </span>
        <span className={`text-xs opacity-60`}>tap to expand</span>
      </button>
    );
  }

  // Closing during an active sync calls cancelImport, which throws away the
  // in-flight transfer of potentially hundreds of MB. Ask before doing that
  // on a stray backdrop click.
  const isDirty = isActive;
  const requestClose = () => {
    if (isDirty) setConfirmingClose(true);
    else handleClose();
  };

  // ── Full modal ─────────────────────────────────────────────────────────────
  return (
    <Modal
      isOpen
      onClose={requestClose}
      title="Sync Sub-Frames"
      className={`relative w-full max-w-md rounded-2xl shadow-2xl overflow-hidden ${
        isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white'
      }`}
    >
        {/* Header */}
        <div className={`flex items-center justify-between px-5 py-4 border-b ${
          isDark ? 'border-slate-800' : 'border-slate-100'
        }`}>
          <div className="flex items-center gap-2.5">
            <Download className={`w-4 h-4 ${isDark ? 'text-accent-400' : 'text-accent-600'}`} />
            <h3 className={`font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>
              Sync Sub-Frames
            </h3>
          </div>
          <div className="flex items-center gap-1">
            {!isFinished && (
              <button
                onClick={() => setMinimized(true)}
                className={`p-1.5 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
                title="Minimize"
              >
                <Minus className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={requestClose}
              className={`p-1.5 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
              title={isFinished ? 'Close' : 'Cancel'}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-5 py-6 space-y-5">

          {/* Starting */}
          {phase === 'starting' && (
            <div className="flex items-center gap-3">
              <RotateCw className="w-5 h-5 animate-spin text-accent-500 flex-shrink-0" />
              <div>
                <p className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                  Connecting to telescope…
                </p>
                <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  Requesting sub-frames for {sessionId}
                </p>
              </div>
            </div>
          )}

          {/* Waiting for another sync to finish */}
          {phase === 'waiting' && (
            <div className="flex items-center gap-3">
              <RotateCw className={`w-5 h-5 animate-spin flex-shrink-0 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
              <div>
                <p className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                  Waiting for current sync to finish…
                </p>
                <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  A backup sync is running. Sub-frame sync will start automatically when it finishes.
                </p>
              </div>
            </div>
          )}

          {/* Syncing */}
          {phase === 'syncing' && (
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <RotateCw className="w-5 h-5 animate-spin text-accent-500 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                    Downloading sub-frames…
                  </p>
                  {status?.currentObject && (
                    <p className={`text-xs mt-0.5 truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                      {status.currentObject}{formatTransportSuffix(status.telescopeName, status.transportKind)}
                    </p>
                  )}
                </div>
                {status && status.filesTotal > 0 && (
                  <span className={`text-sm font-mono tabular-nums flex-shrink-0 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                    {status.filesDone} / {status.filesTotal}
                  </span>
                )}
              </div>

              {/* Progress bar */}
              <div className={`h-2 rounded-full overflow-hidden ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                {progressPct !== null && (
                  <div
                    className="h-full rounded-full bg-accent-500 transition-all duration-500"
                    style={{ width: `${progressPct}%` }}
                  />
                )}
              </div>

              {status && status.filesTotal > 0 && (
                <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  {progressPct}% complete
                </p>
              )}
            </div>
          )}

          {/* Done */}
          {phase === 'done' && (
            <div className="flex items-start gap-3">
              <CheckCircle className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                  Sync complete
                </p>
                <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  {status?.filesDone ?? 0} sub-frame{(status?.filesDone ?? 0) !== 1 ? 's' : ''} downloaded successfully.
                </p>
              </div>
            </div>
          )}

          {/* Empty — no sub-frames on telescope */}
          {phase === 'empty' && (
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <Layers className={`w-5 h-5 flex-shrink-0 mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
                <div>
                  <p className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                    No sub-frames found
                  </p>
                  <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                    The telescope has no raw sub-frame files for this session date, or they have already been downloaded.
                  </p>
                </div>
              </div>
              <div className={`rounded-xl p-3 text-xs space-y-1 ${isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-50 text-slate-500'}`}>
                <p>Possible reasons:</p>
                <ul className="list-disc list-inside space-y-0.5 ml-1">
                  <li>Sub-frames were already synced previously</li>
                  <li>The telescope's SMB share is not reachable</li>
                  <li>The session folder does not have a <code>_sub</code> directory</li>
                </ul>
              </div>
            </div>
          )}

          {/* Error */}
          {phase === 'error' && (
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className={`text-sm font-medium ${isDark ? 'text-red-400' : 'text-red-600'}`}>
                  Sync failed
                </p>
                {errorMsg && (
                  <p className={`text-xs mt-0.5 font-mono break-all ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                    {errorMsg}
                  </p>
                )}
              </div>
            </div>
          )}

        </div>

        {/* Footer */}
        <div className={`px-5 py-3 border-t flex items-center justify-between ${
          isDark ? 'border-slate-800' : 'border-slate-100'
        }`}>
          {!isFinished && <span />}
          {phase === 'error' && (
            <WifiOff className={`w-4 h-4 ${isDark ? 'text-slate-600' : 'text-slate-400'}`} />
          )}
          {isFinished && <span />}

          <button
            onClick={requestClose}
            className={`ml-auto px-4 py-2 rounded-xl text-sm font-medium transition ${
              isFinished
                ? isDark ? 'bg-accent-500/15 text-accent-400 hover:bg-accent-500/25' : 'bg-accent-300 text-accent-700 hover:bg-accent-400'
                : isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            {isFinished ? 'Close' : 'Cancel'}
          </button>
        </div>
        {confirmingClose && (
          <CloseConfirm
            message="Stop the sub-frame sync and close?"
            onCancel={() => setConfirmingClose(false)}
            onDiscard={() => { setConfirmingClose(false); handleClose(); }}
          />
        )}
    </Modal>
  );
}
