/**
 * "Observations List" share card, the List-view counterpart to
 * calendarShare.ts. Turns the currently visible, currently sorted table into
 * a single branded image that can be printed, shared, or saved — the same
 * two outputs from one dataset:
 *
 *   - buildListShareText: a plain-text table for the clipboard.
 *   - drawListShareCard:  the branded dark table painted onto a <canvas>,
 *                         used as both the modal preview and the exported PNG.
 *
 * The palette mirrors calendarShare.ts/planShare.ts so all three share cards
 * look like siblings.
 */

export interface ListShareRow {
  id: string;
  /** What the Object column shows: common name, falling back to the catalog id. */
  display: string;
  catalog: string;
  /** Pre-formatted for display (matches ObservationsList's own formatting). */
  dateLabel: string;
  telescopeColor?: string;
}

export interface ListShareData {
  rows: ListShareRow[];
  uniqueObjects: number;
  /** e.g. "Sorted by date, newest first" — states what "the list" means here
   *  since, unlike the calendar, this card has no month to anchor it. */
  sortLabel: string;
  showTelescopeDots: boolean;
}

// ── Palette (shared with calendarShare.ts/planShare.ts) ─────────────────────
const BG = '#0F1426';
const SURFACE = '#1C243D';
const TEXT_PRI = '#FFFFFF';
const TEXT_SEC = '#9EBAE6';
const BRAND_ORANGE = '#F59E0B';
const RULE = 'rgba(255,255,255,0.08)';

const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// A card holding thousands of rows would be an unreasonably tall PNG (and
// slow to rasterize), so the export is capped and says so in the footer —
// mirrors how the on-screen thumbnail strip windows around 300+ sub-frames
// rather than trying to render everything.
const MAX_ROWS = 60;

// ── Plain text ────────────────────────────────────────────────────────────

export function buildListShareText(data: ListShareData): string {
  const rows = data.rows.slice(0, MAX_ROWS);
  const objectW = Math.max(6, ...rows.map(r => r.display.length));
  const catalogW = Math.max(7, ...rows.map(r => r.catalog.length));

  const lines = [
    `Observations · ${data.rows.length} total`,
    `${data.rows.length} observation${data.rows.length === 1 ? '' : 's'} across ${data.uniqueObjects} object${data.uniqueObjects === 1 ? '' : 's'}`,
    data.sortLabel,
    '',
  ];

  for (const row of rows) {
    lines.push(`${row.display.padEnd(objectW)}  ${row.catalog.padEnd(catalogW)}  ${row.dateLabel}`);
  }
  if (data.rows.length > rows.length) {
    lines.push('', `+ ${data.rows.length - rows.length} more not shown`);
  }

  lines.push('', 'Shared from Nebulis');
  return lines.join('\n');
}

// ── Card layout constants (logical points) ───────────────────────────────────

const W = 880;
const PAD = 32;
const HEADER_H = 88;
const COL_HEAD_H = 30;
const ROW_H = 34;
const FOOTER_H = 40;
const ROW_RADIUS = 8;

// Object | Catalog | Date, as fractions of the inner width.
const COL_FRACTIONS = [0.52, 0.24, 0.24];

/**
 * Paint the list share card onto `canvas`, sizing it for `scale`× the logical
 * dimensions. Returns the logical (CSS) width/height so callers can set the
 * display size. Safe to call repeatedly.
 */
