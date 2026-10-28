/**
 * Visibility scoring for the Sky Forecast.
 *
 * Extracted from ForecastPage so the hero timeline, the hour strip, and the
 * detail panel all read one implementation. The maths is unchanged from the
 * original page-local version; only its home moved.
 */
import type { ForecastHour } from './api/planner';
import { formatTime12 } from './formatLocale';

/** The band label and recommendation sentence both live in common.json (not
 *  forecast.json/planner.json) since this scoring engine is shared by the
 *  Forecast page and the Planner's night hero/schedule — see the header
 *  comment above. Callers already have a `t` from their own useTranslation()
 *  call; pass it straight through rather than this module owning a hook. */
export type TFunc = (key: string, opts?: Record<string, unknown>) => string;

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

/** i18n key per seeing value, resolved against `hourDetail.seeingName.*`.
 *  Index 0 is unused: the model numbers seeing 1 (excellent) through 5 (bad),
 *  and `hour.seeing` is null when it has no value for that hour. Shared by the
 *  hour detail panel and the imaging window table so the two name the same
 *  seeing number the same way. */
export const SEEING_KEYS = ['', 'excellent', 'good', 'average', 'poor', 'bad'] as const;

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
const SCORE_BANDS: { min: number; labelKey: string; color: string; stroke: string; hex: string }[] = [
  { min: 85, labelKey: 'scoreBand.ideal', color: 'text-emerald-400', stroke: 'stroke-emerald-400', hex: '#34d399' },
  { min: 70, labelKey: 'scoreBand.great', color: 'text-emerald-500', stroke: 'stroke-emerald-500', hex: '#10b981' },
  { min: 55, labelKey: 'scoreBand.good',  color: 'text-blue-400',    stroke: 'stroke-blue-400',    hex: '#60a5fa' },
  { min: 40, labelKey: 'scoreBand.fair',  color: 'text-amber-400',   stroke: 'stroke-amber-400',   hex: '#fbbf24' },
  { min: 25, labelKey: 'scoreBand.poor',  color: 'text-orange-500',  stroke: 'stroke-orange-500',  hex: '#f97316' },
  { min: 0,  labelKey: 'scoreBand.bad',   color: 'text-red-500',     stroke: 'stroke-red-500',     hex: '#ef4444' },
];

/** Night-theme equivalent of SCORE_BANDS. Same thresholds and labels, but
 *  every hue collapses to the same dark-red ladder `.night` already uses for
 *  slate text in index.css (#cc3333 down to #4d1414), so a score band never
 *  renders green/blue/amber/orange while red-light mode is protecting the
 *  viewer's dark adaptation. Brightness still carries the good/bad signal;
 *  hue no longer does. */
const NIGHT_SCORE_BANDS: { min: number; labelKey: string; color: string; stroke: string; hex: string }[] = [
  { min: 85, labelKey: 'scoreBand.ideal', color: 'text-[#cc3333]', stroke: 'stroke-[#cc3333]', hex: '#cc3333' },
  { min: 70, labelKey: 'scoreBand.great', color: 'text-[#b82e2e]', stroke: 'stroke-[#b82e2e]', hex: '#b82e2e' },
  { min: 55, labelKey: 'scoreBand.good',  color: 'text-[#a02828]', stroke: 'stroke-[#a02828]', hex: '#a02828' },
  { min: 40, labelKey: 'scoreBand.fair',  color: 'text-[#882222]', stroke: 'stroke-[#882222]', hex: '#882222' },
  { min: 25, labelKey: 'scoreBand.poor',  color: 'text-[#661a1a]', stroke: 'stroke-[#661a1a]', hex: '#661a1a' },
  { min: 0,  labelKey: 'scoreBand.bad',   color: 'text-[#4d1414]', stroke: 'stroke-[#4d1414]', hex: '#4d1414' },
];

function bandFor(score: number, isNight = false) {
  const bands = isNight ? NIGHT_SCORE_BANDS : SCORE_BANDS;
  return bands.find(b => score >= b.min) ?? bands[bands.length - 1];
}

export function scoreRingColor(score: number, isNight = false): string {
  return bandFor(score, isNight).stroke;
}

export function scoreHex(score: number, isNight = false): string {
  return bandFor(score, isNight).hex;
}

export function scoreLabel(score: number, t: TFunc): string {
  return t(bandFor(score).labelKey, { ns: 'common' });
}

