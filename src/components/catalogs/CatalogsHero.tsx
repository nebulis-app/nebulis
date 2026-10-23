/**
 * Banner for the Catalogs hub.
 *
 * The page is a grid of per-program progress panels, so the hero does not
 * repeat them. It answers the one thing the grid makes you add up in your
 * head: across every program, how far along are you? A progress ring on the
 * right carries that at a glance, with the two raw counts beside the title.
 *
 * Dark in every theme, matching the Catalogs panels themselves, the planner's
 * night hero and the observations record, which is why it takes the bright
 * `accent` hex directly rather than `accent-*` utilities and styles its own
 * text white.
 */
import { BookOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CollapsibleHero, HeroSummary } from '../ui/CollapsibleHero';
import { PAGE_HERO } from '../../lib/heroImagery';
import { formatNumber } from '../../lib/formatLocale';
import { useTheme } from '../../hooks/useTheme';

interface Props {
  /** Unique objects imaged across every program (payload already deduped on
   *  the shared NGC id, so a target in two catalogs counts once). */
  imaged: number;
  /** Unique objects across every program. */
  total: number;
  /** `imaged / total` as a whole percentage. */
  pct: number;
  /** False until every program's progress query has resolved. */
  loaded: boolean;
  accent: string;
}

/** Circular imaged/total gauge. The percentage sits in the middle because a
 *  ring on its own can't be read to any precision. */
function ProgressRing({ pct, accent, className = '' }: { pct: number; accent: string; className?: string }) {
  const { t } = useTranslation('catalogs');
  const { isNight } = useTheme();
  const r = 46;
  const circumference = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <svg
      viewBox="0 0 112 112"
      className={`h-24 w-24 shrink-0 sm:h-28 sm:w-28 ${className}`}
      role="img"
      aria-label={t('catalogsHero.percentImagedAriaLabel', { percent: clamped })}
    >
      <circle cx="56" cy="56" r={r} fill="none" stroke={isNight ? 'rgba(204,51,51,0.14)' : 'rgba(255,255,255,0.14)'} strokeWidth="10" />
      <circle
        cx="56"
        cy="56"
        r={r}
        fill="none"
        stroke={accent}
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - clamped / 100)}
        transform="rotate(-90 56 56)"
        style={{ transition: 'stroke-dashoffset 700ms ease-out' }}
      />
      <text
        x="56"
        y="56"
        textAnchor="middle"
        dominantBaseline="central"
        fill={isNight ? '#dd3333' : '#fff'}
        fontSize="23"
        className="font-display font-bold tabular-nums"
      >
        {clamped}%
      </text>
    </svg>
  );
}

export function CatalogsHero({ imaged, total, pct, loaded, accent }: Props) {
  const { t } = useTranslation('catalogs');
  const stats: { value: string; label: string }[] = [
    { value: formatNumber(imaged), label: t('catalogsHero.imaged') },
    { value: formatNumber(total), label: t('catalogsHero.catalogObjects') },
  ];

  return (
    <CollapsibleHero
      page="catalogs"
      image={PAGE_HERO.catalogs}
      accent={accent}
      icon={<BookOpen className="h-5 w-5 sm:h-7 sm:w-7" style={{ color: accent }} />}
      title={t('catalogsHero.title')}
      summary={loaded ? <HeroSummary stats={stats} /> : undefined}
      contentClassName="flex hero-min-h flex-col justify-center gap-6 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-6"
    >
        <div className="min-w-0">
          <h1 className="font-display flex items-center gap-2.5 text-xl font-bold tracking-tight text-white sm:text-4xl">
            <BookOpen className="h-5 w-5 sm:h-7 sm:w-7" style={{ color: accent }} />
            {t('catalogsHero.title')}
          </h1>
          <p className="mt-2 text-[0.8125rem] text-white/55">
            {t('catalogsHero.subtitle')}
          </p>

          {loaded && (
            <div className="mt-6 hidden flex-wrap items-end gap-x-12 gap-y-4 sm:flex sm:gap-x-16">
              {stats.map(({ value, label }) => (
                <div key={label} className="min-w-0">
                  <div className="font-display text-2xl font-bold leading-none tracking-tight text-white tabular-nums">
                    {value}
                  </div>
                  <div className="mt-1.5 text-[0.625rem] font-medium uppercase tracking-[0.14em] text-white/45">
                    {label}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {loaded && <ProgressRing pct={pct} accent={accent} className="hidden sm:block" />}
    </CollapsibleHero>
  );
}
