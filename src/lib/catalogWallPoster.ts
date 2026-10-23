/**
 * Renders the "My Catalog" wall to a canvas for download and sharing.
 *
 * Done in the browser rather than on the server: the page already has the
 * display font loaded and the images are same-origin, whereas a server render
 * would depend on system fonts the Docker image does not reliably carry. Tile
 * placement comes from the same `layoutWall` the on-screen wall uses, so the
 * poster is a faithful copy of the user's layout and size edits.
 */
import { wallCropSource } from './catalogWallCrop';
import type { WallTile } from './api/catalogs';
import { tileLabel } from './catalogWallTile';
import { getLibraryFileThumbnailUrl } from './api/library';
import { layoutWall, type LayoutItem, type WallLayout } from './catalogWallLayout';
import type { WallOverrides } from './catalogWallOverrides';

export type PosterFormat = 'wide' | 'story' | 'square' | 'print';

export const POSTER_FORMATS: Record<PosterFormat, { width: number; height: number }> = {
  wide: { width: 3840, height: 2160 },
  story: { width: 1080, height: 1920 },
  square: { width: 2048, height: 2048 },
  // A2 at 300 dpi.
  print: { width: 4961, height: 7016 },
};

export interface PosterSpec {
  tiles: WallTile[];
  overrides: WallOverrides;
  title: string;
  /** Optional line under the title (the owner's name, a site, a year). */
  subtitle: string;
  format: PosterFormat;
  imagedOnly: boolean;
  labels: boolean;
  /** Draw the Nebulis logo and name in a top corner. Off by default. */
  brand: boolean;
  brandSide: 'left' | 'right' | 'bottom-right';
  imagedCount: number;
  total: number;
  accent: string;
}

const STATS_KEY = '__stats';
const MAX_COLUMNS = 40;

/**
 * Pick the column count that makes the tiles as large as possible while the
 * whole wall still fits the given area. Pure, so the sizing rule is testable.
 */
export function choosePosterGrid(
  items: LayoutItem[], areaW: number, areaH: number, gap: number,
): { columns: number; cell: number; layout: WallLayout } {
  for (let columns = 3; columns <= MAX_COLUMNS; columns++) {
    const cell = (areaW - (columns - 1) * gap) / columns;
    const layout = layoutWall(items, columns);
    const height = layout.rows * cell + (layout.rows - 1) * gap;
    if (height <= areaH) return { columns, cell, layout };
  }
  // Nothing fit: fall back to the last attempt (MAX_COLUMNS) so a very tall
  // request still renders, at a slightly clipped scale.
  const cell = (areaW - (MAX_COLUMNS - 1) * gap) / MAX_COLUMNS;
  const layout = layoutWall(items, MAX_COLUMNS);
  return { columns: MAX_COLUMNS, cell: Math.min(cell, (areaH - (layout.rows - 1) * gap) / layout.rows), layout };
}

const imageCache = new Map<string, Promise<HTMLImageElement | null>>();

export function loadImage(url: string): Promise<HTMLImageElement | null> {
  let p = imageCache.get(url);
  if (!p) {
    p = new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
    imageCache.set(url, p);
  }
  return p;
}

