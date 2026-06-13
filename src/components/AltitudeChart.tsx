import { useMemo, useState, useCallback } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { computeAltitudeCurve, buildTonightWindow } from '../lib/altaz';

interface AltitudeChartProps {
  /** RA in decimal hours */
  ra: number;
  /** Dec in decimal degrees */
  dec: number;
  /** Observer latitude in decimal degrees */
  lat: number;
  /** Observer longitude in decimal degrees, east positive */
  lon: number;
  /** Minimum altitude line (degrees). Pulled from user settings. */
  minAlt?: number;
  isDark: boolean;
  /**
   * Fired while the user scrubs the curve, with the time/alt/az under the
   * cursor (or null when the pointer leaves). Lets a parent sync another view
   * — e.g. rotate a sky preview to the scrubbed moment — to the chart.
   */
  onScrub?: (point: { time: Date; alt: number; az: number } | null) => void;
}

/**
 * Compact 24-hour altitude chart for a fixed sky object.
 *
 * Computes altitude at 15-minute intervals across tonight's local noon-to-noon
 * window entirely client-side — no server round-trip. Renders as an SVG curve
 * with fixed 4-hour tick labels (12, 16, 20, 00, 04, 08, 12) and a marker
 * showing the object's current position.
 */
export function AltitudeChart({ ra, dec, lat, lon, minAlt, isDark, onScrub }: AltitudeChartProps) {
  const { samples, start, end } = useMemo(() => {
    const { start, end } = buildTonightWindow();
    const samples = computeAltitudeCurve(ra, dec, lat, lon, start, end, 15);
    return { samples, start, end };
  }, [ra, dec, lat, lon]);

  const { pathD, currentPoint } = useMemo(() => {
    const startMs = start.getTime();
    const spanMs = end.getTime() - startMs;

    // Normalize samples — allow negative y so below-horizon portions flow
    // smoothly through the Catmull-Rom spline without distorting the curve.
    // The SVG clips anything outside the viewBox.
    const points = samples.map(s => ({
      x: (s.time.getTime() - startMs) / spanMs,
      y: s.alt / 90,
      alt: s.alt,
      az: s.az,
    }));

    const path = buildSmoothPath(points);

    const nowMs = Date.now();
    const tNow = (nowMs - startMs) / spanMs;
    let current: { x: number; y: number; alt: number; az: number } | null = null;
    if (tNow >= 0 && tNow <= 1 && points.length > 0) {
      // Linear interpolation between the two bracketing samples for a smooth dot
      const idxF = tNow * (points.length - 1);
      const i0 = Math.floor(idxF);
      const i1 = Math.min(points.length - 1, i0 + 1);
      const f = idxF - i0;
      const p0 = points[i0];
      const p1 = points[i1];
      let dAzNow = p1.az - p0.az;
      if (dAzNow > 180) dAzNow -= 360;
      if (dAzNow < -180) dAzNow += 360;
      current = {
        x: tNow,
        y: p0.y + (p1.y - p0.y) * f,
        alt: p0.alt + (p1.alt - p0.alt) * f,
        az: ((p0.az + dAzNow * f) % 360 + 360) % 360,
      };
    }

    return { pathD: path, currentPoint: current };
  }, [samples, start, end]);

  // Fixed chart geometry — not stretched across full width
  const W = 560;
  const H = 160;
  const padL = 10;
  const padR = 30;
  const padT = 10;
  const padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const xToPx = (x: number) => padL + x * plotW;
  const yToPx = (y: number) => padT + (1 - y) * plotH;

  const gridColor = isDark ? 'rgba(148,163,184,0.10)' : 'rgba(100,116,139,0.14)';
  const axisLabelColor = isDark ? '#64748b' : '#94a3b8';
  const curveColor = isDark ? '#e2e8f0' : '#475569';
  const dotFill = isDark ? '#ffffff' : '#0f172a';
  const dotStroke = isDark ? '#0f172a' : '#ffffff';

  // Fixed 4-hour ticks — start is local noon, so offsets of 0/4/8/12/16/20/24
  // produce the hour labels 12, 16, 20, 00, 04, 08, 12.
  const TICKS = [
    { t: 0 / 24, label: '12' },
    { t: 4 / 24, label: '16' },
    { t: 8 / 24, label: '20' },
    { t: 12 / 24, label: '00' },
    { t: 16 / 24, label: '04' },
    { t: 20 / 24, label: '08' },
    { t: 24 / 24, label: '12' },
  ];

  // Hover state — set by pointer move/click on the chart
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    alt: number;
    az: number;
    time: Date;
  } | null>(null);

  /**
   * Compute a scrubbed point at normalized [0..1] t across the window,
   * linearly interpolating between the two bracketing 15-min samples.
   */
  const interpAt = useCallback(
    (t: number) => {
      const clamped = Math.max(0, Math.min(1, t));
      const idxF = clamped * (samples.length - 1);
      const i0 = Math.floor(idxF);
      const i1 = Math.min(samples.length - 1, i0 + 1);
      const f = idxF - i0;
      const s0 = samples[i0];
      const s1 = samples[i1];
      const alt = s0.alt + (s1.alt - s0.alt) * f;
      // Azimuth wraps 0↔360 — interpolate on the shorter arc
      let dAz = s1.az - s0.az;
      if (dAz > 180) dAz -= 360;
      if (dAz < -180) dAz += 360;
      const az = ((s0.az + dAz * f) % 360 + 360) % 360;
      const timeMs = s0.time.getTime() + (s1.time.getTime() - s0.time.getTime()) * f;
      return {
        x: clamped,
        y: alt / 90,
        alt,
        az,
        time: new Date(timeMs),
      };
    },
    [samples],
  );

  const handlePointer = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      // Map client X to viewBox X (SVG scales to container)
      const vbX = ((e.clientX - rect.left) / rect.width) * W;
      const clampedVbX = Math.max(padL, Math.min(W - padR, vbX));
      const t = (clampedVbX - padL) / plotW;
      const point = interpAt(t);
      setHover(point);
      onScrub?.({ time: point.time, alt: point.alt, az: point.az });
    },
    [interpAt, padL, plotW, onScrub],
  );

  const handleLeave = useCallback(() => {
    setHover(null);
    onScrub?.(null);
  }, [onScrub]);

  // The "active" point drives the header and the big marker.
  // Hover takes precedence over the real-time "now" position.
  const activePoint = hover ?? currentPoint;
  const headerAlt = activePoint ? Math.round(activePoint.alt) : 0;
  const headerDir = activePoint ? azToCompass(activePoint.az) : '';
  const headerLabel = hover
    ? hover.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
    : currentPoint
      ? 'Current Altitude'
      : '';

  if (samples.length === 0) return null;

  return (
    <div
      className={`rounded-xl border max-w-xl ${
        isDark ? 'bg-slate-900/40 border-slate-800' : 'bg-slate-50/80 border-slate-200'
      }`}
    >
      {/* Header — shows hovered point when scrubbing, otherwise live "now" */}
      <div className="flex items-start justify-between px-4 pt-3 pb-2">
        <div>
          <div className={`text-2xl font-bold leading-none tabular-nums ${isDark ? 'text-white' : 'text-slate-900'}`}>
            {headerAlt}°
          </div>
          <div className={`text-[11px] mt-1 tabular-nums ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {headerLabel}
          </div>
        </div>
        {headerDir && (
          <div className={`text-sm font-semibold tracking-wide ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
            {headerDir}
          </div>
        )}
      </div>

      {/* Chart */}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        className="w-full cursor-crosshair touch-none overflow-hidden"
        style={{ display: 'block' }}
        onPointerMove={handlePointer}
        onPointerDown={handlePointer}
        onPointerLeave={handleLeave}
        onPointerCancel={handleLeave}
      >
        {/* Horizontal grid at 0°, 30°, 60°, 90° */}
        {[0, 30, 60, 90].map(deg => {
          const y = yToPx(deg / 90);
          return (
            <g key={deg}>
              <line
                x1={padL}
                x2={W - padR}
                y1={y}
                y2={y}
                stroke={gridColor}
                strokeWidth={1}
                strokeDasharray={deg === 0 ? 'none' : '3 3'}
              />
              <text
                x={W - padR + 4}
                y={y + 3}
                fontSize={9}
                fill={axisLabelColor}
                fontFamily="system-ui, sans-serif"
              >
                {deg}°
              </text>
            </g>
          );
        })}

        {/* Minimum altitude threshold (user setting) */}
        {minAlt != null && minAlt > 0 && minAlt < 90 && (
          <line
            x1={padL}
            x2={W - padR}
            y1={yToPx(minAlt / 90)}
            y2={yToPx(minAlt / 90)}
            stroke={isDark ? 'rgba(251,146,60,0.4)' : 'rgba(251,146,60,0.55)'}
            strokeWidth={1}
            strokeDasharray="4 4"
          />
        )}

        {/* Fixed hour ticks */}
        {TICKS.map((tick, i) => (
          <text
            key={i}
            x={xToPx(tick.t)}
            y={H - 6}
            fontSize={9}
            fill={axisLabelColor}
            textAnchor={i === 0 ? 'start' : i === TICKS.length - 1 ? 'end' : 'middle'}
            fontFamily="system-ui, sans-serif"
          >
            {tick.label}
          </text>
        ))}

        {/* Altitude curve */}
        <path
          d={transformPath(pathD, xToPx, yToPx)}
          fill="none"
          stroke={curveColor}
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Real-time "now" marker — dim, stays put even while scrubbing */}
        {currentPoint && hover && (
          <circle
            cx={xToPx(currentPoint.x)}
            cy={yToPx(currentPoint.y)}
            r={3}
            fill={isDark ? 'rgba(226,232,240,0.4)' : 'rgba(71,85,105,0.4)'}
          />
        )}

        {/* Active marker — follows the cursor while hovering, else sits at "now" */}
        {activePoint && (
          <g>
            <line
              x1={xToPx(activePoint.x)}
              x2={xToPx(activePoint.x)}
              y1={padT}
              y2={H - padB}
              stroke={isDark ? 'rgba(226,232,240,0.35)' : 'rgba(71,85,105,0.35)'}
              strokeWidth={1}
            />
            <circle
              cx={xToPx(activePoint.x)}
              cy={yToPx(activePoint.y)}
              r={4.5}
              fill={dotFill}
              stroke={dotStroke}
              strokeWidth={1.5}
            />
          </g>
        )}
      </svg>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Smooth cubic-Bezier path through normalized points using a Catmull-Rom-to-
 * Bezier conversion. Tension 0.5 gives a soft, slightly taut curve that
 * reads naturally for altitude-over-time without overshoot.
 */
function buildSmoothPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;

  const tension = 0.5;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;

    const c1x = p1.x + ((p2.x - p0.x) / 6) * tension;
    const c1y = p1.y + ((p2.y - p0.y) / 6) * tension;
    const c2x = p2.x - ((p3.x - p1.x) / 6) * tension;
    const c2y = p2.y - ((p3.y - p1.y) / 6) * tension;

    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

/** Remap an SVG path from normalized [0..1] coordinates into pixel space. */
function transformPath(
  d: string,
  xToPx: (x: number) => number,
  yToPx: (y: number) => number,
): string {
  let isX = true;
  return d.replace(/-?\d*\.?\d+/g, match => {
    const v = parseFloat(match);
    const out = isX ? xToPx(v) : yToPx(v);
    isX = !isX;
    return out.toFixed(1);
  });
}

function azToCompass(az: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const idx = Math.round((az % 360) / 45) % 8;
  return dirs[idx];
}
