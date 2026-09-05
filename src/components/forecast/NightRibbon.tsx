/**
 * The night, drawn end to end on one time axis.
 *
 * x runs from an hour before the observing window opens to an hour after it
 * closes. Everything shares that axis, so the shape of the night is readable in
 * one look: how the sky darkens through twilight, which cloud decks roll in and
 * when, how long the Moon is up, and where the usable hours actually sit.
 *
 * Layers, back to front:
 *   1. Twilight gradient, sampled from a darkness curve keyed on the real
 *      sunset / nautical / astronomical times rather than fixed clock hours.
 *   2. Star field, each star faded by the darkness at its own x, so the stars
 *      come out through dusk and wash out again at dawn.
 *   3. Cloud decks (high, mid, low) hanging from the top of the sky band. They
 *      are drawn as three overlapping areas rather than a stack because the
 *      model reports each deck's coverage independently and they do not sum.
 *   4. Visibility score curve, stroked with a gradient built from each hour's
 *      own score colour, so the line changes colour along the night.
 *   5. Markers: twilight boundaries, the Moon's window, now, and the hour rail.
 *
 * Rendered at 1 SVG unit per CSS pixel (the viewBox tracks the measured width)
 * so the HTML scrub tooltip can be positioned against the same coordinates.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ForecastHour } from '../../lib/api/planner';
import {
  calculateVisibilityScore,
  formatTemp,
  formatTime,
  scoreHex,
  type DarkWindow,
} from '../../lib/forecastScore';

interface TonightInfo {
  moonIllumination: number;
  moonPhase: string;
  moonRise: string | null;
  moonSet: string | null;
  sunset: string;
  sunrise: string;
  astronomicalTwilightEnd: string;
  astronomicalTwilightStart: string;
  nauticalTwilightEnd: string;
  nauticalTwilightStart: string;
}

interface Props {
  hours: ForecastHour[];
  tonight: TonightInfo;
  timeZone?: string;
  darkWindow: DarkWindow | null;
  tempUnit: 'celsius' | 'fahrenheit';
  selectedTime: string | null;
  onSelect: (hour: ForecastHour) => void;
}

// ─── Colour helpers ──────────────────────────────────────────────────

type Rgb = [number, number, number];

/** Sky colour by darkness, 0 = just after sunset, 1 = astronomical dark. */
const SKY_RAMP: { d: number; c: Rgb }[] = [
  { d: 0.0,  c: [ 88, 120, 176] },
  { d: 0.22, c: [ 51,  76, 133] },
  { d: 0.45, c: [ 28,  46,  96] },
  { d: 0.70, c: [ 14,  26,  60] },
  { d: 0.88, c: [  7,  14,  35] },
  { d: 1.0,  c: [  4,   7,  19] },
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Compact hour-only tick label ("9PM"), like formatTime in forecastScore.ts
 *  but without minutes. timeZone is a site record or forecast-response
 *  value, not authored by this component — Intl throws synchronously on one
 *  it can't parse, so fall back to the device's own zone rather than crash
 *  the whole ribbon. */
function hourTickLabel(ms: number, timeZone: string | undefined): string {
  try {
    return new Date(ms)
      .toLocaleTimeString('en-US', { hour: 'numeric', hour12: true, ...(timeZone ? { timeZone } : {}) })
      .replace(' ', '');
  } catch {
    return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', hour12: true }).replace(' ', '');
  }
}

function skyColor(d: number): string {
  const x = Math.min(1, Math.max(0, d));
  for (let i = 1; i < SKY_RAMP.length; i++) {
    const lo = SKY_RAMP[i - 1];
    const hi = SKY_RAMP[i];
    if (x <= hi.d) {
      const t = hi.d === lo.d ? 0 : (x - lo.d) / (hi.d - lo.d);
      return `rgb(${Math.round(lerp(lo.c[0], hi.c[0], t))},${Math.round(lerp(lo.c[1], hi.c[1], t))},${Math.round(lerp(lo.c[2], hi.c[2], t))})`;
    }
  }
  return `rgb(${SKY_RAMP[SKY_RAMP.length - 1].c.join(',')})`;
}

/** Deterministic PRNG so the star field does not reshuffle on every render. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Width the container has to reach before the ribbon draws itself. */
const MIN_WIDTH = 240;

function useMeasuredWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width ?? 0;
      setWidth(Math.round(w));
    });
    ro.observe(el);
    setWidth(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);

  return [ref, width] as const;
}

