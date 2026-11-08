/**
 * Horizontal altitude band chart for the night's scheduled blocks.
 *
 * X axis: time, spanning the full dark window (dusk to dawn).
 * Y axis: altitude in degrees (clamped 0-90).
 *
 * Each scheduled block renders its object's altitude curve only within its
 * own time band. Vertical separators delimit each block and the object name
 * sits underneath it. Gaps between blocks are left blank — the chart matches
 * what was actually planned, not what could be observed.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { computeAltitudeCurve } from '../../lib/altaz';
import { twilightGradientCss, type TwilightMarks } from '../../lib/plannerNight';
import { useTheme } from '../../hooks/useTheme';
import { formatHm, hourTicks } from './scheduleGeometry';
import type { PlannedSession } from '../../lib/api/plannedSessions';

interface AltitudeBandChartProps {
  nightStart: Date;
  nightEnd: Date;
  sessions: PlannedSession[];
  observerLat: number;
  observerLon: number;
  minAlt?: number;
  /** IANA timezone for tick/tooltip labels. Defaults to machine-local. */
  observerTimezone?: string;
  /** Sun-angle boundaries, painted left-to-right behind the plot so this
   *  chart reads as a continuation of the schedule timeline above it (same
   *  twilight gradient, rotated to match this chart's horizontal time axis)
   *  rather than a flat black slab under a gradient one. */
  twilight?: TwilightMarks | null;
}

// Default / minimum chart height. The rendered height is measured at runtime
// (see DEFAULT_HEIGHT usage) so the chart grows on tall screens; this value is
// the floor and the pre-measurement fallback.
const DEFAULT_HEIGHT = 102;
const PAD_LEFT = 36;
const PAD_RIGHT = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 28;     // room for hour ticks
// Approximate width of one label character at the 11px label size, in SVG
// units, used to trim a name to the block it sits in.
const LABEL_CHAR_WIDTH = 6.4;
const LABEL_PAD = 8;

