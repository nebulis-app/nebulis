/**
 * The whole of tonight in one panel: how good it will be, what the Moon is
 * doing, when the dark actually starts and ends, and the hour-by-hour shape of
 * the night on a single time axis.
 *
 * The panel is dark in every theme. It is a picture of the night sky, and the
 * Catalogs hub sets the same precedent for imagery-backed panels, so the
 * surrounding page stays theme-driven while this stays night-side.
 */
import type { ReactNode } from 'react';
import { CloudSun, Star, Sunrise, Sunset, Timer } from 'lucide-react';
import type { ForecastHour } from '../../lib/api/planner';
import {
  calculateVisibilityScore,
  formatTime,
  scoreHex,
  scoreLabel,
  type DarkWindow,
  type VisibilityResult,
} from '../../lib/forecastScore';
import { MoonDisk } from '../ui/MoonDisk';
import { NightRibbon } from './NightRibbon';
import { ScoreDial } from '../ui/ScoreDial';
import { HeroBackdrop } from '../ui/HeroBackdrop';
import { PAGE_HERO } from '../../lib/heroImagery';

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
}

/** Minimum per-hour score for an hour to count as worth being outside for. */
const USABLE_SCORE = 55;

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

function StatPill({ icon, label, value, sub }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-2xl bg-white/[0.06] px-4 py-3 ring-1 ring-inset ring-white/10 backdrop-blur-md">
      <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[0.14em] text-white/45">
        {icon}
        {label}
      </div>
      <div className="mt-1.5 font-display text-lg font-semibold leading-none text-white tabular-nums">
        {value}
      </div>
      {sub && <div className="mt-1.5 text-[11px] leading-tight text-white/45">{sub}</div>}
    </div>
  );
}

export function TonightHero({
  hours, tonight, timeZone, darkWindow, tempUnit, selectedTime, onSelect, accent, siteControl,
}: Props) {
  const fmt = (iso: string | null) => (iso ? formatTime(iso, timeZone) : null);

  const scored = hours.map(h => ({
    hour: h,
    vis: calculateVisibilityScore(h, tonight.moonIllumination, timeZone, darkWindow),
  }));

  // The headline rating averages only the hours inside the usable window, so a
  // clouded-over hour either side of dusk cannot drag down an otherwise clear
  // night. Everything on this page reads from this one engine.
  const inWindow = darkWindow
    ? scored.filter(s => {
        const t = new Date(s.hour.time).getTime();
        return t >= darkWindow.start && t <= darkWindow.end;
      })
    : scored;
  const rated = inWindow.length > 0 ? inWindow : scored;
  const nightScore = rated.length
    ? Math.round(rated.reduce((a, s) => a + s.vis.score, 0) / rated.length)
    : 0;

  const best = findBestWindow(scored);
  const hex = scoreHex(nightScore);

  // The recommendation for the middle of the usable window says more about the
  // night than the one for an arbitrary edge hour.
  const headlineAdvice = rated.length
    ? rated[Math.floor(rated.length / 2)].vis.recommendation
    : null;

  const darkLabel = tonight.darkHours > 0
    ? { value: `${tonight.darkHours}h`, sub: 'Astronomical dark' }
    : { value: `${tonight.nauticalDarkHours}h`, sub: 'Nautical dark' };

  const astroDusk = fmt(tonight.astronomicalTwilightEnd) ?? fmt(tonight.nauticalTwilightEnd);
  const astroDawn = fmt(tonight.astronomicalTwilightStart) ?? fmt(tonight.nauticalTwilightStart);

  return (
    <section
      className="relative overflow-hidden rounded-3xl bg-slate-950"
      style={{ boxShadow: '0 24px 60px -30px rgba(0,0,0,0.9)' }}
    >
      {/* Kept low: the score dial, the Moon and the night ribbon all read over
          this panel, and the ribbon in particular is a fine-grained chart. */}
      <HeroBackdrop image={PAGE_HERO.forecast} intensity={0.24} />

      {/* Accent bloom, tinted to the score so a bad night does not glow gold. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-64 opacity-60"
        style={{ background: `radial-gradient(120% 100% at 18% 0%, ${hex}26 0%, transparent 68%)` }}
      />
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-64 opacity-50"
        style={{ background: `radial-gradient(90% 90% at 88% 0%, ${accent}1f 0%, transparent 70%)` }}
      />
      <div className="pointer-events-none absolute inset-0 rounded-3xl" style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.10)' }} />

      {/* One padded panel, title and content together, rather than two
          stacked boxes with a hard rule between them — matching how the
          Observations hero reads as a single card. */}
      <div className="relative p-6 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-display flex items-center gap-2.5 text-3xl font-bold tracking-tight text-white sm:text-4xl">
              <CloudSun className="h-6 w-6 sm:h-7 sm:w-7" style={{ color: accent }} />
              Sky Forecast
            </h1>
            <p className="mt-2 text-[13px] text-white/55">
              Astronomy weather conditions for tonight and upcoming nights
            </p>
          </div>
          {siteControl}
        </div>

        {/* Rating + Moon */}
        <div className="mt-7 flex flex-wrap items-start justify-between gap-8 sm:flex-nowrap sm:gap-6">
          <div className="flex items-center gap-5 sm:gap-6">
            <ScoreDial score={nightScore} size={132} showLabel={false} />
            <div className="min-w-0">
              <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/45">
                Tonight
              </div>
              <h2
                className="font-display text-4xl font-bold leading-none tracking-tight sm:text-5xl"
                style={{ color: hex, textShadow: `0 0 28px ${hex}4d` }}
              >
                {scoreLabel(nightScore)}
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
              <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/45">
                Moon
              </div>
              <div className="mt-1 truncate font-display text-lg font-semibold text-white">
                {tonight.moonPhase}
              </div>
              <div className="mt-0.5 truncate text-sm text-white/55 tabular-nums">
                {Math.round(tonight.moonIllumination)}% illuminated
              </div>
              {/* Allowed to wrap rather than truncate: a half-printed
                  "Sets 4:0" reads as a real time. */}
              {(tonight.moonRise || tonight.moonSet) && (
                <div className="mt-1.5 text-[11px] text-white/40 tabular-nums">
                  {fmt(tonight.moonRise) && `Rises ${fmt(tonight.moonRise)}`}
                  {fmt(tonight.moonRise) && fmt(tonight.moonSet) && ' · '}
                  {fmt(tonight.moonSet) && `Sets ${fmt(tonight.moonSet)}`}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Key times */}
        <div className="mt-7 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatPill
            icon={<Timer className="h-3.5 w-3.5" />}
            label="Dark hours"
            value={darkLabel.value}
            sub={darkLabel.sub}
          />
          <StatPill
            icon={<Sunset className="h-3.5 w-3.5" />}
            label="Sunset"
            value={formatTime(tonight.sunset, timeZone)}
            sub={astroDusk ? `Dark by ${astroDusk}` : 'No dark window'}
          />
          <StatPill
            icon={<Sunrise className="h-3.5 w-3.5" />}
            label="Sunrise"
            value={formatTime(tonight.sunrise, timeZone)}
            sub={astroDawn ? `Dawn from ${astroDawn}` : 'No dark window'}
          />
          <StatPill
            icon={<Star className="h-3.5 w-3.5" />}
            label="Best window"
            value={best ? `${fmt(best.start)} to ${fmt(best.end)}` : 'None tonight'}
            sub={best ? `${best.hours}h averaging ${best.avg}` : `Nothing reaches ${USABLE_SCORE}`}
          />
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
