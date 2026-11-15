import { useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  X, Minus, Download, CheckCircle, AlertCircle, Layers,
  WifiOff, RotateCw,
} from 'lucide-react';
import { syncSessionSubFrames, syncObjectSubFrames, getImportStatus, cancelImport, formatTransportSuffix, type ImportStatus } from '../lib/api/library';
import { useTheme } from '../hooks/useTheme';
import { Modal } from './ui/Modal';
import { CloseConfirm } from './ui/CloseConfirm';

interface SyncSubframesModalProps {
  objectId: string;
  /** A single night's date, or null to sync every night of the object. */
  sessionId: string | null;
  /** Fetch every frame again, even one already on disk at the right size. Set only from the
   *  "download every frame again" confirmation, never by an ordinary sync. */
  force?: boolean;
  /** Called when the modal closes after a completed sync, so the parent can refetch. */
  onComplete: () => void;
  onClose: () => void;
}

type Phase = 'starting' | 'waiting' | 'syncing' | 'done' | 'upToDate' | 'empty' | 'error';

export function SyncSubframesModal({ objectId, sessionId, force = false, onComplete, onClose }: SyncSubframesModalProps) {
  const { isDark } = useTheme();
  const { t } = useTranslation('common');
  const [phase, setPhase] = useState<Phase>('starting');
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const completedRef = useRef(false);
  // StrictMode (dev) mounts, cleans up, and re-mounts the same instance in one
  // synchronous pass. Without this guard the first invocation's POST claims the
  // server import lock and its run is orphaned (no runId yet, so the cleanup
  // can't cancel it), while the second invocation's POST gets a 409 and sits in
  // 'waiting' for the whole duration of the sync it kicked off itself. Then it
  // retries, finds every file already downloaded, and reports "Already up to
  // date". One start per instance fixes it.
  const startedRef = useRef(false);
  // Cleanup sets this; the effect re-arms it so a StrictMode cleanup doesn't
  // abort the run the surviving instance still owns.
  const cancelledRef = useRef(false);
  // Set only once our own sync is confirmed running (from the first status
  // poll after 'syncing' starts). Null while 'starting' or 'waiting' — in
  // 'waiting' the active run belongs to someone else (e.g. the auto-import
  // scheduler raced in first), and closing the modal must not cancel it.
  const ownRunIdRef = useRef<string | null>(null);
  // Refs capture prop values at mount so the one-shot effect needs no deps.
  const objectIdRef = useRef(objectId);
  const sessionIdRef = useRef(sessionId);
  const forceRef = useRef(force);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  // Same reasoning as onCompleteRef: the mount-only effect below reads this
  // via the ref rather than depending on `t` directly, so a language switch
  // mid-sync doesn't re-run the effect's cleanup and cancel the in-flight
  // transfer.
  const tRef = useRef(t);
  tRef.current = t;

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  useEffect(() => {
    async function start() {
      // If another sync is already running, wait for it to finish then retry.
      // This handles the auto-import scheduler firing at the same moment.
      let attempt = 0;
      while (true) {
        try {
          const sid = sessionIdRef.current;
          const opts = forceRef.current ? { force: true } : undefined;
          if (sid) await syncSessionSubFrames(objectIdRef.current, sid, opts);
          else await syncObjectSubFrames(objectIdRef.current, opts);
          break; // lock acquired, sync started
        } catch (err) {
          if (cancelledRef.current) return;
          const msg = err instanceof Error ? err.message : '';
          const isLocked = msg.toLowerCase().includes('already in progress');
          if (isLocked && attempt < 20) {
            attempt++;
            setPhase('waiting');
            // Poll until the running sync finishes, then retry. Self-rescheduling
            // setTimeout (not setInterval) so a slow getImportStatus can't stack
            // concurrent requests on the already-busy server, and a bail after 5
            // consecutive failures so an unreachable server surfaces an error
            // instead of waiting forever.
            const finished = await new Promise<boolean>(resolve => {
              let waitErrors = 0;
              const tick = async () => {
                if (cancelledRef.current) { resolve(false); return; }
                try {
                  const s = await getImportStatus();
                  waitErrors = 0;
                  if (!s.running) { resolve(true); return; }
                } catch {
                  if (++waitErrors >= 5) { resolve(false); return; }
                }
                if (!cancelledRef.current) setTimeout(tick, 2000);
              };
              setTimeout(tick, 2000);
            });
            if (cancelledRef.current) return;
            if (!finished) {
              setPhase('error');
              setErrorMsg(tRef.current('syncSubframesModal.lostConnectionWaiting'));
              return;
            }
            continue;
          }
          setPhase('error');
          setErrorMsg(msg || tRef.current('syncSubframesModal.startFailed'));
          return;
        }
      }

      if (cancelledRef.current) return;
      setPhase('syncing');

      let consecutiveErrors = 0;

      pollRef.current = setInterval(async () => {
        if (cancelledRef.current) { stopPolling(); return; }
        try {
          const s = await getImportStatus();
          consecutiveErrors = 0;
          if (cancelledRef.current) return;
          setStatus(s);
          if (!ownRunIdRef.current && s.runId) ownRunIdRef.current = s.runId;
          if (!s.running) {
            stopPolling();
            completedRef.current = true;
            if (s.error) {
              setPhase('error');
              setErrorMsg(s.error);
            } else if (s.filesDone === 0) {
              // filesDone stays 0 both when nothing was found on the telescope
              // and when every candidate was already downloaded (toDownload
              // filters those out before the counter ever moves — see
              // syncSessionSubFrames in server/lib/library/import.ts).
              // skippedFiles is what tells those two apart.
              setPhase(s.skippedFiles > 0 ? 'upToDate' : 'empty');
            } else {
              setPhase('done');
            }
            onCompleteRef.current();
          }
        } catch {
          consecutiveErrors++;
          if (!cancelledRef.current && consecutiveErrors >= 3) {
            stopPolling();
            setPhase('error');
            setErrorMsg(tRef.current('syncSubframesModal.lostConnectionStatus'));
          }
        }
      }, 1500);
    }

    // Re-arm after a StrictMode cleanup, then start at most once per instance.
    cancelledRef.current = false;
    if (!startedRef.current) {
      startedRef.current = true;
      start();
    }

    return () => {
      cancelledRef.current = true;
      stopPolling();
      // Cancel our own in-flight server sync so the lock is released
      // promptly. Scoped to ownRunIdRef: while 'starting' or 'waiting' we
      // don't yet know (or don't own) the active run, and cancelling without
      // a runId would kill whatever import happens to be running, e.g. an
      // unrelated auto-import that raced in first.
      if (!completedRef.current && ownRunIdRef.current) {
        // The modal is unmounting either way, so there's nowhere left to show
        // an inline error — but a silently-failed cancel leaves the server
        // lock held with the user believing they stopped it, so at least log
        // it. The 6-hour stale-lock watchdog is the eventual backstop.
        cancelImport(ownRunIdRef.current).catch(err => console.warn('Failed to cancel sub-frame sync:', err));
      }
    };
  }, []);

  const isFinished = phase === 'done' || phase === 'upToDate' || phase === 'empty' || phase === 'error';
  const isActive = phase === 'starting' || phase === 'waiting' || phase === 'syncing';

  function handleClose() {
    stopPolling();
    if (!isFinished && ownRunIdRef.current) {
      cancelImport(ownRunIdRef.current).catch(err => console.warn('Failed to cancel sub-frame sync:', err));
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
          {phase === 'starting' && t('syncSubframesModal.connectingShort')}
          {phase === 'waiting' && t('syncSubframesModal.waitingShort')}
          {phase === 'syncing' && (
            progressPct !== null
              ? t('syncSubframesModal.syncingPercent', { percent: progressPct })
              : t('syncSubframesModal.syncingShort')
          )}
          {phase === 'done' && t('syncSubframesModal.filesSyncedShort', { count: status?.filesDone ?? 0 })}
          {phase === 'upToDate' && t('syncSubframesModal.upToDateShort')}
          {phase === 'empty' && t('syncSubframesModal.emptyShort')}
          {phase === 'error' && t('syncSubframesModal.errorShort')}
        </span>
        <span className={`text-xs opacity-60`}>{t('syncSubframesModal.tapToExpand')}</span>
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
      title={t('syncSubframesModal.title')}
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
              {t('syncSubframesModal.title')}
            </h3>
          </div>
          <div className="flex items-center gap-1">
            {!isFinished && (
              <button
                onClick={() => setMinimized(true)}
                className={`p-1.5 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
                title={t('syncSubframesModal.minimize')}
              >
                <Minus className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={requestClose}
              className={`p-1.5 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
              title={isFinished ? t('syncSubframesModal.close') : t('syncSubframesModal.cancel')}
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
                  {t('syncSubframesModal.connectingToTelescope')}
                </p>
                <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  {sessionId
                    ? t('syncSubframesModal.requestingSession', { sessionId })
                    : t('syncSubframesModal.requestingAllNights')}
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
                  {t('syncSubframesModal.waitingTitle')}
                </p>
                <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  {t('syncSubframesModal.waitingHint')}
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
                    {t('syncSubframesModal.downloading')}
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
                  {t('syncSubframesModal.percentComplete', { percent: progressPct })}
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
                  {t('syncSubframesModal.syncComplete')}
                </p>
                <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  {t('syncSubframesModal.filesSynced', { count: status?.filesDone ?? 0 })}
                </p>
              </div>
            </div>
          )}

          {/* Up to date — sub-frames exist but were all already downloaded */}
          {phase === 'upToDate' && (
            <div className="flex items-start gap-3">
              <CheckCircle className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                  {t('syncSubframesModal.upToDateTitle')}
                </p>
                <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  {sessionId
                    ? t('syncSubframesModal.upToDateSession', { count: status?.skippedFiles ?? 0 })
                    : t('syncSubframesModal.upToDateObject', { count: status?.skippedFiles ?? 0 })}
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
                    {t('syncSubframesModal.emptyTitle')}
                  </p>
                  <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                    {sessionId
                      ? t('syncSubframesModal.emptySession')
                      : t('syncSubframesModal.emptyObject')}
                  </p>
                </div>
              </div>
              <div className={`rounded-xl p-3 text-xs space-y-1 ${isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-50 text-slate-500'}`}>
                <p>{t('syncSubframesModal.possibleReasons')}</p>
                <ul className="list-disc list-inside space-y-0.5 ml-1">
                  <li>{sessionId ? t('syncSubframesModal.reasonNotEnabledSession') : t('syncSubframesModal.reasonNotEnabledObject')}</li>
                  <li>{t('syncSubframesModal.reasonShareUnreachable')}</li>
                  <li>
                    {sessionId ? (
                      <Trans i18nKey="syncSubframesModal.reasonNoSubFolderSession" ns="common" components={{ 1: <code /> }} />
                    ) : (
                      <Trans i18nKey="syncSubframesModal.reasonNoSubFolderObject" ns="common" components={{ 1: <code /> }} />
                    )}
                  </li>
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
                  {t('syncSubframesModal.errorTitle')}
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
            {isFinished ? t('syncSubframesModal.close') : t('syncSubframesModal.cancel')}
          </button>
        </div>
        {confirmingClose && (
          <CloseConfirm
            message={t('syncSubframesModal.closeConfirmMessage')}
            cancelLabel={t('syncSubframesModal.keepSyncing')}
            onCancel={() => setConfirmingClose(false)}
            onDiscard={() => { setConfirmingClose(false); handleClose(); }}
            isDark={isDark}
          />
        )}
    </Modal>
  );
}
