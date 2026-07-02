/**
 * "Observation Plan" share card, web port of the iOS PlanShareCard /
 * PlannerSchedule share sheet (NebulisIOS) and Android PlanShareSheet.
 *
 * Two outputs from one plan:
 *   - buildPlanShareText: a plain-text summary for the clipboard.
 *   - drawPlanShareCard:  a branded dark card painted onto a <canvas>, used
 *                         both as the modal preview and as the exported PNG.
 *
 * The card is drawn at a fixed logical width (390pt, matching mobile) and
 * scaled up for crispness. Layout constants mirror the mobile cards so the
 * three clients produce the same image.
 */
import type { PlannedSession } from './api/plannedSessions';
import { formatHm } from './timeFormat';
import { computeAltitudeCurve } from './altaz';
import { formatObjectName } from './utils';

export interface PlanShareData {
  sessions: PlannedSession[];
  nightStart: Date;
  nightEnd: Date;
  date: Date;
  moonIllumination: number | null;
  moonPhase: string | null;
  observerLat: number | null;
  observerLon: number | null;
  timezone?: string;
}

// ── Palette (shared with mobile) ────────────────────────────────────────────
const BG = '#0F1426';
const SURFACE = '#1C243D';
const TEXT_PRI = '#FFFFFF';
const TEXT_SEC = '#9EBAE6';
const BRAND_ORANGE = '#F59E0B';
const RULE = 'rgba(255,255,255,0.08)';

const BLOCK_PALETTE = ['#57D399', '#6EA1F7', '#E08CFA', '#FABF59', '#FA7090', '#59E0EB'];
const blockColor = (idx: number) => BLOCK_PALETTE[idx % BLOCK_PALETTE.length];

const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

// ── Shared helpers ──────────────────────────────────────────────────────────

/** Compact catalog designation (e.g. "M81"), falling back to the stored name
 *  for custom objects without a catalog id. Mirrors plannerCatalogLabel. */
function catalogLabel(s: PlannedSession): string {
  return s.objectId || s.objectName;
}

/** Full session label: catalog id + common name, e.g. "M40 - Winnecke 4",
 *  collapsing redundant cases like "M92 - Messier 92" down to "M92". */
function sessionLabel(s: PlannedSession): string {
  return formatObjectName(s.objectId, s.objectName);
}

function durationLabel(s: PlannedSession): string | null {
  const start = Date.parse(s.startTime);
  const end = Date.parse(s.endTime);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const mins = Math.round((end - start) / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0) return m === 0 ? `${h}h` : `${h}h ${m}m`;
  return `${m}m`;
}

function sortedSessions(sessions: PlannedSession[]): PlannedSession[] {
  return [...sessions].sort((a, b) => {
    const ta = Date.parse(a.startTime);
    const tb = Date.parse(b.startTime);
    return (Number.isNaN(ta) ? -Infinity : ta) - (Number.isNaN(tb) ? -Infinity : tb);
  });
}

