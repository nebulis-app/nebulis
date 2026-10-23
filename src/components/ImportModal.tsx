import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X, FolderOpen, RotateCw, CheckCircle2, Upload, HardDrive, ArrowLeft, ArrowRight, Copy } from 'lucide-react';
import {
  uploadFolderTemp,
  reportImportDebug,
  preflightImportSpace,
  discardImportTempSession,
} from '../lib/api/library';
import { locateFolderOnServer, getClientLocality } from '../lib/api/storage';
import { listTelescopes } from '../lib/api/telescopes';
import { ImportStepIndicator } from './ImportStepIndicator';
import { getDebugLoggingStatus } from '../lib/api/settings';
import { useTheme } from '../hooks/useTheme';
import { formatBytes } from '../lib/utils';
import { Modal } from './ui/Modal';
import { CloseConfirm } from './ui/CloseConfirm';
import { ServerFolderPicker } from './folderImport/ServerFolderPicker';
import { formatFocal } from '../lib/rigLabel';

interface PickedFile {
  file: File;
  /** Relative path with the top-level folder name already stripped. */
  relativePath: string;
}

function isFileEntry(e: FileSystemEntry): e is FileSystemFileEntry { return e.isFile; }
function isDirectoryEntry(e: FileSystemEntry): e is FileSystemDirectoryEntry { return e.isDirectory; }

/** Read all files recursively from a FileSystemDirectoryEntry. */
async function readDirEntry(entry: FileSystemDirectoryEntry, prefix: string): Promise<PickedFile[]> {
  const reader = entry.createReader();
  const results: PickedFile[] = [];
  // readEntries may return results in batches; loop until empty.
  let batch: FileSystemEntry[];
  do {
    batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
    for (const child of batch) {
      if (isFileEntry(child)) {
        const file = await new Promise<File>((res, rej) => child.file(res, rej));
        results.push({ file, relativePath: prefix ? `${prefix}/${file.name}` : file.name });
      } else if (isDirectoryEntry(child)) {
        const sub = await readDirEntry(child, prefix ? `${prefix}/${child.name}` : child.name);
        results.push(...sub);
      }
    }
  } while (batch.length > 0);
  return results;
}

/** Strip the common leading folder name from all relative paths so the server
 *  temp dir IS the scan root (no extra nesting).
 *
 *  Exception: if stripping would leave all paths flat (no remaining `/`), the
 *  prefix is the object folder itself — not a container. Keep it so the server
 *  sees the folder as a named subdirectory and can run a catalog match on it.
 *  Example: dropping `IC 1805_mosaic/` directly should NOT lose the folder name.
 *
 *  Second exception: if all top-level folders after stripping look like session
 *  dates (YYYY-MM-DD…), the prefix was also the object folder. Preserving it
 *  lets the server match "NGC1499" against the catalog rather than treating the
 *  date-stamped session folder as the object name. */
function isDateLikeFolderName(name: string): boolean {
  return /^(?:20|19)\d{2}-\d{2}-\d{2}/.test(name);
}

function stripTopFolder(files: PickedFile[]): PickedFile[] {
  if (files.length === 0) return files;
  const firstSlash = files[0].relativePath.indexOf('/');
  if (firstSlash < 0) return files;
  const prefix = files[0].relativePath.slice(0, firstSlash + 1);
  if (!files.every(f => f.relativePath.startsWith(prefix))) return files;
  const stripped = files.map(f => ({ ...f, relativePath: f.relativePath.slice(prefix.length) }));
  // If all stripped paths are flat (no subdirectory), the prefix was the object
  // folder — preserve it so the scan can match it against the catalog.
  if (stripped.every(f => !f.relativePath.includes('/'))) return files;
  // If every top-level folder looks like a session date, the prefix was the
  // object folder (e.g. NGC1499/2025-03-01_2126/lights/…) — don't strip it.
  const topFolders = new Set(stripped.map(f => f.relativePath.split('/')[0]));
  if ([...topFolders].every(n => isDateLikeFolderName(n))) return files;
  return stripped;
}

// Coarse client-side pre-filter, mirroring ALLOWED_UPLOAD_EXTS on the server
// (routes/library.ts). Whether a video actually imports is still decided
// server-side by classifyImportFile, same as any other file kind.
const ACCEPTED_EXTS = new Set([
  '.fit', '.fits', '.fts',
  '.jpg', '.jpeg', '.png', '.tif', '.tiff',
  '.avi', '.mp4', '.mov',
]);

type Phase = 'idle' | 'staging' | 'uploading' | 'done';
/** How the chosen folder gets into the library. */
type Method = 'link' | 'copy' | 'upload';

/** 'upload' streams files through the browser; 'local' points the server at a
 *  folder already on the same machine (no upload). */
type Source = 'upload' | 'local';

