/**
 * Visibility scoring for the Sky Forecast.
 *
 * Extracted from ForecastPage so the hero timeline, the hour strip, and the
 * detail panel all read one implementation. The maths is unchanged from the
 * original page-local version; only its home moved.
 */
import type { ForecastHour } from './api/planner';

export interface VisibilityResult {
  score: number;
  label: string;
  /** Tailwind text class, kept for the light/dark call sites that expect one. */
  color: string;
  /** Raw hex for SVG fills, glows, and gradients that cannot use a class. */
  hex: string;
  recommendation: string;
  breakdown: { clouds: number; seeing: number; moon: number; transparency: number };
  dewWarning: boolean;
}

export interface DarkWindow {
  start: number;
  end: number;
}

// Smooth cloud cover over a ±1 hour window to reduce NWP model noise.
// The raw hourly model output can swing ±50% between adjacent hours for
// partial cloud cover — averaging with neighbors gives a more realistic picture.
export function smoothHours(hours: ForecastHour[]): ForecastHour[] {
  return hours.map((h, i) => {
    const values = [hours[i - 1]?.cloudCover, h.cloudCover, hours[i + 1]?.cloudCover]
      .filter((v): v is number => v !== undefined);
    return { ...h, cloudCover: Math.round(values.reduce((a, b) => a + b, 0) / values.length) };
  });
}

/**
 * Score bands, ordered high to low. One table drives the label, the Tailwind
 * text class, the SVG stroke class, and the raw hex, so a band can never
 * disagree with itself across the four call sites that used to hardcode it.
 */
const SCORE_BANDS: { min: number; label: string; color: string; stroke: string; hex: string }[] = [
  { min: 85, label: 'Ideal', color: 'text-emerald-400', stroke: 'stroke-emerald-400', hex: '#34d399' },
  { min: 70, label: 'Great', color: 'text-emerald-500', stroke: 'stroke-emerald-500', hex: '#10b981' },
  { min: 55, label: 'Good',  color: 'text-blue-400',    stroke: 'stroke-blue-400',    hex: '#60a5fa' },
  { min: 40, label: 'Fair',  color: 'text-amber-400',   stroke: 'stroke-amber-400',   hex: '#fbbf24' },
  { min: 25, label: 'Poor',  color: 'text-orange-500',  stroke: 'stroke-orange-500',  hex: '#f97316' },
  { min: 0,  label: 'Bad',   color: 'text-red-500',     stroke: 'stroke-red-500',     hex: '#ef4444' },
];

function bandFor(score: number) {
  return SCORE_BANDS.find(b => score >= b.min) ?? SCORE_BANDS[SCORE_BANDS.length - 1];
}

export function scoreRingColor(score: number): string {
  return bandFor(score).stroke;
}

export function scoreHex(score: number): string {
  return bandFor(score).hex;
}

export function scoreLabel(score: number): string {
  return bandFor(score).label;
}

export function scoreTextColor(score: number): string {
  return bandFor(score).color;
}

export function scoreBgColor(score: number, isDark: boolean): string {
  if (score >= 85) return isDark ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-emerald-50 border-emerald-200';
  if (score >= 70) return isDark ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-emerald-50/50 border-emerald-100';
  if (score >= 55) return isDark ? 'bg-blue-500/5 border-blue-500/20' : 'bg-blue-50/50 border-blue-100';
  if (score >= 40) return isDark ? 'bg-amber-500/5 border-amber-500/20' : 'bg-amber-50/50 border-amber-100';
  return isDark ? 'bg-red-500/5 border-red-500/20' : 'bg-red-50/50 border-red-100';
}

