/**
 * A per-object crop of the picture that represents it (the hero and library
 * card). Stored as JSON on libraryObjects.galleryCrop and applied server-side
 * in the object thumbnail route, so every client that draws that thumbnail
 * gets the framing without knowing about it.
 *
 * The window keeps the source image's own aspect ratio, so it is described by
 * a centre point and a zoom alone: at zoom 2 the window is half the width and
 * half the height of the image. x/y are the centre as a 0..1 fraction of the
 * image. Pure functions only (no db), so objects.ts and gallery.ts can both
 * import it.
 */

import { isRecord } from '../typeGuards.js';

export interface GalleryCrop {
  x: number;
  y: number;
  zoom: number;
  /** The window is the source's aspect ratio turned 90 degrees (a portrait
   *  frame on a landscape picture, or the reverse). Absent means the source's
   *  own aspect. */
  rotated?: boolean;
}

/** The window's width and height as fractions of the image, at zoom 1. The
 *  window is the largest box of the wanted aspect that fits inside the image,
 *  so an unrotated crop is the whole image and a rotated one is a full-height
 *  (or full-width) strip. `aspect` is the image's width / height. */
export function baseWindow(aspect: number, rotated: boolean): { w: number; h: number } {
  const a = rotated ? 1 / aspect : aspect;
  return a >= aspect ? { w: 1, h: aspect / a } : { w: a / aspect, h: 1 };
}

export const GALLERY_CROP_MAX_ZOOM = 8;

/** Validate and normalise untrusted input (request body or a stored JSON
 *  string). Returns null for "no crop" — including a no-op crop (zoom ≈ 1) —
 *  and for anything malformed, so a bad row can never break a thumbnail. The
 *  centre is clamped so the window always lies inside the image. */
export function parseGalleryCrop(raw: unknown): GalleryCrop | null {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw); } catch { return null; }
  }
  if (!isRecord(v)) return null;
  const { x, y, zoom, rotated: rawRotated } = v;
  const rotated = rawRotated === true;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof zoom !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom)) return null;
  // A rotated window at zoom 1 is still a real crop (a strip of the image).
  if (zoom < 1.01 && !rotated) return null;
  const z = Math.min(Math.max(zoom, 1), GALLERY_CROP_MAX_ZOOM);
  const round = (n: number) => Math.round(n * 10000) / 10000;
  if (rotated) {
    // The window's extent depends on the image's aspect, which isn't known here;
    // cropRegion does the exact clamping once it has the pixel size.
    return {
      x: round(Math.min(Math.max(x, 0), 1)),
      y: round(Math.min(Math.max(y, 0), 1)),
      zoom: round(z),
      rotated: true,
    };
  }
  const half = 1 / (2 * z);
  return {
    x: round(Math.min(Math.max(x, half), 1 - half)),
    y: round(Math.min(Math.max(y, half), 1 - half)),
    zoom: round(z),
  };
}

/** The pixel rectangle of `crop` inside a `width`×`height` image. */
export function cropRegion(crop: GalleryCrop, width: number, height: number) {
  const base = baseWindow(width / height, crop.rotated === true);
  const w = Math.min(width, Math.max(1, Math.round((width * base.w) / crop.zoom)));
  const h = Math.min(height, Math.max(1, Math.round((height * base.h) / crop.zoom)));
  const left = Math.min(Math.max(Math.round(crop.x * width - w / 2), 0), width - w);
  const top = Math.min(Math.max(Math.round(crop.y * height - h / 2), 0), height - h);
  return { left, top, width: w, height: h };
}