export function scoreTextColor(score: number, isNight = false): string {
  return bandFor(score, isNight).color;
}

export function scoreBgColor(score: number, isDark: boolean, isNight = false): string {
  if (isNight) {
    // Same red ladder as NIGHT_SCORE_BANDS, dimmed to a wash for a card background.
    if (score >= 85) return 'bg-[#cc3333]/10 border-[#cc3333]/30';
    if (score >= 70) return 'bg-[#b82e2e]/5 border-[#b82e2e]/20';
    if (score >= 55) return 'bg-[#a02828]/5 border-[#a02828]/20';
    if (score >= 40) return 'bg-[#882222]/5 border-[#882222]/20';
    return 'bg-[#661a1a]/5 border-[#661a1a]/20';
  }
  if (score >= 85) return isDark ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-emerald-50 border-emerald-200';
  if (score >= 70) return isDark ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-emerald-50/50 border-emerald-100';
  if (score >= 55) return isDark ? 'bg-blue-500/5 border-blue-500/20' : 'bg-blue-50/50 border-blue-100';
  if (score >= 40) return isDark ? 'bg-amber-500/5 border-amber-500/20' : 'bg-amber-50/50 border-amber-100';
  return isDark ? 'bg-red-500/5 border-red-500/20' : 'bg-red-50/50 border-red-100';
}

export function calculateVisibilityScore(
  hour: ForecastHour,
  moonIllumination: number,
  timeZone: string | undefined,
  darkWindow: DarkWindow | null | undefined,
  t: TFunc,
  isNightTheme = false,
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

  const band = bandFor(score, isNightTheme);

  return {
    score,
    label: t(band.labelKey, { ns: 'common' }),
    color: band.color,
    hex: band.hex,
    recommendation: getRecommendation(score, hour, moonIllumination, t),
    dewWarning,
    breakdown: {
      clouds: Math.round(cloudScore * 100),
      seeing: Math.round(seeingScore * 100),
      moon: Math.round(moonPenalty * 100),
      transparency: Math.round(humidityPenalty * 100),
    },
  };
}

function getRecommendation(score: number, hour: ForecastHour, moonIllumination: number, t: TFunc): string {
  const key = (name: string) => t(`scoreRecommendation.${name}`, { ns: 'common' });
  if (score < 25) return key('overcast');
  if (score < 40) return key('marginal');
  if (hour.cloudCover > 50) return key('partlyCloudy');
  if (moonIllumination > 70 && score >= 55) return key('brightMoon');
  if (moonIllumination < 20 && score >= 70) return key('darkSkies');
  if (score >= 85) return key('excellent');
  if (score >= 70) return key('good');
  if (score >= 55) return key('decent');
  return key('limited');
}

export function localHour(date: Date, timeZone?: string): number {
  if (!timeZone) return date.getHours();
  try {
    // 'en-US' here is locale-invariant PARSING (formatToParts pulls the hour
    // digit), not display — see formatLocale.ts's header comment.
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
    return formatTime12(new Date(iso), timeZone);
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

/**
 * The intervals inside [t0, t1] during which the Moon is above the horizon.
 *
 * A rise later than the set means the Moon was already up when the window
 * opened and comes back up before it closes, which is why that case yields two
 * spans rather than none.
 *
 * An empty result means the Moon is down for the whole window, or that neither
 * rise nor set is known. Those two are deliberately indistinguishable here: a
 * caller that must not claim "down" from missing data checks the inputs itself,
 * which both the night ribbon and the imaging window table do.
 */
export function moonUpSpans(
  t0: number,
  t1: number,
  moonRiseIso: string | null,
  moonSetIso: string | null,
): Array<[number, number]> {
  const rise = moonRiseIso ? new Date(moonRiseIso).getTime() : null;
  const set = moonSetIso ? new Date(moonSetIso).getTime() : null;
  if (rise === null && set === null) return [];

  const spans: Array<[number, number]> = [];
  if (rise !== null && set !== null) {
    if (rise < set) spans.push([rise, set]);
    else {
      spans.push([t0, set]);
      spans.push([rise, t1]);
    }
  } else if (rise !== null) {
    spans.push([rise, t1]);
  } else if (set !== null) {
    spans.push([t0, set]);
  }

  return spans
    .map(([a, b]): [number, number] => [Math.max(t0, a), Math.min(t1, b)])
    .filter(([a, b]) => b > a);
}
