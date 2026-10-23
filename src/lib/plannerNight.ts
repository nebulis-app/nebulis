/**
 * Night-shape helpers for the planner.
 *
 * Everything here answers a question the planner asks about a single night:
 * where the twilight bands fall, when the moon is up, which stretches of the
 * timeline are still empty, when a target sits highest, and how good the
 * weather is over the dark window. The scheduling geometry (pixels, snapping)
 * stays in components/planner/scheduleGeometry.ts; this file is pure time and
 * sky math so it can be unit tested without a DOM.
 */
import SunCalc from 'suncalc';
import { altAz } from './altaz';
import { observerNoonAnchor } from './nightWindow';
import { calculateVisibilityScore, type DarkWindow, type TFunc } from './forecastScore';
import { checkMoonProximity, type MoonVerdict } from './moonProximity';
import type { ForecastHour } from './api/planner';
import type { PlannedSession } from './api/plannedSessions';

/** An interval on the timeline, in epoch milliseconds. */
export interface Interval {
  start: number;
  end: number;
}

/** A stretch of the dark window with nothing scheduled in it. */
export interface NightGap extends Interval {
  minutes: number;
}

/**
 * The sun's descent through the twilight phases, in order. Used to paint the
 * timeline background so dusk reads as a gradient rather than a flat block.
 * Any phase the sun does not reach (high-latitude summer) comes back null.
 */
export interface TwilightMarks {
  sunset: Date | null;
  civilEnd: Date | null;
  nauticalEnd: Date | null;
  astroEnd: Date | null;
  astroStart: Date | null;
  nauticalStart: Date | null;
  civilStart: Date | null;
  sunrise: Date | null;
}

function validDate(d: unknown): Date | null {
  return d instanceof Date && !isNaN(d.getTime()) ? d : null;
}

/**
 * CSS gradient for the night, keyed off the real twilight boundaries so the
 * darkening tracks the sun rather than a fixed schedule. Shared by the
 * schedule timeline (vertical: dusk-to-dawn runs top-to-bottom, matching its
 * own time axis) and the altitude chart beneath it (horizontal: dusk-to-dawn
 * runs left-to-right, matching its own time axis) so the two panels read as
 * one continuous night rather than a gradient sitting on top of a flat black
 * slab. Falls back to a plain deep gradient when the sun's angles are
 * unknown (high latitude, or no location).
 */
export function twilightGradientCss(
  marks: TwilightMarks | null | undefined,
  startMs: number,
  totalMs: number,
  direction: 'to bottom' | 'to right' = 'to bottom',
  isNight = false,
): string {
  // This gradient is deliberately "night-side in every theme" — it never
  // reads isDark, so a light/dark/space toggle never washes out the timeline
  // it sits behind. The astronomy red-light theme is different in kind: it
  // isn't a palette choice, it's protecting the viewer's actual dark
  // adaptation, so it gets an explicit carve-out here rather than being
  // swept up in that same "ignore the app theme" convention.
  const DEEP = isNight ? '#000000' : '#05070f';
  const fallback = isNight
    ? `linear-gradient(${direction}, #1a0505 0%, ${DEEP} 22%, ${DEEP} 78%, #1a0505 100%)`
    : `linear-gradient(${direction}, #16233d 0%, ${DEEP} 22%, ${DEEP} 78%, #16233d 100%)`;
  if (!marks || totalMs <= 0) return fallback;

  const pct = (d: Date | null): number | null => {
    if (!d) return null;
    const p = ((d.getTime() - startMs) / totalMs) * 100;
    return p >= -20 && p <= 120 ? Math.max(0, Math.min(100, p)) : null;
  };

  // Evening down, morning back up. Colours run from a lit horizon blue through
  // the twilight phases into astronomical dark (red-ladder equivalent in
  // night mode, so the same shape reads without leaking blue).
  const phases: [number | null, string][] = isNight ? [
    [0, '#3a0f0f'],
    [pct(marks.sunset), '#330d0d'],
    [pct(marks.civilEnd), '#220a0a'],
    [pct(marks.nauticalEnd), '#100404'],
    [pct(marks.astroEnd), DEEP],
    [pct(marks.astroStart), DEEP],
    [pct(marks.nauticalStart), '#100404'],
    [pct(marks.civilStart), '#220a0a'],
    [pct(marks.sunrise), '#330d0d'],
    [100, '#3a0f0f'],
  ] : [
    [0, '#2a3d63'],
    [pct(marks.sunset), '#233958'],
    [pct(marks.civilEnd), '#152744'],
    [pct(marks.nauticalEnd), '#0a1526'],
    [pct(marks.astroEnd), DEEP],
    [pct(marks.astroStart), DEEP],
    [pct(marks.nauticalStart), '#0a1526'],
    [pct(marks.civilStart), '#152744'],
    [pct(marks.sunrise), '#233958'],
    [100, '#2a3d63'],
  ];

  // The 0%/100% horizon stops always exist, so require at least one real
  // twilight mark; otherwise a window the marks missed paints flat blue.
  if (!phases.some(([p], i) => i > 0 && i < phases.length - 1 && p != null)) return fallback;

  const stops = phases
    .filter((p): p is [number, string] => p[0] != null)
    .sort((a, b) => a[0] - b[0])
    .map(([p, c]) => `${c} ${p.toFixed(2)}%`);

  return stops.length >= 2 ? `linear-gradient(${direction}, ${stops.join(', ')})` : fallback;
}