export function drawCover(
  ctx: CanvasRenderingContext2D, img: HTMLImageElement,
  x: number, y: number, w: number, h: number, focus: { x: number; y: number }, zoom: number,
) {
  const { sx, sy, sw, sh } = wallCropSource(img.naturalWidth, img.naturalHeight, w, h, focus, zoom);
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

/**
 * Draw the poster. `scale` shrinks the whole canvas for the live preview while
 * keeping every proportion identical to the full-size export.
 */
export async function renderPoster(spec: PosterSpec, scale = 1): Promise<HTMLCanvasElement> {
  const { width: W, height: H } = POSTER_FORMATS[spec.format];
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available');
  ctx.scale(scale, scale);

  const display = "'Space Grotesk', 'Inter', system-ui, sans-serif";
  // Make sure the display font is actually decoded before measuring or drawing.
  try {
    await Promise.all([document.fonts.load(`700 64px ${display}`), document.fonts.load(`500 32px ${display}`)]);
  } catch { /* fall back to the system font */ }

  const unit = Math.min(W, H) / 1000; // everything below scales with the poster
  const margin = 40 * unit;
  const headerH = (spec.subtitle ? 150 : 120) * unit;
  const footerH = 70 * unit;
  const gap = Math.max(1, Math.round(1.5 * unit));

  ctx.fillStyle = '#05060a';
  ctx.fillRect(0, 0, W, H);

  // Brand (logo + wordmark) in a top corner, when asked for.
  let brandW = 0;
  if (spec.brand) {
    const logo = await loadImage('/nebulis-64.png');
    const size = 52 * unit;
    const gapX = 14 * unit;
    ctx.font = `700 ${40 * unit}px ${display}`;
    const neb = ctx.measureText('Neb').width;
    const ulis = ctx.measureText('ulis').width;
    brandW = size + gapX + neb + ulis;
    const bx = spec.brandSide === 'left' ? margin : W - margin - brandW;
    const by = spec.brandSide === 'bottom-right' ? H - margin * 0.6 - size : margin;
    if (logo) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(bx, by, size, size, size * 0.2);
      ctx.clip();
      ctx.drawImage(logo, bx, by, size, size);
      ctx.restore();
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.fillText('Neb', bx + size + gapX, by + size / 2);
    ctx.fillStyle = spec.accent;
    ctx.fillText('ulis', bx + size + gapX + neb, by + size / 2);
  }

  // Title (kept clear of the brand so a long title never runs under it)
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `700 ${58 * unit}px ${display}`;
  const brandClear = spec.brand && spec.brandSide !== 'bottom-right' ? (brandW + 24 * unit) * 2 : 0;
  ctx.fillText(spec.title, W / 2, margin + 62 * unit, W - margin * 2 - brandClear);
  if (spec.subtitle) {
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = `500 ${24 * unit}px ${display}`;
    ctx.fillText(spec.subtitle, W / 2, margin + 108 * unit, W - margin * 2);
  }

  // Wall
  const tiles = spec.imagedOnly ? spec.tiles.filter(t => t.imaged) : spec.tiles;
  const items: LayoutItem[] = tiles.map(t => ({
    key: t.id,
    span: !t.imaged ? { cols: 1, rows: 1 } : spec.overrides[t.id]?.span ?? t.span,
  }));
  if (!spec.imagedOnly) items.push({ key: STATS_KEY, span: { cols: 2, rows: 1 } });

  const areaW = W - margin * 2;
  const areaH = H - margin - headerH - footerH - margin * 0.5;
  const { cell, layout } = choosePosterGrid(items, areaW, areaH, gap);
  const gridW = layout.placements.reduce((m, p) => Math.max(m, (p.col + p.placed.cols) * (cell + gap) - gap), 0);
  const gridH = layout.rows * (cell + gap) - gap;
  const ox = margin + (areaW - gridW) / 2;
  const oy = margin + headerH + Math.max(0, (areaH - gridH) / 2);

  // Hairline backing so gaps read as thin rules.
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  ctx.fillRect(ox - gap, oy - gap, gridW + gap * 2, gridH + gap * 2);

  // Every cell starts dark, so any the packing leaves empty still read as part of the wall.
  ctx.fillStyle = '#07080d';
  for (let r = 0; r < layout.rows; r++) {
    for (let c = 0; c < Math.round((gridW + gap) / (cell + gap)); c++) {
      ctx.fillRect(ox + c * (cell + gap), oy + r * (cell + gap), cell, cell);
    }
  }

  const byId = new Map(tiles.map(t => [t.id, t]));
  const pending: Promise<void>[] = [];
  for (const p of layout.placements) {
    const x = ox + p.col * (cell + gap);
    const y = oy + p.row * (cell + gap);
    const w = p.placed.cols * cell + (p.placed.cols - 1) * gap;
    const h = p.placed.rows * cell + (p.placed.rows - 1) * gap;

    if (p.key === STATS_KEY) {
      ctx.fillStyle = '#07080d';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `600 ${Math.min(h * 0.32, 34 * unit)}px ${display}`;
      ctx.fillText(`${spec.imagedCount} / ${spec.total}`, x + w / 2, y + h / 2, w - 8 * unit);
      continue;
    }
    const tile = byId.get(p.key);
    if (!tile) continue;
    const label = tileLabel(tile);

    if (!tile.imaged || !tile.image) {
      ctx.fillStyle = '#07080d';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `600 ${Math.min(cell * 0.2, 30 * unit)}px ${display}`;
      ctx.fillText(label, x + w / 2, y + h / 2, w - 6 * unit);
      continue;
    }

    const o = spec.overrides[tile.id];
    const path = o?.imagePath ?? tile.image.path;
    const px = Math.min(2048, Math.max(160, Math.ceil(Math.max(w, h) * scale * Math.max(1, o?.zoom ?? 1))));
    const size = px <= 200 ? 160 : px <= 400 ? 360 : px <= 700 ? 640 : px <= 1000 ? 960 : 2048;
    pending.push(loadImage(getLibraryFileThumbnailUrl(path, size, size)).then(img => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.fillStyle = '#0b0d14';
      ctx.fillRect(x, y, w, h);
      if (img) drawCover(ctx, img, x, y, w, h, o?.focus ?? { x: 0.5, y: 0.5 }, o?.zoom ?? 1);
      if (spec.labels) {
        const g = ctx.createLinearGradient(0, y + h * 0.6, 0, y + h);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, 'rgba(0,0,0,0.75)');
        ctx.fillStyle = g;
        ctx.fillRect(x, y + h * 0.6, w, h * 0.4);
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.font = `600 ${Math.min(cell * 0.17, 26 * unit)}px ${display}`;
        ctx.fillText(label, x + 6 * unit, y + h - 6 * unit, w - 12 * unit);
      }
      ctx.restore();
    }));
  }
  await Promise.all(pending);

  // Footer
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  ctx.textBaseline = 'alphabetic';
  ctx.font = `500 ${22 * unit}px ${display}`;
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.textAlign = 'left';
  ctx.fillText(`${spec.imagedCount} / ${spec.total} · ${date}`, margin, H - margin * 0.9);

  return canvas;
}

export function canvasToBlob(canvas: HTMLCanvasElement, type: 'image/png' | 'image/jpeg', quality = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not encode the image'))), type, quality);
  });
}
