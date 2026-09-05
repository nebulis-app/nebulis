import { useState, useRef, useCallback, useEffect } from 'react';
import {
  X, Minus, Satellite, Loader2, Trash2, AlertTriangle,
  CheckCircle2, ChevronLeft, ChevronRight, RotateCw,
} from 'lucide-react';
import { detectSatelliteTrail, type SatelliteTrailResult } from '../lib/api/observations';
import { deleteLibraryFile } from '../lib/api/library';
import { FitsViewer } from './FitsViewer';
import { FitsThumbnail } from './FitsThumbnail';
import type { SessionFile } from '../types';
import { Modal } from './ui/Modal';
import { CloseConfirm } from './ui/CloseConfirm';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  files: SessionFile[];
  onFilesDeleted: () => void;
  isDark: boolean;
}

type Phase = 'ready' | 'scanning' | 'done';

interface TrailCard {
  file: SessionFile;
  result: SatelliteTrailResult;
  deleted: boolean;
}

// Detection is synchronous CPU work on the server's main Node thread. Sending
// multiple requests at once does not make them run in parallel, it just queues
// extra work that is harder to cancel and makes the app feel frozen longer.
const CONCURRENCY = 1;

function formatDuration(ms: number): string {
  if (ms < 5000) return '< 5 s';
  if (ms < 60000) return `~${Math.round(ms / 1000)} s`;
  const m = Math.round(ms / 60000);
  return `~${m} min`;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export function SatelliteTrailScanModal({ isOpen, onClose, files, onFilesDeleted, isDark }: Props) {
  const [phase, setPhase] = useState<Phase>('ready');
  const [trailCards, setTrailCards] = useState<TrailCard[]>([]);
  const [completedCount, setCompletedCount] = useState(0);
  const [errorCount, setErrorCount] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const cancelRef = useRef(false);
  const startTimeRef = useRef<number>(0);
  const abortControllersRef = useRef<Set<AbortController>>(new Set());
  const thumbRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [activeFileName, setActiveFileName] = useState<string | null>(null);

  const fitsFiles = files.filter(f => f.type === 'fits');
  const visibleCards = trailCards.filter(c => !c.deleted);
  // Clamp on read — raw selectedIndex may point past the end after deletions,
  // but every consumer goes through currentIndex so it never matters (this is
  // why there's no corrective setState-in-effect keeping the two in sync).
  const currentIndex = Math.min(selectedIndex, Math.max(0, visibleCards.length - 1));
  const currentCard = visibleCards[currentIndex] ?? null;

  // Reset when modal opens
  useEffect(() => {
    if (isOpen) {
      setPhase('ready');
      setTrailCards([]);
      setCompletedCount(0);
      setErrorCount(0);
      setSelectedIndex(0);
      setMinimized(false);
      cancelRef.current = false;
    }
    // cancelRef was previously only set from the in-modal Cancel/discard
    // buttons — closing via nav, browser back, or a parent unmount left the
    // scan queue's worker slots running server-side detection (a full
    // Radon-projection FITS parse per subframe) with nowhere for the result
    // to land.
    return () => {
      cancelRef.current = true;
      abortControllersRef.current.forEach(controller => controller.abort());
      abortControllersRef.current.clear();
    };
  }, [isOpen]);

  // Scroll selected thumbnail into view
  useEffect(() => {
    thumbRefs.current[currentIndex]?.scrollIntoView({
      behavior: 'smooth',
      inline: 'center',
      block: 'nearest',
    });
  }, [currentIndex]);

  // Keyboard navigation. Escape is handled by the Modal primitive.
  useEffect(() => {
    if (!isOpen || minimized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft')  { e.preventDefault(); setSelectedIndex(i => Math.max(0, i - 1)); }
      if (e.key === 'ArrowRight') { e.preventDefault(); setSelectedIndex(i => Math.min(visibleCards.length - 1, i + 1)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, minimized, visibleCards.length]);

  const startScan = useCallback(async (force = false) => {
    cancelRef.current = false;
    abortControllersRef.current.forEach(controller => controller.abort());
    abortControllersRef.current.clear();
    startTimeRef.current = Date.now();
    setPhase('scanning');
    setTrailCards([]);
    setCompletedCount(0);
    setErrorCount(0);
    setSelectedIndex(0);
    setActiveFileName(null);

    const queue = [...fitsFiles];
    let completed = 0;
    let errors = 0;

    // Pixel-level trail detection only — no observer location needed, no
    // network call. Identifying which satellite made a trail is a separate,
    // explicit, per-file step (the "Identify Satellite" button in FitsViewer),
    // not something a bulk scan does automatically for every frame it flags.
    const runSlot = async () => {
      while (queue.length > 0 && !cancelRef.current) {
        const file = queue.shift()!;
        setActiveFileName(file.name);
        const controller = new AbortController();
        abortControllersRef.current.add(controller);
        try {
          const result = await detectSatelliteTrail(file.path, force, undefined, undefined, controller.signal);
          if (cancelRef.current) return;
          if (result.trailDetected) {
            setTrailCards(prev => [...prev, { file, result, deleted: false }]);
          }
        } catch (err) {
          if (isAbortError(err) || cancelRef.current) return;
          errors++;
          setErrorCount(errors);
        } finally {
          abortControllersRef.current.delete(controller);
        }
        if (cancelRef.current) return;
        completed++;
        setCompletedCount(completed);
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, fitsFiles.length) }, runSlot));
    setActiveFileName(null);
    if (!cancelRef.current) setPhase('done');
  }, [fitsFiles]);

  const handleDelete = async (path: string) => {
    const deletedIdx = visibleCards.findIndex(c => c.file.path === path);
    setDeletingPath(path);
    try {
      await deleteLibraryFile(path);
      setTrailCards(prev => prev.map(c => c.file.path === path ? { ...c, deleted: true } : c));
      onFilesDeleted();
      // Step back if we deleted the last card
      if (deletedIdx > 0 && deletedIdx >= visibleCards.length - 1) {
        setSelectedIndex(deletedIdx - 1);
      }
    } catch {
      // silently ignore; user can retry
    } finally {
      setDeletingPath(null);
    }
  };

  if (!isOpen) return null;

  const progress = fitsFiles.length > 0 ? (completedCount / fitsFiles.length) * 100 : 0;
  const etaMs = completedCount >= 2 && phase === 'scanning'
    ? (Date.now() - startTimeRef.current) / completedCount * (fitsFiles.length - completedCount)
    : null;

  // ── Minimized pill ─────────────────────────────────────────────────────────
  if (minimized) {
    return (
      <button
        onClick={() => setMinimized(false)}
        className={`fixed bottom-5 right-5 z-[60] flex items-center gap-3 pl-3.5 pr-4 py-2.5 rounded-full shadow-xl border transition-all hover:scale-105 ${
          phase === 'done' && visibleCards.length > 0
            ? isDark ? 'bg-amber-950 border-amber-800 text-amber-300' : 'bg-amber-50 border-amber-300 text-amber-700'
            : phase === 'done'
              ? isDark ? 'bg-green-950 border-green-800 text-green-300' : 'bg-green-50 border-green-300 text-green-700'
              : isDark ? 'bg-slate-900 border-slate-700 text-slate-300' : 'bg-white border-slate-300 text-slate-700'
        }`}
      >
        {phase === 'scanning'
          ? <RotateCw className="w-4 h-4 flex-shrink-0 animate-spin" />
          : visibleCards.length > 0
            ? <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            : <Satellite className="w-4 h-4 flex-shrink-0" />
        }
        <div className="flex flex-col gap-1 min-w-[130px]">
          <span className="text-sm font-medium leading-tight">
            {phase === 'scanning' && `Scanning ${completedCount} / ${fitsFiles.length}`}
            {phase === 'done' && visibleCards.length > 0 && `${visibleCards.length} trail${visibleCards.length !== 1 ? 's' : ''} detected`}
            {phase === 'done' && visibleCards.length === 0 && 'Scan complete. All clear.'}
            {phase === 'ready' && 'Trail scan ready'}
          </span>
          {phase === 'scanning' && (
            <div className={`h-1 rounded-full overflow-hidden ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`}>
              <div className="h-full bg-amber-500 rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
            </div>
          )}
        </div>
        <span className="text-xs opacity-50 ml-1">tap to expand</span>
      </button>
    );
  }

  // While the scan is in flight, closing the modal aborts a long-running
  // background task. Ask before discarding so an accidental backdrop click
  // doesn't throw away an in-progress scan of hundreds of frames.
  const isDirty = phase === 'scanning';
  const requestClose = () => {
    if (isDirty) setConfirmingClose(true);
    else onClose();
  };

  const cancelScan = () => {
    cancelRef.current = true;
    abortControllersRef.current.forEach(controller => controller.abort());
    abortControllersRef.current.clear();
    setActiveFileName(null);
  };

  // ── Full modal — mirrors the ObservationDetail gallery layout exactly ──────
  return (
    <Modal
      isOpen={isOpen}
      onClose={requestClose}
      title="Satellite Trail Detection"
      className={`relative w-full max-w-6xl h-[min(85vh,900px)] flex flex-col rounded-2xl overflow-hidden ${isDark ? 'bg-slate-900' : 'bg-white'}`}
    >

        {/* ── Header ─────────────────────────────────────────────────────────── */}
        <div className={`flex-shrink-0 flex items-center justify-between p-4 border-b ${
          isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
        }`}>
          {/* Left: icon + file info */}
          <div className="flex items-center gap-3 min-w-0 mr-3">
            <Satellite className="w-5 h-5 text-amber-500 flex-shrink-0" />
            <div className="min-w-0">
              {currentCard ? (
                <>
                  <span className={`font-medium text-sm truncate block ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                    {currentCard.file.name}
                  </span>
                  <span className={`text-xs truncate block ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    {currentCard.result.confidence != null && `${Math.round(currentCard.result.confidence * 100)}% confidence`}
                    {currentCard.result.angleDegrees != null && ` · ${currentCard.result.angleDegrees}° angle`}
                    {currentCard.result.lengthPixels != null && ` · ${currentCard.result.lengthPixels}px`}
                  </span>
                </>
              ) : (
                <>
                  <span className={`font-medium text-sm block ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                    Satellite Trail Detection
                  </span>
                  <span className={`text-xs block ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    {phase === 'ready'    && `${fitsFiles.length} FITS frame${fitsFiles.length !== 1 ? 's' : ''} ready to scan`}
                    {phase === 'scanning' && (activeFileName ? `Scanning ${activeFileName}` : `Scanning ${fitsFiles.length} frames…`)}
                    {phase === 'done'     && `${fitsFiles.length} frames analyzed. No trails detected.`}
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Right: navigation + actions */}
          <div className="flex items-center gap-1 flex-shrink-0">
            {visibleCards.length > 0 && (
              <>
                <button
                  onClick={() => setSelectedIndex(i => Math.max(0, i - 1))}
                  disabled={currentIndex <= 0}
                  className={`p-2 rounded-lg transition disabled:opacity-30 ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <span className={`text-sm font-medium tabular-nums px-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  {currentIndex + 1} / {visibleCards.length}
                  {phase === 'scanning' && (
                    <span className={`text-xs ml-1 ${isDark ? 'text-slate-600' : 'text-slate-300'}`}>
                      (scanning…)
                    </span>
                  )}
                </span>
                <button
                  onClick={() => setSelectedIndex(i => Math.min(visibleCards.length - 1, i + 1))}
                  disabled={currentIndex >= visibleCards.length - 1}
                  className={`p-2 rounded-lg transition disabled:opacity-30 ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
                >
                  <ChevronRight className="w-5 h-5" />
                </button>
                <div className={`w-px h-5 mx-1 ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`} />
              </>
            )}

            {/* Delete current frame */}
            {currentCard && (
              <button
                onClick={() => handleDelete(currentCard.file.path)}
                disabled={deletingPath === currentCard.file.path}
                title="Delete this frame"
                className={`p-2 rounded-lg transition disabled:opacity-40 ${isDark ? 'text-red-400 hover:bg-red-500/10' : 'text-red-500 hover:bg-red-50'}`}
              >
                {deletingPath === currentCard.file.path
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <Trash2 className="w-4 h-4" />
                }
              </button>
            )}

            {/* Minimize (scanning only) */}
            {phase === 'scanning' && (
              <button
                onClick={() => setMinimized(true)}
                title="Minimize"
                className={`p-2 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
              >
                <Minus className="w-4 h-4" />
              </button>
            )}

            {/* Close */}
            <button
              onClick={requestClose}
              className={`p-2 rounded-lg transition ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* ── Scanning progress strip ─────────────────────────────────────────── */}
        {phase === 'scanning' && (
          <div className={`flex-shrink-0 flex items-center gap-3 px-4 py-2 border-b ${
            isDark ? 'border-slate-800 bg-slate-900' : 'border-slate-100 bg-slate-50'
          }`}>
            <Loader2 className="w-3.5 h-3.5 text-amber-500 animate-spin flex-shrink-0" />
            <div className={`flex-1 h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`}>
              <div
                className="h-full bg-amber-500 rounded-full transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className={`text-xs tabular-nums flex-shrink-0 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {completedCount} / {fitsFiles.length}
              {etaMs !== null && <span className="ml-1">· {formatDuration(etaMs)}</span>}
              {errorCount > 0 && <span className={`ml-1 ${isDark ? 'text-red-400' : 'text-red-500'}`}>· {errorCount} err</span>}
            </span>
            <button
              onClick={cancelScan}
              className={`text-xs flex-shrink-0 transition ${isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600'}`}
            >
              Cancel
            </button>
          </div>
        )}

        {/* ── Image area ─────────────────────────────────────────────────────── */}
        <div className="flex-1 min-h-0 p-4">
          {currentCard ? (
            <div className="w-full h-full">
              <FitsViewer
                url={currentCard.file.downloadUrl}
                isDark={isDark}
                filePath={currentCard.file.path}
                fileType="sub"
                initialSatResult={currentCard.result}
                hideControls
              />
            </div>
          ) : (
            /* No trail selected — show scanning or done empty state */
            <div className={`flex flex-col items-center justify-center h-full gap-4 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
              {phase === 'ready' && (
                <>
                  <Satellite className={`w-16 h-16 ${isDark ? 'text-amber-500/20' : 'text-amber-400/30'}`} />
                  <div className="text-center space-y-1.5">
                    <p className={`text-base font-semibold ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                      Scan {fitsFiles.length} subframe{fitsFiles.length !== 1 ? 's' : ''} for satellite trails
                    </p>
                    <p className="text-sm">
                      Detected frames appear here. Use ← → or click thumbnails to navigate.
                    </p>
                  </div>
                  <button
                    onClick={() => startScan()}
                    disabled={fitsFiles.length === 0}
                    className="mt-2 px-6 py-2.5 rounded-xl text-sm font-semibold bg-amber-500 text-white hover:bg-amber-600 transition disabled:opacity-40"
                  >
                    Start Scan
                  </button>
                </>
              )}

              {phase === 'scanning' && (
                <>
                  <Loader2 className="w-10 h-10 text-amber-500/40 animate-spin" />
                  <p className="text-sm">Scanning. Detected trails will appear here as they are found.</p>
                </>
              )}

              {phase === 'done' && (
                <>
                  <CheckCircle2 className={`w-14 h-14 ${isDark ? 'text-green-500/30' : 'text-green-400/40'}`} />
                  <p className={`text-base font-semibold ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                    All frames are clean
                  </p>
                  <p className="text-sm">No satellite trails detected in {fitsFiles.length} subframe{fitsFiles.length !== 1 ? 's' : ''}</p>
                  <button
                    onClick={() => startScan(true)}
                    className={`mt-1 px-4 py-1.5 rounded-lg text-xs font-medium transition ${isDark ? 'text-slate-500 hover:text-slate-300 hover:bg-slate-800' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'}`}
                  >
                    Re-scan
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* ── Thumbnail strip ─────────────────────────────────────────────────── */}
        {(visibleCards.length > 1 || (phase === 'scanning' && visibleCards.length >= 1)) && (
          <div className={`flex-shrink-0 border-t p-3 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
            <div className="flex gap-2 overflow-x-auto pb-1 items-center">
              {visibleCards.map((card, idx) => (
                <button
                  key={card.file.path}
                  ref={el => { thumbRefs.current[idx] = el; }}
                  onClick={() => setSelectedIndex(idx)}
                  title={card.file.name}
                  className={`flex-shrink-0 w-14 h-14 rounded-lg overflow-hidden border-2 transition ${
                    idx === currentIndex
                      ? 'border-amber-500 ring-2 ring-amber-500/20'
                      : isDark ? 'border-slate-800 hover:border-slate-600' : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <FitsThumbnail url={card.file.downloadUrl} thumbUrl={card.file.thumbUrl} stretch={1.0} isDark={isDark} />
                </button>
              ))}
              {phase === 'scanning' && (
                <div className={`flex-shrink-0 w-14 h-14 rounded-lg border-2 flex items-center justify-center ${
                  isDark ? 'border-slate-800 bg-slate-800' : 'border-slate-200 bg-slate-100'
                }`}>
                  <Loader2 className="w-4 h-4 text-amber-500/50 animate-spin" />
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── "Use arrow keys" hint — same position as original gallery ────────── */}
        <div className={`absolute bottom-4 left-1/2 -translate-x-1/2 text-xs pointer-events-none select-none ${
          isDark ? 'text-white/20' : 'text-slate-300'
        }`}>
          {phase !== 'ready' && visibleCards.length > 1 && 'Use arrow keys to navigate'}
          {phase === 'done' && visibleCards.length > 0 && (
            <span className="ml-3 pointer-events-auto">
              <button
                onClick={() => startScan(true)}
                className={`transition underline-offset-2 hover:underline ${isDark ? 'text-slate-600 hover:text-slate-400' : 'text-slate-300 hover:text-slate-500'}`}
              >
                Re-scan
              </button>
            </span>
          )}
        </div>
        {confirmingClose && (
          <CloseConfirm
            message="Stop the scan and close?"
            cancelLabel="Keep scanning"
            onCancel={() => setConfirmingClose(false)}
            onDiscard={() => { setConfirmingClose(false); cancelScan(); onClose(); }}
            isDark={isDark}
          />
        )}

    </Modal>
  );
}
