// Gallery timing constants and pure helpers, extracted from ImageGalleryPage.

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
