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

// Extension lists mirroring PROCESSED_FORMATS in server/lib/library/processed.ts.
// Client and server can't share a source module, so this is the frontend's
// single source: the RENDERABLE/FITS regexes below and
// the exported *_EXTENSIONS arrays (used to build the upload `accept`
// attribute) both derive from these instead of re-listing extensions by hand.
const RENDERABLE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'tif', 'tiff'] as const;
const STORED_ONLY_EXTENSIONS = ['xisf', 'fit', 'fits', 'fts', 'psd', 'xcf', 'dng', 'cr2', 'cr3', 'nef', 'arw'] as const;
const FITS_EXTENSIONS = ['fit', 'fits', 'fts'] as const;

/** For the upload `<input accept>` attribute — every format the server will
 *  accept for a processed-image upload, renderable or stored-only. */
export const PROCESSED_UPLOAD_EXTENSIONS = [...RENDERABLE_EXTENSIONS, ...STORED_ONLY_EXTENSIONS].map(ext => `.${ext}`);

const RENDERABLE = new RegExp(`\\.(${RENDERABLE_EXTENSIONS.join('|')})$`, 'i');

// Mirrors the FITS check in server/lib/library/processed.ts and the
// server/routes/library.ts /fits-thumbnail route.
const FITS = new RegExp(`\\.(${FITS_EXTENSIONS.join('|')})$`, 'i');

/** True when the file can be shown in an `<img>` and previewed before upload. */
export function isRenderableProcessed(filename: string): boolean {
  return RENDERABLE.test(filename);
}

/** True for a FITS processed image — not directly renderable, but eligible
 *  for the server-rendered `/fits-thumbnail` (see `ProcessedImage.thumbUrl`),
 *  unlike other stored-only formats (XISF, PSD, RAW) which have no renderer
 *  and fall back to a plain file-card icon. */
export function isFitsProcessed(filename: string): boolean {
  return FITS.test(filename);
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
