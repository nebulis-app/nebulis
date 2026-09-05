import { useTheme } from '../../hooks/useTheme';

export type ObservationTab = 'images' | 'subframes' | 'processed' | 'videos';

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
export function ObservationTabs({ active, onChange, counts }: {
  active: ObservationTab;
  onChange: (tab: ObservationTab) => void;
  counts: { images: number; subframes: number; processed: number; videos: number };
}) {
  const { isDark, isNight, isSpace } = useTheme();
  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500';
  const accentBorder = isNight ? 'border-red-400' : isSpace ? 'border-violet-400' : 'border-accent-500';

  const tabs: { id: ObservationTab; label: string; count?: number }[] = [
    { id: 'images', label: 'Images', count: counts.images },
    { id: 'subframes', label: 'Subframes', count: counts.subframes },
    { id: 'processed', label: 'Processed', count: counts.processed },
    // Only surfaces when the night has a video (lunar/planetary timelapse). A
    // DSO observation never has one, so the tab stays hidden rather than sitting
    // at zero on every page.
    ...(counts.videos > 0
      ? [{ id: 'videos' as const, label: 'Videos', count: counts.videos }]
      : []),
  ];

  return (
    <div
      role="tablist"
      aria-label="Session files"
      className={`flex items-center gap-1 overflow-x-auto no-scrollbar border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}
    >
      {tabs.map(({ id, label, count }) => {
        const isActive = active === id;
        return (
          <button
            key={id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(id)}
            className={`font-display text-[13px] font-medium inline-flex items-center gap-2 px-3.5 py-2.5 border-b-2 -mb-px whitespace-nowrap transition ${
              isActive
                ? `${accentText} ${accentBorder}`
                : `border-transparent ${isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-800'}`
            }`}
          >
            {label}
            {count != null && (
              <span className={`text-[11px] font-sans tabular-nums px-1.5 py-px rounded-full ${
                isActive
                  ? isDark ? 'bg-accent-500/15 text-accent-400' : 'bg-accent-300 text-accent-700'
                  : isDark ? 'bg-slate-800 text-slate-500' : 'bg-slate-100 text-slate-500'
              }`}>
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
