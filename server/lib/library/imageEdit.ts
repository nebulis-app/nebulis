/**
 * Render an image-editor edit on the server, so the browser never has to hold the full-size picture (a 24 MP stack
 * killed the Safari tab). The order matches the old canvas export: honor the file's EXIF orientation, crop the
 * source, flip, turn clockwise, adjust color, then lay the text overlay on top.
 *
 * Each geometry step is its own sharp pass over a raw buffer rather than one chained pipeline, because sharp applies
 * rotate, flip and extract in its own fixed order, not the order they are called in.
 */
import sharp from '../sharp-optional.js';
import type { GeometryEdit } from '../annotate/wcs.js';
import { applyPixelAdjustments, type Adjustments } from './imageAdjust.js';

export const EDIT_JPEG_QUALITY = 93;
/** Long edge of the picture the editor shows on screen. */
export const EDITOR_PREVIEW_MAX_PX = 2048;

interface RawPicture {
  data: Buffer;
  width: number;
  height: number;
  channels: 3 | 4;
}

async function toRaw(pipeline: ReturnType<typeof sharp>): Promise<RawPicture> {
  const { data, info } = await pipeline.raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  if (info.channels !== 3 && info.channels !== 4) throw new Error('Unsupported picture: expected color channels');
  return { data, width: info.width, height: info.height, channels: info.channels };
}

const fromRaw = (p: RawPicture) => sharp(p.data, { raw: { width: p.width, height: p.height, channels: p.channels } });

export interface RenderOptions {
  sourcePath: string;
  edit: GeometryEdit;
  adjust: Adjustments;
  /** A transparent PNG of the text layers, any size with the output's aspect ratio. */
  overlay?: Buffer;
  /** PNG keeps transparency; JPEG flattens onto black, as the canvas export did. */
  format: 'jpeg' | 'png';
  outPath: string;
}

export async function renderEditedPicture(opts: RenderOptions): Promise<{ width: number; height: number }> {
  const { edit } = opts;
  // limitInputPixels off: the whole point is large stacks, and the file is one the library already holds.
  const decoded = sharp(opts.sourcePath, { limitInputPixels: false }).rotate().toColourspace('srgb');
  let pic = await toRaw(opts.format === 'jpeg' ? decoded.flatten({ background: '#000' }) : decoded);

  if (edit.crop) {
    const left = Math.min(pic.width - 1, Math.max(0, Math.round(edit.crop.x1 * pic.width)));
    const top = Math.min(pic.height - 1, Math.max(0, Math.round(edit.crop.y1 * pic.height)));
    const width = Math.max(1, Math.min(pic.width - left, Math.round(edit.crop.x2 * pic.width) - left));
    const height = Math.max(1, Math.min(pic.height - top, Math.round(edit.crop.y2 * pic.height) - top));
    pic = await toRaw(fromRaw(pic).extract({ left, top, width, height }));
  }
  if (edit.flipH) pic = await toRaw(fromRaw(pic).flop());
  if (edit.flipV) pic = await toRaw(fromRaw(pic).flip());
  if (edit.rotation) pic = await toRaw(fromRaw(pic).rotate(edit.rotation));

  applyPixelAdjustments(pic.data, pic.channels, opts.adjust);

  let out = fromRaw(pic);
  if (opts.overlay) {
    const layer = await sharp(opts.overlay).resize(pic.width, pic.height, { fit: 'fill' }).ensureAlpha().png().toBuffer();
    out = out.composite([{ input: layer }]);
  }
  await (opts.format === 'png' ? out.png() : out.jpeg({ quality: EDIT_JPEG_QUALITY })).toFile(opts.outPath);
  return { width: pic.width, height: pic.height };
}

/** A picture scaled to fit `maxSide` on its long edge, EXIF orientation applied, for the editor's on-screen preview. */
export async function renderEditorPreview(sourcePath: string, maxSide: number): Promise<Buffer> {
  return sharp(sourcePath, { limitInputPixels: false })
    .rotate()
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();
}
