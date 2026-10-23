/**
 * Planetarium-style finder chart for a planner target: a view looking toward
 * the object's compass direction at a given moment, with the horizon along the
 * bottom, cardinal markers, surrounding constellations and naked-eye stars, and
 * a reticle where the object sits. It answers "where in my sky is this, and
 * what's around it" rather than "what does the object look like".
 *
 * Rendered on a canvas (thousands of stars redrawn smoothly while scrubbing
 * time) using a simple horizon-centered cylindrical projection: the chart is
 * centered horizontally on the object's azimuth, x is the azimuth offset and y
 * is altitude, so the horizon is a straight line and the object stays centered.
 */
import { useEffect, useMemo, useRef } from 'react';
import SunCalc from 'suncalc';
import { useTranslation } from 'react-i18next';
import { altAz } from '../../lib/altaz';
import { useTheme } from '../../hooks/useTheme';
import { moonThresholdForIllumination } from '../../lib/moonProximity';
import {
  SKY_STARS,
  SKY_CONSTELLATION_LINES,
  SKY_CONSTELLATION_LABELS,
} from '../../data/skyChartData';

interface SkyChartProps {
  objectName: string;
  /** RA in decimal hours */
  ra: number;
  /** Dec in decimal degrees */
  dec: number;
  lat: number;
  lon: number;
  time: Date;
  isDark: boolean;
}

/** Horizontal field of view in degrees (full width). */
const HFOV = 95;
/** Fraction of the canvas height where the horizon sits (rest below is ground). */
const HORIZON_FRAC = 0.82;

const CARDINALS: { az: number; key: string }[] = [
  { az: 0, key: 'n' }, { az: 45, key: 'ne' }, { az: 90, key: 'e' },
  { az: 135, key: 'se' }, { az: 180, key: 's' }, { az: 225, key: 'sw' },
  { az: 270, key: 'w' }, { az: 315, key: 'nw' },
];

