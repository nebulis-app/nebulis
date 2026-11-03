/**
 * The whole of tonight in one panel: how good it will be, what the Moon is
 * doing, when the dark actually starts and ends, and the hour-by-hour shape of
 * the night on a single time axis.
 *
 * The page title and site picker sit in their own collapsible banner above the
 * panel, so folding the banner (or "Compact page banners") never hides the
 * forecast itself.
 *
 * The panel is dark in every theme. It is a picture of the night sky, and the
 * Catalogs hub sets the same precedent for imagery-backed panels, so the
 * surrounding page stays theme-driven while this stays night-side.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { CloudSun, Star, Sunrise, Sunset, Timer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ForecastHour, NightRating } from '../../lib/api/planner';
import { translateMoonPhase } from '../../lib/moonPhaseLabel';
import {
  calculateVisibilityScore,
  formatTime,
  scoreHex,
  scoreLabel,
  type DarkWindow,
  type VisibilityResult,
} from '../../lib/forecastScore';
import { scoreNight } from '../../lib/plannerNight';
import { dateFromKey } from '../../lib/nightWindow';
import { formatDate } from '../../lib/formatLocale';
import { MoonDisk } from '../ui/MoonDisk';
import { NightRibbon } from './NightRibbon';
import { ScoreDial } from '../ui/ScoreDial';
import { CollapsibleHero } from '../ui/CollapsibleHero';
import { PAGE_HERO } from '../../lib/heroImagery';
import { useTheme } from '../../hooks/useTheme';

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
  darkHours: number;
  nauticalDarkHours: number;
}

interface Props {
  hours: ForecastHour[];
  tonight: TonightInfo;
  timeZone?: string;
  darkWindow: DarkWindow | null;
  tempUnit: 'celsius' | 'fahrenheit';
  selectedTime: string | null;
  onSelect: (hour: ForecastHour) => void;
  /** Bright accent for the current theme, matching the Catalogs hub. */
  accent: string;
  /** The site picker + refresh control, shown top-right beside the page
   *  title. Passed in already decided (only known when a location is set). */
  siteControl?: ReactNode;
  /** The light-pollution tile. Built by the page, which owns the active site
   *  and the detect action, and rendered as a fifth tile in the key-times row. */
  lightPollution?: ReactNode;
  /** The nights after tonight, for the banner's "next good night" line. Left
   *  out where the banner has no room for it (the Planner's weather popup). */
  upcomingNights?: NightRating[];
}

/** Minimum per-hour score for an hour to count as worth being outside for. */
const USABLE_SCORE = 55;

/** A night at or above this is worth setting up for (the "Good" band). */
const GOOD_NIGHT_SCORE = 55;

interface BestWindow {
  start: string;
  end: string;
  hours: number;
  avg: number;
}

/**
 * Longest unbroken run of usable hours. A run beats a single brilliant hour
 * because setting up for one hour is rarely worth it, and this is the number
 * that decides whether tonight is a session or a write-off.
 */
function findBestWindow(scored: { hour: ForecastHour; vis: VisibilityResult }[]): BestWindow | null {
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
  if (!best || best.to === best.from) return null;

  const slice = scored.slice(best.from, best.to + 1);
  return {
    start: slice[0].hour.time,
    end: slice[slice.length - 1].hour.time,
    hours: slice.length - 1,
    avg: Math.round(slice.reduce((a, s) => a + s.vis.score, 0) / slice.length),
  };
}

/** A key-facts tile in the hero. Exported so the light-pollution tile, which
 *  owns its own data, can sit in the same row rather than inventing a second
 *  look for the same thing. */
export function StatPill({ icon, label, value, sub, action, valueClass }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  /** Rendered at the right end of the label row, e.g. a re-detect button. */
  action?: React.ReactNode;
  /** Overrides the value's colour, e.g. the Bortle class's own tone. */
  valueClass?: string;
}) {
  return (
    <div className="rounded-2xl bg-white/[0.06] px-4 py-3 ring-1 ring-inset ring-white/10 backdrop-blur-md">
      <div className="flex items-center gap-1.5 text-[0.6562rem] font-medium uppercase tracking-[0.14em] text-white/45">
        {icon}
        {label}
        {action && <span className="ml-auto">{action}</span>}
      </div>
      <div className={`mt-1.5 font-display text-lg font-semibold leading-none tabular-nums ${valueClass ?? 'text-white'}`}>
        {value}
      </div>
      {sub && <div className="mt-1.5 text-[0.6875rem] leading-tight text-white/45">{sub}</div>}
    </div>
  );
}

