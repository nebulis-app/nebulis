import { Layers, NotebookPen, CheckCircle2 } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import type { SessionFile } from '../../types';

function formatIntegration(secs: number): string {
  if (secs < 60) return `${Math.round(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

function filterDisplay(f: string): string {
  if (f.toUpperCase() === 'LP') return 'LP Filter';
  if (f.toUpperCase() === 'IRCUT') return 'IR Cut';
  return f;
}

/** "Session Metrics and Notes" tile — integration stats derived from the
 *  stacked file, plus the session-notes entry point. Renders nothing if
 *  there are no stats to show and notes aren't reachable. */
export function ObservationStatsTiles({ files, hasNote, canOpenNotes, isAdmin, onOpenNotes }: {
  files: SessionFile[];
  hasNote: boolean;
  canOpenNotes: boolean;
  isAdmin: boolean;
  onOpenNotes: () => void;
}) {
  const { isDark, isNight, isSpace } = useTheme();
  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500';

  const stackedFile = files.find(f => f.fileType === 'stacked');
  const subCount = files.filter(f => f.fileType === 'sub').length;

  const frameCount = stackedFile?.frameCount ?? null;
  const exposure = stackedFile?.exposure ?? null;
  const filter = stackedFile?.filter ?? null;
  const expSeconds = exposure ? parseFloat(exposure.replace('s', '')) : null;
  const totalSeconds = (frameCount && expSeconds) ? frameCount * expSeconds : null;

  const tiles: { value: string; label: string }[] = [];
  if (frameCount != null) tiles.push({ value: frameCount.toLocaleString(), label: 'Frames Stacked' });
  if (totalSeconds != null) tiles.push({ value: formatIntegration(totalSeconds), label: 'Total Integration' });
  if (exposure) tiles.push({ value: exposure, label: 'Exp. per Frame' });
  if (filter) tiles.push({ value: filterDisplay(filter), label: 'Filter' });
  if (subCount > 0) tiles.push({ value: subCount.toLocaleString(), label: 'Sub-frames' });

  if (tiles.length === 0 && !canOpenNotes) return null;

  return (
    <div className={`rounded-xl border p-4 ${isDark ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
      <h3 className={`font-display font-semibold text-sm flex items-center gap-2 mb-3 ${isDark ? 'text-white' : 'text-slate-900'}`}>
        <Layers className={`w-3.5 h-3.5 ${accentText}`} />
        Session Metrics and Notes
      </h3>
      <div className="grid grid-cols-2 gap-2">
        {tiles.map(({ value, label }) => (
          <div
            key={label}
            className={`rounded-lg px-3 py-2.5 ${isDark ? 'bg-slate-800/60' : 'bg-slate-50'}`}
          >
            <div className={`text-base font-semibold leading-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
              {value}
            </div>
            <div className={`text-[10px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {label}
            </div>
          </div>
        ))}
        {canOpenNotes && (isAdmin || hasNote) && (
          <button
            onClick={onOpenNotes}
            title={isAdmin ? (hasNote ? 'Edit session notes' : 'Add session notes') : 'View session notes'}
            className={`group rounded-lg px-3 py-2.5 text-left transition border ${
              isDark
                ? 'bg-amber-500/10 hover:bg-amber-500/20 border-amber-500/30'
                : 'bg-amber-50 hover:bg-amber-100 border-amber-200'
            }`}
          >
            <div className={`text-base font-semibold leading-tight flex items-center gap-1.5 ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
              <NotebookPen className="w-4 h-4" />
              Session Notes
              {hasNote && (
                <CheckCircle2 className={`w-3.5 h-3.5 ${isDark ? 'text-amber-400' : 'text-amber-600'}`} />
              )}
            </div>
            <div className={`text-[10px] mt-0.5 ${isDark ? 'text-amber-500/70' : 'text-amber-700/70'}`}>
              {isAdmin
                ? (hasNote ? 'Saved. Click to edit.' : 'Click to add')
                : 'Click to view'}
            </div>
          </button>
        )}
      </div>
    </div>
  );
}
