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
import { useTheme } from '../../hooks/useTheme';
import { computeAltitudeCurve } from '../../lib/altaz';
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
}

// Default / minimum chart height. The rendered height is measured at runtime
// (see DEFAULT_HEIGHT usage) so the chart grows on tall screens; this value is
// the floor and the pre-measurement fallback.
const DEFAULT_HEIGHT = 160;
const PAD_LEFT = 36;
const PAD_RIGHT = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 28;     // room for hour ticks
const LABEL_BAND_HEIGHT = 18; // strip below the plot for object names

// Auto-range altitude: cover the full plotted set, but never tighter than
// a 30° window so single-target plots don't look distorted.
function altRange(curves: Array<{ alt: number }[]>): { lo: number; hi: number } {
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
}: AltitudeBandChartProps) {
  const { isDark } = useTheme();

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

  const range = useMemo(() => altRange(curves.map(c => c.samples)), [curves]);

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
  const plotBottom = height - PAD_BOTTOM - LABEL_BAND_HEIGHT;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;

  const totalNightMs = nightEnd.getTime() - nightStart.getTime();
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

  // Build hour ticks. Hour-tick set from scheduleGeometry to match the
  // timeline above (same observer-zone snapping).
  const ticks = hourTicks(nightStart, nightEnd, observerTimezone);

  // Y-axis tick lines at 10° intervals (clamped to range).
  const yTicks: number[] = [];
  for (let a = Math.ceil(range.lo / 10) * 10; a <= range.hi; a += 10) yTicks.push(a);

  const axisColor = isDark ? 'rgb(71 85 105)' : 'rgb(148 163 184)';
  const gridColor = isDark ? 'rgb(51 65 85 / 0.6)' : 'rgb(203 213 225 / 0.6)';
  const textColor = isDark ? 'rgb(203 213 225)' : 'rgb(51 65 85)';
  const labelColor = isDark ? 'rgb(148 163 184)' : 'rgb(100 116 139)';
  const curveColor = 'rgb(52 211 153)';     // emerald-400
  const minAltLineColor = 'rgb(244 114 182 / 0.7)'; // pink-ish

  // Viewport-relative height: grows on tall screens, floored so it stays usable
  // on short ones. The measured value feeds the SVG's coordinate system above.
  const wrapperStyle = { height: `clamp(${DEFAULT_HEIGHT}px, 22vh, 380px)` };

  if (sessions.length === 0) {
    return (
      <div
        ref={wrapRef}
        className={`shrink-0 flex items-center justify-center px-4 py-3 border-t ${isDark ? 'border-slate-800 bg-slate-950/40 text-slate-500' : 'border-slate-200 bg-slate-50 text-slate-500'}`}
        style={wrapperStyle}
      >
        <span className="text-xs">Drag targets from the library onto the timeline to see their altitude curves here.</span>
      </div>
    );
  }

  return (
    <div
      ref={wrapRef}
      className={`shrink-0 border-t ${isDark ? 'border-slate-800 bg-slate-950/40' : 'border-slate-200 bg-slate-50'}`}
      style={wrapperStyle}
    >
      <svg
        ref={svgRef}
        viewBox={`0 0 ${SVG_WIDTH} ${height}`}
        preserveAspectRatio="none"
        className="block w-full h-full"
        role="img"
        aria-label="Altitude of each scheduled object over time"
        onMouseMove={(e) => {
          const svg = svgRef.current;
          if (!svg) return;
          const rect = svg.getBoundingClientRect();
          // viewBox is stretched (preserveAspectRatio=none) so X / Y scale
          // independently. Convert screen px → SVG user-space px.
          const svgX = ((e.clientX - rect.left) / rect.width) * SVG_WIDTH;
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
        }}
        onMouseLeave={() => setHover(null)}
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
        {minAlt != null && minAlt >= range.lo && minAlt <= range.hi && (
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
                fill={isDark ? 'rgb(16 185 129 / 0.05)' : 'rgb(16 185 129 / 0.07)'}
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
              {/* Object name centered under the band */}
              <text
                x={(xStart + xEnd) / 2}
                y={height - 8}
                textAnchor="middle"
                fontSize={11}
                fontWeight={500}
                fill={textColor}
              >
                {session.objectName}
              </text>
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
            isDark={isDark}
            axisColor={axisColor}
            timeZone={observerTimezone}
          />
        )}
      </svg>
    </div>
  );
}

export const ALTITUDE_BAND_CHART_HEIGHT = DEFAULT_HEIGHT;

interface HoverOverlayProps {
  svgWidth: number;
  x: number;
  curveY: number;
  plotTop: number;
  plotBottom: number;
  objectName: string;
  time: Date;
  alt: number;
  isDark: boolean;
  axisColor: string;
  timeZone?: string;
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
  isDark,
  axisColor,
  timeZone,
}: HoverOverlayProps) {
  // Tooltip box: pick a side that keeps the box inside the plot. Width is a
  // generous estimate so single-line copy ("M 81 · 02:35 · 47°") never overflows.
  const tooltipWidth = 150;
  const tooltipHeight = 36;
  const margin = 8;
  const placeRight = x + margin + tooltipWidth <= svgWidth - 4;
  const tooltipX = placeRight ? x + margin : x - margin - tooltipWidth;
  const tooltipY = Math.max(plotTop + 2, Math.min(plotBottom - tooltipHeight - 2, curveY - tooltipHeight / 2));

  const bg = isDark ? 'rgb(15 23 42 / 0.95)' : 'rgb(255 255 255 / 0.95)';
  const border = isDark ? 'rgb(71 85 105)' : 'rgb(203 213 225)';
  const headColor = isDark ? 'rgb(241 245 249)' : 'rgb(15 23 42)';
  const subColor = isDark ? 'rgb(148 163 184)' : 'rgb(71 85 105)';
  const dotColor = 'rgb(52 211 153)';
  const dotRing = isDark ? 'rgb(15 23 42)' : 'rgb(255 255 255)';

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
        {timeLabel} · {Math.round(alt)}° altitude
      </text>
    </g>
  );
}
