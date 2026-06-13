import { useState, useEffect, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Sparkles, X, ImagePlus, AlertTriangle, Loader2 } from 'lucide-react';
import { uploadProcessedImage } from '../lib/api/library';
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

  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500';

  const handleSelectFile = useCallback((file: File) => {
    setUploadFile(file);
    setUploadError('');
    const reader = new FileReader();
    reader.onload = e => {
      const result = e.target?.result;
      if (typeof result === 'string') setUploadPreview(result);
    };
    reader.readAsDataURL(file);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setUploadTitle('');
    setUploadNotes('');
    setUploadError('');
    setIsDragging(false);
    if (initialFile) {
      handleSelectFile(initialFile);
    } else {
      setUploadFile(null);
      setUploadPreview(null);
    }
  }, [isOpen, initialFile, handleSelectFile]);

  const handleUpload = useCallback(async () => {
    if (!uploadFile || isUploading) return;
    setIsUploading(true);
    setUploadError('');
    try {
      await uploadProcessedImage(objectId, date, uploadFile, uploadTitle, uploadNotes);
      await queryClient.invalidateQueries({ queryKey: ['processedImages', objectId, date] });
      onClose();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setIsUploading(false);
    }
  }, [uploadFile, isUploading, objectId, date, uploadTitle, uploadNotes, queryClient, onClose]);

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
            ) : (
              <div className="flex flex-col items-center justify-center gap-2 py-8">
                <div className={`p-3 rounded-full ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                  <ImagePlus className={`w-6 h-6 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
                </div>
                <p className={`text-sm font-medium ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  Drop your image here or click to browse
                </p>
                <p className={`text-xs ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                  JPG, PNG, TIFF · up to 300 MB
                </p>
              </div>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".jpg,.jpeg,.png,.tif,.tiff"
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
