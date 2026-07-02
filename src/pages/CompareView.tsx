import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ArrowLeft, Columns, Layers, Calendar, GripVertical, ImageOff } from 'lucide-react';
import { getLibrarySessions } from '../lib/api/library';
import { useTheme } from '../hooks/useTheme';

export function CompareView() {
  const { objectId } = useParams<{ objectId: string }>();
  const { isDark } = useTheme();

  const { data: sessions } = useQuery({
    queryKey: ['library-sessions', objectId],
    queryFn: () => getLibrarySessions(objectId!),
    enabled: !!objectId,
  });

  const [leftSession, setLeftSession] = useState<string | null>(null);
  const [rightSession, setRightSession] = useState<string | null>(null);
  const [sliderPos, setSliderPos] = useState(50);
  const [mode, setMode] = useState<'side-by-side' | 'slider'>('side-by-side');

  // Compute effective selections: use user choice if set, otherwise auto-select first two sessions
  const effectiveLeft = leftSession ?? (sessions && sessions.length >= 2 ? sessions[sessions.length - 1]?.thumbnailUrl : '') ?? '';
  const effectiveRight = rightSession ?? (sessions && sessions.length >= 2 ? sessions[0]?.thumbnailUrl : '') ?? '';

  const sessionOptions = sessions?.map(s => ({
    value: s.thumbnailUrl,
    label: s.date !== 'unknown'
      ? new Date(s.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : s.id,
    date: s.date,
    fileCount: s.fileCount,
    stackedCount: s.stackedCount,
  })) || [];

  const selectClass = `px-3 py-2 rounded-lg border text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 ${
    isDark ? 'bg-slate-800 border-slate-700 text-slate-200' : 'bg-white border-slate-200 text-slate-800'
  }`;

  return (
    <div className="space-y-6">
      <Link
        to={`/object/${encodeURIComponent(objectId!)}`}
        className={`inline-flex items-center gap-2 text-sm font-medium transition ${
          isDark ? 'text-slate-400 hover:text-accent-400' : 'text-slate-500 hover:text-accent-600'
        }`}
      >
        <ArrowLeft className="w-4 h-4" />
        Back to {objectId}
      </Link>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h1 className={`font-display text-2xl font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>
          <Columns className="w-6 h-6 inline mr-2 text-accent-500" />
          Compare Sessions
        </h1>

        <div className={`flex rounded-xl overflow-hidden border ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          <button
            onClick={() => setMode('side-by-side')}
            className={`px-4 py-2 text-sm font-medium transition ${
              mode === 'side-by-side'
                ? isDark ? 'bg-accent-500/15 text-accent-400' : 'bg-accent-300 text-accent-700'
                : isDark ? 'bg-slate-900 text-slate-400' : 'bg-white text-slate-500'
            }`}
          >
            <Columns className="w-3.5 h-3.5 inline mr-1.5" />Side by Side
          </button>
          <button
            onClick={() => setMode('slider')}
            className={`px-4 py-2 text-sm font-medium transition ${
              mode === 'slider'
                ? isDark ? 'bg-accent-500/15 text-accent-400' : 'bg-accent-300 text-accent-700'
                : isDark ? 'bg-slate-900 text-slate-400' : 'bg-white text-slate-500'
            }`}
          >
            <GripVertical className="w-3.5 h-3.5 inline mr-1.5" />Slider
          </button>
        </div>
      </div>

      {/* Session selectors */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={`block text-xs font-medium mb-1.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            <Calendar className="w-3 h-3 inline mr-1" /> Left Image
          </label>
          <select value={effectiveLeft} onChange={e => setLeftSession(e.target.value)} className={`w-full ${selectClass}`}>
            <option value="">Select session...</option>
            {sessionOptions.map(s => (
              <option key={`l-${s.value}`} value={s.value}>
                {s.label} ({s.stackedCount} stacked, {s.fileCount} files)
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={`block text-xs font-medium mb-1.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            <Calendar className="w-3 h-3 inline mr-1" /> Right Image
          </label>
          <select value={effectiveRight} onChange={e => setRightSession(e.target.value)} className={`w-full ${selectClass}`}>
            <option value="">Select session...</option>
            {sessionOptions.map(s => (
              <option key={`r-${s.value}`} value={s.value}>
                {s.label} ({s.stackedCount} stacked, {s.fileCount} files)
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Comparison area */}
      {effectiveLeft && effectiveRight ? (
        mode === 'side-by-side' ? (
          <div className="grid grid-cols-2 gap-4">
            <CompareImage src={effectiveLeft} alt="Left" isDark={isDark} />
            <CompareImage src={effectiveRight} alt="Right" isDark={isDark} />
          </div>
        ) : (
          <div className={`relative rounded-xl overflow-hidden border ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
            <img src={effectiveRight} alt="Right" className="w-full h-auto" />
            <div
              className="absolute top-0 left-0 h-full overflow-hidden"
              style={{ width: `${sliderPos}%` }}
            >
              <img
                src={effectiveLeft}
                alt="Left"
                className="h-full object-cover"
                style={{ width: `${10000 / sliderPos}%`, maxWidth: 'none' }}
              />
            </div>
            {/* Slider handle */}
            <div
              className="absolute top-0 h-full w-1 bg-accent-500 cursor-ew-resize"
              style={{ left: `${sliderPos}%`, transform: 'translateX(-50%)' }}
            >
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-accent-500 flex items-center justify-center shadow-lg">
                <GripVertical className="w-4 h-4 text-white" />
              </div>
            </div>
            {/* Slider input overlay */}
            <input
              type="range"
              min="5"
              max="95"
              value={sliderPos}
              onChange={e => setSliderPos(parseInt(e.target.value))}
              className="absolute top-0 left-0 w-full h-full opacity-0 cursor-ew-resize"
            />
          </div>
        )
      ) : (
        <div className={`text-center py-20 rounded-xl border ${
          isDark ? 'bg-slate-900/50 border-slate-800 text-slate-500' : 'bg-white border-slate-200 text-slate-400'
        }`}>
          <Layers className="w-10 h-10 mx-auto mb-3 opacity-40" />
          <p>Select two sessions above to compare</p>
        </div>
      )}
    </div>
  );
}

function CompareImage({ src, alt, isDark }: { src: string; alt: string; isDark: boolean }) {
  const [error, setError] = useState(false);
  return (
    <div className={`rounded-xl overflow-hidden border ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
      {error ? (
        <div className={`flex flex-col items-center justify-center py-20 ${isDark ? 'bg-slate-900 text-slate-600' : 'bg-slate-50 text-slate-400'}`}>
          <ImageOff className="w-8 h-8 mb-2" />
          <span className="text-sm">Failed to load image</span>
          <span className="text-xs opacity-60 mt-1">The file may be unavailable.</span>
        </div>
      ) : (
        <img src={src} alt={alt} className="w-full h-auto" onError={() => setError(true)} />
      )}
    </div>
  );
}
