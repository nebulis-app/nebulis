import { useCallback, useRef, useState } from 'react';
import { X, FolderOpen, RotateCw, CheckCircle2 } from 'lucide-react';
import { uploadFolderTemp } from '../lib/api/library';
import { useTheme } from '../hooks/useTheme';
import { Modal } from './ui/Modal';
import { CloseConfirm } from './ui/CloseConfirm';

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

const ACCEPTED_EXTS = new Set([
  '.fit', '.fits', '.fts',
  '.jpg', '.jpeg', '.png', '.tif', '.tiff',
]);

type Phase = 'idle' | 'staging' | 'uploading' | 'done';

export function ImportModal({ onClose, onReview }: {
  onClose: () => void;
  onReview: (folderPath: string, includeSubframes: boolean, includeFits: boolean) => void;
}) {
  const { isDark } = useTheme();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [includeSubframes, setIncludeSubframes] = useState(false);
  const [includeFits, setIncludeFits] = useState(true);

  const isDirty = phase === 'staging' || phase === 'uploading';

  const requestClose = useCallback(() => {
    if (isDirty) setConfirmingClose(true);
    else onClose();
  }, [isDirty, onClose]);

  function acceptFiles(files: PickedFile[]) {
    const stripped = stripTopFolder(files);
    // Drop failed frames client-side so they never reach the upload.
    const filtered = stripped.filter(({ relativePath }) => {
      const basename = relativePath.split('/').pop() ?? '';
      if (basename.toLowerCase().includes('failed')) return false;
      const dot = basename.lastIndexOf('.');
      const ext = dot >= 0 ? basename.slice(dot).toLowerCase() : '';
      return ACCEPTED_EXTS.has(ext);
    });
    setPicked(filtered);
    setError(null);
    setPhase('staging');
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
    setPhase('uploading');
    setUploadProgress(0);
    setError(null);
    try {
      const result = await uploadFolderTemp(
        picked.map(p => p.file),
        picked.map(p => p.relativePath),
        (sent, total) => setUploadProgress(total > 0 ? Math.round((sent / total) * 100) : 0),
      );
      setPhase('done');
      onReview(result.tmpPath, includeSubframes, includeFits);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
      setPhase('staging');
    }
  }

  // ── Derived display info ─────────────────────────────────────────────────

  const objectCounts = picked.reduce<Record<string, number>>((acc, { relativePath }) => {
    const topDir = relativePath.split('/')[0];
    if (topDir && relativePath.includes('/')) {
      acc[topDir] = (acc[topDir] ?? 0) + 1;
    }
    return acc;
  }, {});
  const objectNames = Object.keys(objectCounts);

  const card = isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200';
  const mutedText = isDark ? 'text-slate-500' : 'text-slate-400';

  return (
    <Modal
      isOpen
      onClose={requestClose}
      title="Import to Library"
      className={`relative w-full max-w-lg rounded-2xl border shadow-2xl ${card}`}
    >
      {/* Header */}
      <div className={`flex items-center justify-between px-6 py-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <h2 className={`font-display font-semibold text-lg ${isDark ? 'text-white' : 'text-slate-900'}`}>
          Import to Library
        </h2>
        <button onClick={requestClose} className={`p-1.5 rounded-lg transition ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}>
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-6 space-y-5">

        {/* Drop zone — always visible */}
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

        {/* Import toggles — shown before upload */}
        {(phase === 'staging' || phase === 'idle') && (
          <div className="space-y-2">
            <label className={`flex items-center gap-2.5 cursor-pointer select-none text-sm ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              <input
                type="checkbox"
                checked={includeFits}
                onChange={e => setIncludeFits(e.target.checked)}
                className="w-4 h-4 rounded accent-accent-500"
              />
              Include FITS files
              <span className={`text-xs ${mutedText}`}>(stacked and raw)</span>
            </label>
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

          </div>
        )}

        {/* Staged file summary */}
        {phase === 'staging' && picked.length > 0 && (
          <div className={`rounded-xl border p-4 space-y-3 ${isDark ? 'border-slate-800 bg-slate-800/40' : 'border-slate-200 bg-slate-50'}`}>
            <div className="flex items-center justify-between">
              <p className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                {picked.length} file{picked.length !== 1 ? 's' : ''} ready
                {objectNames.length > 0 && ` across ${objectNames.length} folder${objectNames.length !== 1 ? 's' : ''}`}
              </p>
              <button
                onClick={() => { setPicked([]); setPhase('idle'); }}
                className={`text-xs ${mutedText} hover:text-red-500 transition`}
              >
                Clear
              </button>
            </div>
            {objectNames.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {objectNames.map(name => (
                  <span
                    key={name}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium truncate max-w-[200px] ${
                      isDark ? 'bg-slate-700 text-slate-300' : 'bg-slate-200 text-slate-700'
                    }`}
                    title={name}
                  >
                    {name}
                    <span className={mutedText}>×{objectCounts[name]}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Error */}
        {error && (
          <p className="text-sm text-red-500">{error}</p>
        )}

        {/* CTA */}
        {phase === 'staging' && (
          <button
            onClick={handleUpload}
            disabled={picked.length === 0}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition disabled:opacity-50"
          >
            <FolderOpen className="w-4 h-4" />
            Review &amp; import {picked.length} file{picked.length !== 1 ? 's' : ''}
          </button>
        )}

        {phase === 'idle' && (
          <p className={`text-xs text-center ${mutedText}`}>
            Nebulis will detect objects, session dates, and catalog matches before importing anything.
          </p>
        )}
      </div>

      {confirmingClose && (
        <CloseConfirm
          message="Discard selected files?"
          onCancel={() => setConfirmingClose(false)}
          onDiscard={() => { setConfirmingClose(false); onClose(); }}
        />
      )}
    </Modal>
  );
}