export function drawListShareCard(
  canvas: HTMLCanvasElement,
  data: ListShareData,
  scale = 2,
): { width: number; height: number } {
  const rows = data.rows.slice(0, MAX_ROWS);
  const truncated = data.rows.length > rows.length;

  const ctx = canvas.getContext('2d');
  if (!ctx) return { width: W, height: HEADER_H + FOOTER_H };

  const font = (size: number, weight: number | string, mono = false) =>
    `${weight} ${size}px ${mono ? MONO : SANS}`;

  // Truncates with an ellipsis rather than letting canvas's own maxWidth
  // squish (its fallback for an overflowing fillText) visibly distort a long
  // object name into condensed type. Assumes ctx.font is already set.
  const ellipsize = (text: string, maxW: number): string => {
    if (ctx.measureText(text).width <= maxW) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? `${text.slice(0, lo)}…` : '…';
  };

  const roundRect = (x: number, y: number, w: number, h: number, r: number) => {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  };

  const innerW = W - PAD * 2;
  const colX = [PAD, PAD + innerW * COL_FRACTIONS[0], PAD + innerW * (COL_FRACTIONS[0] + COL_FRACTIONS[1])];

  const rowsH = rows.length * ROW_H;
  const H = HEADER_H + COL_HEAD_H + rowsH + (truncated ? 24 : 0) + FOOTER_H;

  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.textBaseline = 'top';

  // Background
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // ── Header ──────────────────────────────────────────────────────────────
  {
    ctx.textAlign = 'left';
    ctx.font = font(15, 700);
    ctx.fillStyle = TEXT_PRI;
    ctx.fillText('Neb', PAD, 24);
    const nebW = ctx.measureText('Neb').width;
    ctx.fillStyle = BRAND_ORANGE;
    ctx.fillText('ulis', PAD + nebW, 24);

    ctx.fillStyle = TEXT_PRI;
    ctx.font = font(24, 700);
    ctx.fillText('Observations', PAD, 46);

    ctx.textAlign = 'right';
    ctx.font = font(13, 500);
    ctx.fillStyle = TEXT_SEC;
    const stats = `${data.rows.length} observation${data.rows.length === 1 ? '' : 's'} · ${data.uniqueObjects} object${data.uniqueObjects === 1 ? '' : 's'}`;
    ctx.fillText(stats, W - PAD, 24);
    ctx.fillStyle = hexToRgba(TEXT_SEC, 0.7);
    ctx.font = font(12, 400);
    ctx.fillText(data.sortLabel, W - PAD, 44);

    ctx.fillStyle = RULE;
    ctx.fillRect(PAD, HEADER_H - 1, W - PAD * 2, 1);
  }

  // ── Column headers ──────────────────────────────────────────────────────
  {
    const top = HEADER_H;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = font(11, 700);
    ctx.fillStyle = hexToRgba(TEXT_SEC, 0.55);
    const midY = top + COL_HEAD_H / 2;
    ctx.fillText('OBJECT', colX[0], midY);
    ctx.fillText('CATALOG', colX[1], midY);
    ctx.fillText('DATE', colX[2], midY);
    ctx.textBaseline = 'top';
  }

  // ── Rows ────────────────────────────────────────────────────────────────
  let rowTop = HEADER_H + COL_HEAD_H;
  rows.forEach((row, i) => {
    if (i % 2 === 1) {
      ctx.fillStyle = SURFACE;
      roundRect(PAD - 8, rowTop, innerW + 16, ROW_H, ROW_RADIUS);
      ctx.fill();
    }

    const midY = rowTop + ROW_H / 2;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    let objectX = colX[0];
    if (data.showTelescopeDots && row.telescopeColor) {
      ctx.fillStyle = row.telescopeColor;
      ctx.beginPath();
      ctx.arc(objectX + 4, midY, 4, 0, Math.PI * 2);
      ctx.fill();
      objectX += 14;
    }

    ctx.font = font(13, 600);
    ctx.fillStyle = TEXT_PRI;
    ctx.fillText(ellipsize(row.display, colX[1] - objectX - 12), objectX, midY);

    ctx.font = font(12, 500, true);
    ctx.fillStyle = TEXT_SEC;
    ctx.fillText(ellipsize(row.catalog, colX[2] - colX[1] - 12), colX[1], midY);

    ctx.fillStyle = hexToRgba(TEXT_SEC, 0.85);
    ctx.fillText(ellipsize(row.dateLabel, W - PAD - colX[2]), colX[2], midY);

    ctx.textBaseline = 'top';
    rowTop += ROW_H;
  });

  if (truncated) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = font(11, 500, true);
    ctx.fillStyle = hexToRgba(TEXT_SEC, 0.5);
    ctx.fillText(`+ ${data.rows.length - rows.length} more not shown`, PAD, rowTop + 12);
    ctx.textBaseline = 'top';
    rowTop += 24;
  }

  // ── Footer ──────────────────────────────────────────────────────────────
  {
    ctx.fillStyle = RULE;
    ctx.fillRect(PAD, rowTop, W - PAD * 2, 1);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = font(11, 500, true);
    ctx.fillStyle = hexToRgba(TEXT_SEC, 0.4);
    ctx.fillText('nebulis.app', PAD, rowTop + FOOTER_H / 2 + 1);
    ctx.textAlign = 'right';
    ctx.fillText('Observation log', W - PAD, rowTop + FOOTER_H / 2 + 1);
    ctx.textBaseline = 'top';
  }

  return { width: W, height: H };
}