/**
 * Twilight boundaries for the night that begins on `date`'s evening. Evening
 * events come from that day's SunCalc table, morning events from the next
 * day's, which is what makes the returned list monotonic across midnight.
 */
export function twilightMarksFor(date: Date, lat: number, lon: number): TwilightMarks {
  const evening = SunCalc.getTimes(observerNoonAnchor(date, lon, 0), lat, lon);
  const morning = SunCalc.getTimes(observerNoonAnchor(date, lon, 1), lat, lon);
  return {
    sunset: validDate(evening.sunset),
    civilEnd: validDate(evening.dusk),
    nauticalEnd: validDate(evening.nauticalDusk),
    astroEnd: validDate(evening.night),
    astroStart: validDate(morning.nightEnd),
    nauticalStart: validDate(morning.nauticalDawn),
    civilStart: validDate(morning.dawn),
    sunrise: validDate(morning.sunrise),
  };
}

/**
 * Phase name for a SunCalc phase value (0 = new, 0.5 = full). Kept in step
 * with moonPhaseName in server/lib/astroCalc.ts: the planner labels future
 * nights client-side (the server only reports the phase for the night it was
 * asked about), and the two must not disagree on the same night.
 */
export function moonPhaseNameFor(phase: number): string {
  if (phase < 0.03 || phase > 0.97) return 'New Moon';
  if (phase < 0.22) return 'Waxing Crescent';
  if (phase < 0.28) return 'First Quarter';
  if (phase < 0.47) return 'Waxing Gibbous';
  if (phase < 0.53) return 'Full Moon';
  if (phase < 0.72) return 'Waning Gibbous';
  if (phase < 0.78) return 'Last Quarter';
  return 'Waning Crescent';
}

/** Moon altitude in degrees at an instant. */
function moonAltitude(when: Date, lat: number, lon: number): number {
  return (SunCalc.getMoonPosition(when, lat, lon).altitude * 180) / Math.PI;
}

/**
 * Stretches of [start, end] where the moon is above the horizon, found by
 * sampling and then refining each crossing by bisection so a rise time is
 * accurate to well under a minute rather than to the sample cadence.
 */
