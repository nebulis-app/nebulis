// Gallery timing constants and pure helpers, extracted from ImageGalleryPage.

import { getLibraryFileThumbnailUrl } from '../../lib/api/library';

const DISPLAY_MS = 9000;          // fully visible time per slide
export const FADE_MS = 2500;             // crossfade duration
export const TOTAL_MS = DISPLAY_MS + FADE_MS;
export const KB_MS = TOTAL_MS * 2;       // Ken Burns runs for two full slide cycles

export function fisherYates<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function randomKenBurns() {
  const fromScale = (1.0 + Math.random() * 0.04).toFixed(4);
  const toScale = (1.1 + Math.random() * 0.08).toFixed(4);
  const fromX = ((Math.random() - 0.5) * 6).toFixed(2);
  const fromY = ((Math.random() - 0.5) * 4).toFixed(2);
  const toX = ((Math.random() - 0.5) * 6).toFixed(2);
  const toY = ((Math.random() - 0.5) * 4).toFixed(2);
  return {
    from: `scale(${fromScale}) translate(${fromX}%, ${fromY}%)`,
    to: `scale(${toScale})   translate(${toX}%,   ${toY}%)`,
  };
}

/** Warm the browser decode cache without blocking the main thread. */
export function preload(url: string): void {
  const img = new window.Image();
  img.src = url;
}

/**
 * Slideshow `<img>` src for a library image path, bounded regardless of the
 * source format or size.
 *
 * `LibraryImage.downloadUrl` serves the raw file. For a processed TIFF export
 * (`RENDERABLE_PROCESSED` in `server/lib/library/processed.ts` allows tif/tiff
 * because sharp can decode it server-side, not because a browser `<img>` can)
 * that is both undisplayable — Chrome/Firefox don't render TIFF inline — and,
 * on a Dwarf's ~100-200 MB stacked master, a payload big enough to stall the
 * slideshow or the tab. `/library/file/thumbnail` already solves exactly this
 * (see `src/lib/sessionImageSrc.ts` for the same fix applied to the
 * observation viewer): it converts via sharp and caps the output, so this is
 * always a bounded JPEG. Used for both the displayed slide and its preload,
 * so the preload actually warms the URL that gets shown.
 */
export const SLIDE_MAX_DIMENSION = 1200;
export function slideImageUrl(path: string): string {
  return getLibraryFileThumbnailUrl(path, SLIDE_MAX_DIMENSION, SLIDE_MAX_DIMENSION);
}
