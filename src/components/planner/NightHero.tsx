/**
 * Is this night worth setting up for, and what is the Moon doing?
 *
 * Two facts and one action, deliberately. Everything else that used to live up
 * here moved to where it belongs: picking a night is navigation (NightStrip),
 * how full the plan is belongs to the schedule (its header), and the dark
 * window, the Moon's hours and the hourly weather are all drawn on the
 * timeline itself rather than described in text above it.
 *
 * The panel is dark in every theme, matching the Sky Forecast hero and the
 * Catalogs panels: it is a picture of the night sky, so the page around it
 * stays theme-driven while this stays night-side.
 */
import type { ReactNode } from 'react';
import { ChevronRight, CloudSun, Crosshair, Droplets, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatTime, scoreHex, scoreLabel } from '../../lib/forecastScore';
import type { NightConditions } from '../../lib/plannerNight';
import { MoonDisk } from '../ui/MoonDisk';
import { ScoreDial } from '../ui/ScoreDial';
import { HeroBackdrop } from '../ui/HeroBackdrop';
import { PAGE_HERO } from '../../lib/heroImagery';
import { translateMoonPhase } from '../../lib/moonPhaseLabel';
import type { NightFilterAdvice } from '../../lib/nightFilterAdvice';
import { formatDate } from '../../lib/formatLocale';
import { useTheme } from '../../hooks/useTheme';

interface Props {
  date: Date;
  isToday: boolean;
  /** Null past the forecast horizon, or when no weather could be fetched. */
  conditions: NightConditions | null;
  moonIllumination: number;
  moonPhase: string;
  moonRise: Date | null;
  moonSet: Date | null;
  /** Broadband or narrowband, from the Moon over the dark window. Null when
   *  there is no location to work it out from. */
  filterAdvice?: NightFilterAdvice | null;
  timeZone?: string;
  /** Bright accent for the current theme, matching the Forecast hero. */
  accent: string;
  canAutoPlan: boolean;
  onAutoPlan: () => void;
  /** Opens the full forecast for this night. Omitted when there is no weather
   *  to show, in which case the rating block is not interactive. */
  onOpenWeather?: () => void;
  /** Slot for the save indicator and anything else status-shaped. */
  status?: ReactNode;
  /** The site picker, shown top-right beside the page title. Carries its own
   *  visibility condition (only known lat/lon), so it is passed in already
   *  decided rather than gated here. */
  siteControl?: ReactNode;
}