export function moonUpIntervals(
  start: Date,
  end: Date,
  lat: number,
  lon: number,
  stepMinutes = 10,
): Interval[] {
  const stepMs = Math.max(1, stepMinutes) * 60_000;
  const startMs = start.getTime();
  const endMs = end.getTime();
  if (endMs <= startMs) return [];

  const crossing = (loMs: number, hiMs: number): number => {
    let lo = loMs;
    let hi = hiMs;
    for (let i = 0; i < 24 && hi - lo > 20_000; i++) {
      const mid = (lo + hi) / 2;
      if (moonAltitude(new Date(mid), lat, lon) >= 0) hi = mid;
      else lo = mid;
    }
    return (lo + hi) / 2;
  };

  const intervals: Interval[] = [];
  let wasUp = moonAltitude(start, lat, lon) >= 0;
  let openedAt = wasUp ? startMs : null;

  for (let t = startMs + stepMs; t <= endMs; t += stepMs) {
    const isUp = moonAltitude(new Date(t), lat, lon) >= 0;
    if (isUp === wasUp) continue;
    if (isUp) {
      // Rising: bisect between the last sample (down) and this one (up).
      openedAt = crossing(t - stepMs, t);
    } else if (openedAt != null) {
      // Setting: the bisector expects lo=down, hi=up, so search the mirror.
      let lo = t - stepMs;
      let hi = t;
      for (let i = 0; i < 24 && hi - lo > 20_000; i++) {
        const mid = (lo + hi) / 2;
        if (moonAltitude(new Date(mid), lat, lon) >= 0) lo = mid;
        else hi = mid;
      }
      intervals.push({ start: openedAt, end: (lo + hi) / 2 });
      openedAt = null;
    }
    wasUp = isUp;
  }
  if (openedAt != null) intervals.push({ start: openedAt, end: endMs });
  return intervals;
}

/**
 * Unscheduled stretches of [windowStart, windowEnd] at least `minMinutes`
 * long. Sessions are merged before subtracting, so two back-to-back blocks
 * never manufacture a one-minute sliver between them.
 */
export function findGaps(
  sessions: PlannedSession[],
  windowStart: Date,
  windowEnd: Date,
  minMinutes = 30,
): NightGap[] {
  const windowStartMs = windowStart.getTime();
  const windowEndMs = windowEnd.getTime();
  if (windowEndMs <= windowStartMs) return [];

  const busy = sessions
    .map(s => ({ start: new Date(s.startTime).getTime(), end: new Date(s.endTime).getTime() }))
    .filter(b => b.end > windowStartMs && b.start < windowEndMs)
    .sort((a, b) => a.start - b.start);

  const merged: Interval[] = [];
  for (const b of busy) {
    const last = merged[merged.length - 1];
    if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
    else merged.push({ start: b.start, end: b.end });
  }

  const gaps: NightGap[] = [];
  let cursor = windowStartMs;
  for (const b of merged) {
    if (b.start > cursor) gaps.push({ start: cursor, end: Math.min(b.start, windowEndMs), minutes: 0 });
    cursor = Math.max(cursor, b.end);
    if (cursor >= windowEndMs) break;
  }
  if (cursor < windowEndMs) gaps.push({ start: cursor, end: windowEndMs, minutes: 0 });

  return gaps
    .map(g => ({ ...g, minutes: Math.round((g.end - g.start) / 60_000) }))
    .filter(g => g.minutes >= minMinutes);
}

/**
 * Where in [windowStart, windowEnd] a target should go: the slot of
 * `durationMinutes` with the highest mean altitude that does not collide with
 * anything already scheduled. If every free slot is taken, the best slot
 * overall is returned so a quick-add always lands somewhere sensible and the
 * user can drag it afterwards.
 *
 * When `moonIllumination` is supplied, slot scoring also avoids the moon the
 * same way autoPlan.ts's server-side "Plan My Night" scheduler does: a slot
 * whose worst-case separation crosses into 'warning' is skipped in favor of
 * any 'ok'/'caution' alternative, and 'caution' slots are penalized (not
 * excluded) relative to 'ok' ones. Without this, quick-add (the target list's
 * "+" button) picked purely on altitude and could hand back a slot the
 * timeline immediately flags red, with no warning at add-time. A 'warning'
 * slot is only ever returned when literally every candidate in the window is
 * 'warning' too, so quick-add never fails outright over the moon.
 */
