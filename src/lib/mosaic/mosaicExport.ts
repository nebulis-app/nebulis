/**
 * Renders the Mosaic view of the Library or Gallery to a canvas, for download and sharing.
 *
 * Drawn in the browser, like the catalog wall poster: the page already has the display font loaded and the pictures
 * are same-origin. The tiles are packed again for the picture's own shape (the on-screen wall is packed for the box
 * it happens to be shown in), so every format is a gap-free rectangle.
 */
import { layoutMosaic } from './mosaicPacker';
import { canvasToBlob, drawCover, loadImage } from '../catalogWallPoster';

export { canvasToBlob };

export type MosaicExportFormat = 'shown' | 'wide' | 'square' | 'story';

/** The long side of an "as shown" picture, and the fixed sizes of the other formats. */
const SHOWN_LONG_SIDE = 3840;
const FIXED: Record<Exclude<MosaicExportFormat, 'shown'>, { width: number; height: number }> = {
  wide: { width: 3840, height: 2160 },
  square: { width: 2048, height: 2048 },
  story: { width: 1080, height: 1920 },
};

/** The packer's own limits on shape, the same as the on-screen wall. */
const MIN_ASPECT = 0.6;
const MAX_ASPECT = 3;

/** Picture sizes the server renders. */
const BUCKETS = [96, 256, 512, 1024, 2048];
const LOAD_AT_ONCE = 8;

export interface MosaicExportTile {
  id: string;
  title: string;
  score: number;
  /** Picture URL sized for a longest side of `px` pixels. */
  imageUrl: (px: number) => string;
}

export interface MosaicExportSpec {
  tiles: MosaicExportTile[];
  format: MosaicExportFormat;
  /** Width / height of the wall as it is on screen; the shape of an "as shown" picture. */
  shownAspect: number;
  labels: boolean;
}

/** Pixel size of the picture. Pure, so the sizing rule is testable. */
export function mosaicExportSize(format: MosaicExportFormat, shownAspect: number): { width: number; height: number } {
  if (format !== 'shown') return FIXED[format];
  const aspect = Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, Number.isFinite(shownAspect) && shownAspect > 0 ? shownAspect : 1.5));
  return aspect >= 1
    ? { width: SHOWN_LONG_SIDE, height: Math.round(SHOWN_LONG_SIDE / aspect) }
    : { width: Math.round(SHOWN_LONG_SIDE * aspect), height: SHOWN_LONG_SIDE };
}

const bucketFor = (px: number) => BUCKETS.find(b => b >= px) ?? BUCKETS[BUCKETS.length - 1];

/** Run `task` over `items`, `limit` at a time. */
async function inBatches<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await task(items[next++]);
  }));
}

/** Draw the picture. `scale` shrinks the canvas for the live preview, keeping every proportion of the full size. */
export async function renderMosaicImage(spec: MosaicExportSpec, scale = 1): Promise<HTMLCanvasElement> {
  const { width: W, height: H } = mosaicExportSize(spec.format, spec.shownAspect);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(W * scale));
  canvas.height = Math.max(1, Math.round(H * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available');
  ctx.scale(scale, scale);

  const display = "'Space Grotesk', 'Inter', system-ui, sans-serif";
  try { await document.fonts.load(`600 32px ${display}`); } catch { /* fall back to the system font */ }

  ctx.fillStyle = '#05060a';
  ctx.fillRect(0, 0, W, H);
  if (spec.tiles.length === 0) return canvas;

  const aspect = Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, W / H));
  const layout = layoutMosaic(spec.tiles.map(t => ({ id: t.id, score: t.score })), aspect);
  const k = Math.min(W / layout.width, H / layout.height);
  const ox = (W - layout.width * k) / 2;
  const oy = (H - layout.height * k) / 2;
  const line = Math.max(1, W / 1800);
  const byId = new Map(spec.tiles.map(t => [t.id, t]));

  await inBatches(layout.placements, LOAD_AT_ONCE, async p => {
    const tile = byId.get(p.id);
    if (!tile) return;
    const x = ox + p.x * k;
    const y = oy + p.y * k;
    const w = p.w * k;
    const h = p.h * k;
    const longPx = Math.max(w, h) * scale;
    const img = w * scale >= 2 && h * scale >= 2 ? await loadImage(tile.imageUrl(bucketFor(longPx))) : null;

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(x, y, w, h);
    if (img) drawCover(ctx, img, x, y, w, h, { x: 0.5, y: 0.5 }, 1);
    if (spec.labels && Math.min(w, h) >= 38 * (W / 1800)) {
      const size = Math.min(Math.max(Math.min(w, h) * 0.1, 11 * (W / 1800)), 30 * (W / 1800));
      const g = ctx.createLinearGradient(0, y + h - size * 3, 0, y + h);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.75)');
      ctx.fillStyle = g;
      ctx.fillRect(x, y + h - size * 3, w, size * 3);
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.font = `600 ${size}px ${display}`;
      ctx.fillText(tile.title, x + size * 0.5, y + h - size * 0.45, w - size);
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = line;
    ctx.strokeRect(x + line / 2, y + line / 2, w - line, h - line);
  });

  return canvas;
}