export function NightHero({
  date,
  isToday,
  conditions,
  moonIllumination,
  moonPhase,
  moonRise,
  moonSet,
  filterAdvice,
  timeZone,
  accent,
  canAutoPlan,
  onAutoPlan,
  onOpenWeather,
  status,
  siteControl,
}: Props) {
  const { t } = useTranslation('planner');
  const { isNight } = useTheme();
  const hex = conditions ? scoreHex(conditions.score, isNight) : (isNight ? '#661a1a' : '#64748b');
  const fmt = (d: Date | null) => (d ? formatTime(d.toISOString(), timeZone) : null);

  const dateLabel = formatDate(date, { weekday: 'long', month: 'long', day: 'numeric' });
  const moonTimes = [
    fmt(moonRise) && t('nightHero.rises', { time: fmt(moonRise) }),
    fmt(moonSet) && t('nightHero.sets', { time: fmt(moonSet) }),
  ].filter(Boolean).join(' · ');

  const advice = conditions
    ? conditions.advice ?? t('nightHero.averageCloud', { percent: conditions.cloudCover })
    : t('nightHero.pastForecast');

  return (
    <section
      className="relative overflow-hidden rounded-3xl bg-slate-950 hero-panel"
    >
      {/* Kept low: the rating dial, the Moon and the verdict all sit over this
          panel, and none of them may lose contrast to decoration. */}
      <HeroBackdrop image={PAGE_HERO.planner} intensity={0.26} rounded="rounded-2xl" />

      {/* Bloom tinted to the rating, so a clouded-out night does not glow gold. */}
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{ background: `radial-gradient(90% 180% at 12% 0%, ${hex}24 0%, transparent 62%)` }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{ background: `radial-gradient(70% 160% at 92% 0%, ${accent}1c 0%, transparent 66%)` }}
      />
      <div
        className="pointer-events-none absolute inset-0 rounded-3xl"
        style={{ boxShadow: `inset 0 0 0 1px ${isNight ? 'rgba(204,51,51,0.10)' : 'rgba(255,255,255,0.10)'}` }}
      />

      {/* One padded panel, title and content together, rather than two
          stacked boxes with a hard rule between them — matching how the
          Observations hero reads as a single card. */}
      <div className="relative flex flex-col gap-5 p-5 sm:p-7">
        <div className="flex items-center justify-between gap-4">
          <h1 className="font-display flex items-center gap-2.5 text-3xl font-bold tracking-tight text-white sm:text-4xl">
            <Crosshair className="h-6 w-6 sm:h-7 sm:w-7" style={{ color: accent }} />
            {t('nightHero.title')}
          </h1>
          {siteControl}
        </div>

        {/* Column on a phone: at that width the three parts cannot share a row
            without the verdict collapsing into the Moon. */}
        <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-6">
          {/* Rating. The whole block opens the night's full forecast: the number
              invites the question "why", and this is the answer. */}
          <div
            role={onOpenWeather ? 'button' : undefined}
            tabIndex={onOpenWeather ? 0 : undefined}
            onClick={onOpenWeather}
            onKeyDown={onOpenWeather
              ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenWeather(); } }
              : undefined}
            title={onOpenWeather ? t('nightHero.openForecastTitle') : undefined}
            // Without this the computed name would be the whole verdict
            // paragraph, which is a mouthful to announce for a "show me more".
            aria-label={onOpenWeather ? t('nightHero.openForecastTitle') : undefined}
            className={`group flex min-w-0 items-center gap-4 rounded-xl sm:flex-1 ${
              onOpenWeather
                ? 'cursor-pointer outline-none transition hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-white/30'
                : ''
            }`}
          >
            {conditions ? (
              <ScoreDial score={conditions.score} size={78} showLabel={false} />
            ) : (
              <div className="flex h-[78px] w-[78px] shrink-0 items-center justify-center rounded-full ring-1 ring-inset ring-white/10">
                <CloudSun className="h-6 w-6 text-white/25" />
              </div>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[10.5px] font-medium uppercase tracking-[0.18em] text-white/40">
                {isToday ? t('nightHero.tonight') : t('nightHero.planning')}
                <span className="normal-case tracking-normal text-white/30">{dateLabel}</span>
                {status}
              </div>
              <h2
                className="mt-1 flex items-center gap-1 font-display text-[28px] font-bold leading-none tracking-tight"
                style={conditions ? { color: hex, textShadow: `0 0 28px ${hex}4d` } : { color: isNight ? '#882222' : '#e2e8f0' }}
              >
                {conditions ? scoreLabel(conditions.score, t) : t('nightHero.noForecastYet')}
                {onOpenWeather && (
                  <ChevronRight className="h-5 w-5 opacity-0 transition group-hover:opacity-60" />
                )}
              </h2>
              <p className="mt-1.5 truncate text-[13px] text-white/60">
                {advice}
                {onOpenWeather && (
                  <span className="ml-1.5 hidden text-white/35 underline decoration-white/20 underline-offset-2 group-hover:text-white/60 sm:inline">
                    {t('nightHero.hourByHour')}
                  </span>
                )}
              </p>
              {/* Cloud/dew were previously appended to the verdict sentence with
                  " · ", which read as one run-on line and truncated the dew
                  warning off-screen first on narrow panels. Broken out as their
                  own scannable stats so each is visible on its own. */}
              {conditions && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <StatChip icon={CloudSun}>{t('nightHero.cloudPercent', { percent: conditions.cloudCover })}</StatChip>
                  {conditions.dewRisk && (
                    <StatChip icon={Droplets} tone="warn">{t('nightHero.dewRisk')}</StatChip>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Moon. Fixed width so a longer phase name or rise/set string (e.g.
              "Waxing Crescent" vs "New Moon") never changes how much space
              this block claims — without it, the flex-1 rating block to its
              left absorbs the difference and the Moon visibly jumps
              left/right as you step between nights.

              w-64, and the times on their own line that is allowed to wrap. At
              w-52 with everything on one truncated line, "32% lit, sets 10:12
              PM" was cut to "...sets 10:1", which is worse than useless: a
              half-printed time reads as a real one. The label above already
              says Moon, so the percentage does not repeat it. */}
          <div className="flex w-full shrink-0 items-center gap-3 sm:w-64">
            <MoonDisk illumination={moonIllumination} phase={moonPhase} size={50} />
            <div className="min-w-0 leading-tight">
              <div className="text-[10.5px] font-medium uppercase tracking-[0.18em] text-white/40">{t('nightHero.moon')}</div>
              <div className="mt-1 truncate text-sm font-semibold text-white">{translateMoonPhase(t, moonPhase)}</div>
              <div className="mt-0.5 text-xs text-white/45 tabular-nums">
                {t('nightHero.litPercent', { percent: Math.round(moonIllumination) })}
              </div>
              {moonTimes && (
                <div className="mt-1 text-[11px] text-white/40 tabular-nums">{moonTimes}</div>
              )}
              {filterAdvice && (
                <div
                  className={`mt-1 text-[11px] font-medium ${
                    filterAdvice.kind === 'broadband' ? 'text-emerald-300/90' : filterAdvice.kind === 'narrowband' ? 'text-violet-300/90' : 'text-sky-300/90'
                  }`}
                  title={t('nightHero.filterAdviceTitle')}
                >
                  {filterAdvice.kind === 'broadbandUntil' || filterAdvice.kind === 'broadbandFrom'
                    ? t(`nightHero.filterAdvice.${filterAdvice.kind}`, { time: fmt(filterAdvice.at) })
                    : t(`nightHero.filterAdvice.${filterAdvice.kind}`)}
                </div>
              )}
            </div>
          </div>

          {/* The one action that belongs to the night itself. Everything else the
              planner can do sits in the page menu, since it is not about tonight. */}
          {canAutoPlan && (
            <button
              onClick={onAutoPlan}
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:brightness-110"
              style={{ background: accent, boxShadow: `0 8px 24px -12px ${accent}` }}
            >
              <Sparkles className="h-4 w-4" />
              {t('nightHero.planMyNight')}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function StatChip({
  icon: Icon,
  tone = 'neutral',
  children,
}: {
  icon: typeof CloudSun;
  tone?: 'neutral' | 'warn';
  children: ReactNode;
}) {
  const cls = tone === 'warn'
    ? 'bg-amber-500/15 text-amber-300 ring-amber-400/25'
    : 'bg-white/[0.06] text-white/60 ring-white/10';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${cls}`}>
      <Icon className="h-3 w-3" />
      {children}
    </span>
  );
}