export function bestSlotFor(opts: {
  ra: number;
  dec: number;
  lat: number;
  lon: number;
  windowStart: Date;
  windowEnd: Date;
  durationMinutes: number;
  busy?: Interval[];
  /** Candidate-start cadence in minutes. */
  stepMinutes?: number;
  /** Tonight's moon illumination (0-100). Omit to skip the moon check. */
  moonIllumination?: number;
}): { start: Date; end: Date; meanAlt: number; clashes: boolean; moonVerdict: MoonVerdict } | null {
  const { ra, dec, lat, lon, windowStart, windowEnd, durationMinutes, moonIllumination } = opts;
  const step = Math.max(5, opts.stepMinutes ?? 15) * 60_000;
  const durationMs = durationMinutes * 60_000;
  const lastStart = windowEnd.getTime() - durationMs;
  if (lastStart < windowStart.getTime()) return null;

  const busy = opts.busy ?? [];
  const meanAltOver = (startMs: number): number => {
    const samples = 7;
    let sum = 0;
    for (let i = 0; i < samples; i++) {
      const t = new Date(startMs + (durationMs * i) / (samples - 1));
      sum += altAz(ra, dec, lat, lon, t).alt;
    }
    return sum / samples;
  };
  const moonVerdictOver = (startMs: number): MoonVerdict => {
    if (moonIllumination == null) return 'ok';
    const result = checkMoonProximity(
      ra, dec, lat, lon,
      new Date(startMs), new Date(startMs + durationMs),
      moonIllumination, 15,
    );
    return result.verdict;
  };

  type Candidate = { start: number; meanAlt: number; score: number };
  let bestFree: Candidate | null = null;
  let bestFreeAny: Candidate | null = null;
  let bestAny: Candidate | null = null;
  let bestAnyAny: Candidate | null = null;

  for (let t = windowStart.getTime(); t <= lastStart; t += step) {
    const meanAlt = meanAltOver(t);
    const moonVerdict = moonVerdictOver(t);
    const moonPenalty = moonVerdict === 'caution' ? 10 : 0;
    const score = meanAlt - moonPenalty;
    const moonSafe = moonVerdict !== 'warning';
    const clashes = busy.some(b => t < b.end && b.start < t + durationMs);

    if (!bestAnyAny || meanAlt > bestAnyAny.meanAlt) bestAnyAny = { start: t, meanAlt, score };
    if (moonSafe && (!bestAny || score > bestAny.score)) bestAny = { start: t, meanAlt, score };
    if (!clashes) {
      if (!bestFreeAny || meanAlt > bestFreeAny.meanAlt) bestFreeAny = { start: t, meanAlt, score };
      if (moonSafe && (!bestFree || score > bestFree.score)) bestFree = { start: t, meanAlt, score };
    }
  }

  const chosen = bestFree ?? bestFreeAny ?? bestAny ?? bestAnyAny;
  if (!chosen) return null;
  const clashes = busy.some(b => chosen.start < b.end && b.start < chosen.start + durationMs);
  return {
    start: new Date(chosen.start),
    end: new Date(chosen.start + durationMs),
    meanAlt: chosen.meanAlt,
    clashes,
    moonVerdict: moonVerdictOver(chosen.start),
  };
}

/** Forecast hours that fall inside a window, with an hour of padding. */
export function hoursInWindow(hourly: ForecastHour[], start: Date, end: Date, padHours = 1): ForecastHour[] {
  const lo = start.getTime() - padHours * 3_600_000;
  const hi = end.getTime() + padHours * 3_600_000;
  return hourly.filter(h => {
    const t = new Date(h.time).getTime();
    return t >= lo && t <= hi;
  });
}