function formatDate(date: Date, timeZone: string | undefined, long: boolean): string {
  const opts: Intl.DateTimeFormatOptions = long
    ? { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }
    : { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };
  if (timeZone) opts.timeZone = timeZone;
  return date.toLocaleDateString('en-US', opts);
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Plain text ──────────────────────────────────────────────────────────────

export function buildPlanShareText(data: PlanShareData): string {
  const { nightStart, nightEnd, date, moonIllumination, moonPhase, timezone } = data;
  const sorted = sortedSessions(data.sessions);
  const dateStr = formatDate(date, timezone, true);
  const dur = ((nightEnd.getTime() - nightStart.getTime()) / 3_600_000).toFixed(1);

  const lines = [
    `Observation Plan · ${dateStr}`,
    `Dark window: ${formatHm(nightStart, timezone)} – ${formatHm(nightEnd, timezone)} (${dur}h)`,
  ];
  if (moonIllumination != null && moonPhase) lines.push(`Moon: ${moonIllumination}% ${moonPhase}`);
  lines.push('');

  sorted.forEach((s, idx) => {
    const start = Number.isNaN(Date.parse(s.startTime)) ? '—' : formatHm(new Date(s.startTime), timezone);
    const end = Number.isNaN(Date.parse(s.endTime)) ? '—' : formatHm(new Date(s.endTime), timezone);
    let line = `${idx + 1}. ${sessionLabel(s)}  ${start} – ${end}`;
    const d = durationLabel(s);
    if (d) line += `  (${d})`;
    lines.push(line);
  });

  lines.push('', 'Planned with Nebulis');
  return lines.join('\n');
}

// ── Card layout constants (logical points, mirror mobile) ────────────────────

const W = 390;
const PAD = 20;

const HEADER_H = 114;
const TIMELINE_H = 99;
const LIST_ROW_H = 48;
const LIST_PAD = 8; // 4 top + 4 bottom
const FOOTER_H = 37;

// Elevation plot
const ELEV_LEFT = 30;
const ELEV_RIGHT = 6;
const ELEV_TOP = 6;
const ELEV_PLOT_H = 120;
const ELEV_TIME_GAP = 4;
const ELEV_TIME_LABEL_H = 12;
const ELEV_NAME_GAP = 3;
const ELEV_NAME_LABEL_H = 12;
const ELEV_CANVAS_H =
  ELEV_TOP + ELEV_PLOT_H + ELEV_TIME_GAP + ELEV_TIME_LABEL_H + ELEV_NAME_GAP + ELEV_NAME_LABEL_H + 4;
const ELEV_SECTION_H = 14 + 11 + 6 + ELEV_CANVAS_H + 14; // vpad + label + gap + plot + vpad

function cardHeight(n: number, hasElev: boolean): number {
  const listH = LIST_PAD + LIST_ROW_H * Math.max(0, n);
  const ruleCount = hasElev ? 4 : 3;
  return HEADER_H + TIMELINE_H + listH + (hasElev ? ELEV_SECTION_H : 0) + FOOTER_H + ruleCount;
}

// ── Card rendering ────────────────────────────────────────────────────────────

/**
 * Paint the share card onto `canvas`, sizing it for `scale`× the logical
 * dimensions. Returns the logical (CSS) width/height so callers can set the
 * display size. Safe to call repeatedly.
 */
export function drawPlanShareCard(
  canvas: HTMLCanvasElement,
  data: PlanShareData,
  scale = 2,
): { width: number; height: number } {
  const { nightStart, nightEnd, observerLat, observerLon, timezone } = data;
  const sorted = sortedSessions(data.sessions);
  const hasElev = observerLat != null && observerLon != null;

  // Axis spans the union of the dark window and every session so blocks
  // scheduled outside the dark window aren't clipped to slivers.
  const sessionStarts = sorted.map(s => Date.parse(s.startTime)).filter(t => !Number.isNaN(t));
  const sessionEnds = sorted.map(s => Date.parse(s.endTime)).filter(t => !Number.isNaN(t));
  const axisStart = Math.min(nightStart.getTime(), ...(sessionStarts.length ? sessionStarts : [nightStart.getTime()]));
  const axisEnd = Math.max(nightEnd.getTime(), ...(sessionEnds.length ? sessionEnds : [nightEnd.getTime()]));

  const H = cardHeight(sorted.length, hasElev);

  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return { width: W, height: H };
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.textBaseline = 'top';

  // Background
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  const font = (size: number, weight: number | string, mono = false) =>
    `${weight} ${size}px ${mono ? MONO : SANS}`;

  const drawRule = (yPos: number, inset = 0) => {
    ctx.fillStyle = RULE;
    ctx.fillRect(inset, yPos, W - inset * 2, 1);
  };

  const roundRect = (x: number, yPos: number, w: number, h: number, r: number) => {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, yPos);
    ctx.arcTo(x + w, yPos, x + w, yPos + h, rr);
    ctx.arcTo(x + w, yPos + h, x, yPos + h, rr);
    ctx.arcTo(x, yPos + h, x, yPos, rr);
    ctx.arcTo(x, yPos, x + w, yPos, rr);
    ctx.closePath();
  };

  let y = 0;

  // ── Header ──────────────────────────────────────────────────────────────
  {
    // Brand "Nebulis" (white + orange)
    ctx.textAlign = 'left';
    ctx.font = font(14, 700);
    ctx.fillStyle = TEXT_PRI;
    ctx.fillText('Neb', PAD, 21);
    const nebW = ctx.measureText('Neb').width;
    ctx.fillStyle = BRAND_ORANGE;
    ctx.fillText('ulis', PAD + nebW, 21);

    // Date (right)
    ctx.textAlign = 'right';
    ctx.font = font(11, 500);
    ctx.fillStyle = TEXT_SEC;
    ctx.fillText(formatDate(data.date, timezone, false), W - PAD, 23);

    // Title
    ctx.textAlign = 'left';
    ctx.font = font(24, 700);
    ctx.fillStyle = TEXT_PRI;
    ctx.fillText('Observation Plan', PAD, 42);

    // Meta row
    const dur = ((nightEnd.getTime() - nightStart.getTime()) / 3_600_000).toFixed(1);
    const metaY = 80;
    ctx.font = font(12, 400);
    ctx.fillStyle = TEXT_SEC;
    const windowText = `🌙 ${formatHm(nightStart, timezone)} – ${formatHm(nightEnd, timezone)}  (${dur}h)`;
    ctx.fillText(windowText, PAD, metaY);
    if (data.moonIllumination != null && data.moonPhase) {
      const w = ctx.measureText(windowText).width;
      ctx.fillStyle = hexToRgba(TEXT_SEC, 0.65);
      ctx.fillText(`${data.moonIllumination}% ${data.moonPhase}`, PAD + w + 16, metaY);
    }

    y = HEADER_H;
    drawRule(y);
    y += 1;
  }

  // ── Timeline bar ──────────────────────────────────────────────────────────
  {
    const top = y;
    ctx.textAlign = 'left';
    ctx.font = font(9, 700, true);
    ctx.fillStyle = hexToRgba(TEXT_SEC, 0.4);
    ctx.fillText('TIMELINE', PAD, top + 14);

    const barY = top + 14 + 11 + 6;
    const barW = W - PAD * 2;
    ctx.fillStyle = SURFACE;
    roundRect(PAD, barY, barW, 36, 5);
    ctx.fill();

    const totalMs = Math.max(1, axisEnd - axisStart);
    sorted.forEach((s, idx) => {
      const st = Date.parse(s.startTime);
      const en = Date.parse(s.endTime);
      if (Number.isNaN(st) || Number.isNaN(en)) return;
      const fStart = Math.min(1, Math.max(0, (st - axisStart) / totalMs));
      const fEnd = Math.min(1, Math.max(0, (en - axisStart) / totalMs));
      const x = PAD + barW * fStart;
      const bw = Math.max(3, barW * (fEnd - fStart));
      ctx.fillStyle = hexToRgba(blockColor(idx), 0.85);
      roundRect(x, barY, bw, 36, 4);
      ctx.fill();
      if (bw > 24) {
        ctx.save();
        roundRect(x, barY, bw, 36, 4);
        ctx.clip();
        ctx.fillStyle = '#FFFFFF';
        ctx.font = font(9, 600);
        ctx.textBaseline = 'middle';
        ctx.fillText(catalogLabel(s), x + 5, barY + 18);
        ctx.textBaseline = 'top';
        ctx.restore();
      }
    });

    const timeY = barY + 36 + 6;
    ctx.font = font(10, 400, true);
    ctx.fillStyle = hexToRgba(TEXT_SEC, 0.45);
    ctx.textAlign = 'left';
    ctx.fillText(formatHm(new Date(axisStart), timezone), PAD, timeY);
    ctx.textAlign = 'right';
    ctx.fillText(formatHm(new Date(axisEnd), timezone), W - PAD, timeY);

    y = top + TIMELINE_H;
    drawRule(y);
    y += 1;
  }

  // ── Session list ──────────────────────────────────────────────────────────
  {
    const top = y;
    let rowTop = top + 4;
    ctx.textAlign = 'left';
    sorted.forEach((s, idx) => {
      const centerY = rowTop + LIST_ROW_H / 2;

      // Numbered chip
      ctx.fillStyle = hexToRgba(blockColor(idx), 0.18);
      ctx.beginPath();
      ctx.arc(PAD + 13, centerY, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = blockColor(idx);
      ctx.font = font(11, 700, true);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(idx + 1), PAD + 13, centerY + 0.5);

      // Object name (clipped so it never collides with the time column)
      const nameX = PAD + 38;
      const nameMaxW = W - PAD - 92 - nameX;
      ctx.save();
      ctx.beginPath();
      ctx.rect(nameX, rowTop, nameMaxW, LIST_ROW_H);
      ctx.clip();
      ctx.textAlign = 'left';
      ctx.fillStyle = TEXT_PRI;
      ctx.font = font(14, 600);
      ctx.fillText(sessionLabel(s), nameX, centerY);
      ctx.restore();

      // Time range + duration (right)
      const start = Number.isNaN(Date.parse(s.startTime)) ? '—' : formatHm(new Date(s.startTime), timezone);
      const end = Number.isNaN(Date.parse(s.endTime)) ? '—' : formatHm(new Date(s.endTime), timezone);
      const dl = durationLabel(s);
      ctx.textAlign = 'right';
      ctx.fillStyle = TEXT_SEC;
      ctx.font = font(11, 500, true);
      ctx.fillText(`${start} – ${end}`, W - PAD, dl ? centerY - 7 : centerY);
      if (dl) {
        ctx.fillStyle = hexToRgba(TEXT_SEC, 0.5);
        ctx.font = font(10, 400);
        ctx.fillText(dl, W - PAD, centerY + 7);
      }
      ctx.textBaseline = 'top';

      rowTop += LIST_ROW_H;
      if (idx < sorted.length - 1) drawRule(rowTop, PAD);
    });

    y = top + LIST_PAD + LIST_ROW_H * sorted.length;
    drawRule(y);
    y += 1;
  }

  // ── Elevation graph ─────────────────────────────────────────────────────────
  if (hasElev) {
    const top = y;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = font(9, 700, true);
    ctx.fillStyle = hexToRgba(TEXT_SEC, 0.4);
    ctx.fillText('ELEVATION', PAD, top + 14);

    const boxX = PAD;
    const boxY = top + 14 + 11 + 6;
    const boxW = W - PAD * 2;
    ctx.fillStyle = SURFACE;
    roundRect(boxX, boxY, boxW, ELEV_CANVAS_H, 6);
    ctx.fill();

    ctx.save();
    roundRect(boxX, boxY, boxW, ELEV_CANVAS_H, 6);
    ctx.clip();

    const axisDur = axisEnd - axisStart;
    const plotW = boxW - ELEV_LEFT - ELEV_RIGHT;
    const minAlt = 20;
    const maxAlt = 90;
    const altRange = maxAlt - minAlt;
    const xFor = (t: number) => boxX + ELEV_LEFT + plotW * ((t - axisStart) / axisDur);
    const yFor = (alt: number) =>
      boxY + ELEV_TOP + ELEV_PLOT_H * (1 - (Math.min(maxAlt, Math.max(minAlt, alt)) - minAlt) / altRange);

    if (axisDur > 0) {
      // Horizontal grid + y labels every 10°
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.lineWidth = 0.5;
      ctx.setLineDash([4, 3]);
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.font = font(8, 400);
      for (let altDeg = 20; altDeg <= 90; altDeg += 10) {
        const gy = yFor(altDeg);
        ctx.beginPath();
        ctx.moveTo(boxX + ELEV_LEFT, gy);
        ctx.lineTo(boxX + boxW - ELEV_RIGHT, gy);
        ctx.stroke();
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${altDeg}°`, boxX + ELEV_LEFT - 4, gy);
      }

      // Vertical grid + time labels every hour
      ctx.font = font(8, 400, true);
      ctx.textBaseline = 'top';
      const axisStartSec = axisStart / 1000;
      const axisEndSec = axisEnd / 1000;
      let tSec = Math.ceil(axisStartSec / 3600) * 3600;
      while (tSec <= axisEndSec) {
        const gx = xFor(tSec * 1000);
        ctx.beginPath();
        ctx.moveTo(gx, boxY + ELEV_TOP);
        ctx.lineTo(gx, boxY + ELEV_TOP + ELEV_PLOT_H);
        ctx.stroke();
        ctx.textAlign = 'center';
        ctx.fillText(formatHm(new Date(tSec * 1000), timezone), gx, boxY + ELEV_TOP + ELEV_PLOT_H + ELEV_TIME_GAP);
        tSec += 3600;
      }
      ctx.setLineDash([]);

      // Per-session altitude curves + names
      sorted.forEach((s, idx) => {
        const st = Date.parse(s.startTime);
        const en = Date.parse(s.endTime);
        if (Number.isNaN(st) || Number.isNaN(en)) return;
        const color = blockColor(idx);
        const curve = computeAltitudeCurve(s.ra, s.dec, observerLat!, observerLon!, new Date(st), new Date(en), 5);
        if (curve.length) {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          curve.forEach((c, i) => {
            const px = xFor(c.time.getTime());
            const py = yFor(c.alt);
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          });
          ctx.stroke();
        }

        const midX = xFor((st + en) / 2);
        ctx.fillStyle = hexToRgba(color, 0.8);
        ctx.font = font(8, 500);
        ctx.textAlign = 'center';
        const label = catalogLabel(s);
        const halfW = ctx.measureText(label).width / 2;
        const clampedX = Math.max(boxX + halfW, Math.min(boxX + boxW - halfW, midX));
        ctx.fillText(label, clampedX, boxY + ELEV_TOP + ELEV_PLOT_H + ELEV_TIME_GAP + ELEV_TIME_LABEL_H + ELEV_NAME_GAP);
      });
    }

    ctx.restore();
    ctx.textBaseline = 'top';

    y = top + ELEV_SECTION_H;
    drawRule(y);
    y += 1;
  }

  // ── Footer ──────────────────────────────────────────────────────────────
  {
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.font = font(10, 500, true);
    ctx.fillStyle = hexToRgba(TEXT_SEC, 0.4);
    ctx.fillText('nebulis.app', W - PAD, y + 12);
  }

  return { width: W, height: H };
}
