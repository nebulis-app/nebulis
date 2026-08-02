/**
 * "Observations Calendar" share card, the calendar-view counterpart to the
 * planner's PlanShareCard (see planShare.ts). Turns a month of observations
 * into a single branded image that can be printed, shared, or saved.
 *
 * Two outputs from one month:
 *   - buildCalendarShareText:  a plain-text month summary for the clipboard.
 *   - drawCalendarShareCard:   the branded dark calendar painted onto a
 *                              <canvas>, used as both the modal preview and
 *                              the exported PNG.
 *
 * The card is drawn at a fixed logical width and scaled up for crispness.
 * The palette mirrors planShare.ts so the two share cards look like siblings.
 */
import type { ObservationSummary } from './api/observations';
import { cleanCatalogId, formatObjectName } from './utils';

export interface CalendarShareDay {
  date: string; // YYYY-MM-DD
  day: number;
  isCurrentMonth: boolean;
  observations: ObservationSummary[];
}

export interface CalendarShareData {
  monthLabel: string; // e.g. "July 2026"
  weeks: CalendarShareDay[][]; // each row is 7 days
  totalObservations: number;
  uniqueObjects: number;
  today: string; // YYYY-MM-DD
  telescopeColorById: Record<string, string>;
  showTelescopeDots: boolean;
}

// ── Palette (shared with planShare.ts) ──────────────────────────────────────
const BG = '#0F1426';
const SURFACE = '#1C243D';
const SURFACE_DIM = '#141A2E';
const TEXT_PRI = '#FFFFFF';
const TEXT_SEC = '#9EBAE6';
const BRAND_ORANGE = '#F59E0B';
const ACCENT_TEXT = '#FBBF24';
const RULE = 'rgba(255,255,255,0.08)';

const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ── Shared helpers ──────────────────────────────────────────────────────────

function obsName(obs: ObservationSummary): string {
  return formatObjectName(cleanCatalogId(obs.objectId), cleanCatalogId(obs.objectName));
}

