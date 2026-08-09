import { useEffect, useRef, useState, type ReactNode } from 'react';

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
  /** Tiles rendered either side of the current one, before the strip's
   *  rendered width has been measured. Once ResizeObserver reports a real
   *  width this is ignored in favor of however many tiles actually fit. */
  window?: number;
}

/** Tile width (`w-14` = 56px) plus the row's `gap-2` (8px). */
const TILE_SLOT_PX = 64;
/** An overflow marker is narrower than a tile, but budgeting it a full slot
 *  keeps the fit math simple and guarantees the row never overflows. */
const MARKER_SLOTS = 1;
/** Floor on neighbors shown either side, so a very narrow window (or a tiny
 *  measured width) still leaves room to navigate rather than windowing down
 *  to just the active tile. */
const MIN_SIDE = 3;

/**
 * Thumbnail strip, windowed around the current index so an observation with
 * several hundred sub-frames does not mount several hundred `<img>` elements.
 *
 * The window size is not a fixed number: a strip on a phone and a strip on a
 * living-room TV have very different amounts of room, so a constant either
 * under-fills the TV or overflows the phone. A ResizeObserver reports the
 * strip's actual rendered width, which converts directly to a tile count via
 * TILE_SLOT_PX. Below that count, every entry is shown and no windowing
 * happens at all — most observations are well under it.
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
  window: fallbackSide = 10,
}: Props) {
  const stripRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Before the first ResizeObserver callback lands, fall back to the `window`
  // prop rather than a guessed width, so there's no flash of an under-filled
  // strip while measurement spins up.
  const maxTiles = containerWidth > 0
    ? Math.max(MIN_SIDE * 2 + 1, Math.floor(containerWidth / TILE_SLOT_PX))
    : fallbackSide * 2 + 1;

  let start = 0;
  let end = entries.length;
  let side = 0;
  if (entries.length > maxTiles) {
    // First pass ignoring overflow markers, then — only if a marker turns out
    // to be needed on that side — shrink the tile budget by one slot per
    // marker and recompute. Reserving marker space that never renders would
    // under-fill the strip for no reason.
    side = Math.max(MIN_SIDE, Math.floor((maxTiles - 1) / 2));
    start = Math.max(0, index - side);
    end = Math.min(entries.length, index + side + 1);

    const reserved = (start > 0 ? MARKER_SLOTS : 0) + (end < entries.length ? MARKER_SLOTS : 0);
    if (reserved > 0) {
      side = Math.max(MIN_SIDE, Math.floor((maxTiles - reserved - 1) / 2));
      start = Math.max(0, index - side);
      end = Math.min(entries.length, index + side + 1);
    }
  }

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
            onClick={() => onSelect(Math.max(0, index - side * 2))}
            title={`Jump back ${Math.min(start, side * 2)} images`}
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
            onClick={() => onSelect(Math.min(entries.length - 1, index + side * 2))}
            title={`Jump forward ${Math.min(entries.length - end, side * 2)} images`}
            className={markerClass}
          >
            +{entries.length - end}
          </button>
        )}
      </div>
    </div>
  );
}