/** Minutes now, refreshed once a minute, for the dark countdown. */
function useNowMs(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/** The two things the panel below does not say: how long until (or left of)
 *  the dark, and when the next decent night is if tonight is not one. */
function BannerFacts({ darkWindow, tonightScore, upcomingNights, block }: {
  /** A paragraph under the subtitle when expanded; bare text inside the collapsed bar's own line. */
  block: boolean;
  darkWindow: DarkWindow | null;
  tonightScore: number;
  upcomingNights?: NightRating[];
}) {
  const { t } = useTranslation('forecast');
  const now = useNowMs();

  const span = (ms: number) => {
    const total = Math.max(1, Math.round(ms / 60_000));
    const hours = Math.floor(total / 60);
    const minutes = total % 60;
    return hours > 0 ? t('tonightHero.duration', { hours, minutes }) : t('tonightHero.durationShort', { minutes });
  };

  let dark: string | null = null;
  if (darkWindow) {
    if (now < darkWindow.start) dark = t('tonightHero.darkIn', { time: span(darkWindow.start - now) });
    else if (now < darkWindow.end) dark = t('tonightHero.darkNow', { time: span(darkWindow.end - now) });
  }

  let next: string | null = null;
  if (upcomingNights && tonightScore < GOOD_NIGHT_SCORE) {
    const night = upcomingNights.find(n => n.score >= GOOD_NIGHT_SCORE);
    next = night
      ? t('tonightHero.nextGoodNight', {
        day: formatDate(dateFromKey(night.date), { weekday: 'long' }),
        score: night.score,
      })
      : t('tonightHero.noGoodNight');
  }

  if (!dark && !next) return null;
  const text = (
    <>
      {dark}
      {dark && next && <span className="text-white/25"> · </span>}
      {next}
    </>
  );
  return block
    ? <p className="mt-2 text-[0.8125rem] font-medium text-white/75 tabular-nums">{text}</p>
    : text;
}

/** The page banner: title, subtitle and the site picker. It folds to a slim row;
 *  the forecast panel below it stays put. */
function ForecastBanner({ accent, siteControl, facts }: { accent: string; siteControl?: ReactNode; facts: (block: boolean) => ReactNode }) {
  const { t } = useTranslation('forecast');
  return (
    <CollapsibleHero
      page="forecast"
      image={PAGE_HERO.forecast}
      intensity={0.24}
      accent={accent}
      bottomBloom={false}
      icon={<CloudSun className="h-6 w-6 sm:h-7 sm:w-7" style={{ color: accent }} />}
      title={t('tonightHero.title')}
      summary={facts(false)}
      actions={siteControl}
      contentClassName="p-6 sm:p-7"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display flex items-center gap-2.5 text-3xl font-bold tracking-tight text-white sm:text-4xl">
            <CloudSun className="h-6 w-6 sm:h-7 sm:w-7" style={{ color: accent }} />
            {t('tonightHero.title')}
          </h1>
          <p className="mt-2 text-[0.8125rem] text-white/55">
            {t('tonightHero.subtitle')}
          </p>
          {facts(true)}
        </div>
        {siteControl}
      </div>
    </CollapsibleHero>
  );
}

export function TonightHero({ accent, siteControl, upcomingNights, ...panel }: Props) {
  const { t } = useTranslation('forecast');
  const tonightScore = scoreNight(panel.hours, panel.tonight.moonIllumination, panel.timeZone, panel.darkWindow, t)?.score ?? 0;
  return (
    <div className="space-y-4">
      <ForecastBanner
        accent={accent}
        siteControl={siteControl}
        facts={block => (
          <BannerFacts block={block} darkWindow={panel.darkWindow} tonightScore={tonightScore} upcomingNights={upcomingNights} />
        )}
      />
      <TonightPanel {...panel} />
    </div>
  );
}

function TonightPanel({
  hours, tonight, timeZone, darkWindow, tempUnit, selectedTime, onSelect, lightPollution,
}: Omit<Props, 'accent' | 'siteControl'>) {
  const { t } = useTranslation('forecast');
  const { isNight } = useTheme();
  const fmt = (iso: string | null) => (iso ? formatTime(iso, timeZone) : null);

  const scored = hours.map(h => ({
    hour: h,
    vis: calculateVisibilityScore(h, tonight.moonIllumination, timeZone, darkWindow, t, isNight),
  }));

  // The headline rating is the same roll-up the Planner strip and the outlook
  // cards use (scoreNight), so tonight cannot read differently on another page.
  const night = scoreNight(hours, tonight.moonIllumination, timeZone, darkWindow, t);
  const nightScore = night?.score ?? 0;

  const best = findBestWindow(scored);
  const hex = scoreHex(nightScore, isNight);

  // The recommendation for the middle of the usable window says more about the
  // night than the one for an arbitrary edge hour.
  const headlineAdvice = night?.advice ?? null;

  const darkLabel = tonight.darkHours > 0
    ? { value: `${tonight.darkHours}h`, sub: t('tonightHero.astronomicalDark') }
    : { value: `${tonight.nauticalDarkHours}h`, sub: t('tonightHero.nauticalDark') };

  const astroDusk = fmt(tonight.astronomicalTwilightEnd) ?? fmt(tonight.nauticalTwilightEnd);
  const astroDawn = fmt(tonight.astronomicalTwilightStart) ?? fmt(tonight.nauticalTwilightStart);

  return (
    <section className="relative overflow-hidden rounded-3xl bg-slate-950 hero-panel">
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{ background: `radial-gradient(90% 140% at 8% 0%, ${hex}1f 0%, transparent 60%)` }}
      />
      <div
        className="pointer-events-none absolute inset-0 rounded-3xl"
        style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.10)' }}
      />
      <div className="relative p-6 sm:p-8">
        {/* Rating + Moon */}
        <div className="flex flex-wrap items-start justify-between gap-8 sm:flex-nowrap sm:gap-6">
          <div className="flex items-center gap-5 sm:gap-6">
            <ScoreDial score={nightScore} size={132} showLabel={false} />
            <div className="min-w-0">
              <div className="text-[0.6875rem] font-medium uppercase tracking-[0.18em] text-white/45">
                {t('tonightHero.tonight')}
              </div>
              <h2
                className="font-display text-4xl font-bold leading-none tracking-tight sm:text-5xl"
                style={{ color: hex, textShadow: `0 0 28px ${hex}4d` }}
              >
                {scoreLabel(nightScore, t)}
              </h2>
              {headlineAdvice && (
                <p className="mt-3 max-w-md text-sm leading-relaxed text-white/65">
                  {headlineAdvice}
                </p>
              )}
            </div>
          </div>

          {/* Fixed width so a longer phase name or rise/set string doesn't
              change how much space this block claims, which would otherwise
              shift the Moon disk left/right as the forecast changes night to
              night — see the same fix in the Planner's NightHero. */}
          <div className="flex w-full items-center gap-4 sm:w-72 sm:shrink-0">
            <MoonDisk
              illumination={tonight.moonIllumination}
              phase={tonight.moonPhase}
              size={88}
            />
            <div className="min-w-0 leading-tight">
              <div className="text-[0.6875rem] font-medium uppercase tracking-[0.18em] text-white/45">
                {t('tonightHero.moon')}
              </div>
              <div className="mt-1 truncate font-display text-lg font-semibold text-white">
                {translateMoonPhase(t, tonight.moonPhase)}
              </div>
              <div className="mt-0.5 truncate text-sm text-white/55 tabular-nums">
                {t('tonightHero.illuminated', { percent: Math.round(tonight.moonIllumination) })}
              </div>
              {/* Allowed to wrap rather than truncate: a half-printed
                  "Sets 4:0" reads as a real time. */}
              {(tonight.moonRise || tonight.moonSet) && (
                <div className="mt-1.5 text-[0.6875rem] text-white/40 tabular-nums">
                  {fmt(tonight.moonRise) && t('tonightHero.rises', { time: fmt(tonight.moonRise) })}
                  {fmt(tonight.moonRise) && fmt(tonight.moonSet) && ' · '}
                  {fmt(tonight.moonSet) && t('tonightHero.sets', { time: fmt(tonight.moonSet) })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Key times, plus light pollution once the page supplies that tile.
            Both column counts are spelled out rather than interpolated:
            Tailwind only emits a class it can see as a whole string. */}
        <div className={`mt-7 grid grid-cols-2 gap-3 ${lightPollution ? 'lg:grid-cols-5' : 'lg:grid-cols-4'}`}>
          <StatPill
            icon={<Timer className="h-3.5 w-3.5" />}
            label={t('tonightHero.darkHours')}
            value={darkLabel.value}
            sub={darkLabel.sub}
          />
          <StatPill
            icon={<Sunset className="h-3.5 w-3.5" />}
            label={t('tonightHero.sunset')}
            value={formatTime(tonight.sunset, timeZone)}
            sub={astroDusk ? t('tonightHero.darkBy', { time: astroDusk }) : t('tonightHero.noDarkWindow')}
          />
          <StatPill
            icon={<Sunrise className="h-3.5 w-3.5" />}
            label={t('tonightHero.sunrise')}
            value={formatTime(tonight.sunrise, timeZone)}
            sub={astroDawn ? t('tonightHero.dawnFrom', { time: astroDawn }) : t('tonightHero.noDarkWindow')}
          />
          <StatPill
            icon={<Star className="h-3.5 w-3.5" />}
            label={t('tonightHero.bestWindow')}
            value={best ? t('tonightHero.windowRange', { start: fmt(best.start), end: fmt(best.end) }) : t('tonightHero.noneTonight')}
            sub={best ? t('tonightHero.windowAverage', { hours: best.hours, avg: best.avg }) : t('tonightHero.nothingReaches', { score: USABLE_SCORE })}
          />
          {lightPollution}
        </div>

        {/* The night itself */}
        <div className="mt-7">
          <NightRibbon
            hours={hours}
            tonight={tonight}
            timeZone={timeZone}
            darkWindow={darkWindow}
            tempUnit={tempUnit}
            selectedTime={selectedTime}
            onSelect={onSelect}
          />
        </div>
      </div>
    </section>
  );
}