export function calculateVisibilityScore(
  hour: ForecastHour,
  moonIllumination: number,
  timeZone?: string,
  darkWindow?: DarkWindow | null,
): VisibilityResult {
  // Cloud Cover (60% weight): 0% = 1.0, 100% = 0.0
  const cloudScore = 1 - hour.cloudCover / 100;

  // Seeing (20% weight): base from 7Timer (interpolated), then apply jet stream + CAPE modifiers.
  // Jet stream (500hPa wind): the primary physical driver of atmospheric seeing.
  //   <40 km/h = minimal penalty, >120 km/h = severe.
  // CAPE: atmospheric instability. >500 J/kg means turbulent, convective air column.
  const seeingMap: Record<number, number> = { 1: 1.0, 2: 0.75, 3: 0.5, 4: 0.2, 5: 0.0 };
  let seeingScore = hour.seeing != null ? (seeingMap[hour.seeing] ?? 0.5) : 0.5;

  if (hour.jetStream != null) {
    const jsPenalty = hour.jetStream < 40 ? 0
      : hour.jetStream < 80 ? 0.12
      : hour.jetStream < 120 ? 0.25
      : 0.40;
    seeingScore = Math.max(0, seeingScore - jsPenalty);
  }
  if (hour.cape != null && hour.cape > 100) {
    const capePenalty = hour.cape < 500 ? 0.05 : hour.cape < 1500 ? 0.10 : 0.15;
    seeingScore = Math.max(0, seeingScore - capePenalty);
  }

  // Moon (20% weight): penalty for high illumination, but only while it's
  // actually dark. Prefer the real dark window (astronomical/nautical twilight)
  // so deep-winter early-dark and high-summer pre-dawn hours are classed
  // correctly; fall back to a fixed 19:00-05:00 band if no window is known.
  const tMs = new Date(hour.time).getTime();
  const isNight = darkWindow
    ? tMs >= darkWindow.start && tMs <= darkWindow.end
    : (() => {
        const hourOfDay = localHour(new Date(hour.time), timeZone);
        return hourOfDay >= 19 || hourOfDay <= 5;
      })();
  const moonPenalty = isNight ? (1 - moonIllumination / 100) : 1.0;

  // Transparency bonus: based on humidity (high humidity = poor transparency)
  const humidityPenalty = Math.max(0, 1 - Math.max(0, hour.humidity - 40) / 60);
  const transparencyBonus = humidityPenalty * 0.1; // up to 10% bonus

  // Dew risk: temp within 3°C of dew point means equipment may dew over
  const dewWarning = (hour.temperature - hour.dewPoint) < 3;

  const raw = (cloudScore * 0.6) + (seeingScore * 0.2) + (moonPenalty * 0.2) + transparencyBonus;
  const score = Math.round(Math.min(100, Math.max(0, raw * 100)));

  const band = bandFor(score);

  return {
    score,
    label: band.label,
    color: band.color,
    hex: band.hex,
    recommendation: getRecommendation(score, hour, moonIllumination),
    dewWarning,
    breakdown: {
      clouds: Math.round(cloudScore * 100),
      seeing: Math.round(seeingScore * 100),
      moon: Math.round(moonPenalty * 100),
      transparency: Math.round(humidityPenalty * 100),
    },
  };
}

function getRecommendation(score: number, hour: ForecastHour, moonIllumination: number): string {
  if (score < 25) return 'Stay inside - overcast or very poor conditions.';
  if (score < 40) return 'Marginal - maybe bright planets through cloud gaps.';
  if (hour.cloudCover > 50) return 'Partly cloudy - try bright targets like the Moon or planets.';
  if (moonIllumination > 70 && score >= 55) return 'Bright Moon - great for planets, Moon detail, and star clusters. Avoid faint nebulae.';
  if (moonIllumination < 20 && score >= 70) return 'Dark skies - ideal for deep sky: galaxies, nebulae, and faint targets.';
  if (score >= 85) return 'Excellent conditions for any target - deep sky objects, planets, and wide-field.';
  if (score >= 70) return 'Good for most targets - galaxies and brighter nebulae will show well.';
  if (score >= 55) return 'Decent conditions - stick to brighter targets like star clusters and planets.';
  return 'Limited - try bright planets or the Moon.';
}

export function localHour(date: Date, timeZone?: string): number {
  if (!timeZone) return date.getHours();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    return parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
  } catch {
    return date.getHours();
  }
}

export function formatTime(iso: string, timeZone?: string): string {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      ...(timeZone ? { timeZone } : {}),
    });
  } catch {
    return '-';
  }
}

export function formatTemp(celsius: number, unit: 'celsius' | 'fahrenheit'): string {
  if (unit === 'fahrenheit') return `${Math.round(celsius * 9 / 5 + 32)}°F`;
  return `${Math.round(celsius)}°C`;
}

export function formatWind(kmh: number, unit: 'mph' | 'kmh'): string {
  if (unit === 'mph') return `${Math.round(kmh * 0.621371)} mph`;
  return `${Math.round(kmh)} km/h`;
}