// ─── Component ───────────────────────────────────────────────────────

export function NightRibbon({
  hours, tonight, timeZone, darkWindow, tempUnit, selectedTime, onSelect,
}: Props) {
  const [wrapRef, width] = useMeasuredWidth<HTMLDivElement>();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // A minute is plenty of resolution for the "now" marker and it keeps the
  // component from re-rendering on every animation frame.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const H = width > 0 ? Math.round(Math.min(300, Math.max(212, width * 0.22))) : 260;
  const PAD_X = 14;
  const MOON_Y = 8;
  const MOON_H = 14;
  const SKY_TOP = MOON_Y + MOON_H + 10;
  const RAIL_Y = H - 40;
  const SKY_BOTTOM = RAIL_Y - 14;
  const LABEL_Y = H - 12;

  const t0 = hours.length ? new Date(hours[0].time).getTime() : 0;
  const t1 = hours.length ? new Date(hours[hours.length - 1].time).getTime() : 0;
  const span = Math.max(1, t1 - t0);

  const xOf = (ms: number) => PAD_X + ((ms - t0) / span) * (width - PAD_X * 2);
  const inRange = (ms: number) => ms >= t0 && ms <= t1;

  /**
   * Darkness at a moment, interpolated between the real twilight boundaries.
   * Missing boundaries (high-latitude summer has no astronomical dark) simply
   * drop out of the control points, so the curve degrades to whatever the site
   * actually gets instead of inventing a dark window.
   */
  const darknessAt = useMemo(() => {
    const ms = (iso: string | null) => (iso ? new Date(iso).getTime() : null);
    const raw: { t: number | null; d: number }[] = [
      { t: ms(tonight.sunset), d: 0 },
      { t: ms(tonight.nauticalTwilightEnd), d: 0.6 },
      { t: ms(tonight.astronomicalTwilightEnd), d: 1 },
      { t: ms(tonight.astronomicalTwilightStart), d: 1 },
      { t: ms(tonight.nauticalTwilightStart), d: 0.6 },
      { t: ms(tonight.sunrise), d: 0 },
    ];
    const pts = raw.filter((p): p is { t: number; d: number } => p.t != null && Number.isFinite(p.t));
    // Guard against a boundary list that is not increasing (it can happen when
    // the window straddles midnight oddly); a non-monotonic list would make the
    // interpolation jump backwards.
    const clean = pts.filter((p, i) => i === 0 || p.t >= pts[i - 1].t);

    return (t: number): number => {
      if (clean.length === 0) return 1;
      if (t <= clean[0].t) return clean[0].d;
      const last = clean[clean.length - 1];
      if (t >= last.t) return last.d;
      for (let i = 1; i < clean.length; i++) {
        if (t <= clean[i].t) {
          const a = clean[i - 1];
          const b = clean[i];
          const f = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
          return lerp(a.d, b.d, f);
        }
      }
      return last.d;
    };
  }, [tonight]);

  // Sample the darkness curve into gradient stops. Sampling beats computing
  // exact stop offsets because it needs no special cases for missing or
  // out-of-range boundaries.
  const skyStops = useMemo(() => {
    const N = 40;
    return Array.from({ length: N + 1 }, (_, i) => {
      const f = i / N;
      return { offset: f, color: skyColor(darknessAt(t0 + f * span)) };
    });
  }, [darknessAt, t0, span]);

  const stars = useMemo(() => {
    if (width < MIN_WIDTH) return [];
    const rand = mulberry32(0x5eed);
    const count = Math.round((width * (SKY_BOTTOM - SKY_TOP)) / 900);
    return Array.from({ length: count }, () => {
      const fx = rand();
      return {
        fx,
        y: SKY_TOP + rand() * (SKY_BOTTOM - SKY_TOP - 18),
        r: 0.45 + rand() * rand() * 1.4,
        base: 0.35 + rand() * 0.65,
      };
    });
  }, [width, SKY_TOP, SKY_BOTTOM]);

  const scored = useMemo(
    () => hours.map(h => ({
      hour: h,
      ms: new Date(h.time).getTime(),
      vis: calculateVisibilityScore(h, tonight.moonIllumination, timeZone, darkWindow),
    })),
    [hours, tonight.moonIllumination, timeZone, darkWindow],
  );

  if (hours.length < 2) return null;

  const scoreY = (score: number) =>
    SKY_BOTTOM - (score / 100) * (SKY_BOTTOM - SKY_TOP - 26);

  /** Catmull-Rom to cubic Bezier, so the curves read as weather not as a graph. */
  const smoothPath = (pts: { x: number; y: number }[]): string => {
    if (pts.length < 2) return '';
    let d = `M ${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(pts.length - 1, i + 2)];
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = p2.y - (p3.y - p1.y) / 6;
      d += ` C ${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
    }
    return d;
  };

  const scorePts = scored.map(s => ({ x: xOf(s.ms), y: scoreY(s.vis.score) }));
  const scoreLine = smoothPath(scorePts);
  const scoreArea = scoreLine
    ? `${scoreLine} L ${scorePts[scorePts.length - 1].x.toFixed(2)},${SKY_BOTTOM} L ${scorePts[0].x.toFixed(2)},${SKY_BOTTOM} Z`
    : '';

  /**
   * Cloud deck hanging from the top of the sky band. The underside is returned
   * separately so it can be stroked: a soft fill alone blurs into a flat wash
   * and hides the very thing worth seeing, which is where the deck thins out.
   */
  const cloudDeck = (pick: (h: ForecastHour) => number, depth: number) => {
    const pts = scored.map(s => ({
      x: xOf(s.ms),
      y: SKY_TOP + (Math.min(100, Math.max(0, pick(s.hour))) / 100) * (SKY_BOTTOM - SKY_TOP) * depth,
    }));
    const line = smoothPath(pts);
    if (!line) return { line: '', area: '' };
    return {
      line,
      area: `${line} L ${pts[pts.length - 1].x.toFixed(2)},${SKY_TOP} L ${pts[0].x.toFixed(2)},${SKY_TOP} Z`,
    };
  };

  // Moon-up intervals inside the window. A rise later than the set means the
  // Moon is already up when the window opens and rises again before it closes.
  const moonRise = tonight.moonRise ? new Date(tonight.moonRise).getTime() : null;
  const moonSet = tonight.moonSet ? new Date(tonight.moonSet).getTime() : null;
  const moonSpans: [number, number][] = (() => {
    if (moonRise == null && moonSet == null) return [];
    if (moonRise == null) return [[t0, moonSet!]];
    if (moonSet == null) return [[moonRise, t1]];
    return moonRise < moonSet ? [[moonRise, moonSet]] : [[t0, moonSet], [moonRise, t1]];
  })()
    .map(([a, b]): [number, number] => [Math.max(t0, a), Math.min(t1, b)])
    .filter(([a, b]) => b > a);

  const boundaries = [
    { ms: new Date(tonight.sunset).getTime(), label: 'Sunset' },
    { ms: tonight.astronomicalTwilightEnd ? new Date(tonight.astronomicalTwilightEnd).getTime() : NaN, label: 'Astro dark' },
    { ms: tonight.astronomicalTwilightStart ? new Date(tonight.astronomicalTwilightStart).getTime() : NaN, label: 'Astro dawn' },
    { ms: new Date(tonight.sunrise).getTime(), label: 'Sunrise' },
  ].filter(b => Number.isFinite(b.ms) && inRange(b.ms));

  // Label every hour when there is room, otherwise thin them out.
  const labelStride = width > 900 ? 1 : width > 620 ? 2 : 3;

  const activeIndex = hoverIndex ?? scored.findIndex(s => s.hour.time === selectedTime);
  const active = activeIndex >= 0 ? scored[activeIndex] : null;

  const indexFromClientX = (clientX: number): number | null => {
    const el = wrapRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left;
    let best = 0;
    let bestD = Infinity;
    scored.forEach((s, i) => {
      const d = Math.abs(xOf(s.ms) - x);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  };

  const gid = 'ribbon';

  // The chart is the only way to reach an hour's detail, so it takes focus and
  // arrow keys as well as the pointer.
  const step = (delta: number) => {
    const from = activeIndex >= 0 ? activeIndex : 0;
    const next = Math.min(scored.length - 1, Math.max(0, from + delta));
    setHoverIndex(next);
    onSelect(scored[next].hour);
  };

  return (
    <div
      ref={wrapRef}
      className="relative w-full select-none rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-white/40"
      tabIndex={0}
      role="group"
      aria-label="Hourly sky conditions. Use the left and right arrow keys to step through the night."
      onKeyDown={e => {
        if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
        else if (e.key === 'Home') { e.preventDefault(); setHoverIndex(0); onSelect(scored[0].hour); }
        else if (e.key === 'End') { e.preventDefault(); setHoverIndex(scored.length - 1); onSelect(scored[scored.length - 1].hour); }
      }}
    >
      {width >= MIN_WIDTH && (
        <>
          <svg
            width={width}
            height={H}
            viewBox={`0 0 ${width} ${H}`}
            className="block rounded-2xl"
            role="img"
            aria-label="Tonight's sky conditions from dusk to dawn"
            onPointerMove={e => setHoverIndex(indexFromClientX(e.clientX))}
            onPointerLeave={() => setHoverIndex(null)}
            onClick={e => {
              const i = indexFromClientX(e.clientX);
              if (i != null) onSelect(scored[i].hour);
            }}
            style={{ cursor: 'crosshair' }}
          >
            <defs>
              <linearGradient id={`${gid}-sky`} x1="0" y1="0" x2="1" y2="0">
                {skyStops.map(s => (
                  <stop key={s.offset} offset={s.offset} stopColor={s.color} />
                ))}
              </linearGradient>

              {/* Warm light lingering at the horizon around sunset and sunrise. */}
              <radialGradient id={`${gid}-dusk`} cx="50%" cy="100%" r="72%">
                <stop offset="0%" stopColor="rgba(251,146,60,0.42)" />
                <stop offset="100%" stopColor="rgba(251,146,60,0)" />
              </radialGradient>

              {/* Anchored to the sky band, not to each path's bounding box, so a
                  thin deck shows only the faint top of the fade instead of
                  being rescaled into a solid white bar. */}
              <linearGradient
                id={`${gid}-cloud`}
                gradientUnits="userSpaceOnUse"
                x1="0" y1={SKY_TOP} x2="0" y2={SKY_BOTTOM}
              >
                <stop offset="0%" stopColor="rgba(203,213,225,0.17)" />
                <stop offset="45%" stopColor="rgba(203,213,225,0.07)" />
                <stop offset="100%" stopColor="rgba(203,213,225,0)" />
              </linearGradient>

              {/* Moonlight washing the top of the sky while the Moon is up. */}
              <linearGradient
                id={`${gid}-moonwash`}
                gradientUnits="userSpaceOnUse"
                x1="0" y1={SKY_TOP} x2="0" y2={SKY_BOTTOM}
              >
                <stop offset="0%" stopColor="rgba(253,246,227,0.09)" />
                <stop offset="100%" stopColor="rgba(253,246,227,0)" />
              </linearGradient>

              {/* One stop per hour, coloured by that hour's own score band. */}
              <linearGradient id={`${gid}-score`} x1="0" y1="0" x2="1" y2="0">
                {scored.map((s, i) => (
                  <stop
                    key={s.hour.time}
                    offset={scored.length === 1 ? 0 : i / (scored.length - 1)}
                    stopColor={scoreHex(s.vis.score)}
                  />
                ))}
              </linearGradient>
              {/* Vertical fade for the area under the score line. Masking the
                  x-coloured gradient with it keeps the fill in each hour's own
                  colour instead of a flat white wash. */}
              <linearGradient
                id={`${gid}-scoreFade`}
                gradientUnits="userSpaceOnUse"
                x1="0" y1={SKY_TOP} x2="0" y2={SKY_BOTTOM}
              >
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.34" />
                <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
              </linearGradient>
              <mask id={`${gid}-scoreMask`}>
                <rect
                  x={PAD_X} y={SKY_TOP} width={width - PAD_X * 2} height={SKY_BOTTOM - SKY_TOP}
                  fill={`url(#${gid}-scoreFade)`}
                />
              </mask>

              <filter id={`${gid}-blur`} x="-20%" y="-40%" width="140%" height="200%">
                <feGaussianBlur stdDeviation="7" />
              </filter>
              <filter id={`${gid}-glow`} x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="4" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>

              <clipPath id={`${gid}-sky-clip`}>
                <rect x={PAD_X} y={SKY_TOP} width={width - PAD_X * 2} height={SKY_BOTTOM - SKY_TOP} rx="12" />
              </clipPath>
            </defs>

            {/* ── Sky band ── */}
            <rect
              x={PAD_X} y={SKY_TOP} width={width - PAD_X * 2} height={SKY_BOTTOM - SKY_TOP}
              rx="12" fill={`url(#${gid}-sky)`}
            />

            <g clipPath={`url(#${gid}-sky-clip)`}>
              {/* Horizon glow at each end of the night. */}
              {[tonight.sunset, tonight.sunrise].map(iso => {
                const ms = new Date(iso).getTime();
                if (!inRange(ms)) return null;
                const r = Math.max(90, width * 0.16);
                return (
                  <ellipse
                    key={iso}
                    cx={xOf(ms)} cy={SKY_BOTTOM} rx={r} ry={(SKY_BOTTOM - SKY_TOP) * 0.85}
                    fill={`url(#${gid}-dusk)`}
                  />
                );
              })}

              {/* Stars, faded by how dark the sky is at their own moment. */}
              {stars.map((s, i) => {
                const ms = t0 + s.fx * span;
                const o = s.base * Math.pow(darknessAt(ms), 1.6);
                if (o < 0.03) return null;
                return (
                  <circle
                    key={i}
                    cx={PAD_X + s.fx * (width - PAD_X * 2)}
                    cy={s.y}
                    r={s.r}
                    fill="#ffffff"
                    opacity={o}
                  />
                );
              })}

              {/* Moonlight, before the clouds so cloud sits in front of it. */}
              {moonSpans.map(([a, b], i) => (
                <rect
                  key={`wash-${i}`}
                  x={xOf(a)} y={SKY_TOP} width={Math.max(1, xOf(b) - xOf(a))} height={SKY_BOTTOM - SKY_TOP}
                  fill={`url(#${gid}-moonwash)`}
                  opacity={0.35 + (tonight.moonIllumination / 100) * 0.65}
                />
              ))}

              {/* Cloud decks. High cirrus is thin and sits shallow, the low deck
                  is the densest and reaches furthest down. */}
              {([
                { pick: (h: ForecastHour) => h.cloudCoverHigh, depth: 0.46, fill: 0.5,  edge: 0.14 },
                { pick: (h: ForecastHour) => h.cloudCoverMid,  depth: 0.62, fill: 0.65, edge: 0.18 },
                { pick: (h: ForecastHour) => h.cloudCoverLow,  depth: 0.78, fill: 0.8,  edge: 0.22 },
              ]).map((deck, i) => {
                const { line, area } = cloudDeck(deck.pick, deck.depth);
                if (!area) return null;
                return (
                  <g key={i}>
                    <path d={area} fill={`url(#${gid}-cloud)`} opacity={deck.fill} filter={`url(#${gid}-blur)`} />
                    <path d={line} fill="none" stroke={`rgba(226,232,240,${deck.edge})`} strokeWidth="1" />
                  </g>
                );
              })}

              {/* Twilight boundaries. */}
              {boundaries.map(b => {
                const x = xOf(b.ms);
                // Half the widest label, so a boundary near either end drops its
                // caption rather than having it clipped by the sky band.
                const roomForLabel = width >= 560 && x > PAD_X + 44 && x < width - PAD_X - 44;
                return (
                  <g key={b.label}>
                    <line
                      x1={x} y1={SKY_TOP} x2={x} y2={SKY_BOTTOM}
                      stroke="rgba(255,255,255,0.22)" strokeWidth="1" strokeDasharray="3 4"
                    />
                    {roomForLabel && (
                      <text
                        x={x} y={SKY_BOTTOM - 7}
                        textAnchor="middle" fontSize="9"
                        fill="rgba(255,255,255,0.55)"
                        letterSpacing="0.10em"
                        style={{ textTransform: 'uppercase', textShadow: '0 1px 3px rgba(0,0,0,0.9)' }}
                      >
                        {b.label}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* Visibility score. */}
              {scoreArea && (
                <path d={scoreArea} fill={`url(#${gid}-score)`} mask={`url(#${gid}-scoreMask)`} />
              )}
              {scoreLine && (
                <path
                  d={scoreLine}
                  fill="none"
                  stroke={`url(#${gid}-score)`}
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  filter={`url(#${gid}-glow)`}
                />
              )}
            </g>

            {/* Sky band hairline, above the clipped content. */}
            <rect
              x={PAD_X} y={SKY_TOP} width={width - PAD_X * 2} height={SKY_BOTTOM - SKY_TOP}
              rx="12" fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth="1"
            />

            {/* ── Moon window ── */}
            {moonSpans.map(([a, b], i) => {
              const w = Math.max(2, xOf(b) - xOf(a));
              return (
                <g key={i}>
                  <rect
                    x={xOf(a)} y={MOON_Y} width={w} height={MOON_H}
                    rx={MOON_H / 2}
                    fill="rgba(250,224,158,0.20)"
                    stroke="rgba(250,224,158,0.42)"
                    strokeWidth="1"
                  />
                  <circle cx={xOf(a) + MOON_H / 2} cy={MOON_Y + MOON_H / 2} r="3.5" fill="rgba(253,246,227,0.95)" />
                  {w > 130 && (
                    <text
                      x={xOf(a) + MOON_H + 6} y={MOON_Y + MOON_H - 4}
                      fontSize="8.5" fill="rgba(253,246,227,0.9)"
                      letterSpacing="0.12em" fontWeight="600"
                    >
                      MOON UP · {Math.round(tonight.moonIllumination)}%
                    </text>
                  )}
                </g>
              );
            })}

            {/* ── Hour rail ── */}
            {scored.map((s, i) => {
              const x = xOf(s.ms);
              const isActive = activeIndex === i;
              return (
                <g key={s.hour.time}>
                  <circle
                    cx={x} cy={RAIL_Y} r={isActive ? 5 : 3}
                    fill={scoreHex(s.vis.score)}
                    opacity={isActive ? 1 : 0.75}
                  />
                  {isActive && (
                    <circle cx={x} cy={RAIL_Y} r="8.5" fill="none" stroke={scoreHex(s.vis.score)} strokeOpacity="0.45" strokeWidth="1.5" />
                  )}
                  {i % labelStride === 0 && (
                    <text
                      x={x} y={LABEL_Y}
                      textAnchor="middle" fontSize="10.5"
                      fill={isActive ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.42)'}
                      className="tabular-nums"
                    >
                      {hourTickLabel(s.ms, timeZone)}
                    </text>
                  )}
                </g>
              );
            })}

            {/* ── Now ── */}
            {inRange(now) && (
              <g>
                <line
                  x1={xOf(now)} y1={MOON_Y} x2={xOf(now)} y2={RAIL_Y}
                  stroke="rgba(255,255,255,0.55)" strokeWidth="1.5"
                />
                <circle cx={xOf(now)} cy={MOON_Y} r="3.5" fill="#ffffff" />
              </g>
            )}

            {/* ── Scrub line ── */}
            {active && (
              <line
                x1={xOf(active.ms)} y1={SKY_TOP} x2={xOf(active.ms)} y2={RAIL_Y}
                stroke="rgba(255,255,255,0.65)" strokeWidth="1" strokeDasharray="2 3"
              />
            )}
          </svg>

          {/* Scrub readout. HTML rather than SVG text so it picks up the app's
              font stack and rounded-pill styling for free. Dropped on narrow
              screens, where it would cover most of the chart and where the
              detail panel below is doing the same job anyway. */}
          {active && width >= 560 && (
            <div
              className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-xl bg-slate-950/85 px-3 py-2
                text-center ring-1 ring-inset ring-white/15 backdrop-blur-md shadow-xl"
              style={{
                left: Math.min(width - 66, Math.max(66, xOf(active.ms))),
                top: SKY_TOP + 30,
                minWidth: '7.5rem',
              }}
            >
              <div className="text-[11px] font-medium text-white/60 tabular-nums">
                {formatTime(active.hour.time, timeZone)}
              </div>
              <div
                className="font-display text-2xl font-bold leading-tight tabular-nums"
                style={{ color: active.vis.hex, textShadow: `0 0 18px ${active.vis.hex}66` }}
              >
                {active.vis.score}
              </div>
              <div className="text-[11px] font-semibold" style={{ color: active.vis.hex }}>
                {active.vis.label}
              </div>
              <div className="mt-1 text-[11px] text-white/55 tabular-nums">
                {active.hour.cloudCover}% cloud · {formatTemp(active.hour.temperature, tempUnit)}
              </div>
            </div>
          )}
        </>
      )}

      {/* Reserve the height before the first measurement so the page does not
          jump when the ribbon appears. */}
      {width < MIN_WIDTH && <div style={{ height: H }} />}
    </div>
  );
}
