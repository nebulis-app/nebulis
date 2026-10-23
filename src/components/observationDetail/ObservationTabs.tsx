import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../hooks/useTheme';
import { formatNumber } from '../../lib/formatLocale';

export type ObservationTab = 'images' | 'subframes' | 'processed' | 'videos';

/** Drag payload type an Images-tab tile carries: the file's library path. */
export const SESSION_FILE_DRAG_TYPE = 'application/x-nebulis-session-file';

/**
 * The page's single navigation control, and the boundary between reading the
 * session and working on its files.
 *
 * Everything above it describes the night and is always visible; everything
 * below it is a grid of files, and only one grid at a time. That is what keeps
 * the page a fixed height as a session grows: a new file category becomes a tab
 * rather than another band down the page, and each grid gets the full width
 * where Images and Subframes used to split it in half.
 */
export function ObservationTabs({ active, onChange, counts, onDropFileOnProcessed, dragActive = false }: {
  active: ObservationTab;
  onChange: (tab: ObservationTab) => void;
  /** Present for an admin: lets an Images-tab tile be dropped on the Processed
   *  tab to mark it processed. Receives the dragged file's library path. */
  onDropFileOnProcessed?: (path: string) => void;
  /** A tile is being dragged: the Processed tab shows itself as the drop target. */
  dragActive?: boolean;
  counts: { images: number; subframes: number; processed: number; videos: number };
}) {
  const { t } = useTranslation('observations');
  const { isDark, isNight, isSpace } = useTheme();
  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500';
  const [dropTarget, setDropTarget] = useState(false);
  const accentBorder = isNight ? 'border-red-400' : isSpace ? 'border-violet-400' : 'border-accent-500';

  const tabs: { id: ObservationTab; label: string; count?: number }[] = [
    { id: 'images', label: t('observationDetail.tabs.images'), count: counts.images },
    { id: 'subframes', label: t('observationDetail.tabs.subframes'), count: counts.subframes },
    { id: 'processed', label: t('observationDetail.tabs.processed'), count: counts.processed },
    // Only surfaces when the night has a video (lunar/planetary timelapse). A
    // DSO observation never has one, so the tab stays hidden rather than sitting
    // at zero on every page.
    ...(counts.videos > 0
      ? [{ id: 'videos' as const, label: t('observationDetail.tabs.videos'), count: counts.videos }]
      : []),
  ];

  return (
    <div
      role="tablist"
      aria-label={t('observationDetail.tabs.sessionFiles')}
      className={`flex items-center gap-1 overflow-x-auto no-scrollbar border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}
    >
      {tabs.map(({ id, label, count }) => {
        const isActive = active === id;
        const acceptsDrop = id === 'processed' && !!onDropFileOnProcessed;
        const isDropTarget = acceptsDrop && dropTarget;
        return (
          <button
            key={id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(id)}
            onDragOver={acceptsDrop ? e => {
              if (!e.dataTransfer.types.includes(SESSION_FILE_DRAG_TYPE)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setDropTarget(true);
            } : undefined}
            onDragLeave={acceptsDrop ? () => setDropTarget(false) : undefined}
            onDrop={acceptsDrop ? e => {
              const filePath = e.dataTransfer.getData(SESSION_FILE_DRAG_TYPE);
              setDropTarget(false);
              if (!filePath) return;
              e.preventDefault();
              onDropFileOnProcessed?.(filePath);
            } : undefined}
            title={isDropTarget ? t('observationDetail.tabs.dropToMarkProcessed') : undefined}
            className={`font-display text-[0.8125rem] font-medium inline-flex items-center gap-2 px-3.5 py-2.5 border-b-2 -mb-px whitespace-nowrap transition ${
              acceptsDrop && dragActive && !isDropTarget ? `rounded-t-lg outline-dashed outline-2 -outline-offset-2 outline-accent-500/60 animate-pulse ${accentText}` : ''
            } ${
              isDropTarget
                ? `${accentText} ${accentBorder} ${isDark ? 'bg-accent-500/15' : 'bg-accent-300/60'}`
                : isActive
                ? `${accentText} ${accentBorder}`
                : `border-transparent ${isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-800'}`
            }`}
          >
            {acceptsDrop && (dragActive || isDropTarget) ? t('observationDetail.tabs.dropToMarkProcessed') : label}
            {count != null && !(acceptsDrop && (dragActive || isDropTarget)) && (
              <span className={`text-[0.6875rem] font-sans tabular-nums px-1.5 py-px rounded-full ${
                isActive
                  ? isDark ? 'bg-accent-500/15 text-accent-400' : 'bg-accent-300 text-accent-700'
                  : isDark ? 'bg-slate-800 text-slate-500' : 'bg-slate-100 text-slate-500'
              }`}>
                {formatNumber(count)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
