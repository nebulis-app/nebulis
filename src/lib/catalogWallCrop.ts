/**
 * How a wall tile shows a zoomed/re-centred picture.
 *
 * Model: the tile normally shows the largest window of the picture that has the
 * tile's shape ("cover"). A crop shrinks that window to 1/zoom and centres it on
 * (x, y), both as 0-1 fractions of the picture. The same maths drives the tile
 * (CSS), the poster (canvas) and the chooser's frame box.
 */
import type { CSSProperties } from 'react';

export interface WallCrop { x: number; y: number; zoom: number }

export const hasWallCrop = (focus?: { x: number; y: number } | null, zoom?: number | null) =>
  (zoom ?? 1) > 1.01 || (focus != null && (Math.abs(focus.x - 0.5) > 0.005 || Math.abs(focus.y - 0.5) > 0.005));

/**
 * Inline style for an absolutely positioned <img> inside a tile whose wrapper is
 * `container-type: size`. `aspect` is the picture's width / height. The picture
 * is scaled uniformly (never stretched) and clamped so no empty edge shows.
 */
export function wallCropStyle(aspect: number, focus: { x: number; y: number }, zoom: number): CSSProperties {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const w = `calc(max(100cqw, 100cqh * ${a}) * ${zoom})`;
  const h = `calc(${w} / ${a})`;
  return {
    position: 'absolute',
    maxWidth: 'none',
    width: w,
    height: h,
    left: `clamp(calc(100cqw - ${w}), calc(50cqw - ${w} * ${focus.x}), 0px)`,
    top: `clamp(calc(100cqh - ${h}), calc(50cqh - ${h} * ${focus.y}), 0px)`,
  };
}

/** Source rectangle (in picture pixels) for a canvas draw of the same crop. */
export function wallCropSource(
  iw: number, ih: number, w: number, h: number, focus: { x: number; y: number }, zoom: number,
): { sx: number; sy: number; sw: number; sh: number } {
  const scale = Math.max(w / iw, h / ih) * Math.max(1, zoom);
  const sw = w / scale;
  const sh = h / scale;
  return {
    sx: Math.min(iw - sw, Math.max(0, focus.x * iw - sw / 2)),
    sy: Math.min(ih - sh, Math.max(0, focus.y * ih - sh / 2)),
    sw, sh,
  };
}
