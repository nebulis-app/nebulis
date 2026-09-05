import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, FolderOpen, RotateCw, CheckCircle2, Upload, HardDrive } from 'lucide-react';
import {
  uploadFolderTemp,
  reportImportDebug,
  preflightImportSpace,
  discardImportTempSession,
} from '../lib/api/library';
import { locateFolderOnServer } from '../lib/api/storage';
import { listTelescopes } from '../lib/api/telescopes';
import { getDebugLoggingStatus } from '../lib/api/settings';
import { useTheme } from '../hooks/useTheme';
import { Modal } from './ui/Modal';
import { CloseConfirm } from './ui/CloseConfirm';
import { ServerFolderPicker } from './folderImport/ServerFolderPicker';

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
/** 'upload' streams files through the browser; 'local' points the server at a
 *  folder already on the same machine (no upload). */
type Source = 'upload' | 'local';

export function ImportModal({ onClose, onReview }: {
  onClose: () => void;
  onReview: (folderPath: string, includeSubframes: boolean, includeFits: boolean, telescopeId: string | null, archiveAll: boolean, tmpId: string | null) => void;
}) {
  const { isDark } = useTheme();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [source, setSource] = useState<Source>('upload');
  const [serverPath, setServerPath] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [includeSubframes, setIncludeSubframes] = useState(false);
  const [archiveAll, setArchiveAll] = useState(false);
  // FITS files (stacked and raw) are always imported; only subframes are optional.
  const includeFits = true;

  const [telescopeId, setTelescopeId] = useState('');
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
  const activeTelescopes = (telescopes ?? []).filter(t => !t.archivedAt);
  // The selected telescope's local-mirror transport path, if it has one —
  // offered as a one-click starting point in the folder browser so the user
  // doesn't have to hunt for a folder Nebulis already knows about.
  const suggestedFolderPath = activeTelescopes
    .find(t => t.id === telescopeId)
    ?.transports?.find(tr => tr.kind === 'local' && tr.localPath)?.localPath ?? null;

  const isDirty = phase === 'staging' || phase === 'uploading';

  const requestClose = useCallback(() => {
    if (isDirty) setConfirmingClose(true);
    else onClose();
  }, [isDirty, onClose]);

  function acceptFiles(files: PickedFile[]) {
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
    if (filtered.length === 0 || preStrip.length === 0) return;

    // The anchor is the dropped folder's name: the common first path segment
    // of everything picked. A multi-root drop has no single anchor; skip.
    const firstSlash = preStrip[0].relativePath.indexOf('/');
    if (firstSlash <= 0) return;
    const anchor = preStrip[0].relativePath.slice(0, firstSlash);
    if (!preStrip.every(f => f.relativePath.startsWith(`${anchor}/`))) return;

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
        if (!controller.signal.aborted) setLocatedPath(result.path);
      })
      .catch(() => { /* best-effort; upload flow is unaffected */ });
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

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    setError(null);

    const items = e.dataTransfer.items;
    if (!items) { acceptFiles([]); return; }

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
    acceptFiles(allFiles);
  }, []);

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
        setError(check.message ?? 'There is not enough free space on the server to stage this upload.');
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
      onReview(result.tmpPath, includeSubframes, includeFits, telescopeId || null, archiveAll, result.tmpId);
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
      const message = err instanceof Error ? err.message : 'Upload failed';
      if (debug) reportImportDebug(`[browser] import dialog: upload aborted with error: ${message}`);
      setError(message);
      setPhase('staging');
    } finally {
      uploadAbortRef.current = null;
    }
  }

  // ── Derived display info ─────────────────────────────────────────────────

  // Count distinct top-level folders for the staging summary. The file count
  // does the real "did I pick the right thing?" job; the folder count is a
  // secondary hint. We don't enumerate the names: for a Dwarf SD card that is
  // hundreds of raw-capture folders, and the review step lists every object
  // properly a click later anyway.
  const folderCount = new Set(
    picked
      .filter(({ relativePath }) => relativePath.includes('/'))
      .map(({ relativePath }) => relativePath.split('/')[0]),
  ).size;

  const card = isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200';
  const mutedText = isDark ? 'text-slate-500' : 'text-slate-400';
  // The server folder picker shows filesystem paths, which are long and deeply
  // nested; 512px truncates every one of them. The upload flow has no such
  // content, so it keeps the narrower dialog.
  const modalWidth = source === 'local' ? 'max-w-3xl' : 'max-w-lg';

  return (
    <Modal
      isOpen
      onClose={requestClose}
      title="Import to Library"
      className={`relative w-full ${modalWidth} max-h-[88vh] flex flex-col rounded-2xl border shadow-2xl ${card}`}
    >
      {/* Header */}
      <div className={`shrink-0 flex items-center justify-between px-6 py-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <h2 className={`font-display font-semibold text-lg ${isDark ? 'text-white' : 'text-slate-900'}`}>
          Import to Library
        </h2>
        <button onClick={requestClose} className={`p-1.5 rounded-lg transition ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}>
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-5">

        {source === 'local' && (
          <>
            <ServerFolderPicker isDark={isDark} onChange={setServerPath} suggestedPath={suggestedFolderPath} />
            <p className={`text-xs ${mutedText}`}>
              Nothing is uploaded: the server reads the folder in place, so large libraries import in seconds.
            </p>
            <button
              type="button"
              onClick={() => { setSource('upload'); setServerPath(null); }}
              className={`flex items-center gap-1.5 text-xs transition ${
                isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <Upload className="w-3.5 h-3.5" />
              Back to file upload
            </button>
          </>
        )}

        {/* Drop zone — upload mode only */}
        {source === 'upload' && (
        <div
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => phase !== 'uploading' && fileInputRef.current?.click()}
          className={`relative border-2 border-dashed rounded-xl py-12 flex flex-col items-center gap-3 transition-colors ${
            phase === 'uploading'
              ? isDark ? 'border-slate-700 cursor-default' : 'border-slate-300 cursor-default'
              : dragging
                ? isDark ? 'border-accent-500 bg-accent-500/10 cursor-copy' : 'border-accent-400 bg-accent-50 cursor-copy'
                : isDark ? 'border-slate-700 hover:border-slate-600 cursor-pointer' : 'border-slate-300 hover:border-slate-400 cursor-pointer'
          }`}
        >
          {phase === 'uploading' ? (
            <>
              <RotateCw className="w-10 h-10 text-accent-500 animate-spin" />
              <div className="text-center space-y-2 w-48">
                <p className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                  Uploading... {uploadProgress}%
                </p>
                <div className={`h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`}>
                  <div
                    className="h-full bg-accent-500 transition-all duration-200"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
            </>
          ) : phase === 'done' ? (
            <>
              <CheckCircle2 className="w-10 h-10 text-emerald-500" />
              <p className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                Upload complete
              </p>
            </>
          ) : (
            <>
              <FolderOpen className={`w-10 h-10 ${dragging ? 'text-accent-500' : mutedText}`} />
              <div className="text-center">
                <p className={`text-sm font-medium ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                  {picked.length > 0 ? 'Drop a different folder, or click to pick one' : 'Drop a folder here, or click to choose one'}
                </p>
                <p className={`text-xs mt-1 ${mutedText}`}>
                  FITS, JPG, PNG, TIFF accepted
                </p>
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
        )}

        {/* Secondary path: import in place from the server's own disk, for the
            case auto-detection can't cover: the files live on the server but
            the user is browsing from another device, so there is nothing to
            drag. Hidden once a drop has been auto-located. */}
        {source === 'upload' && (phase === 'idle' || phase === 'staging') && !locatedPath && (
          <button
            type="button"
            onClick={() => setSource('local')}
            className={`flex items-center gap-1.5 text-xs transition ${
              isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <HardDrive className="w-3.5 h-3.5" />
            Files already on the computer running Nebulis? Import in place, no upload.
          </button>
        )}

        {/* Import toggles — shown before upload */}
        {(phase === 'staging' || phase === 'idle') && (
          <div className="space-y-4">
            <label className={`flex items-center gap-2.5 cursor-pointer select-none text-sm ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              <input
                type="checkbox"
                checked={includeSubframes}
                onChange={e => setIncludeSubframes(e.target.checked)}
                className="w-4 h-4 rounded accent-accent-500"
              />
              Include subframes
              <span className={`text-xs ${mutedText}`}>(individual raw exposures)</span>
            </label>

            <label className={`flex items-start gap-2.5 cursor-pointer select-none text-sm ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              <input
                type="checkbox"
                checked={archiveAll}
                onChange={e => setArchiveAll(e.target.checked)}
                className="w-4 h-4 mt-0.5 rounded accent-accent-500"
              />
              <span>
                Archive everything
                <span className={`block text-xs mt-0.5 ${mutedText}`}>
                  Copy every file in the folder, overriding the choice above. Includes
                  sub-frames, per-frame thumbnails, working and calibration images, rejected
                  frames, logs, and unrecognized types, keeping the original folder structure.
                  This can be very large.
                </span>
              </span>
            </label>

            <div className="space-y-1.5">
              <label className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                Captured with
              </label>
              <select
                value={telescopeId}
                onChange={e => setTelescopeId(e.target.value)}
                className={`w-full px-3 py-2 rounded-lg border text-sm outline-none transition ${
                  isDark ? 'bg-slate-800 border-slate-700 text-slate-200' : 'bg-white border-slate-200 text-slate-800'
                }`}
              >
                <option value="">Not sure / mixed sources</option>
                {activeTelescopes.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <p className={`text-xs ${mutedText}`}>
                Tags every session from this import with the telescope so it shows up correctly in the calendar.
              </p>
            </div>
          </div>
        )}

        {/* Staged file summary */}
        {phase === 'staging' && picked.length > 0 && (
          <div className={`rounded-xl border p-4 ${isDark ? 'border-slate-800 bg-slate-800/40' : 'border-slate-200 bg-slate-50'}`}>
            <div className="flex items-center justify-between">
              <p className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                {picked.length} file{picked.length !== 1 ? 's' : ''} ready
                {folderCount > 0 && ` across ${folderCount} folder${folderCount !== 1 ? 's' : ''}`}
              </p>
              <button
                onClick={() => {
                  locateAbortRef.current?.abort();
                  setLocatedPath(null);
                  setPicked([]);
                  setPhase('idle');
                }}
                className={`text-xs ${mutedText} hover:text-red-500 transition`}
              >
                Clear
              </button>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <p className="text-sm text-red-500">{error}</p>
        )}

        {/* CTA — upload mode. When the dropped folder was found on the server's
            own disk, the primary action becomes an in-place import (no upload)
            with the upload kept as a quiet fallback. */}
        {source === 'upload' && phase === 'staging' && locatedPath && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => onReview(locatedPath, includeSubframes, includeFits, telescopeId || null, archiveAll, null)}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition"
            >
              <HardDrive className="w-4 h-4" />
              Review &amp; import in place (no upload)
            </button>
            <p className={`text-xs ${mutedText}`}>
              This folder is already on the computer running Nebulis at {locatedPath}, so the server can read it directly.
            </p>
            <button
              type="button"
              onClick={handleUpload}
              className={`text-xs transition ${isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'}`}
            >
              Upload the {picked.length} file{picked.length !== 1 ? 's' : ''} instead
            </button>
          </div>
        )}
        {source === 'upload' && phase === 'staging' && !locatedPath && (
          <button
            onClick={handleUpload}
            disabled={picked.length === 0}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition disabled:opacity-50"
          >
            <FolderOpen className="w-4 h-4" />
            Review &amp; import {picked.length} file{picked.length !== 1 ? 's' : ''}
          </button>
        )}

        {/* CTA — local folder mode (no upload) */}
        {source === 'local' && (
          <button
            type="button"
            onClick={() => serverPath && onReview(serverPath, includeSubframes, includeFits, telescopeId || null, archiveAll, null)}
            disabled={!serverPath}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition disabled:opacity-50"
          >
            <FolderOpen className="w-4 h-4" />
            Review &amp; import this folder
          </button>
        )}

        {phase === 'idle' && source === 'upload' && (
          <p className={`text-xs text-center ${mutedText}`}>
            Nebulis will detect objects, session dates, and catalog matches before importing anything.
          </p>
        )}
      </div>

      {confirmingClose && (
        <CloseConfirm
          message="Discard selected files?"
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
