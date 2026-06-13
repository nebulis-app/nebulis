import { useState } from 'react';
import { X, Columns, GripVertical, ImageOff, Layers, Clock } from 'lucide-react';
import { Modal } from './ui/Modal';

/** Minimal interface accepted by the compare modal — both SessionFile and ProcessedImage satisfy this. */
export interface CompareFile {
  name: string;
  downloadUrl: string;
  exposure?: string | null;
  frameCount?: number | null;
  filter?: string | null;
}

interface ImageCompareModalProps {
  leftFile: CompareFile;
  rightFile: CompareFile;
  onClose: () => void;
  isDark: boolean;
}

export function ImageCompareModal({ leftFile, rightFile, onClose, isDark }: ImageCompareModalProps) {
  const [mode, setMode] = useState<'side-by-side' | 'slider'>('slider');
  const [sliderPos, setSliderPos] = useState(50);

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Compare Images"
      className="w-full h-full max-w-none flex flex-col bg-black/95 backdrop-blur-sm"
    >
      {/* Header */}
      <div className={`flex items-center justify-between px-5 py-3 border-b shrink-0 ${
        isDark ? 'border-slate-800 bg-slate-950' : 'border-slate-200 bg-white'
      }`}>
        <div className="flex items-center gap-3">
          <Columns className="w-5 h-5 text-accent-500" />
          <span className={`font-semibold text-sm ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
            Compare Images
          </span>
        </div>

        {/* Mode toggle */}
        <div className={`flex rounded-xl overflow-hidden border ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
          <button
            onClick={() => setMode('side-by-side')}
            className={`px-4 py-1.5 text-sm font-medium transition ${
              mode === 'side-by-side'
                ? isDark ? 'bg-accent-500/15 text-accent-400' : 'bg-accent-300 text-accent-700'
                : isDark ? 'bg-slate-900 text-slate-400 hover:bg-slate-800' : 'bg-white text-slate-500 hover:bg-slate-50'
            }`}
          >
            <Columns className="w-3.5 h-3.5 inline mr-1.5" />Side by Side
          </button>
          <button
            onClick={() => setMode('slider')}
            className={`px-4 py-1.5 text-sm font-medium transition ${
              mode === 'slider'
                ? isDark ? 'bg-accent-500/15 text-accent-400' : 'bg-accent-300 text-accent-700'
                : isDark ? 'bg-slate-900 text-slate-400 hover:bg-slate-800' : 'bg-white text-slate-500 hover:bg-slate-50'
            }`}
          >
            <GripVertical className="w-3.5 h-3.5 inline mr-1.5" />Slider
          </button>
        </div>

        <button
          onClick={onClose}
          className={`p-2 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
          title="Close (Esc)"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Labels bar */}
      {mode === 'side-by-side' && (
        <div className={`grid grid-cols-2 gap-4 px-5 pt-3 shrink-0 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
          <FileLabel file={leftFile} slot={1} isDark={isDark} />
          <FileLabel file={rightFile} slot={2} isDark={isDark} />
        </div>
      )}

      {/* Comparison area */}
      <div className="flex-1 overflow-auto px-5 py-4">
        {mode === 'side-by-side' ? (
          <div className="grid grid-cols-2 gap-4 h-full">
            <CompareImage src={leftFile.downloadUrl} alt="Image 1" isDark={isDark} />
            <CompareImage src={rightFile.downloadUrl} alt="Image 2" isDark={isDark} />
          </div>
        ) : (
          <div className="flex flex-col gap-3 h-full">
            {/* Slider labels */}
            <div className="grid grid-cols-2 gap-4 shrink-0">
              <FileLabel file={leftFile} slot={1} isDark={isDark} />
              <FileLabel file={rightFile} slot={2} isDark={isDark} />
            </div>
            <div className={`relative rounded-xl overflow-hidden border flex-1 min-h-0 ${
              isDark ? 'border-slate-800' : 'border-slate-200'
            }`}>
              <img
                src={rightFile.downloadUrl}
                alt="Image 2"
                className="w-full h-full object-contain"
                style={{ display: 'block' }}
              />
              <div
                className="absolute top-0 left-0 h-full overflow-hidden"
                style={{ width: `${sliderPos}%` }}
              >
                <img
                  src={leftFile.downloadUrl}
                  alt="Image 1"
                  className="h-full object-contain"
                  style={{ width: `${10000 / sliderPos}%`, maxWidth: 'none' }}
                />
              </div>
              {/* Divider line */}
              <div
                className="absolute top-0 h-full w-0.5 bg-accent-500 pointer-events-none"
                style={{ left: `${sliderPos}%`, transform: 'translateX(-50%)' }}
              />
              {/* Handle */}
              <div
                className="absolute top-1/2 -translate-y-1/2 pointer-events-none"
                style={{ left: `${sliderPos}%`, transform: 'translate(-50%, -50%)' }}
              >
                <div className="w-9 h-9 rounded-full bg-accent-500 flex items-center justify-center shadow-lg">
                  <GripVertical className="w-4 h-4 text-white" />
                </div>
              </div>
              {/* Invisible range input for drag */}
              <input
                type="range"
                min="5"
                max="95"
                value={sliderPos}
                onChange={e => setSliderPos(parseInt(e.target.value))}
                className="absolute top-0 left-0 w-full h-full opacity-0 cursor-ew-resize"
              />
              {/* Corner labels on slider */}
              <div className="absolute top-3 left-3 pointer-events-none">
                <span className="px-2 py-0.5 rounded-md bg-black/60 text-white text-xs font-medium">1</span>
              </div>
              <div className="absolute top-3 right-3 pointer-events-none">
                <span className="px-2 py-0.5 rounded-md bg-black/60 text-white text-xs font-medium">2</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function FileLabel({ file, slot, isDark }: { file: CompareFile; slot: 1 | 2; isDark: boolean }) {
  return (
    <div className={`flex items-center gap-2 text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
      <span className={`w-5 h-5 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0 ${
        slot === 1 ? 'bg-accent-500' : 'bg-violet-500'
      }`}>
        {slot}
      </span>
      <span className="truncate font-medium">{file.name}</span>
      {file.exposure && (
        <span className="flex items-center gap-0.5 shrink-0 opacity-70">
          <Clock className="w-3 h-3" />{file.exposure}
        </span>
      )}
      {file.frameCount && (
        <span className="flex items-center gap-0.5 shrink-0 opacity-70">
          <Layers className="w-3 h-3" />{file.frameCount}
        </span>
      )}
      {file.filter && (
        <span className="shrink-0 opacity-70">{file.filter}</span>
      )}
    </div>
  );
}

function CompareImage({ src, alt, isDark }: { src: string; alt: string; isDark: boolean }) {
  const [error, setError] = useState(false);
  return (
    <div className={`rounded-xl overflow-hidden border h-full ${isDark ? 'border-slate-800 bg-slate-950' : 'border-slate-200 bg-slate-50'}`}>
      {error ? (
        <div className={`flex flex-col items-center justify-center h-full py-20 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
          <ImageOff className="w-8 h-8 mb-2" />
          <span className="text-sm">Failed to load</span>
          <span className="text-xs opacity-60 mt-1">Close and reopen to try again.</span>
        </div>
      ) : (
        <img src={src} alt={alt} className="w-full h-full object-contain" onError={() => setError(true)} />
      )}
    </div>
  );
}
