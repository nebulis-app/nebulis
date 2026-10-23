/**
 * Burns the annotation rings and names into a copy of a picture, for Download and Share.
 *
 * Drawn in the browser, like the catalog wall poster: the page already has its font, whereas a server render would
 * depend on system fonts the Docker image does not carry. The drawing mirrors the on-screen overlay (same label
 * placement, same ring styles) at a size proportional to the picture rather than to the screen, so the export reads
 * the same whether it is a 1080 px SeeStar frame or a 4K Dwarf stack. The (i) buttons are UI and are left out.
 *
 * Colours are the day palette whatever theme the viewer is in: a saved picture leaves the app, and red-light
 * mode's remap is for the screen at the telescope, not for the file.
 */
import type { AnnotationData, FrameAnnotation } from './api/annotate';
import { placeLabels } from './annotateLabels';

export type RingKind = 'target' | 'galaxy' | 'cluster' | 'nebula';

const GALAXY_TYPES = new Set(['G', 'GPair', 'GTrpl', 'GGroup']);
const CLUSTER_TYPES = new Set(['OCl', 'GCl', '*Ass']);

export function ringKind(a: Pick<FrameAnnotation, 'isTarget' | 'typeCode'>): RingKind {
  if (a.isTarget) return 'target';
  if (GALAXY_TYPES.has(a.typeCode)) return 'galaxy';
  if (CLUSTER_TYPES.has(a.typeCode)) return 'cluster';
  return 'nebula';
}

/** Tailwind's accent-400 / sky-300 / emerald-300 / rose-300, the colours the overlay shows in the default theme. */
export const RING_HEX: Record<RingKind, string> = {
  target: '#fbbf24',
  galaxy: '#7dd3fc',
  cluster: '#6ee7b7',
  nebula: '#fda4af',
};

/** Label height as a share of the picture's long side: 24 px on a 1920 px frame, 48 px on a 4K one. */
const FONT_FRACTION = 0.0125;
const MIN_FONT_PX = 12;
/** The overlay's 1.6 px ring next to its 12.5 px label, kept in proportion. */
const STROKE_PER_FONT = 1.6 / 12.5;
/** Safari refuses a canvas above 16.7 megapixels (4096 x 4096); bigger pictures are drawn just under it. */
const MAX_CANVAS_PIXELS = 16_000_000;
/** A decoded picture whose shape differs from the annotation grid by more than this is not the same picture
 *  (an EXIF-rotated original, say), and the rings would land in the wrong place on it. */
const ASPECT_TOLERANCE = 0.01;

export interface BurnRing {
  x: number;
  y: number;
  r: number;
  color: string;
  dash: number[] | null;
  round: boolean;
  opacity: number;
}

export interface BurnLabel {
  x: number;
  y: number;
  label: string;
  designation: string | null;
  isTarget: boolean;
}

export interface BurnPlan {
  width: number;
  height: number;
  fontPx: number;
  strokePx: number;
  rings: BurnRing[];
  labels: BurnLabel[];
}

/** Everything to draw on a `width` x `height` copy of the picture, in its pixels. Pure, so it can be tested. */
export function planBurn(data: AnnotationData, width: number, height: number): BurnPlan {
  const k = width / data.imageWidth;
  const fontPx = Math.max(MIN_FONT_PX, Math.max(width, height) * FONT_FRACTION);
  const strokePx = fontPx * STROKE_PER_FONT;
  // The overlay's dash patterns are in screen pixels beside a 1.6 px stroke; scale them with the stroke.
  const dashUnit = strokePx / 1.6;

  const scaled = data.annotations.map(a => ({ ...a, x: a.x * k, y: a.y * k, r: a.r * k }));
  const rings = scaled.map(a => ({
    x: a.x,
    y: a.y,
    r: a.r,
    color: RING_HEX[ringKind(a)],
    dash: a.oversized ? [2 * dashUnit, 7 * dashUnit] : data.quality === 'approximate' ? [6 * dashUnit, 4 * dashUnit] : null,
    round: a.oversized,
    opacity: a.oversized && !a.isTarget ? 0.75 : 1,
  }));
  const labels = placeLabels(scaled, width, height, fontPx).map(p => ({
    x: p.x,
    y: p.y,
    label: p.a.label,
    designation: p.a.designation,
    isTarget: p.a.isTarget,
  }));
  return { width, height, fontPx, strokePx, rings, labels };
}

