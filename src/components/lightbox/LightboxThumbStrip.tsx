import { useEffect, useRef, type ReactNode } from 'react';

export interface ThumbEntry {
  key: string;
  /** Rendered inside the 56px tile. */
  content: ReactNode;
  /** Accessible label for the tile button. */
  label: string;
}

interface Props {
  entries: ThumbEntry[];
  index: number;
  onSelect: (index: number) => void;
  isDark: boolean;
  /** Tiles rendered either side of the current one. */
  window?: number;
}

/**
 * Thumbnail strip, windowed around the current index so an observation with
 * several hundred sub-frames does not mount several hundred `<img>` elements.
 *
 * The overflow markers are buttons, not labels. Previously they were plain
 * spans reading "+253", which told the user there were more frames and gave
 * them no way to reach them; they now page the window by a screenful.
 */
export function LightboxThumbStrip({
  entries,
  index,
  onSelect,
  isDark,
  window: windowSize = 10,
}: Props) {
  const stripRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  const start = Math.max(0, index - windowSize);
  const end = Math.min(entries.length, index + windowSize + 1);

  useEffect(() => {
    const thumb = activeRef.current;
    const strip = stripRef.current;
    if (!thumb || !strip) return;
    strip.scrollTo({
      left: Math.max(0, thumb.offsetLeft - strip.clientWidth / 2 + thumb.offsetWidth / 2),
      behavior: 'smooth',
    });
  }, [index]);

  if (entries.length <= 1) return null;

  const markerClass = `flex-shrink-0 px-2 py-1 rounded-md text-[10px] font-medium tabular-nums transition ${
    isDark
      ? 'text-slate-500 hover:text-slate-200 hover:bg-slate-800'
      : 'text-slate-400 hover:text-slate-700 hover:bg-slate-100'
  }`;

  return (
    <div className={`flex-shrink-0 border-t p-3 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
      <div ref={stripRef} className="flex gap-2 overflow-x-auto pb-1 items-center">
        {start > 0 && (
          <button
            type="button"
            onClick={() => onSelect(Math.max(0, index - windowSize * 2))}
            title={`Jump back ${Math.min(start, windowSize * 2)} images`}
            className={markerClass}
          >
            +{start}
          </button>
        )}

        {entries.slice(start, end).map((entry, i) => {
          const idx = start + i;
          const isActive = idx === index;
          return (
            <button
              key={entry.key}
              type="button"
              ref={isActive ? activeRef : null}
              onClick={() => onSelect(idx)}
              aria-label={entry.label}
              aria-current={isActive ? 'true' : undefined}
              className={`flex-shrink-0 w-14 h-14 rounded-lg overflow-hidden border-2 transition ${
                isActive
                  ? 'border-accent-500'
                  : isDark ? 'border-slate-800 hover:border-slate-600' : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              {entry.content}
            </button>
          );
        })}

        {end < entries.length && (
          <button
            type="button"
            onClick={() => onSelect(Math.min(entries.length - 1, index + windowSize * 2))}
            title={`Jump forward ${Math.min(entries.length - end, windowSize * 2)} images`}
            className={markerClass}
          >
            +{entries.length - end}
          </button>
        )}
      </div>
    </div>
  );
}
