/**
 * Which processed-image formats a browser can actually display.
 *
 * Nebulis stores the output of external processing workflows, and the useful
 * deliverables (XISF, 32-bit FITS, PSD, camera RAW) are formats no browser
 * renders. Those are kept as downloadable assets and shown as a file card, so
 * two things must never happen:
 *
 *   1. an `<img src>` pointed at one, which paints a broken-image icon; and
 *   2. `FileReader.readAsDataURL` called on one to build a preview, which reads
 *      the whole file into a base64 string. At the 2 GB upload ceiling that
 *      allocates roughly 2.7 GB and takes the tab down.
 *
 * Mirrors RENDERABLE_PROCESSED / STORED_PROCESSED in server/routes/library.ts.
 * Keep the two in step: the server decides what may be stored, this decides how
 * it is shown.
 */

const RENDERABLE = /\.(jpg|jpeg|png|tiff?|tif)$/i;

/** True when the file can be shown in an `<img>` and previewed before upload. */
export function isRenderableProcessed(filename: string): boolean {
  return RENDERABLE.test(filename);
}

/**
 * True when a local `File` is safe to preview before upload.
 *
 * Format is necessary but not sufficient. The doc above worries about
 * `readAsDataURL` on a multi-gigabyte XISF, which the format check does catch;
 * it does not catch a 500 MB TIFF or JPEG, which passes the format check and
 * then allocates a base64 string around 1.4x its size. Previews are now built
 * with `URL.createObjectURL`, which is O(1) memory, so this exists as a second
 * line of defence and to skip pointless work on absurd inputs.
 *
 * TIFF stays in RENDERABLE deliberately, even though Chrome and Firefox will not
 * draw it in an `<img>`: those cards are already broken there today, and Safari
 * does render 8-bit TIFF, so narrowing it would take a working preview away from
 * Safari users without fixing anything for the others. The real fix is to serve
 * processed images through a render route like session files use, which is a
 * larger change than this note. See the internal doc's open list.
 */
const MAX_LOCAL_PREVIEW_BYTES = 512 * 1024 * 1024;

export function canPreviewLocally(file: File): boolean {
  return isRenderableProcessed(file.name) && file.size <= MAX_LOCAL_PREVIEW_BYTES;
}

/** Short uppercase badge for a processed file, e.g. "XISF". Null when the name
 *  carries no extension worth labelling. */
export function processedFormatLabel(filename: string): string | null {
  const ext = filename.split('.').pop()?.toUpperCase();
  if (!ext || ext === filename.toUpperCase()) return null;
  if (ext === 'JPEG') return 'JPG';
  if (ext === 'TIF') return 'TIFF';
  if (ext === 'FIT' || ext === 'FTS') return 'FITS';
  return ext;
}
