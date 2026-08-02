import { useState, useEffect, useCallback, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, X, ImagePlus, AlertTriangle, Loader2, Layers, CheckSquare, Square } from 'lucide-react';
import { uploadProcessedImage, createProcessingRun, getLibrarySessions } from '../lib/api/library';
import { consumeCombinedSessions } from '../lib/lastCombinedSessions';
import { canPreviewLocally, processedFormatLabel } from '../lib/processedFormats';
import { useTheme } from '../hooks/useTheme';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  objectId: string;
  date: string;
  initialFile?: File | null;
}

export function UploadProcessedModal({ isOpen, onClose, objectId, date, initialFile }: Props) {
  const { isDark, isNight, isSpace } = useTheme();
  const queryClient = useQueryClient();

  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadNotes, setUploadNotes] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // "Combine multiple nights" — off by default, so the common single-session
  // upload is unchanged. When on, `selectedDates` (a superset of just `date`)
  // becomes the nights a processingRun records this image as combining.
  const [combineMultiple, setCombineMultiple] = useState(false);
  const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set([date]));
  const [software, setSoftware] = useState('');

  const { data: sessions = [] } = useQuery({
    queryKey: ['library-sessions', objectId],
    queryFn: () => getLibrarySessions(objectId),
    enabled: isOpen,
  });

  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500';

  // The live object URL, so it can be revoked when replaced or on unmount.
  // Leaking these pins the whole file in memory, which is the thing we are
  // trying to avoid.
  const previewUrlRef = useRef<string | null>(null);
  const releasePreview = useCallback(() => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
  }, []);
  useEffect(() => releasePreview, [releasePreview]);

  const handleSelectFile = useCallback((file: File) => {
    setUploadFile(file);
    setUploadError('');
    releasePreview();
    // Only preview formats a browser can draw, and only at a sane size.
    // createObjectURL rather than readAsDataURL: the latter reads the whole file
    // into a base64 string (roughly 1.4x its size), which at the 2 GB upload
    // ceiling takes the tab down. An object URL costs nothing to create.
    if (!canPreviewLocally(file)) {
      setUploadPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    previewUrlRef.current = url;
    setUploadPreview(url);
  }, [releasePreview]);

  useEffect(() => {
    if (!isOpen) return;
    setUploadTitle('');
    setUploadNotes('');
    setUploadError('');
    setIsDragging(false);
    setSoftware('');
    // A prior "Combine & Download" for this object hands us the nights it
    // combined, one-shot, so the user doesn't have to re-pick them here.
    const remembered = consumeCombinedSessions(objectId);
    if (remembered && remembered.length > 1) {
      setCombineMultiple(true);
      setSelectedDates(new Set(remembered));
    } else {
      setCombineMultiple(false);
      setSelectedDates(new Set([date]));
    }
    if (initialFile) {
      handleSelectFile(initialFile);
    } else {
      setUploadFile(null);
      setUploadPreview(null);
    }
  }, [isOpen, objectId, date, initialFile, handleSelectFile]);

  function toggleDate(d: string) {
    setSelectedDates(prev => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });
  }

  const handleUpload = useCallback(async () => {
    if (!uploadFile || isUploading) return;
    setIsUploading(true);
    setUploadError('');
    try {
      const dates = combineMultiple ? Array.from(selectedDates) : [date];
      let runId: string | undefined;
      let targetDate = date;
      if (dates.length > 1) {
        const run = await createProcessingRun(objectId, { dates, title: uploadTitle, notes: uploadNotes, software });
        runId = run.id;
        targetDate = [...dates].sort().at(-1) ?? date;
      }
      await uploadProcessedImage(objectId, targetDate, uploadFile, uploadTitle, uploadNotes, runId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['processedImages', objectId, targetDate] }),
        queryClient.invalidateQueries({ queryKey: ['all-processed-images', objectId] }),
        queryClient.invalidateQueries({ queryKey: ['processingRuns', objectId] }),
      ]);
      onClose();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setIsUploading(false);
    }
  }, [uploadFile, isUploading, objectId, date, uploadTitle, uploadNotes, software, combineMultiple, selectedDates, queryClient, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className={`w-full max-w-lg rounded-2xl border shadow-2xl ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'}`}>
        <div className={`flex items-center justify-between p-5 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-full ${isDark ? 'bg-accent-500/10' : 'bg-accent-50'}`}>
              <Sparkles className={`w-4 h-4 ${accentText}`} />
            </div>
            <h3 className={`font-display font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>
              Upload Processed Image
            </h3>
          </div>
          <button
            onClick={onClose}
            className={`p-2 rounded-lg transition ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div
            className={`rounded-xl border-2 border-dashed transition cursor-pointer ${
              isDragging
                ? isDark ? 'border-accent-500/60 bg-accent-500/10' : 'border-accent-400 bg-accent-50'
                : uploadFile
                  ? isDark ? 'border-accent-500/40 bg-accent-500/5' : 'border-accent-300 bg-accent-50/50'
                  : isDark ? 'border-slate-700 hover:border-slate-600' : 'border-slate-200 hover:border-slate-300'
            }`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={e => { e.preventDefault(); setIsDragging(false); const f = e.dataTransfer.files[0]; if (f) handleSelectFile(f); }}
          >
            {uploadPreview ? (
              <div className="relative">
                <img src={uploadPreview} alt="Preview" className="w-full max-h-48 object-contain rounded-xl" />
                <div className={`absolute bottom-0 left-0 right-0 rounded-b-xl px-3 py-2 text-xs ${isDark ? 'bg-black/60 text-slate-300' : 'bg-white/80 text-slate-600'}`}>
                  {uploadFile?.name} · {uploadFile ? (uploadFile.size / 1024 / 1024).toFixed(1) : 0} MB
                </div>
              </div>
            ) : uploadFile ? (
              /* Selected but not previewable (XISF, FITS, PSD, RAW). Without
                 this the drop zone falls back to its empty state and the user
                 gets no sign their file was accepted. */
              <div className="flex flex-col items-center justify-center gap-2 py-8">
                <div className={`px-3 py-2 rounded-lg font-mono text-sm font-bold ${isDark ? 'bg-slate-800 text-accent-400' : 'bg-slate-100 text-accent-600'}`}>
                  {processedFormatLabel(uploadFile.name) ?? 'FILE'}
                </div>
                <p className={`text-sm font-medium px-4 text-center break-all ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                  {uploadFile.name}
                </p>
                <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  {(uploadFile.size / 1024 / 1024).toFixed(1)} MB · stored for download, not previewed
                </p>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center gap-2 py-8">
                <div className={`p-3 rounded-full ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                  <ImagePlus className={`w-6 h-6 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
                </div>
                <p className={`text-sm font-medium ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  Drop your image here or click to browse
                </p>
                <p className={`text-xs ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                  JPG, PNG, TIFF, XISF, FITS, PSD, RAW · up to 2 GB
                </p>
              </div>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".jpg,.jpeg,.png,.tif,.tiff,.xisf,.fit,.fits,.fts,.psd,.xcf,.dng,.cr2,.cr3,.nef,.arw"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleSelectFile(f); }}
          />

          <div className="space-y-1">
            <label className={`text-xs font-medium ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              Title <span className={isDark ? 'text-slate-600' : 'text-slate-400'}>(optional)</span>
            </label>
            <input
              type="text"
              value={uploadTitle}
              onChange={e => setUploadTitle(e.target.value)}
              placeholder="e.g. Final HOO version, PixInsight processed"
              className={`w-full px-3 py-2 rounded-lg border text-sm transition ${
                isDark
                  ? 'bg-slate-800 border-slate-700 text-white placeholder-slate-600 focus:border-violet-500'
                  : 'bg-white border-slate-300 text-slate-900 placeholder-slate-400 focus:border-accent-500'
              } focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500`}
            />
          </div>

          <div className="space-y-1">
            <label className={`text-xs font-medium ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              Notes <span className={isDark ? 'text-slate-600' : 'text-slate-400'}>(optional)</span>
            </label>
            <textarea
              value={uploadNotes}
              onChange={e => setUploadNotes(e.target.value)}
              placeholder="Processing notes, software used, integration time…"
              rows={3}
              className={`w-full px-3 py-2 rounded-lg border text-sm resize-none transition ${
                isDark
                  ? 'bg-slate-800 border-slate-700 text-white placeholder-slate-600 focus:border-violet-500'
                  : 'bg-white border-slate-300 text-slate-900 placeholder-slate-400 focus:border-accent-500'
              } focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500`}
            />
          </div>

          <div className={`rounded-xl border ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
            <button
              type="button"
              onClick={() => setCombineMultiple(v => !v)}
              className={`w-full flex items-center gap-2 px-3 py-2.5 text-sm font-medium transition ${
                isDark ? 'text-slate-300 hover:bg-slate-800/50' : 'text-slate-700 hover:bg-slate-50'
              }`}
            >
              {combineMultiple
                ? <CheckSquare className={`w-4 h-4 shrink-0 ${accentText}`} />
                : <Square className={`w-4 h-4 shrink-0 ${isDark ? 'text-slate-600' : 'text-slate-300'}`} />}
              <Layers className="w-3.5 h-3.5 shrink-0 opacity-60" />
              <span className="flex-1 text-left">Combine multiple nights</span>
            </button>
            {combineMultiple && (
              <div className={`px-3 pb-3 space-y-2 border-t ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
                <p className={`text-xs pt-2.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  Which nights does this stack combine?
                </p>
                <div className="max-h-32 overflow-y-auto space-y-1">
                  {sessions.map(s => {
                    const checked = selectedDates.has(s.date);
                    return (
                      <button
                        type="button"
                        key={s.date}
                        onClick={() => toggleDate(s.date)}
                        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition ${
                          checked
                            ? isDark ? 'bg-accent-500/10 text-slate-100' : 'bg-accent-50 text-accent-700'
                            : isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-50 text-slate-600'
                        }`}
                      >
                        {checked
                          ? <CheckSquare className="w-3.5 h-3.5 shrink-0 text-accent-500" />
                          : <Square className={`w-3.5 h-3.5 shrink-0 ${isDark ? 'text-slate-600' : 'text-slate-300'}`} />}
                        {s.date}
                      </button>
                    );
                  })}
                </div>
                <input
                  type="text"
                  value={software}
                  onChange={e => setSoftware(e.target.value)}
                  placeholder="Software used (optional)"
                  className={`w-full px-3 py-1.5 rounded-lg border text-xs transition ${
                    isDark
                      ? 'bg-slate-800 border-slate-700 text-white placeholder-slate-600 focus:border-violet-500'
                      : 'bg-white border-slate-300 text-slate-900 placeholder-slate-400 focus:border-accent-500'
                  } focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500`}
                />
              </div>
            )}
          </div>

          {uploadError && (
            <div className="flex items-center gap-2 text-sm text-red-500">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              {uploadError}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-5 pb-5">
          <button
            onClick={onClose}
            disabled={isUploading}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'}`}
          >
            Cancel
          </button>
          <button
            onClick={handleUpload}
            disabled={!uploadFile || isUploading}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 ${
              isDark
                ? 'bg-accent-500/15 text-accent-400 hover:bg-accent-500/25 border border-accent-500/30'
                : 'bg-accent-500 text-white hover:bg-accent-600'
            }`}
          >
            {isUploading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {isUploading ? 'Uploading…' : 'Upload Image'}
          </button>
        </div>
      </div>
    </div>
  );
}
