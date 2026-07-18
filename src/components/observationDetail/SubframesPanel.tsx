import { useEffect, useRef, useState } from 'react';
import { Telescope, Satellite, Download, Trash2 } from 'lucide-react';
import { FitsThumbnail } from '../FitsThumbnail';
import { useTheme } from '../../hooks/useTheme';
import type { SessionFile } from '../../types';

/** Telescope subframes tray: a fixed-height grid that measures how many
 *  64px tiles fit and reserves the last slot for the "open viewer" button.
 *  The ResizeObserver measurement is entirely local to this panel. */
export function SubframesPanel({
  subFrames,
  isAdmin,
  telescopeOnline,
  archiveState,
  onDownloadToComputer,
  onOpenSync,
  onScanTrails,
  onDeleteAllSubframes,
  onOpenGallery,
}: {
  subFrames: SessionFile[];
  isAdmin: boolean;
  telescopeOnline: boolean;
  archiveState: { done: number; total: number } | 'idle' | 'error';
  onDownloadToComputer: () => void;
  onOpenSync: () => void;
  onScanTrails: () => void;
  onDeleteAllSubframes: () => void;
  onOpenGallery: (index: number, fileList?: SessionFile[]) => void;
}) {
  const { isDark } = useTheme();
  const hasSubFrames = subFrames.length > 0;

  const subFramesRowRef = useRef<HTMLDivElement>(null);
  const [subFramesVisible, setSubFramesVisible] = useState(20);
  useEffect(() => {
    const el = subFramesRowRef.current;
    if (!el) return;
    const TILE = 64 + 6; // w-16 + gap-1.5
    const PADDING = 24;  // p-3 each side
    const measure = () => {
      const cols = Math.max(1, Math.floor((el.offsetWidth - PADDING + 6) / TILE));
      const rows = Math.max(1, Math.floor((el.offsetHeight - PADDING + 6) / TILE));
      setSubFramesVisible(cols * rows);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className={`rounded-2xl border min-w-0 flex flex-col ${isDark ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
      <div className={`flex items-center justify-between p-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <h2 className={`font-display font-semibold flex items-center gap-2 ${isDark ? 'text-white' : 'text-slate-900'}`}>
          <Telescope className="w-4 h-4 flex-shrink-0 text-teal-500" />
          Subframes
          {hasSubFrames && (
            <span className={`text-xs px-2 py-0.5 rounded-full ${isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>
              {subFrames.length}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          {isAdmin && hasSubFrames && subFrames.some(f => f.type === 'fits') && (
            <button
              onClick={onScanTrails}
              title="Scan all FITS subframes for satellite trails"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                isDark
                  ? 'border-amber-500/30 text-amber-400 hover:bg-amber-500/10'
                  : 'border-amber-300 text-amber-600 hover:bg-amber-50'
              }`}
            >
              <Satellite className="w-3.5 h-3.5" />
              Scan Trails
            </button>
          )}
          {isAdmin && (
            <span
              title={!telescopeOnline ? 'Telescope is offline - connect to download subs' : 'Download all raw subframes for this session from the telescope to your library'}
              className={!telescopeOnline ? 'cursor-not-allowed' : undefined}
            >
              <button
                onClick={onOpenSync}
                disabled={!telescopeOnline}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                  !telescopeOnline
                    ? isDark
                      ? 'border-slate-800 text-slate-600 cursor-not-allowed'
                      : 'border-slate-200 text-slate-300 cursor-not-allowed'
                    : isDark
                      ? 'border-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                      : 'border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                }`}
              >
                <Download className="w-3.5 h-3.5" />
                Sync Subs
              </button>
            </span>
          )}
          {hasSubFrames && (
            <button
              onClick={onDownloadToComputer}
              disabled={archiveState !== 'idle'}
              title={
                archiveState === 'error'
                  ? 'Failed. Try again.'
                  : 'Zip the locally-stored subframes for this session and download to your computer'
              }
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition disabled:cursor-wait ${
                archiveState === 'error'
                  ? isDark
                    ? 'border-red-500/30 text-red-400'
                    : 'border-red-300 text-red-600'
                  : isDark
                    ? 'border-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                    : 'border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-50'
              }`}
            >
              <Download className="w-3.5 h-3.5" />
              {archiveState === 'idle'
                ? 'Download to Computer'
                : archiveState === 'error'
                  ? 'Download failed'
                  : `Zipping ${archiveState.done}/${archiveState.total}…`}
            </button>
          )}
          {isAdmin && hasSubFrames && (
            <button
              onClick={onDeleteAllSubframes}
              title="Delete all subframes for this session"
              className={`p-1.5 rounded-lg transition ${isDark ? 'text-slate-600 hover:text-red-400 hover:bg-red-500/10' : 'text-slate-400 hover:text-red-500 hover:bg-red-50'}`}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {subFrames.length > 0 ? (
        <div ref={subFramesRowRef} className="flex flex-wrap gap-1.5 p-3 flex-1 min-h-0 content-start">
          {(() => {
            // Always reserve the last slot for the "···" viewer button
            const capacity = subFramesVisible - 1;
            const shown = Math.min(capacity, subFrames.length);
            const overflow = subFrames.length - shown;
            return (
              <>
                {subFrames.slice(0, shown).map((file, idx) => (
                  <button
                    key={file.path}
                    onClick={() => onOpenGallery(idx, subFrames)}
                    title={file.name}
                    className={`flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden border-2 ${
                      isDark ? 'border-slate-700 hover:border-slate-500 bg-slate-800' : 'border-slate-200 hover:border-slate-400 bg-slate-100'
                    }`}
                  >
                    {file.type === 'fits' ? (
                      <FitsThumbnail url={file.downloadUrl} thumbUrl={file.thumbUrl} stretch={1.0} isDark={isDark} />
                    ) : (
                      <img
                        src={file.downloadUrl}
                        alt={file.name}
                        className="w-full h-full object-cover"
                        onError={e => { if (e.target instanceof HTMLImageElement) e.target.style.display = 'none'; }}
                      />
                    )}
                  </button>
                ))}
                <button
                  onClick={() => onOpenGallery(overflow > 0 ? shown : 0, subFrames)}
                  title={overflow > 0 ? `${overflow} more subframes. Open viewer.` : 'Open subframe viewer'}
                  className={`flex-shrink-0 w-16 h-16 rounded-lg border-2 flex flex-col items-center justify-center gap-0.5 ${
                    isDark ? 'border-slate-700 hover:border-slate-500 bg-slate-800 text-slate-400 hover:text-slate-200' : 'border-slate-200 hover:border-slate-400 bg-slate-100 text-slate-500 hover:text-slate-700'
                  }`}
                >
                  <span className="text-lg leading-none tracking-widest">···</span>
                  {overflow > 0 && <span className="text-[10px] font-medium">+{overflow}</span>}
                </button>
              </>
            );
          })()}
        </div>
      ) : (
        <div className={`p-8 text-center ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
          No subframes downloaded yet - connect your telescope and use Download Subs to sync them.
        </div>
      )}
    </div>
  );
}
