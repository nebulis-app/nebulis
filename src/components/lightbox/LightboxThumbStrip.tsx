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
  /** Tiles rendered either side of the current one, before the strip's
   *  rendered width has been measured. Once ResizeObserver reports a real
   *  width this is ignored in favor of however many tiles actually fit. */
  window?: number;
}

/** Tile width (`w-16` = 64px) plus the row's `gap-2` (8px). */
const TILE_SLOT_PX = 72;
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

  /**
   * The window, centred on the current tile but always spending its full tile
   * budget.
   *
   * The previous version took `side` tiles either side of the index and
   * stopped, so at the start or end of a long list half the window fell
   * outside the array and the rail rendered half empty: frame 1 of 300 showed
   * six tiles in a strip with room for eleven. Sliding the window back inside
   * the array instead keeps it the same size wherever you are in the list.
   */
  let start = 0;
  let end = entries.length;
  if (entries.length > maxTiles) {
    const fit = (budget: number) => {
      const visible = Math.min(entries.length, Math.max(MIN_SIDE * 2 + 1, budget));
      const s = Math.min(
        Math.max(0, index - Math.floor((visible - 1) / 2)),
        entries.length - visible,
      );
      return { s, e: s + visible };
    };

    // First pass ignoring overflow markers, then — only if a marker turns out
    // to be needed on that side — shrink the tile budget by one slot per
    // marker and recompute. Reserving marker space that never renders would
    // under-fill the strip for no reason.
    ({ s: start, e: end } = fit(maxTiles));
    const reserved = (start > 0 ? MARKER_SLOTS : 0) + (end < entries.length ? MARKER_SLOTS : 0);
    if (reserved > 0) ({ s: start, e: end } = fit(maxTiles - reserved));
  }
  /** How far the overflow markers jump: one screenful of tiles. */
  const page = end - start;

  useEffect(() => {
    const thumb = activeRef.current;
    const strip = stripRef.current;
    if (!thumb || !strip) return;
    // Measured against the scroller's own box rather than `offsetLeft`, which
    // is relative to the nearest positioned ancestor and so silently picked up
    // the rail's padding once the tiles moved inside a centring wrapper.
    const thumbBox = thumb.getBoundingClientRect();
    const stripBox = strip.getBoundingClientRect();
    strip.scrollTo({
      left: Math.max(
        0,
        strip.scrollLeft + (thumbBox.left - stripBox.left) - strip.clientWidth / 2 + thumbBox.width / 2,
      ),
      behavior: 'smooth',
    });
  }, [index]);

  if (entries.length <= 1) return null;

  const markerClass = 'flex-shrink-0 rounded-full px-2.5 py-1.5 text-[10px] font-medium tabular-nums '
    + 'text-white/45 outline-none transition hover:bg-white/10 hover:text-white '
    + 'focus-visible:ring-2 focus-visible:ring-white/60';

  return (
    // No rule above the rail: the panel is one dark surface, and a hairline
    // across it read as a second card bolted to the bottom of the first. The
    // strip separates itself by sitting on a slightly deeper black instead.
    <div className="relative z-10 flex-shrink-0 px-3 pb-3 pt-1">
      {/* Centred, and only as wide as the tiles it holds. A two-frame session
          used to leave a full-width bar with two tiles huddled in the corner of
          it, which read as a rail that had failed to load. `w-max mx-auto`
          inside the scroller is what centres a short row without stranding the
          left end of a long one out of reach, which plain `justify-center`
          does. The rail also no longer paints its own darker band: with the
          tiles centred there is nothing to separate, and the band was drawing
          a box around mostly empty space. */}
      <div ref={stripRef} className="overflow-x-auto pb-1">
        <div className="mx-auto flex w-max items-center gap-2 rounded-2xl bg-white/[0.04] p-2
          ring-1 ring-inset ring-white/[0.08] backdrop-blur-md">
        {start > 0 && (
          <button
            type="button"
            onClick={() => onSelect(Math.max(0, index - page))}
            title={`Jump back ${Math.min(start, page)} images`}
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
              // Ring rather than a 2px border, so the tile's picture keeps the
              // full 64px instead of losing four of them to the frame and
              // reflowing by a pixel as the selection moves. Unselected tiles
              // are held back to 55%: with every tile at full strength the
              // strip competed with the picture it is there to navigate.
              className={`h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg outline-none transition
                focus-visible:ring-2 focus-visible:ring-white/70 ${
                isActive
                  ? 'opacity-100 ring-2 ring-accent-400'
                  : 'opacity-55 ring-1 ring-inset ring-white/10 hover:opacity-100 hover:ring-white/30'
              }`}
            >
              {entry.content}
            </button>
          );
        })}

        {end < entries.length && (
          <button
            type="button"
            onClick={() => onSelect(Math.min(entries.length - 1, index + page))}
            title={`Jump forward ${Math.min(entries.length - end, page)} images`}
            className={markerClass}
          >
            +{entries.length - end}
          </button>
        )}
        </div>
      </div>
    </div>
  );
}