export function ImportModal({ onClose, onReview, onLink, resume }: {
  onClose: () => void;
  /** Reopen on the options step of a link the user stepped back out of, with the folder and options they had. */
  resume?: { path: string; includeSubframes: boolean };
  /** Index the chosen server folder in place instead of copying it. */
  onLink?: (folderPath: string, includeSubframes: boolean, includeFits: boolean) => void;
  onReview: (folderPath: string, includeSubframes: boolean, includeFits: boolean, telescopeId: string | null, archiveAll: boolean, tmpId: string | null, opticalConfigId: string | null) => void;
}) {
  const { isDark } = useTheme();
  const { t } = useTranslation('library');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // True for the gap between a drop landing and acceptFiles running — walking
  // a dropped folder tree is slow enough (seconds for a few hundred files)
  // that the drop zone needs its own feedback before picked/locateStatus have
  // anything to show.
  const [enumerating, setEnumerating] = useState(false);
  const [sourceChoice, setSourceChoice] = useState<Source>(resume ? 'local' : 'upload');
  const [serverPath, setServerPath] = useState<string | null>(resume?.path ?? null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [includeSubframes, setIncludeSubframes] = useState(resume?.includeSubframes ?? false);
  const [archiveAll, setArchiveAll] = useState(false);
  // FITS files (stacked and raw) are always imported; only subframes are optional.
  const includeFits = true;

  const [telescopeId, setTelescopeId] = useState('');
  // '' = detect from the FITS focal length (see sessionOptics.ts).
  const [opticalConfigId, setOpticalConfigId] = useState('');
  // Set while an upload is in flight so the discard path can actually stop
  // it. Without this, dismissing the modal mid-upload left the batch loop
  // running in the background, and its eventual resolution could still fire
  // onReview into a caller that had already moved on.
  const uploadAbortRef = useRef<AbortController | null>(null);
  // Staging session id, known once the first batch lands. Held so cancelling
  // can tell the server to delete what was already uploaded instead of leaving
  // it to the cleanup sweep.
  const tmpIdRef = useRef<string | null>(null);
  // When the dropped folder is found on the server's own disk (matched by
  // name + file-size fingerprint), this holds the scan-root path so the
  // import can read it in place instead of uploading the same bytes.
  const [locatedPath, setLocatedPath] = useState<string | null>(null);
  /** Progress of the "is this folder on the server?" check, so the dialog can
   *  say why it is about to upload instead of leaving the user guessing. */
  const [pickedName, setPickedName] = useState('');
  const [step, setStep] = useState<0 | 1 | 2 | 3>(resume ? 2 : 0);
  // Set by the step-0 choice and never revisited implicitly: it decides which
  // methods step 3 can even offer (see `available` below), so "Upload Data"
  // never resurfaces Link even if the dropped folder turns out to already be
  // on the server — that case just falls back to Copy.
  const [entryChoice, setEntryChoice] = useState<'link' | 'upload' | null>(resume ? 'link' : null);
  const [method, setMethod] = useState<Exclude<Method, 'link'> | null>(null);
  const [locateStatus, setLocateStatus] = useState<'idle' | 'checking' | 'missing'>('idle');
  const locateAbortRef = useRef<AbortController | null>(null);

  // This component has no other useEffect — both aborts above were only ever
  // wired to the CloseConfirm discard handler, so navigating away mid-upload
  // (not just an explicit Cancel) left the batch loop streaming in the
  // background and its resolution firing onReview into a stale closure.
  useEffect(() => () => {
    uploadAbortRef.current?.abort();
    locateAbortRef.current?.abort();
  }, []);

  const { data: telescopes } = useQuery({
    queryKey: ['telescopes'],
    queryFn: listTelescopes,
    staleTime: 30_000,
  });
  const activeTelescopes = (telescopes ?? []).filter(scope => !scope.archivedAt);
  // One computer or two? Most people run Nebulis on the machine they browse
  // from, and for them "this device" and "the server" are the same thing, so
  // the dialog should not ask them to tell the two apart.
  const { data: locality } = useQuery({
    queryKey: ['client-locality'],
    queryFn: getClientLocality,
    staleTime: Infinity,
    retry: false,
  });
  const sameMachine = locality?.sameMachine === true;
  // A drop that could not be found on the server's own computer must not
  // quietly turn into an upload: the folder browser takes over, where one pick
  // gives Nebulis a real path to link or copy from. Derived, not stored, so it
  // is correct whether the locality answer arrives before or after the lookup
  // finishes. Anywhere else a miss just means the upload path.
  const missedOnThisComputer = sameMachine && locateStatus === 'missing' && sourceChoice === 'upload';
  const source: Source = missedOnThisComputer ? 'local' : sourceChoice;
  // The selected telescope's local-mirror transport path, if it has one —
  // offered as a one-click starting point in the folder browser so the user
  // doesn't have to hunt for a folder Nebulis already knows about.
  const chosenConfigs = activeTelescopes.find(scope => scope.id === telescopeId)?.opticalConfigs ?? [];
  const suggestedFolderPath = activeTelescopes
    .find(scope => scope.id === telescopeId)
    ?.transports?.find(tr => tr.kind === 'local' && tr.localPath)?.localPath ?? null;

  const isDirty = (phase === 'staging' && picked.length > 0) || phase === 'uploading';

  const requestClose = useCallback(() => {
    if (isDirty) setConfirmingClose(true);
    else onClose();
  }, [isDirty, onClose]);

  function acceptFiles(files: PickedFile[]) {
    const first = files[0]?.relativePath ?? '';
    const top = first.includes('/') ? first.slice(0, first.indexOf('/')) : '';
    setPickedName(top && files.every(f => f.relativePath.startsWith(`${top}/`)) ? top : '');
    const stripped = stripTopFolder(files);
    // Drop failed frames client-side so they never reach the upload. Dwarf
    // marks rejected frames with a "failed_" prefix; anchored so a user's own
    // file containing "failed" elsewhere in the name isn't silently dropped.
    const filtered = stripped.filter(({ relativePath }) => {
      const basename = relativePath.split('/').pop() ?? '';
      if (/^failed_/i.test(basename)) return false;
      const dot = basename.lastIndexOf('.');
      const ext = dot >= 0 ? basename.slice(dot).toLowerCase() : '';
      return ACCEPTED_EXTS.has(ext);
    });
    setPicked(filtered);
    setError(null);
    setPhase('staging');
    probeServerForFolder(files, filtered);
  }

  /** Silently ask the server whether the dropped folder already exists on its
   *  own disk. The browser never sees absolute paths, so this matches by the
   *  top-level folder name plus a sample of file names and exact sizes. On a
   *  hit the CTA switches to an in-place import; on any miss or failure the
   *  normal upload flow is untouched. */
  function probeServerForFolder(preStrip: PickedFile[], filtered: PickedFile[]) {
    locateAbortRef.current?.abort();
    setLocatedPath(null);

    // A miss only records that the folder was not found. Where to go next
    // depends on whether this browser is on the server's own computer, which
    // may not be known yet, so the effect below decides once it is.
    const miss = () => setLocateStatus('missing');
    if (filtered.length === 0 || preStrip.length === 0) { miss(); return; }

    // The anchor is the dropped folder's name: the common first path segment
    // of everything picked. A multi-root drop has no single anchor; skip.
    const firstSlash = preStrip[0].relativePath.indexOf('/');
    if (firstSlash <= 0) { miss(); return; }
    const anchor = preStrip[0].relativePath.slice(0, firstSlash);
    if (!preStrip.every(f => f.relativePath.startsWith(`${anchor}/`))) { miss(); return; }
    setLocateStatus('checking');

    // Sample up to 40 files spread across the selection. Sizes must match
    // exactly server-side, so this is a strong fingerprint without hashing.
    const step = Math.max(1, Math.floor(filtered.length / 40));
    const samples = filtered
      .filter((_, i) => i % step === 0)
      .slice(0, 40)
      .map(f => ({ relativePath: f.relativePath, size: f.file.size }));

    const controller = new AbortController();
    locateAbortRef.current = controller;
    locateFolderOnServer(anchor, samples, controller.signal)
      .then(result => {
        if (controller.signal.aborted) return;
        if (result.path) {
          setLocatedPath(result.path);
          setLocateStatus('idle');
        } else {
          miss();
        }
      })
      .catch(() => {
        // Best-effort; the upload flow is unaffected.
        if (!controller.signal.aborted) miss();
      });
  }

  // ── Input (webkitdirectory) ──────────────────────────────────────────────

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files) return;
    const files: PickedFile[] = Array.from(e.target.files).map(f => ({
      file: f,
      relativePath: f.webkitRelativePath || f.name,
    }));
    acceptFiles(files);
    // Reset input so the same folder can be re-selected if needed
    e.target.value = '';
  }

  // ── Drag and drop ────────────────────────────────────────────────────────

  // A plain function, not useCallback([]): it calls acceptFiles, which reads
  // sameMachine and other live state. A memoised copy froze the first render's
  // values (sameMachine is false until the locality query returns).
  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    setError(null);
    // Walking a dropped tree via FileSystemDirectoryReader is genuinely slow
    // for a few hundred nested files (seconds, not milliseconds), and until
    // acceptFiles runs there's nothing else to show progress — so flip this on
    // immediately, before any of that async work starts.
    setEnumerating(true);

    const items = e.dataTransfer.items;
    if (!items) { setEnumerating(false); acceptFiles([]); return; }

    const allFiles: PickedFile[] = [];
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry?.();
      if (!entry) continue;
      if (isFileEntry(entry)) {
        const file = await new Promise<File>((res, rej) => entry.file(res, rej));
        allFiles.push({ file, relativePath: file.name });
      } else if (isDirectoryEntry(entry)) {
        const sub = await readDirEntry(entry, entry.name);
        allFiles.push(...sub);
      }
    }
    setEnumerating(false);
    acceptFiles(allFiles);
  }

  // ── Upload ───────────────────────────────────────────────────────────────

  async function handleUpload() {
    if (picked.length === 0) return;
    locateAbortRef.current?.abort();

    // Check the server has room before sending a byte. An upload is staged in
    // full on the server's data drive before any of it is imported, so a
    // folder bigger than the free space there fails partway through and leaves
    // the staged part behind. Asking first turns that into a message in this
    // dialog. A preflight that itself fails is not treated as a refusal: the
    // upload proceeds and the per-batch guard still protects the disk.
    try {
      const check = await preflightImportSpace(picked.reduce((sum, p) => sum + p.file.size, 0));
      if (!check.ok) {
        setError(check.message ?? t('importModal.notEnoughSpace'));
        return;
      }
    } catch { /* preflight unavailable; the server-side batch guard still applies */ }

    setPhase('uploading');
    setUploadProgress(0);
    setError(null);

    // Only stream client-side breadcrumbs when the user has debug logging on,
    // so normal imports add zero extra requests. Best-effort: if the status
    // check fails, we just upload without breadcrumbs.
    let debug = false;
    try { debug = (await getDebugLoggingStatus()).enabled; } catch { /* ignore */ }
    if (debug) {
      reportImportDebug(
        `[browser] import dialog: ${picked.length} files staged for upload ` +
        `(include sub-frames: ${includeSubframes}, include FITS: ${includeFits}, archive all: ${archiveAll}, ` +
        `telescope: ${telescopeId || 'none'})`,
      );
    }

    const controller = new AbortController();
    uploadAbortRef.current = controller;

    try {
      const result = await uploadFolderTemp(
        picked.map(p => p.file),
        picked.map(p => p.relativePath),
        (sent, total) => setUploadProgress(total > 0 ? Math.round((sent / total) * 100) : 0),
        debug,
        controller.signal,
        id => { tmpIdRef.current = id; },
      );
      // Handed off to the review step, which now owns the staged files: it
      // deletes them on commit, or discards the session itself if the user
      // cancels before committing. Clearing the ref here only stops *this*
      // dialog from also trying to discard it (e.g. on a lingering unmount).
      tmpIdRef.current = null;
      setPhase('done');
      onReview(result.tmpPath, includeSubframes, includeFits, telescopeId || null, archiveAll, result.tmpId, opticalConfigId || null);
    } catch (err) {
      // A cancelled upload already unmounted (or is about to) via the discard
      // path — don't flash an error or bounce the phase back to 'staging' on
      // the way out.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      // A failed upload's partial staging is dead weight: the retry starts a
      // fresh session rather than resuming this one, so release it now.
      if (tmpIdRef.current) {
        discardImportTempSession(tmpIdRef.current);
        tmpIdRef.current = null;
      }
      const message = err instanceof Error ? err.message : t('importModal.uploadFailed');
      if (debug) reportImportDebug(`[browser] import dialog: upload aborted with error: ${message}`);
      setError(message);
      setPhase('staging');
    } finally {
      uploadAbortRef.current = null;
    }
  }

  function clearPicked() {
    locateAbortRef.current?.abort();
    setLocatedPath(null);
    setLocateStatus('idle');
    setPicked([]);
    setPickedName('');
    setMethod(null);
    setStep(1);
    setPhase('idle');
  }

  /** Step 0: commit to linking (browse a path, index in place) or uploading
   *  (stream files in) before any folder is even picked, so the method never
   *  changes underneath the user mid-flow. */
  function chooseEntry(choice: 'link' | 'upload') {
    clearPicked();
    setServerPath(null);
    setSourceChoice(choice === 'link' ? 'local' : 'upload');
    setEntryChoice(choice);
  }

  function goBack() {
    setError(null);
    if (step === 1) {
      // Leaving step 1 back to the entry choice discards whatever was picked
      // or browsed so far — switching methods starts clean rather than
      // carrying over state from the other path.
      locateAbortRef.current?.abort();
      setLocatedPath(null);
      setLocateStatus('idle');
      setPicked([]);
      setPickedName('');
      setMethod(null);
      setPhase('idle');
      setServerPath(null);
      setEntryChoice(null);
      setStep(0);
    } else {
      setStep(step === 3 ? 2 : 1);
    }
  }

  // ── Derived display info ─────────────────────────────────────────────────

  // Count distinct top-level folders for the staging summary. The file count
  // does the real "did I pick the right thing?" job; the folder count is a
  // secondary hint. We don't enumerate the names: for a Dwarf SD card that is
  // hundreds of raw-capture folders, and the review step lists every object
  // properly a click later anyway.
  const pickedBytes = picked.reduce((sum, p) => sum + p.file.size, 0);
  const folderCount = new Set(
    picked
      .filter(({ relativePath }) => relativePath.includes('/'))
      .map(({ relativePath }) => relativePath.split('/')[0]),
  ).size;

  const card = isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200';
  const mutedText = isDark ? 'text-slate-500' : 'text-slate-400';
  // The server folder picker shows filesystem paths, which are long and deeply
  // nested; 512px truncates every one of them. Every other step (including
  // step 0, reached again via Back while `source` is still 'local' from a
  // prior Link Data pick) has no such content, so it keeps the narrower dialog.
  const modalWidth = step === 1 && source === 'local' ? 'max-w-3xl' : 'max-w-lg';

  // A folder the server can read directly: found by the drop's fingerprint
  // check, or picked in the server browser. Only these can be linked or copied
  // without an upload.
  const serverTarget = source === 'local' ? serverPath : locatedPath;
  const available: Record<Method, boolean> = {
    // Link is only ever offered after choosing "Link Data" up front.
    link: entryChoice === 'link' && !!serverTarget && !!onLink,
    // "Link Data" means link: copy from a server folder lives under "Upload Data".
    copy: entryChoice !== 'link' && !!serverTarget,
    // Uploading a folder that already lives on the server's own computer buys
    // nothing, so it is never offered there. Under "Link Data" the source is
    // always a server folder, so this is false there too.
    upload: source === 'upload' && picked.length > 0 && !sameMachine,
  };
  // Only recommend when we can actually justify it: a dropped folder that the
  // server can already read is cheaper to copy than to upload.
  const recommended: Method | null = !serverTarget
    ? (available.upload ? 'upload' : null)
    : source === 'upload' ? 'copy' : null;
  const firstAvailable: Method | null = available.link ? 'link' : available.copy ? 'copy' : available.upload ? 'upload' : null;
  const chosen: Method | null = method && available[method] ? method : (recommended ?? firstAvailable);
  // What step 3 renders: the selectable methods, at most copy and upload.
  // "Link Data" has no step 3 at all: the choice was already made on step 0,
  // so the options step carries the "Link folder" button itself.
  const visibleMethods = (['copy', 'upload'] as const).filter(m => available[m]);
  const lastStep: 2 | 3 = entryChoice === 'link' ? 2 : 3;
  // Once "Link Data" is chosen nothing is imported, so the dialog stops saying so. Its review screen and
  // confirm button already read "Link folder"; this makes the steps between agree.
  const modalTitle = entryChoice === 'link' ? t('importModal.titleLink') : t('importModal.title');
  const canLeaveStep1 = source === 'local'
    ? !!serverPath
    : picked.length > 0 && locateStatus !== 'checking' && (available.link || available.copy || available.upload);

  function startImport() {
    if (chosen === 'link' && serverTarget && onLink) onLink(serverTarget, includeSubframes, includeFits);
    else if (chosen === 'copy' && serverTarget) onReview(serverTarget, includeSubframes, includeFits, telescopeId || null, archiveAll, null, opticalConfigId || null);
    else if (chosen === 'upload') void handleUpload();
  }

  return (
    <Modal
      isOpen
      onClose={requestClose}
      title={modalTitle}
      className={`relative w-full ${modalWidth} max-h-[88vh] flex flex-col rounded-2xl border shadow-2xl ${card}`}
    >
      {/* Header */}
      <div className={`shrink-0 flex items-center justify-between px-6 py-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <h2 className={`font-display font-semibold text-lg ${isDark ? 'text-white' : 'text-slate-900'}`}>
          {modalTitle}
        </h2>
        <button onClick={requestClose} aria-label={t('importModal.close')} className={`p-1.5 rounded-lg transition ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}>
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-5">
        {step !== 0 && <ImportStepIndicator step={step} linking={entryChoice === 'link'} isDark={isDark} />}

        {/* ── Step 0: link or upload? ───────────────────────────────────── */}
        {step === 0 && (
          <>
            <div>
              <h3 className={`text-base font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                {t('importModal.entryTitle')}
              </h3>
              <p className={`text-xs mt-0.5 ${mutedText}`}>{t('importModal.entryHint')}</p>
            </div>
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => chooseEntry('link')}
                disabled={!onLink}
                className={`w-full text-left rounded-xl border p-4 transition disabled:cursor-not-allowed disabled:opacity-50 ${
                  isDark ? 'border-slate-700 hover:border-accent-500' : 'border-slate-200 hover:border-accent-400'
                }`}
              >
                <div className="flex items-center gap-2">
                  <HardDrive className={`w-4 h-4 ${isDark ? 'text-accent-400' : 'text-accent-500'}`} />
                  <span className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                    {t('importModal.entryLink.title')}
                  </span>
                </div>
                <p className={`text-sm mt-1.5 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                  {t('importModal.entryLink.description')}
                </p>
              </button>
              <button
                type="button"
                onClick={() => chooseEntry('upload')}
                className={`w-full text-left rounded-xl border p-4 transition ${
                  isDark ? 'border-slate-700 hover:border-accent-500' : 'border-slate-200 hover:border-accent-400'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Upload className={`w-4 h-4 ${isDark ? 'text-slate-400' : 'text-slate-500'}`} />
                  <span className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                    {t('importModal.entryUpload.title')}
                  </span>
                </div>
                <p className={`text-sm mt-1.5 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                  {t('importModal.entryUpload.description')}
                </p>
              </button>
            </div>
          </>
        )}

        {/* ── Step 1: choose the folder ─────────────────────────────────── */}
        {step === 1 && (
          <>
            <h3 className={`text-base font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
              {t('importModal.step1Title')}
            </h3>

            <p className={`text-xs ${mutedText}`}>
              {source === 'upload'
                ? t('importModal.tabDeviceHintUpload')
                : t('importModal.tabServerHint', { name: locality?.serverName || t('importModal.nebulisComputer') })}
            </p>

            {entryChoice === 'upload' && source === 'local' && (
              <button
                type="button"
                onClick={() => { setServerPath(null); clearPicked(); setSourceChoice('upload'); }}
                className={`inline-flex items-center gap-1.5 text-xs transition ${isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'}`}
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                {t('importModal.backToDrop')}
              </button>
            )}

            {source === 'local' ? (
              <>
                {missedOnThisComputer && (
                  <p className={`text-sm rounded-lg px-3 py-2 ${isDark ? 'bg-amber-500/10 text-amber-300' : 'bg-amber-50 text-amber-800'}`}>
                    {pickedName
                      ? t('importModal.notMatchedNamed', { name: pickedName })
                      : t('importModal.notMatched')}
                  </p>
                )}
                <ServerFolderPicker isDark={isDark} onChange={setServerPath} suggestedPath={suggestedFolderPath} />
                <p className={`text-xs ${mutedText}`}>{t('importModal.noUploadNote')}</p>
              </>
            ) : (
              <>
                <div
                  onDragOver={e => { e.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={onDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={`relative border-2 border-dashed rounded-xl py-10 flex flex-col items-center gap-3 transition-colors ${
                    dragging
                      ? isDark ? 'border-accent-500 bg-accent-500/10 cursor-copy' : 'border-accent-400 bg-accent-50 cursor-copy'
                      : isDark ? 'border-slate-700 hover:border-slate-600 cursor-pointer' : 'border-slate-300 hover:border-slate-400 cursor-pointer'
                  }`}
                >
                  {enumerating ? (
                    <>
                      <RotateCw className="w-10 h-10 text-accent-500 animate-spin" />
                      <p className={`text-sm font-medium ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                        {t('importModal.readingFolder')}
                      </p>
                    </>
                  ) : picked.length > 0 ? (
                    <>
                      {locateStatus === 'checking'
                        ? <RotateCw className="w-10 h-10 text-accent-500 animate-spin" />
                        : <CheckCircle2 className="w-10 h-10 text-emerald-500" />}
                      <div className="text-center px-4 space-y-1">
                        <p className={`text-base font-semibold break-all ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                          {pickedName || t('importModal.selectedFiles')}
                        </p>
                        <p className={`text-sm ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                          {t('importModal.filesReady', { count: picked.length })}
                          {folderCount > 0 && ` ${t('importModal.acrossFolders', { count: folderCount })}`}
                          {` · ${formatBytes(pickedBytes)}`}
                        </p>
                        <p className={`text-xs ${locatedPath ? (isDark ? 'text-emerald-300' : 'text-emerald-700') : mutedText}`}>
                          {locatedPath
                            ? t('importModal.foundOnServer', { path: locatedPath })
                            : locateStatus === 'checking'
                              ? t('importModal.checkingServer')
                              : t('importModal.notOnServer', { name: t('importModal.entryLink.title') })}
                        </p>
                        <p className={`text-xs pt-1 ${mutedText}`}>
                          {t('importModal.dropDifferentFolder')}
                          <span aria-hidden> · </span>
                          <button
                            type="button"
                            onClick={e => { e.stopPropagation(); clearPicked(); }}
                            className="hover:text-red-500 underline transition"
                          >
                            {t('importModal.clear')}
                          </button>
                        </p>
                      </div>
                    </>
                  ) : (
                    <>
                      <FolderOpen className={`w-10 h-10 ${dragging ? 'text-accent-500' : mutedText}`} />
                      <div className="text-center">
                        <p className={`text-sm font-medium ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                          {t('importModal.dropFolderHere')}
                        </p>
                        <p className={`text-xs mt-1 ${mutedText}`}>{t('importModal.acceptedFormatsHint')}</p>
                      </div>
                    </>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    webkitdirectory=""
                    multiple
                    className="hidden"
                    onChange={handleInputChange}
                  />
                </div>

                {picked.length === 0 && (
                  <p className={`text-xs text-center ${mutedText}`}>{t('importModal.detectionNote')}</p>
                )}
              </>
            )}
          </>
        )}

        {/* ── Step 2: what should come in ───────────────────────────────── */}
        {step === 2 && (
          <>
            <div>
              <h3 className={`text-base font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                {t('importModal.step2Title')}
              </h3>
              <p className={`text-xs mt-0.5 ${mutedText}`}>{t('importModal.step2Hint')}</p>
            </div>
            <div className="space-y-4">
              <label className={`flex items-center gap-2.5 cursor-pointer select-none text-sm ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                <input
                  type="checkbox"
                  checked={includeSubframes}
                  onChange={e => setIncludeSubframes(e.target.checked)}
                  className="w-4 h-4 rounded accent-accent-500"
                />
                {t('importModal.includeSubframes')}
                <span className={`text-xs ${mutedText}`}>{t('importModal.includeSubframesHint')}</span>
              </label>

              <label className={`flex items-start gap-2.5 cursor-pointer select-none text-sm ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                <input
                  type="checkbox"
                  checked={archiveAll}
                  onChange={e => setArchiveAll(e.target.checked)}
                  className="w-4 h-4 mt-0.5 rounded accent-accent-500"
                />
                <span>
                  {t('importModal.archiveEverything')}
                  <span className={`block text-xs mt-0.5 ${mutedText}`}>{t('importModal.archiveEverythingHint')}</span>
                </span>
              </label>

              <div className="space-y-1.5">
                <label htmlFor="import-captured-with" className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                  {t('importModal.capturedWith')}
                </label>
                <select
                  id="import-captured-with"
                  value={telescopeId}
                  onChange={e => { setTelescopeId(e.target.value); setOpticalConfigId(''); }}
                  className={`w-full px-3 py-2 rounded-lg border text-sm outline-none transition ${
                    isDark ? 'bg-slate-800 border-slate-700 text-slate-200' : 'bg-white border-slate-200 text-slate-800'
                  }`}
                >
                  <option value="">{t('importModal.notSureMixedSources')}</option>
                  {activeTelescopes.map(scope => (
                    <option key={scope.id} value={scope.id}>{scope.name}</option>
                  ))}
                </select>
                <p className={`text-xs ${mutedText}`}>{t('importModal.capturedWithHint')}</p>
              </div>
              {chosenConfigs.length > 0 && (
                <div className="space-y-1.5">
                  <label htmlFor="import-optics" className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                    {t('importModal.opticalTrain')}
                  </label>
                  <select
                    id="import-optics"
                    value={opticalConfigId}
                    onChange={e => setOpticalConfigId(e.target.value)}
                    className={`w-full px-3 py-2 rounded-lg border text-sm outline-none transition ${
                      isDark ? 'bg-slate-800 border-slate-700 text-slate-200' : 'bg-white border-slate-200 text-slate-800'
                    }`}
                  >
                    <option value="">{t('importModal.opticalTrainAuto')}</option>
                    {chosenConfigs.map(c => (
                      <option key={c.id} value={c.id}>{`${c.name} · ${formatFocal(c.focalLengthMm)}`}</option>
                    ))}
                  </select>
                  <p className={`text-xs ${mutedText}`}>{t('importModal.opticalTrainHint')}</p>
                </div>
              )}
            </div>
          </>
        )}

        {/* ── Step 3: how to add it ─────────────────────────────────────── */}
        {step === 3 && phase !== 'uploading' && phase !== 'done' && (
          <>
            <div>
              <h3 className={`text-base font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                {t('importModal.step3Title')}
              </h3>
              <p className={`text-xs mt-0.5 ${mutedText}`}>
                {source === 'upload' ? (pickedName || t('importModal.selectedFiles')) : serverPath}
                {source === 'upload' && ` · ${formatBytes(pickedBytes)}`}
              </p>
            </div>
            <div role="radiogroup" aria-label={t('importModal.step3Title')} className="space-y-3">
              {/* "Recommended" only means something next to an alternative — on
                  a single-card screen (always the case under "Upload Data")
                  there's nothing to recommend it over, so it's suppressed. */}
              {visibleMethods.map(m => (
                <MethodCard
                  key={m}
                  method={m}
                  isDark={isDark}
                  selected={chosen === m}
                  recommended={recommended === m && visibleMethods.length > 1}
                  size={source === 'upload' ? formatBytes(pickedBytes) : null}
                  onSelect={() => setMethod(m)}
                />
              ))}
            </div>
          </>
        )}

        {step === 3 && phase === 'uploading' && (
          <div className="flex flex-col items-center gap-3 py-10">
            <RotateCw className="w-10 h-10 text-accent-500 animate-spin" />
            <div className="text-center space-y-2 w-56">
              <p className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                {t('importModal.uploadingPercent', { percent: uploadProgress })}
              </p>
              <div className={`h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`}>
                <div className="h-full bg-accent-500 transition-all duration-200" style={{ width: `${uploadProgress}%` }} />
              </div>
            </div>
          </div>
        )}

        {step === 3 && phase === 'done' && (
          <div className="flex flex-col items-center gap-3 py-10">
            <CheckCircle2 className="w-10 h-10 text-emerald-500" />
            <p className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{t('importModal.uploadComplete')}</p>
          </div>
        )}

        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>

      {/* Footer: navigation. Kept outside the scroll area so the way forward is
          always on screen, however long the step above is. */}
      {step !== 0 && phase !== 'uploading' && phase !== 'done' && (
        <div className={`shrink-0 flex items-center justify-between gap-3 px-6 py-4 border-t ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          {step > 0 ? (
            <button
              type="button"
              onClick={goBack}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium border transition ${
                isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-slate-300 text-slate-600 hover:bg-slate-50'
              }`}
            >
              <ArrowLeft className="w-4 h-4" />
              {t('importModal.back')}
            </button>
          ) : <span />}

          {step < lastStep ? (
            <button
              type="button"
              onClick={() => setStep(step === 1 ? 2 : 3)}
              disabled={step === 1 && !canLeaveStep1}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition disabled:opacity-50"
            >
              {step === 1 && locateStatus === 'checking' && source === 'upload'
                ? <><RotateCw className="w-4 h-4 animate-spin" />{t('importModal.checking')}</>
                : <>{t('importModal.next')}<ArrowRight className="w-4 h-4" /></>}
            </button>
          ) : (
            <button
              type="button"
              onClick={startImport}
              disabled={!chosen}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition disabled:opacity-50"
            >
              {chosen === 'link' ? <ArrowRight className="w-4 h-4" /> : chosen === 'copy' ? <Copy className="w-4 h-4" /> : <Upload className="w-4 h-4" />}
              {chosen === 'link'
                ? t('importModal.reviewLink')
                : chosen === 'copy'
                  ? t('importModal.startCopy')
                  : t('importModal.startUpload')}
            </button>
          )}
        </div>
      )}

      {confirmingClose && (
        <CloseConfirm
          message={t('importModal.discardSelectedFiles')}
          onCancel={() => setConfirmingClose(false)}
          onDiscard={() => {
            setConfirmingClose(false);
            uploadAbortRef.current?.abort();
            locateAbortRef.current?.abort();
            // Whatever batches already landed are now orphaned, and for a
            // large folder that can be tens of gigabytes. Ask the server to
            // drop them rather than waiting hours for the sweep.
            if (tmpIdRef.current) {
              discardImportTempSession(tmpIdRef.current);
              tmpIdRef.current = null;
            }
            onClose();
          }}
          isDark={isDark}
        />
      )}
    </Modal>
  );
}

const METHOD_ICON = { copy: Copy, upload: Upload } as const;

function MethodCard({
  method, selected, recommended, size, isDark, onSelect,
}: {
  method: Exclude<Method, 'link'>;
  selected: boolean;
  recommended: boolean;
  /** Size of what would be copied or sent, when known. */
  size: string | null;
  isDark: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation('library');
  const Icon = METHOD_ICON[method];
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`w-full text-left rounded-xl border p-4 transition ${
        selected
          ? isDark ? 'border-accent-500 bg-accent-500/10' : 'border-accent-500 bg-accent-50'
          : isDark ? 'border-slate-700 hover:border-slate-600' : 'border-slate-200 hover:border-slate-300'
      }`}
    >
      <div className="flex items-center gap-2">
        <Icon className={`w-4 h-4 ${selected ? 'text-accent-500' : muted}`} />
        <span className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
          {t(`importModal.method.${method}.title`)}
        </span>
        {recommended && (
          <span className={`px-1.5 py-0.5 rounded text-[0.625rem] font-semibold uppercase tracking-wide ${isDark ? 'bg-accent-500/20 text-accent-300' : 'bg-accent-100 text-accent-700'}`}>
            {t('importModal.recommended')}
          </span>
        )}
      </div>
      <p className={`text-sm mt-1.5 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
        {t(`importModal.method.${method}.description`)}
      </p>
      <p className={`text-xs mt-1.5 ${muted}`}>{t(`importModal.method.${method}.example`)}</p>
      {size && (
        <p className={`text-xs mt-1 ${muted}`}>{t(`importModal.method.${method}.size`, { size })}</p>
      )}
    </button>
  );
}
