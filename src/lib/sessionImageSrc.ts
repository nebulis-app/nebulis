import type { SessionFile } from '../types';

/**
 * Which URL to hand an `<img>` for a session file.
 *
 * ── Why this is not just `file.downloadUrl` ─────────────────────────────────
 * `downloadUrl` serves the raw bytes. That is correct for a download and wrong
 * for an `<img>` on two counts:
 *
 *   1. **Format.** Browsers do not render TIFF in an `<img>` at all, and 16-bit
 *      PNGs out of Dwarf stacking do not display either. Both paint a broken
 *      image. Only JPEG is safe to hand over directly.
 *   2. **Size.** A Dwarf's `img_stacked_all.tif` is a 32-bit float RGB image at
 *      sensor resolution, around 100 MB. Pointing an `<img>` at it took Safari
 *      down on the observation page. Even where a browser can decode a format,
 *      a 100 MB decode in the render path is not something to attempt.
 *
 * The server already emits `thumbUrl` / `previewUrl` for exactly these cases:
 * they route through `/library/file/thumbnail`, which converts via sharp and
 * caches the result. Use them whenever they are present.
 *
 * Mirrors the rule `getLocalSessions` applies when it builds a session's
 * thumbnail URL (JPEG served directly, everything else converted). Keep the two
 * in step.
 */

/**
 * True when this file can be shown as an image at all.
 *
 * The server sets `previewable: false` for formats whose rendering cannot be
 * trusted (a 32-bit float linear TIFF comes out pure white). Those get a
 * download card instead, the same treatment stored-only processed formats get.
 * Older responses omit the field, which is read as previewable.
 */
export function canPreviewImage(file: Pick<SessionFile, 'previewable'>): boolean {
  return file.previewable !== false;
}

/** True when the browser can be handed the raw file for an `<img>`. */
export function isInlineSafeImage(fileName: string): boolean {
  return /\.jpe?g$/i.test(fileName);
}

/** Small `<img>` src for a grid card or thumbnail strip. */
export function thumbSrcFor(file: Pick<SessionFile, 'name' | 'downloadUrl' | 'thumbUrl'>): string {
  return file.thumbUrl ?? file.downloadUrl;
}

/**
 * Large `<img>` src for a hero or a full-screen viewer.
 *
 * Prefers the server-rendered preview tier, which is bigger than the grid
 * thumbnail but still a JPEG. Falls back to the raw file only when it is a
 * format the browser can actually take.
 */
export function previewSrcFor(
  file: Pick<SessionFile, 'name' | 'downloadUrl' | 'thumbUrl' | 'previewUrl'>,
): string {
  if (file.previewUrl) return file.previewUrl;
  if (isInlineSafeImage(file.name)) return file.downloadUrl;
  // No preview tier and not inline-safe: the grid thumbnail is still far better
  // than a broken image or a 100 MB decode.
  return file.thumbUrl ?? file.downloadUrl;
}

/**
 * True when this file should never be auto-picked as a session's hero or an
 * object's gallery image.
 *
 * Such a file can still be *shown* (via the preview tier) and a user can still
 * crown it deliberately. This only keeps the automatic pick on formats that are
 * cheap and reliable to display, so opening an observation does not trigger a
 * 100 MB server-side decode for a picture the user never asked to feature.
 */
export function isPoorHeroCandidate(file: Pick<SessionFile, 'name' | 'previewable'>): boolean {
  return !canPreviewImage(file) || !isInlineSafeImage(file.name);
}
