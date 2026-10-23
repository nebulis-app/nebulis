import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnnotationPanel } from './AnnotationPanel';
import { NO_RESERVE, type DockReserve } from './dockReserve';
import type { useImageAnnotations } from './useImageAnnotations';
import type { ZoomPan } from './useZoomPan';

/** Gap between the tile and the picture, in px. */
const GAP = 12;
/** The tile's natural width, and the narrowest it is still worth showing at. */
const MAX_WIDTH = 272;
const MIN_WIDTH = 160;
/** Tailwind's `sm`: below it there is no room beside the picture, so the tile becomes a bar above it. */
const WIDE_QUERY = '(min-width: 640px)';

function useWide(): boolean {
  const [wide, setWide] = useState(() => (typeof window === 'undefined' ? true : window.matchMedia(WIDE_QUERY).matches));
  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

/**
 * Keeps the annotation status tile off the picture without moving the picture.
 *
 * Beside the picture there is a free strip on each side whenever it does not fill the pane. The tile lives in the
 * left one and is sized to it: full width when there is room, narrower as the strip narrows, and gone once the strip
 * is too small to be worth showing (a zoomed-in or wide picture fills the pane). The picture is never shifted or
 * shrunk, and the toolbar's Annotate button carries a status dot, so the quality of the positions is still visible
 * with the tile hidden.
 *
 * The strip is worked out from the zoom engine's own numbers, so it follows zoom and pan. On a narrow screen there is
 * no strip at all, so the tile is a bar above the picture and reserves its height (see `LightboxPane`'s `reserve`).
 */
export function AnnotationDock({ annotations, canInstall, zoomedPastEstimate, zp, onReserve }: {
  annotations: ReturnType<typeof useImageAnnotations>;
  canInstall: boolean;
  zoomedPastEstimate: boolean;
  zp: ZoomPan;
  onReserve: (r: DockReserve) => void;
}) {
  const wide = useWide();
  const anchor = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [paneWidth, setPaneWidth] = useState(0);

  // Width of the picture pane, which the strip is measured against.
  useLayoutEffect(() => {
    const pane = anchor.current?.parentElement?.querySelector<HTMLElement>('[data-lightbox-pane]');
    if (!pane) return;
    const read = () => setPaneWidth(pane.clientWidth);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(pane);
    return () => ro.disconnect();
  }, []);

  // Narrow screens: reserve the bar's height. Wide screens reserve nothing.
  useLayoutEffect(() => {
    if (wide) { onReserve(NO_RESERVE); return; }
    const el = bar.current;
    if (!el) return;
    const report = () => onReserve({ left: 0, top: Math.ceil(el.offsetHeight) + GAP });
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => { ro.disconnect(); onReserve(NO_RESERVE); };
  }, [wide, onReserve]);

  const panel = (
    <AnnotationPanel annotations={annotations} canInstall={canInstall} zoomedPastEstimate={zoomedPastEstimate} />
  );

  if (!wide) {
    return (
      <>
        <div ref={anchor} aria-hidden="true" className="pointer-events-none absolute left-0 top-0 h-0 w-0" />
        <div ref={bar} data-annotation-dock="" className="absolute inset-x-2 top-2 z-20 max-h-[45%] overflow-y-auto rounded-xl">
          {panel}
        </div>
      </>
    );
  }

  // Free width between the pane's left edge and the picture's left edge, from the zoom engine's own numbers.
  const natural = zp.natural;
  const pictureWidth = natural ? (zp.rotation % 180 === 90 ? natural.h : natural.w) * zp.zoom : 0;
  const strip = Math.max(0, (paneWidth - pictureWidth) / 2 + zp.pan.x);
  const width = Math.min(MAX_WIDTH, Math.floor(strip - GAP));

  return (
    <>
      <div ref={anchor} aria-hidden="true" className="pointer-events-none absolute left-0 top-0 h-0 w-0" />
      {width >= MIN_WIDTH && (
        <div
          data-annotation-dock=""
          style={{ width }}
          className="absolute left-4 top-4 z-20 max-h-[calc(100%-2rem)] overflow-y-auto rounded-xl"
        >
          {panel}
        </div>
      )}
    </>
  );
}
