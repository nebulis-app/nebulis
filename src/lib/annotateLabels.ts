import type { FrameAnnotation } from './api/annotate';

/** The minimum a label placement needs from a ring, so a caller can hand in rings in its own pixel space. */
export type LabelRing = Pick<FrameAnnotation, 'label' | 'designation' | 'x' | 'y' | 'r'>;

export interface PlacedLabel<T extends LabelRing> {
  a: T;
  /** Centre of the text's baseline. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export function labelText(a: Pick<FrameAnnotation, 'label' | 'designation'>): string {
  return a.designation ? `${a.label} ${a.designation}` : a.label;
}

/**
 * Where each label goes, in the rings' own units (`W` x `H` is the picture, `fs` the font size in the same units).
 *
 * A big ring (M42 fills most of a SeeStar frame) holds its label inside, at the top; a small one hangs its label
 * underneath, flipping above at the bottom edge. Labels are kept inside the picture, and one that lands on an earlier
 * label is nudged down rather than overprinted. Shared by the on-screen overlay and the burned-in export, so a saved
 * picture reads the same as the viewer.
 */
export function placeLabels<T extends LabelRing>(items: T[], W: number, H: number, fs: number): PlacedLabel<T>[] {
  const pad = fs * 0.6;
  const placed: PlacedLabel<T>[] = [];
  for (const a of items) {
    const w = labelText(a).length * fs * 0.58;
    const h = fs * 1.25;
    const big = a.r * 2 > Math.min(W, H) * 0.5;
    let y = big ? a.y - a.r + fs * 1.9 : a.y + a.r + fs * 1.3;
    if (!big && y + pad > H) y = a.y - a.r - fs * 0.5;
    const x = Math.min(Math.max(a.x, w / 2 + pad), W - w / 2 - pad);
    for (let tries = 0; tries < 5; tries++) {
      const clash = placed.some(p => Math.abs(p.x - x) < (p.w + w) / 2 && Math.abs(p.y - y) < h);
      if (!clash) break;
      y += h;
    }
    y = Math.min(Math.max(y, h), H - pad);
    placed.push({ a, x, y, w, h });
  }
  return placed;
}