/** Shortest signed angular difference a-b in degrees, range (-180, 180]. */
function angleDiff(a: number, b: number): number {
  let d = ((a - b + 180) % 360 + 360) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

const COMPASS_KEYS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

function azToCompass(az: number, t: TFunc): string {
  const key = COMPASS_KEYS[Math.round((az % 360) / 45) % 8];
  return t(`compass8.${key}`, { ns: 'common' });
}

/** Angular separation (degrees) between two alt/az points. */
function separationDeg(alt1: number, az1: number, alt2: number, az2: number): number {
  const D = Math.PI / 180;
  const c =
    Math.sin(alt1 * D) * Math.sin(alt2 * D) +
    Math.cos(alt1 * D) * Math.cos(alt2 * D) * Math.cos((az1 - az2) * D);
  return Math.acos(Math.max(-1, Math.min(1, c))) / D;
}

/**
 * Draw a Moon glyph with phase shading at (mx, my), radius R. `fraction` is the
 * illuminated fraction (0-1), `phase` is SunCalc's 0-1 phase (0 new, 0.5 full).
 * The lit area is bounded by the lit limb (a semicircle) and the terminator (a
 * half-ellipse whose width tracks the phase). Waning phases mirror horizontally.
 * Orientation of the bright limb isn't modeled — at finder-chart scale only the
 * crescent/gibbous read matters.
 */
function drawMoonGlyph(
  ctx: CanvasRenderingContext2D,
  mx: number,
  my: number,
  R: number,
  fraction: number,
  phase: number,
  isDark: boolean,
  isNight: boolean,
) {
  const lit = isNight ? '#cc3333' : '#eef2f8';
  const dark = isNight ? 'rgba(0,0,0,0.92)' : isDark ? 'rgba(15,23,42,0.92)' : 'rgba(51,65,85,0.9)';

  ctx.save();
  ctx.translate(mx, my);

  // Soft glow scaled by how lit the Moon is — it's the brightest thing up there.
  const glow = ctx.createRadialGradient(0, 0, R, 0, 0, R * 2.6);
  glow.addColorStop(0, isNight ? `rgba(204,51,51,${0.18 + 0.22 * fraction})` : `rgba(226,232,240,${0.18 + 0.22 * fraction})`);
  glow.addColorStop(1, isNight ? 'rgba(204,51,51,0)' : 'rgba(226,232,240,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 0, R * 2.6, 0, Math.PI * 2);
  ctx.fill();

  // Dark base disc, then the lit lune on top.
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.fillStyle = dark;
  ctx.fill();

  const waning = phase > 0.5;
  if (waning) ctx.scale(-1, 1); // draw as if lit-on-right, mirror for waning
  const c = 2 * Math.max(0, Math.min(1, fraction)) - 1; // -1 new .. +1 full
  ctx.beginPath();
  ctx.arc(0, 0, R, -Math.PI / 2, Math.PI / 2, false);                  // lit limb (right)
  ctx.ellipse(0, 0, R * Math.abs(c), R, 0, Math.PI / 2, -Math.PI / 2, c > 0 ? false : true); // terminator
  ctx.closePath();
  ctx.fillStyle = lit;
  ctx.fill();

  ctx.restore();

  // Outline so the full disc always reads, even at new moon.
  ctx.beginPath();
  ctx.arc(mx, my, R, 0, Math.PI * 2);
  ctx.strokeStyle = isNight ? 'rgba(153,42,42,0.6)' : 'rgba(203,213,225,0.6)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

export function SkyChart({ objectName, ra, dec, lat, lon, time, isDark }: SkyChartProps) {
  const { t } = useTranslation('planner');
  const { isNight } = useTheme();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Target alt/az drives the view center. Recomputed when time scrubs.
  const target = useMemo(() => altAz(ra, dec, lat, lon, time), [ra, dec, lat, lon, time]);

  // Moon position + phase via SunCalc (already a project dependency). SunCalc
  // measures azimuth from south, so add 180° to match this chart's from-north
  // convention. Recomputed on every scrub, so the Moon drifts as time changes.
  const moon = useMemo(() => {
    const pos = SunCalc.getMoonPosition(time, lat, lon);
    const illum = SunCalc.getMoonIllumination(time);
    return {
      alt: (pos.altitude * 180) / Math.PI,
      az: ((180 + (pos.azimuth * 180) / Math.PI) % 360 + 360) % 360,
      fraction: illum.fraction,
      phase: illum.phase,
    };
  }, [time, lat, lon]);

  // Separation from the target, and the phase-scaled "too close" threshold
  // (same heuristic the planner uses for moon-proximity warnings).
  const moonSeparation = separationDeg(target.alt, target.az, moon.alt, moon.az);
  const moonThreshold = moonThresholdForIllumination(moon.fraction * 100);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const draw = () => {
      const cssW = wrap.clientWidth;
      const cssH = wrap.clientHeight;
      if (cssW === 0 || cssH === 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const W = cssW;
      const H = cssH;
      const cx = W / 2;
      const horizonY = H * HORIZON_FRAC;
      // Zoom out just enough to keep a high target on the picture: at a fixed
      // scale a target past ~70° altitude sat on or above the top edge.
      const roomAbove = horizonY - H * 0.12;
      const pxPerDeg = target.alt > 0 ? Math.min(W / HFOV, roomAbove / target.alt) : W / HFOV;
      const hfov = W / pxPerDeg;
      const centerAz = target.az;

      // Map an (alt, az) sky point to canvas coords in this projection.
      const project = (alt: number, az: number) => ({
        x: cx + angleDiff(az, centerAz) * pxPerDeg,
        y: horizonY - alt * pxPerDeg,
      });

      // ── Sky + ground background ──
      const skyGrad = ctx.createLinearGradient(0, 0, 0, horizonY);
      if (isNight) {
        skyGrad.addColorStop(0, '#0a0000');
        skyGrad.addColorStop(1, '#1a0505');
      } else if (isDark) {
        skyGrad.addColorStop(0, '#0a1326');
        skyGrad.addColorStop(1, '#142544');
      } else {
        skyGrad.addColorStop(0, '#1e293b');
        skyGrad.addColorStop(1, '#334155');
      }
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, W, horizonY);
      ctx.fillStyle = isNight ? '#000000' : isDark ? '#0a0f0a' : '#14210f';
      ctx.fillRect(0, horizonY, W, H - horizonY);

      // ── Altitude gridlines (30°, 60°) ──
      ctx.strokeStyle = isNight ? 'rgba(153,42,42,0.16)' : 'rgba(148,163,184,0.16)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      for (const a of [30, 60]) {
        const y = horizonY - a * pxPerDeg;
        if (y < 0) continue;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
        ctx.fillStyle = isNight ? 'rgba(153,42,42,0.55)' : 'rgba(148,163,184,0.55)';
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillText(`${a}°`, 4, y - 3);
      }
      ctx.setLineDash([]);

      // ── Constellation lines ──
      ctx.strokeStyle = isNight ? 'rgba(153,42,42,0.35)' : isDark ? 'rgba(96,165,250,0.40)' : 'rgba(125,211,252,0.45)';
      ctx.lineWidth = 1;
      for (const line of SKY_CONSTELLATION_LINES) {
        for (let i = 0; i + 3 < line.length; i += 2) {
          const aRa = line[i], aDec = line[i + 1];
          const bRa = line[i + 2], bDec = line[i + 3];
          const A = altAz(aRa / 15, aDec, lat, lon, time);
          const B = altAz(bRa / 15, bDec, lat, lon, time);
          // Skip segments to the side/behind the viewer or well below horizon.
          if (Math.abs(angleDiff(A.az, centerAz)) > 85 || Math.abs(angleDiff(B.az, centerAz)) > 85) continue;
          if (A.alt < -4 && B.alt < -4) continue;
          const pa = project(A.alt, A.az);
          const pb = project(B.alt, B.az);
          ctx.beginPath();
          ctx.moveTo(pa.x, pa.y);
          ctx.lineTo(pb.x, pb.y);
          ctx.stroke();
        }
      }

      // ── Stars ──
      const half = hfov / 2 + 6;
      for (const [sRa, sDec, mag] of SKY_STARS) {
        const { alt, az } = altAz(sRa / 15, sDec, lat, lon, time);
        if (alt < -2) continue;
        const daz = angleDiff(az, centerAz);
        if (Math.abs(daz) > half) continue;
        const x = cx + daz * pxPerDeg;
        const y = horizonY - alt * pxPerDeg;
        const r = Math.max(0.6, 2.7 - 0.42 * mag);
        const alpha = Math.max(0.35, Math.min(1, 1.15 - mag * 0.12));
        ctx.beginPath();
        ctx.fillStyle = isNight ? `rgba(204,51,51,${alpha})` : isDark ? `rgba(255,255,255,${alpha})` : `rgba(241,245,249,${alpha})`;
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Where the moon sits, and what its label says. Worked out here because
      // the constellation names below must keep clear of it.
      const dazMoon = angleDiff(moon.az, centerAz);
      // A moon past the edge is pinned to that edge with an arrow, so it can be
      // found rather than looked for.
      const moonOffscreen = Math.abs(dazMoon) > hfov / 2;
      const moonEdge = 28;
      const moonAt = moon.alt > -1 && (!moonOffscreen || moon.alt > 0)
        ? {
            x: moonOffscreen ? (dazMoon > 0 ? W - moonEdge : moonEdge) : cx + dazMoon * pxPerDeg,
            y: Math.max(moonEdge, horizonY - moon.alt * pxPerDeg),
          }
        : null;
      const moonTooClose = moonSeparation < moonThreshold;
      const moonLabel = moonTooClose ? `${t('skyChart.moon')} · ${Math.round(moonSeparation)}°` : t('skyChart.moon');

      // Boxes the constellation names must stay clear of: the target's ring and
      // name, the moon's glyph and label, and each name already placed.
      type Box = { x0: number; y0: number; x1: number; y1: number };
      const taken: Box[] = [];
      const addBox = (x0: number, y0: number, x1: number, y1: number) => taken.push({ x0: x0 - 3, y0: y0 - 3, x1: x1 + 3, y1: y1 + 3 });
      const overlaps = (b: Box) => taken.some(o => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
      {
        const rt = project(target.alt, target.az);
        ctx.font = 'bold 11px system-ui, sans-serif';
        const half = ctx.measureText(objectName).width / 2;
        const nx = Math.min(W - 4 - half, Math.max(4 + half, rt.x));
        const ny = rt.y < 28 ? rt.y + 26 : rt.y - 16;
        addBox(nx - half, ny - 11, nx + half, ny + 3);
        addBox(rt.x - 16, rt.y - 16, rt.x + 16, rt.y + 16);
        if (moonAt) {
          ctx.font = `${moonTooClose ? 'bold ' : ''}10px system-ui, sans-serif`;
          const mhalf = ctx.measureText(moonLabel).width / 2;
          addBox(moonAt.x - 13, moonAt.y - 13, moonAt.x + 13, moonAt.y + 13);
          addBox(moonAt.x - mhalf, moonAt.y + 14, moonAt.x + mhalf, moonAt.y + 27);
        }
      }

      // ── Constellation labels (prominent ones only) ──
      // Most prominent first, so when two names collide the lesser one is the
      // one dropped.
      ctx.fillStyle = isNight ? 'rgba(153,42,42,0.55)' : isDark ? 'rgba(148,163,184,0.55)' : 'rgba(203,213,225,0.7)';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      const prominent = SKY_CONSTELLATION_LABELS.filter(c => c.rank <= 2).sort((p, q) => p.rank - q.rank);
      for (const c of prominent) {
        const { alt, az } = altAz(c.ra / 15, c.dec, lat, lon, time);
        if (alt < 3) continue;
        const daz = angleDiff(az, centerAz);
        if (Math.abs(daz) > hfov / 2 - 4) continue;
        const label = c.name.toUpperCase();
        const lx = cx + daz * pxPerDeg;
        const ly = horizonY - alt * pxPerDeg;
        // A label cut off at the edge ("SSIOPEIA") reads worse than none.
        const half = ctx.measureText(label).width / 2;
        if (lx - half < 4 || lx + half > W - 4) continue;
        const box = { x0: lx - half, y0: ly - 9, x1: lx + half, y1: ly + 3 };
        if (overlaps({ x0: box.x0 - 3, y0: box.y0 - 3, x1: box.x1 + 3, y1: box.y1 + 3 })) continue;
        ctx.fillText(label, lx, ly);
        addBox(box.x0, box.y0, box.x1, box.y1);
      }
      ctx.textAlign = 'left';

      // ── Moon (position + phase) ──
      if (moonAt) {
        const mx = moonAt.x;
        const my = moonAt.y;
        // Real Moon is ~0.5°, a sub-pixel dot at this FOV — draw it exaggerated
        // so the phase is legible, like other finder charts do.
        drawMoonGlyph(ctx, mx, my, 11, moon.fraction, moon.phase, isDark, isNight);
        // The separation is said on the moon itself, and only when it is near
        // enough to matter (amber, then red); the planner's Moon card carries
        // the night's verdict.
        const nearlyTooClose = moonSeparation < moonThreshold - 15;
        ctx.fillStyle = isNight
          ? 'rgba(204,51,51,0.85)'
          : moonTooClose
            ? (nearlyTooClose ? '#fb7185' : '#f59e0b')
            : isDark ? 'rgba(226,232,240,0.85)' : 'rgba(241,245,249,0.95)';
        ctx.font = `${moonTooClose ? 'bold ' : ''}10px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(moonLabel, mx, my + 24);
        if (moonOffscreen) {
          const dir = dazMoon > 0 ? 1 : -1;
          const ax = mx + dir * 17;
          ctx.beginPath();
          ctx.moveTo(ax + dir * 5, my);
          ctx.lineTo(ax - dir * 1, my - 5);
          ctx.lineTo(ax - dir * 1, my + 5);
          ctx.closePath();
          ctx.fill();
        }
        ctx.textAlign = 'left';
      }

      // ── Horizon line ──
      ctx.strokeStyle = isNight ? 'rgba(204,51,51,0.7)' : isDark ? 'rgba(74,222,128,0.7)' : 'rgba(34,197,94,0.8)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, horizonY);
      ctx.lineTo(W, horizonY);
      ctx.stroke();

      // ── Cardinal direction markers ──
      ctx.textAlign = 'center';
      for (const card of CARDINALS) {
        const daz = angleDiff(card.az, centerAz);
        if (Math.abs(daz) > hfov / 2) continue;
        const x = cx + daz * pxPerDeg;
        ctx.strokeStyle = isNight ? 'rgba(153,42,42,0.6)' : isDark ? 'rgba(74,222,128,0.6)' : 'rgba(34,197,94,0.7)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, horizonY);
        ctx.lineTo(x, horizonY + 7);
        ctx.stroke();
        const cardLabel = t(`compass8.${card.key}`, { ns: 'common' });
        const major = cardLabel.length === 1;
        ctx.fillStyle = isNight ? (major ? '#cc3333' : 'rgba(153,42,42,0.7)') : isDark ? (major ? '#86efac' : 'rgba(134,239,172,0.7)') : '#16a34a';
        ctx.font = `${major ? 'bold ' : ''}${major ? 12 : 10}px system-ui, sans-serif`;
        ctx.fillText(cardLabel, x, horizonY + 20);
      }

      // ── Target reticle ──
      const reticle = project(target.alt, target.az);
      const aboveHorizon = target.alt > 0;
      ctx.strokeStyle = isNight
        ? (aboveHorizon ? '#cc3333' : 'rgba(153,42,42,0.9)')
        : aboveHorizon ? '#34d399' : 'rgba(251,191,36,0.9)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(reticle.x, reticle.y, 10, 0, Math.PI * 2);
      ctx.stroke();
      // crosshair ticks
      ctx.beginPath();
      ctx.moveTo(reticle.x, reticle.y - 16); ctx.lineTo(reticle.x, reticle.y - 13);
      ctx.moveTo(reticle.x, reticle.y + 13); ctx.lineTo(reticle.x, reticle.y + 16);
      ctx.moveTo(reticle.x - 16, reticle.y); ctx.lineTo(reticle.x - 13, reticle.y);
      ctx.moveTo(reticle.x + 13, reticle.y); ctx.lineTo(reticle.x + 16, reticle.y);
      ctx.stroke();
      // label
      ctx.fillStyle = isNight ? (aboveHorizon ? '#dd3333' : '#882222') : aboveHorizon ? '#6ee7b7' : '#fbbf24';
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      const labelY = reticle.y < 28 ? reticle.y + 26 : reticle.y - 16;
      // Kept inside the chart: the object can sit near an edge, where its centred name would be cut off.
      const nameHalf = ctx.measureText(objectName).width / 2;
      ctx.fillText(objectName, Math.min(W - 4 - nameHalf, Math.max(4 + nameHalf, reticle.x)), labelY);
      ctx.textAlign = 'left';
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [target, moon, moonSeparation, moonThreshold, ra, dec, lat, lon, time, isDark, isNight, objectName, t]);

  const dirText = t('skyChart.dirText', { compass: azToCompass(target.az, t), az: Math.round(target.az) });

  return (
    <div className="space-y-2">
      <div
        ref={wrapRef}
        className={`relative w-full aspect-square overflow-hidden rounded-xl border ${
          isDark ? 'border-slate-800' : 'border-slate-300'
        }`}
      >
        <canvas ref={canvasRef} className="block h-full w-full" />
      </div>
      <p className={`text-[0.6875rem] text-center ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
        {t('skyChart.looking', { dir: dirText })}
        {target.alt <= 0 ? t('skyChart.belowHorizonNow') : ''}
      </p>
    </div>
  );
}