/** SeeStar "YYYYMMDD-HHMMSS" (or an ISO string) → "HH:MM". */
function formatTime(timestamp: string | null): string | null {
  if (!timestamp) return null;
  const m = timestamp.match(/^\d{8}-(\d{2})(\d{2})/);
  if (m) return `${m[1]}:${m[2]}`;
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/** Time range for a single observation, e.g. "20:14 – 21:30" or "20:14". */
function timeRange(obs: ObservationSummary): string | null {
  const start = formatTime(obs.startTime);
  if (!start) return null;
  const end = formatTime(obs.endTime);
  if (end && obs.endTime !== obs.startTime) return `${start} – ${end}`;
  return start;
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Plain text ──────────────────────────────────────────────────────────────

export function buildCalendarShareText(data: CalendarShareData): string {
  const lines = [
    `Observations · ${data.monthLabel}`,
    `${data.totalObservations} observation${data.totalObservations === 1 ? '' : 's'} across ${data.uniqueObjects} object${data.uniqueObjects === 1 ? '' : 's'}`,
    '',
  ];

  const days = data.weeks
    .flat()
    .filter(d => d.isCurrentMonth && d.observations.length > 0);

  for (const day of days) {
    const label = new Date(day.date + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    lines.push(label);
    for (const obs of day.observations) {
      const t = timeRange(obs);
      lines.push(t ? `  ${t}  ${obsName(obs)}` : `  ${obsName(obs)}`);
    }
    lines.push('');
  }

  if (days.length === 0) lines.push('No observations this month.', '');
  lines.push('Shared from Nebulis');
  return lines.join('\n');
}

// ── Card layout constants (logical points) ───────────────────────────────────

const W = 1360;
const PAD = 32;
const COL_GAP = 6;
const ROW_GAP = 6;
const HEADER_H = 96;
const WEEKDAY_H = 34;
const FOOTER_H = 40;
const CELL_RADIUS = 10;
const DAY_NUM_H = 24;
const MIN_CELL_H = 108;
const CELL_BOTTOM_PAD = 8;

// Entry (observation chip) metrics. Names wrap onto as many lines as they need
// so they are never truncated; the time sits on its own line beneath.
const ENTRY_GAP = 5;
const ENTRY_PAD_Y = 5; // top and bottom padding inside a chip
const ENTRY_HPAD = 8; // left/right padding inside a chip
const NAME_LH = 15; // name line height
const TIME_LH = 13; // time line height
const NAME_TIME_GAP = 2;

interface EntryLayout {
  obs: ObservationSummary;
  nameLines: string[];
  timeStr: string | null;
  scopeColor: string | undefined;
  textLeft: number; // where name/time text begins inside the cell
  height: number;
}

// ── Card rendering ────────────────────────────────────────────────────────────

/**
 * Paint the calendar share card onto `canvas`, sizing it for `scale`× the
 * logical dimensions. Returns the logical (CSS) width/height so callers can
 * set the display size. Safe to call repeatedly.
 */
export function drawCalendarShareCard(
  canvas: HTMLCanvasElement,
  data: CalendarShareData,
  scale = 2,
): { width: number; height: number } {
  const { weeks } = data;

  const ctx = canvas.getContext('2d');
  if (!ctx) return { width: W, height: HEADER_H + WEEKDAY_H + FOOTER_H };

  const font = (size: number, weight: number | string, mono = false) =>
    `${weight} ${size}px ${mono ? MONO : SANS}`;

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
  const colW = (innerW - COL_GAP * 6) / 7;
  const colX = (c: number) => PAD + c * (colW + COL_GAP);

  const NAME_FONT = font(11, 600);

  // Word-wrap `text` to fit `maxW`, never truncating: long single tokens
  // (e.g. "SuperCoolObservationName") are hard-broken by character. Assumes
  // ctx.font is already the name font.
  const wrapText = (text: string, maxW: number): string[] => {
    if (maxW <= 4) return [text];
    const out: string[] = [];
    const breakToken = (token: string): string => {
      let chunk = '';
      for (const ch of token) {
        if (chunk && ctx.measureText(chunk + ch).width > maxW) {
          out.push(chunk);
          chunk = ch;
        } else {
          chunk += ch;
        }
      }
      return chunk;
    };
    let cur = '';
    for (const word of text.split(/\s+/)) {
      if (!word) continue;
      const test = cur ? `${cur} ${word}` : word;
      if (ctx.measureText(test).width <= maxW) {
        cur = test;
        continue;
      }
      if (cur) { out.push(cur); cur = ''; }
      cur = ctx.measureText(word).width <= maxW ? word : breakToken(word);
    }
    if (cur) out.push(cur);
    return out.length ? out : [''];
  };

  // ── Measurement pass ────────────────────────────────────────────────────
  // Wrap every observation name once, then grow each week's row to fit the
  // busiest day so no entry is ever clipped.
  ctx.font = NAME_FONT;
  const weekLayouts: EntryLayout[][][] = [];
  const rowHeights: number[] = [];
  const entryW = colW - 12;

  weeks.forEach(week => {
    const dayLayouts: EntryLayout[][] = [];
    let maxDayH = 0;
    week.forEach(day => {
      const entries: EntryLayout[] = [];
      for (const obs of day.observations) {
        const scopeColor = obs.telescopeId ? data.telescopeColorById[obs.telescopeId] : undefined;
        const hasDot = data.showTelescopeDots && !!scopeColor;
        const textLeft = ENTRY_HPAD + (hasDot ? 9 : 0);
        const nameMaxW = entryW - textLeft - ENTRY_HPAD;
        const nameLines = wrapText(obsName(obs), nameMaxW);
        const timeStr = timeRange(obs);
        const height =
          ENTRY_PAD_Y * 2 + nameLines.length * NAME_LH + (timeStr ? NAME_TIME_GAP + TIME_LH : 0);
        entries.push({ obs, nameLines, timeStr, scopeColor: hasDot ? scopeColor : undefined, textLeft, height });
      }
      const n = entries.length;
      const dayH =
        DAY_NUM_H + 4 + entries.reduce((s, e) => s + e.height, 0) + Math.max(0, n - 1) * ENTRY_GAP + CELL_BOTTOM_PAD;
      maxDayH = Math.max(maxDayH, dayH);
      dayLayouts.push(entries);
    });
    weekLayouts.push(dayLayouts);
    rowHeights.push(Math.max(MIN_CELL_H, maxDayH));
  });

  const gridH = rowHeights.reduce((sum, h) => sum + h, 0) + Math.max(0, weeks.length - 1) * ROW_GAP;
  const H = HEADER_H + WEEKDAY_H + gridH + FOOTER_H;

  // Size the canvas (this resets ctx state; every draw call below re-sets font).
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.textBaseline = 'top';

  // Background
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // ── Header ──────────────────────────────────────────────────────────────
  {
    // Brand "Nebulis" (white + orange)
    ctx.textAlign = 'left';
    ctx.font = font(15, 700);
    ctx.fillStyle = TEXT_PRI;
    ctx.fillText('Neb', PAD, 24);
    const nebW = ctx.measureText('Neb').width;
    ctx.fillStyle = BRAND_ORANGE;
    ctx.fillText('ulis', PAD + nebW, 24);

    // Title (month)
    ctx.fillStyle = TEXT_PRI;
    ctx.font = font(28, 700);
    ctx.fillText(data.monthLabel, PAD, 46);

    // Stats (right)
    ctx.textAlign = 'right';
    ctx.font = font(13, 500);
    ctx.fillStyle = TEXT_SEC;
    const stats = `${data.totalObservations} observation${data.totalObservations === 1 ? '' : 's'} · ${data.uniqueObjects} object${data.uniqueObjects === 1 ? '' : 's'}`;
    ctx.fillText('Observations', W - PAD, 26);
    ctx.fillStyle = hexToRgba(TEXT_SEC, 0.7);
    ctx.font = font(12, 400);
    ctx.fillText(stats, W - PAD, 48);

    ctx.fillStyle = RULE;
    ctx.fillRect(PAD, HEADER_H - 1, W - PAD * 2, 1);
  }

  // ── Weekday header row ─────────────────────────────────────────────────────
  {
    const top = HEADER_H;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = font(11, 700);
    ctx.fillStyle = hexToRgba(TEXT_SEC, 0.55);
    WEEKDAYS.forEach((label, c) => {
      ctx.fillText(label.toUpperCase(), colX(c) + colW / 2, top + WEEKDAY_H / 2 + 1);
    });
    ctx.textBaseline = 'top';
  }

  // ── Week rows ──────────────────────────────────────────────────────────────
  let rowTop = HEADER_H + WEEKDAY_H;
  weeks.forEach((week, w) => {
    const rowH = rowHeights[w];
    week.forEach((day, c) => {
      const x = colX(c);
      const y = rowTop;

      // Cell background
      ctx.fillStyle = day.isCurrentMonth ? SURFACE : SURFACE_DIM;
      roundRect(x, y, colW, rowH, CELL_RADIUS);
      ctx.fill();

      const isToday = day.date === data.today && day.isCurrentMonth;

      // Day number (accent puck for today)
      const numCx = x + 16;
      const numCy = y + 15;
      if (isToday) {
        ctx.fillStyle = BRAND_ORANGE;
        ctx.beginPath();
        ctx.arc(numCx, numCy, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#0F1426';
      } else {
        ctx.fillStyle = day.isCurrentMonth ? TEXT_SEC : hexToRgba(TEXT_SEC, 0.35);
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = font(12, isToday ? 700 : 600);
      ctx.fillText(String(day.day), numCx, numCy + 0.5);
      ctx.textBaseline = 'top';

      // Observation entries (pre-wrapped in the measurement pass)
      const entries = weekLayouts[w][c];
      const entryX = x + 6;
      const dimmed = !day.isCurrentMonth;
      let entryTop = y + DAY_NUM_H + 4;
      for (const e of entries) {
        const tintBase = e.scopeColor ?? ACCENT_TEXT;
        ctx.fillStyle = hexToRgba(tintBase, dimmed ? 0.08 : 0.14);
        roundRect(entryX, entryTop, entryW, e.height, 5);
        ctx.fill();

        // Telescope dot on the first name line
        const firstLineCy = entryTop + ENTRY_PAD_Y + NAME_LH / 2;
        if (e.scopeColor) {
          ctx.fillStyle = e.scopeColor;
          ctx.beginPath();
          ctx.arc(entryX + ENTRY_HPAD + 3, firstLineCy, 3, 0, Math.PI * 2);
          ctx.fill();
        }

        // Full object name, wrapped across as many lines as it needs
        ctx.font = NAME_FONT;
        ctx.fillStyle = dimmed ? hexToRgba(ACCENT_TEXT, 0.6) : ACCENT_TEXT;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        e.nameLines.forEach((line, i) => {
          ctx.fillText(line, entryX + e.textLeft, entryTop + ENTRY_PAD_Y + NAME_LH * i + NAME_LH / 2);
        });

        // Time on its own line beneath the name
        if (e.timeStr) {
          ctx.font = font(10, 500, true);
          ctx.fillStyle = hexToRgba(TEXT_SEC, dimmed ? 0.55 : 0.85);
          ctx.fillText(
            e.timeStr,
            entryX + ENTRY_HPAD,
            entryTop + ENTRY_PAD_Y + e.nameLines.length * NAME_LH + NAME_TIME_GAP + TIME_LH / 2,
          );
        }
        ctx.textBaseline = 'top';

        entryTop += e.height + ENTRY_GAP;
      }
    });

    rowTop += rowH + ROW_GAP;
  });

  // ── Footer ──────────────────────────────────────────────────────────────
  {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = font(11, 500, true);
    ctx.fillStyle = hexToRgba(TEXT_SEC, 0.4);
    ctx.fillText('nebulis.app', PAD, H - FOOTER_H / 2);
    ctx.textAlign = 'right';
    ctx.fillText('Observation log', W - PAD, H - FOOTER_H / 2);
    ctx.textBaseline = 'top';
  }

  return { width: W, height: H };
}
