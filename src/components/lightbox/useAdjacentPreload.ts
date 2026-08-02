import { useEffect } from 'react';

/**
 * Warms the browser cache for the images either side of the current one.
 *
 * Without this every next/prev is a cold fetch and the pane sits empty for as
 * long as a full-size stacked JPEG takes to arrive. Decoding is done off the
 * render path via `decode()` where available, so arriving at the neighbour is
 * a cache hit with the bitmap already prepared.
 *
 * `radius` is deliberately small. These are full-resolution astro frames and
 * prefetching a wide window would put tens of megabytes on the wire for images
 * the user may never reach.
 */
export function useAdjacentPreload(
  srcs: (string | null | undefined)[],
  index: number,
  radius = 1,
) {
  useEffect(() => {
    const targets: string[] = [];
    for (let d = 1; d <= radius; d++) {
      for (const i of [index + d, index - d]) {
        const src = srcs[i];
        if (src) targets.push(src);
      }
    }
    if (targets.length === 0) return;

    let cancelled = false;
    const images: HTMLImageElement[] = [];
    for (const src of targets) {
      const img = new Image();
      img.src = src;
      // decode() rejects if the image is removed or the format is undecodable.
      // Neither matters here: this is a cache warm, not a render dependency.
      img.decode?.().catch(() => {});
      images.push(img);
    }

    return () => {
      cancelled = true;
      // Dropping src aborts an in-flight fetch for a neighbour the user has
      // already navigated past, so it cannot compete with the image they want.
      if (cancelled) for (const img of images) img.src = '';
    };
    // `srcs` is rebuilt each render by callers; keying on the specific
    // neighbours avoids re-running when unrelated entries change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, radius, srcs[index - 1], srcs[index + 1]]);
}