// Auto-range altitude: cover the full plotted set, but never tighter than
// a 30° window so single-target plots don't look distorted. Always extends
// the lower bound to include minAlt so the threshold line is never clipped.
function altRange(curves: Array<{ alt: number }[]>, minAlt?: number): { lo: number; hi: number } {
  let lo = 90;
  let hi = 0;
  for (const c of curves) {
    for (const s of c) {
      if (s.alt < lo) lo = s.alt;
      if (s.alt > hi) hi = s.alt;
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) {
    return { lo: 0, hi: 90 };
  }
  // Snap to 5°, pad, and enforce a minimum window.
  lo = Math.max(0, Math.floor((lo - 5) / 5) * 5);
  hi = Math.min(90, Math.ceil((hi + 5) / 5) * 5);
  if (hi - lo < 30) {
    const mid = (hi + lo) / 2;
    lo = Math.max(0, Math.floor((mid - 15) / 5) * 5);
    hi = Math.min(90, Math.ceil((mid + 15) / 5) * 5);
  }
  // Ensure the minAlt line is always visible by pulling the lower bound down.
  if (minAlt != null && minAlt < lo) {
    lo = Math.max(0, Math.floor((minAlt - 5) / 5) * 5);
  }
  return { lo, hi };
}

export function AltitudeBandChart({
  nightStart,
  nightEnd,
  sessions,
  observerLat,
  observerLon,
  minAlt,
  observerTimezone,
  twilight,
}: AltitudeBandChartProps) {
  const { t } = useTranslation('planner');
  const { isNight } = useTheme();
  // The chart sits directly under the schedule on the same night canvas, so its
  // palette is night-side in every theme rather than following the app theme
  // — except the astronomy red-light theme, which twilightGradientCss carves
  // out explicitly (see its own comment).
  const background = useMemo(
    () => twilightGradientCss(twilight, nightStart.getTime(), nightEnd.getTime() - nightStart.getTime(), 'to right', isNight),
    [twilight, nightStart, nightEnd, isNight],
  );

  // Compute one altitude curve per scheduled block, clipped to its time band.
  const curves = useMemo(() => {
    return sessions.map(s => {
      const start = new Date(s.startTime);
      const end = new Date(s.endTime);
      // 5-minute samples — denser at the edges so the curve hugs each band's
      // boundary without visible stair-steps.
      const samples = computeAltitudeCurve(s.ra, s.dec, observerLat, observerLon, start, end, 5);
      return { session: s, start, end, samples };
    });
  }, [sessions, observerLat, observerLon]);

  const range = useMemo(() => altRange(curves.map(c => c.samples), minAlt), [curves, minAlt]);

  // Measure the wrapper so the SVG's logical coordinate system matches its
  // rendered pixel height. viewBox height tracks the real height, so the chart
  // grows vertically without distorting text (unlike a fixed viewBox stretched
  // by preserveAspectRatio). The CSS height (set on the wrapper below) is what
  // makes it viewport-relative; this just reads it back.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const h = entries[0]?.contentRect.height ?? DEFAULT_HEIGHT;
      if (h > 0) setHeight(h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<{
    svgX: number;
    sessionId: number;
    objectName: string;
    time: Date;
    alt: number;
    curveY: number;
  } | null>(null);

  // SVG width is responsive via viewBox; pick a logical width matching the
  // timeline pane's aspect. Higher numbers give more horizontal resolution
  // without affecting rendered size.
  const SVG_WIDTH = 1200;
  const plotLeft = PAD_LEFT;
  const plotRight = SVG_WIDTH - PAD_RIGHT;
  const plotTop = PAD_TOP;
  const plotBottom = height - PAD_BOTTOM;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;

  const totalNightMs = nightEnd.getTime() - nightStart.getTime();
  if (totalNightMs <= 0) return null;
  const timeToX = (t: Date) => {
    const ms = t.getTime() - nightStart.getTime();
    return plotLeft + (ms / totalNightMs) * plotWidth;
  };
  const altToY = (alt: number) => {
    const rangeSize = range.hi - range.lo;
    if (rangeSize === 0) return plotBottom - plotHeight / 2;
    const t = (alt - range.lo) / rangeSize;
    return plotBottom - t * plotHeight;
  };

  // Shared by the mouse-move and tap handlers below: finds the sample nearest
  // a given screen X and updates the crosshair, or clears it if that X isn't
  // over any plotted band.
  function updateHoverAtClientX(clientX: number) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    // viewBox is stretched (preserveAspectRatio=none) so X / Y scale
    // independently. Convert screen px → SVG user-space px.
    const svgX = ((clientX - rect.left) / rect.width) * SVG_WIDTH;
    if (svgX < plotLeft || svgX > plotRight) { setHover(null); return; }
    // Walk each session band and snap to the nearest sample inside it.
    for (const c of curves) {
      const xStart = timeToX(c.start);
      const xEnd = timeToX(c.end);
      if (svgX < xStart || svgX > xEnd) continue;
      // Linear-time nearest sample. Sample density is ~5 minutes;
      // O(n) per move is fine for the handful of bands a user plans.
      let best = c.samples[0];
      let bestDx = Infinity;
      for (const s of c.samples) {
        const dx = Math.abs(timeToX(s.time) - svgX);
        if (dx < bestDx) { bestDx = dx; best = s; }
      }
      if (best) {
        setHover({
          svgX: timeToX(best.time),
          sessionId: c.session.id,
          objectName: c.session.objectName,
          time: best.time,
          alt: best.alt,
          curveY: Math.max(plotTop, Math.min(plotBottom, altToY(best.alt))),
        });
      }
      return;
    }
    // Cursor between bands (in a gap) — clear hover so no stale crosshair lingers.
    setHover(null);
  }

  // Build hour ticks. Hour-tick set from scheduleGeometry to match the
  // timeline above (same observer-zone snapping).
  const ticks = hourTicks(nightStart, nightEnd, observerTimezone);

  // Y-axis tick lines at 10° intervals (clamped to range).
  const yTicks: number[] = [];
  for (let a = Math.ceil(range.lo / 10) * 10; a <= range.hi; a += 10) yTicks.push(a);

  // Every color on this chart is baked as a raw rgb() literal (not a Tailwind
  // class), so none of it is caught by .night's CSS variable overrides in
  // index.css — it has to branch on isNight directly, same as the twilight
  // gradient above.
  const axisColor = isNight ? 'rgb(153 42 42 / 0.22)' : 'rgb(255 255 255 / 0.22)';
  const gridColor = isNight ? 'rgb(153 42 42 / 0.10)' : 'rgb(255 255 255 / 0.10)';
  const textColor = isNight ? 'rgb(153 42 42 / 0.75)' : 'rgb(226 232 240 / 0.75)';
  const labelColor = isNight ? 'rgb(153 42 42 / 0.45)' : 'rgb(226 232 240 / 0.45)';
  const curveColor = isNight ? 'rgb(204 51 51)' : 'rgb(52 211 153)';     // emerald-400
  const minAltLineColor = isNight ? 'rgb(153 42 42 / 0.7)' : 'rgb(244 114 182 / 0.7)'; // pink-ish

  // Viewport-relative height: grows on tall screens, floored so it stays usable
  // on short ones. The measured value feeds the SVG's coordinate system above.
  // `background` carries the same twilight gradient as the timeline above, so
  // both branches below (empty and populated) paint it rather than falling
  // through to the parent panel's flat bg-slate-950.
  const wrapperStyle = { height: `clamp(${DEFAULT_HEIGHT}px, 12.5vh, 182px)`, background };

  if (sessions.length === 0) {
    // Same axis frame as the populated chart below, just with no curves to
    // plot — an empty grid reads as "nothing scheduled yet" the same way the
    // timeline above it reads as "an empty night." A flat unstyled box here
    // read as broken instead, especially once the schedule pane above it
    // stopped being the only dark thing on the page (see hero-panel).
    return (
      <div ref={wrapRef} className="relative shrink-0 border-t border-white/10" style={wrapperStyle}>
        <svg
          viewBox={`0 0 ${SVG_WIDTH} ${height}`}
          preserveAspectRatio="none"
          className="block h-full w-full"
          role="img"
          aria-label={t('altitudeBandChart.noTargetsAriaLabel')}
        >
          {yTicks.map(a => {
            const y = altToY(a);
            return (
              <g key={a}>
                <line
                  x1={plotLeft}
                  x2={plotRight}
                  y1={y}
                  y2={y}
                  stroke={gridColor}
                  strokeDasharray="3 4"
                  strokeWidth={1}
                />
                <text
                  x={plotLeft - 6}
                  y={y}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fontSize={11}
                  fill={labelColor}
                >
                  {a}°
                </text>
              </g>
            );
          })}
          {ticks.map((t, i) => {
            const x = timeToX(t);
            return (
              <g key={i}>
                <line x1={x} x2={x} y1={plotTop} y2={plotBottom} stroke={gridColor} strokeWidth={0.5} />
                <line x1={x} x2={x} y1={plotBottom} y2={plotBottom + 4} stroke={axisColor} strokeWidth={1} />
                <text x={x} y={plotBottom + 16} textAnchor="middle" fontSize={11} fill={textColor}>
                  {formatHm(t, observerTimezone)}
                </text>
              </g>
            );
          })}
          <rect
            x={plotLeft}
            y={plotTop}
            width={plotWidth}
            height={plotHeight}
            fill="none"
            stroke={axisColor}
            strokeWidth={1}
          />
        </svg>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4" style={{ paddingBottom: PAD_BOTTOM }}>
          <span className="rounded-full bg-slate-950/70 px-3 py-1.5 text-xs text-white/50 ring-1 ring-inset ring-white/10">
            {t('altitudeBandChart.emptyHint')}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={wrapRef}
      className="shrink-0 border-t border-white/10"
      style={wrapperStyle}
    >
      <svg
        ref={svgRef}
        viewBox={`0 0 ${SVG_WIDTH} ${height}`}
        preserveAspectRatio="none"
        className="block w-full h-full"
        role="img"
        aria-label={t('altitudeBandChart.ariaLabel')}
        onMouseMove={(e) => updateHoverAtClientX(e.clientX)}
        onMouseLeave={() => setHover(null)}
        // There is no hover on a touchscreen, so without this the altitude/time
        // readout this handler drives never appears on mobile at all. A tap
        // (not a drag) shows the reading at that point, same as a single mouse
        // move: touchmove was deliberately left unwired since preventing it
        // would fight the page's own scroll inside this scrollable modal.
        onTouchStart={(e) => { if (e.touches[0]) updateHoverAtClientX(e.touches[0].clientX); }}
      >
        {/* Y-axis labels and grid lines */}
        {yTicks.map(a => {
          const y = altToY(a);
          return (
            <g key={a}>
              <line
                x1={plotLeft}
                x2={plotRight}
                y1={y}
                y2={y}
                stroke={gridColor}
                strokeDasharray="3 4"
                strokeWidth={1}
              />
              <text
                x={plotLeft - 6}
                y={y}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize={11}
                fill={labelColor}
              >
                {a}°
              </text>
            </g>
          );
        })}

        {/* Min-alt horizon (from settings), if it falls in range */}
        {minAlt != null && minAlt <= range.hi && (
          <line
            x1={plotLeft}
            x2={plotRight}
            y1={altToY(minAlt)}
            y2={altToY(minAlt)}
            stroke={minAltLineColor}
            strokeDasharray="6 4"
            strokeWidth={1}
          />
        )}

        {/* X-axis hour ticks */}
        {ticks.map((t, i) => {
          const x = timeToX(t);
          return (
            <g key={i}>
              <line x1={x} x2={x} y1={plotTop} y2={plotBottom} stroke={gridColor} strokeWidth={0.5} />
              <line x1={x} x2={x} y1={plotBottom} y2={plotBottom + 4} stroke={axisColor} strokeWidth={1} />
              <text
                x={x}
                y={plotBottom + 16}
                textAnchor="middle"
                fontSize={11}
                fill={textColor}
              >
                {formatHm(t, observerTimezone)}
              </text>
            </g>
          );
        })}

        {/* Plot frame */}
        <rect
          x={plotLeft}
          y={plotTop}
          width={plotWidth}
          height={plotHeight}
          fill="none"
          stroke={axisColor}
          strokeWidth={1}
        />

        {/* Each scheduled block: vertical separator + altitude curve + label */}
        {curves.map(({ session, start, end, samples }) => {
          const xStart = timeToX(start);
          const xEnd = timeToX(end);
          // Curve path. Build from samples but clip Y to plot bounds.
          const pts = samples
            .map(s => `${timeToX(s.time).toFixed(2)},${Math.max(plotTop, Math.min(plotBottom, altToY(s.alt))).toFixed(2)}`)
            .join(' ');
          return (
            <g key={session.id}>
              {/* Subtle band background to delimit this block on the chart */}
              <rect
                x={xStart}
                y={plotTop}
                width={Math.max(0, xEnd - xStart)}
                height={plotHeight}
                fill={isNight ? 'rgb(102 26 26 / 0.10)' : 'rgb(16 185 129 / 0.07)'}
              />
              <line x1={xStart} x2={xStart} y1={plotTop} y2={plotBottom} stroke={axisColor} strokeWidth={1} />
              <line x1={xEnd} x2={xEnd} y1={plotTop} y2={plotBottom} stroke={axisColor} strokeWidth={1} />
              <polyline
                points={pts}
                fill="none"
                stroke={curveColor}
                strokeWidth={1.75}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {/* Object name inside its own band, low where the curves rarely go and
                  trimmed to the band's width. A dark halo keeps it readable if a
                  curve does cross it. */}
              {(() => {
                const maxChars = Math.floor((xEnd - xStart - LABEL_PAD * 2) / LABEL_CHAR_WIDTH);
                if (maxChars < 3) return null;
                const name = session.objectName;
                const label = name.length > maxChars ? `${name.slice(0, maxChars - 1).trimEnd()}…` : name;
                return (
                  <text
                    x={(xStart + xEnd) / 2}
                    y={plotBottom - 14}
                    textAnchor="middle"
                    fontSize={11}
                    fontWeight={500}
                    fill={textColor}
                    stroke={isNight ? 'rgb(0 0 0 / 0.6)' : 'rgb(2 6 23 / 0.7)'}
                    strokeWidth={3}
                    paintOrder="stroke"
                    strokeLinejoin="round"
                  >
                    {label}
                  </text>
                );
              })()}
            </g>
          );
        })}

        {/* Hover crosshair + tooltip */}
        {hover && (
          <HoverOverlay
            svgWidth={SVG_WIDTH}
            x={hover.svgX}
            curveY={hover.curveY}
            plotTop={plotTop}
            plotBottom={plotBottom}
            objectName={hover.objectName}
            time={hover.time}
            alt={hover.alt}
            axisColor={axisColor}
            timeZone={observerTimezone}
            isNight={isNight}
          />
        )}
      </svg>
    </div>
  );
}

interface HoverOverlayProps {
  svgWidth: number;
  x: number;
  curveY: number;
  plotTop: number;
  plotBottom: number;
  objectName: string;
  time: Date;
  alt: number;
  axisColor: string;
  timeZone?: string;
  isNight: boolean;
}

function HoverOverlay({
  svgWidth,
  x,
  curveY,
  plotTop,
  plotBottom,
  objectName,
  time,
  alt,
  axisColor,
  timeZone,
  isNight,
}: HoverOverlayProps) {
  const { t } = useTranslation('planner');
  // Tooltip box: pick a side that keeps the box inside the plot. Width is a
  // generous estimate so single-line copy ("M 81 · 02:35 · 47°") never overflows.
  const tooltipWidth = 150;
  const tooltipHeight = 36;
  const margin = 8;
  const placeRight = x + margin + tooltipWidth <= svgWidth - 4;
  const tooltipX = placeRight ? x + margin : x - margin - tooltipWidth;
  const tooltipY = Math.max(plotTop + 2, Math.min(plotBottom - tooltipHeight - 2, curveY - tooltipHeight / 2));

  const bg = isNight ? 'rgb(0 0 0 / 0.95)' : 'rgb(2 6 23 / 0.95)';
  const border = isNight ? 'rgb(153 42 42 / 0.18)' : 'rgb(255 255 255 / 0.18)';
  const headColor = isNight ? 'rgb(204 51 51)' : 'rgb(241 245 249)';
  const subColor = isNight ? 'rgb(136 34 34)' : 'rgb(148 163 184)';
  const dotColor = isNight ? 'rgb(204 51 51)' : 'rgb(52 211 153)';
  const dotRing = isNight ? 'rgb(0 0 0)' : 'rgb(2 6 23)';

  const timeLabel = formatHm(time, timeZone);

  return (
    <g pointerEvents="none">
      {/* Vertical guide line */}
      <line x1={x} x2={x} y1={plotTop} y2={plotBottom} stroke={axisColor} strokeDasharray="4 3" strokeWidth={1} />
      {/* Marker dot on the curve */}
      <circle cx={x} cy={curveY} r={5} fill={dotRing} />
      <circle cx={x} cy={curveY} r={3.5} fill={dotColor} />
      {/* Tooltip */}
      <rect x={tooltipX} y={tooltipY} width={tooltipWidth} height={tooltipHeight} rx={6} ry={6} fill={bg} stroke={border} strokeWidth={1} />
      <text x={tooltipX + 8} y={tooltipY + 14} fontSize={11} fontWeight={600} fill={headColor}>
        {objectName}
      </text>
      <text x={tooltipX + 8} y={tooltipY + 28} fontSize={11} fill={subColor}>
        {t('altitudeBandChart.timeAltitude', { time: timeLabel, alt: Math.round(alt) })}
      </text>
    </g>
  );
}