export interface NightConditions {
  /** Mean visibility score across the dark window, 0-100. */
  score: number;
  /** Longest unbroken run of hours scoring at least `usableScore`. */
  bestWindow: { start: Date; end: Date; hours: number; avg: number } | null;
  /** The middle-of-the-night recommendation, which reads truer than an edge hour. */
  advice: string | null;
  /** Mean cloud cover across the dark window, 0-100. */
  cloudCover: number;
  /** True when any hour in the window is within 3°C of the dew point. */
  dewRisk: boolean;
}

const USABLE_SCORE = 55;

/**
 * Roll a night's forecast hours into the numbers the hero shows. Mirrors the
 * Sky Forecast hero exactly (same engine, same usable-run rule) so the two
 * pages can never disagree about how good a night is.
 */
export function scoreNight(
  hours: ForecastHour[],
  moonIllumination: number,
  timeZone: string | undefined,
  darkWindow: DarkWindow | null,
  t: TFunc,
): NightConditions | null {
  if (hours.length === 0) return null;
  const scored = hours.map(h => ({
    hour: h,
    vis: calculateVisibilityScore(h, moonIllumination, timeZone, darkWindow, t),
  }));

  const inWindow = darkWindow
    ? scored.filter(s => {
        const t = new Date(s.hour.time).getTime();
        return t >= darkWindow.start && t <= darkWindow.end;
      })
    : scored;
  const rated = inWindow.length > 0 ? inWindow : scored;

  const score = Math.round(rated.reduce((a, s) => a + s.vis.score, 0) / rated.length);
  const cloudCover = Math.round(rated.reduce((a, s) => a + s.hour.cloudCover, 0) / rated.length);
  const dewRisk = rated.some(s => s.vis.dewWarning);

  // Longest run of usable hours. A run beats one brilliant hour, because
  // setting up for a single hour is rarely worth it.
  let best: { from: number; to: number } | null = null;
  let runStart: number | null = null;
  for (let i = 0; i <= scored.length; i++) {
    const usable = i < scored.length && scored[i].vis.score >= USABLE_SCORE;
    if (usable && runStart == null) runStart = i;
    if (!usable && runStart != null) {
      const run = { from: runStart, to: i - 1 };
      if (!best || run.to - run.from > best.to - best.from) best = run;
      runStart = null;
    }
  }
  const bestWindow = best && best.to !== best.from
    ? (() => {
        const slice = scored.slice(best.from, best.to + 1);
        return {
          start: new Date(slice[0].hour.time),
          end: new Date(slice[slice.length - 1].hour.time),
          hours: slice.length - 1,
          avg: Math.round(slice.reduce((a, s) => a + s.vis.score, 0) / slice.length),
        };
      })()
    : null;

  return {
    score,
    bestWindow,
    advice: rated[Math.floor(rated.length / 2)]?.vis.recommendation ?? null,
    cloudCover,
    dewRisk,
  };
}

/** Total scheduled minutes inside a window, counting overlaps only once. */
export function plannedMinutes(sessions: PlannedSession[], windowStart: Date, windowEnd: Date): number {
  const lo = windowStart.getTime();
  const hi = windowEnd.getTime();
  const clipped = sessions
    .map(s => ({
      start: Math.max(lo, new Date(s.startTime).getTime()),
      end: Math.min(hi, new Date(s.endTime).getTime()),
    }))
    .filter(b => b.end > b.start)
    .sort((a, b) => a.start - b.start);

  let total = 0;
  let cursor = -Infinity;
  for (const b of clipped) {
    const from = Math.max(b.start, cursor);
    if (b.end > from) total += b.end - from;
    cursor = Math.max(cursor, b.end);
  }
  return Math.round(total / 60_000);
}

/** "4h 20m", "45m", "6h". Empty durations render as "0m". */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return `${rem}m`;
  if (rem === 0) return `${h}h`;
  return `${h}h ${rem}m`;
}