export function drawBurn(ctx: CanvasRenderingContext2D, plan: BurnPlan, fontFamily: string): void {
  const { fontPx, strokePx } = plan;
  ctx.save();
  for (const ring of plan.rings) {
    // A dark halo under every ring, as on screen, so it reads on bright nebulosity as well as black sky.
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2);
    ctx.setLineDash([]);
    ctx.lineWidth = strokePx + 2 * (strokePx / 1.6);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2);
    ctx.setLineDash(ring.dash ?? []);
    ctx.lineCap = ring.round ? 'round' : 'butt';
    ctx.lineWidth = strokePx;
    ctx.globalAlpha = ring.opacity;
    ctx.strokeStyle = ring.color;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  ctx.setLineDash([]);
  ctx.lineJoin = 'round';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const gap = fontPx * 0.4;
  for (const l of plan.labels) {
    const font = `${l.isTarget ? 600 : 500} ${fontPx}px ${fontFamily}`;
    ctx.font = font;
    const nameW = ctx.measureText(l.label).width;
    const desigW = l.designation ? ctx.measureText(l.designation).width + gap : 0;
    // Centred on the placed point like the overlay's text-anchor="middle", then kept on the picture.
    const total = nameW + desigW;
    const left = Math.min(Math.max(l.x - total / 2, fontPx * 0.3), plan.width - total - fontPx * 0.3);
    const parts: Array<[string, number, number]> = [[l.label, left, 1]];
    if (l.designation) parts.push([l.designation, left + nameW + gap, 0.7]);
    for (const [text, x, alpha] of parts) {
      ctx.lineWidth = fontPx * 0.28;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
      ctx.strokeText(text, x, l.y);
      ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
      ctx.fillText(text, x, l.y);
    }
  }
  ctx.restore();
}

/** Output size for a decoded picture: its own, or just under the canvas limit. */
export function burnSize(width: number, height: number): { width: number; height: number } {
  const s = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / (width * height)));
  return { width: Math.max(1, Math.floor(width * s)), height: Math.max(1, Math.floor(height * s)) };
}

/** True when a decoded picture has the annotation grid's shape, so the rings can be scaled onto it. */
export function matchesGrid(data: Pick<AnnotationData, 'imageWidth' | 'imageHeight'>, width: number, height: number): boolean {
  const a = width / height;
  const b = data.imageWidth / data.imageHeight;
  return Math.abs(a - b) / b <= ASPECT_TOLERANCE;
}

/** "Stacked_30_M42.fit.jpg" → "Stacked_30_M42.fit-annotated.jpg"; the export is always a JPEG. */
export function annotatedFileName(fileName: string): string {
  const stem = fileName.replace(/\.(jpe?g|png|tiff?)$/i, '');
  return `${stem || 'image'}-annotated.jpg`;
}

async function decode(url: string): Promise<ImageBitmap | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await createImageBitmap(await res.blob());
  } catch {
    return null;
  }
}

/**
 * The picture with its rings drawn in. `sources` are tried in order: the original first (full resolution), then the
 * preview the viewer shows, which is always decodable and always matches the grid. A source is skipped when the
 * browser cannot decode it (a TIFF) or its shape is not the annotated picture's.
 */
export async function renderAnnotatedCanvas(data: AnnotationData, sources: string[]): Promise<HTMLCanvasElement> {
  let bitmap: ImageBitmap | null = null;
  for (const src of sources) {
    const b = await decode(src);
    if (b && matchesGrid(data, b.width, b.height)) { bitmap = b; break; }
    b?.close();
  }
  if (!bitmap) throw new Error('The picture could not be loaded');

  try {
    const { width, height } = burnSize(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot draw the picture');
    ctx.drawImage(bitmap, 0, 0, width, height);
    // The page's own font, once it has loaded, so the names match the app rather than a fallback face.
    await document.fonts?.ready;
    const fontFamily = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
    drawBurn(ctx, planBurn(data, width, height), fontFamily);
    return canvas;
  } finally {
    bitmap.close();
  }
}

/** Sources worth trying for a burn: the original only when a browser can decode its format, then the preview. */
export function burnSources(original: { url: string; name: string } | null, previewUrl: string | null): string[] {
  const out: string[] = [];
  if (original && /\.(jpe?g|png)$/i.test(original.name)) out.push(original.url);
  if (previewUrl && !out.includes(previewUrl)) out.push(previewUrl);
  return out;
}
