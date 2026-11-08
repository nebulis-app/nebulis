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
import { useEffect, useRef, useState } from 'react';
import { BookOpen, Check, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CollapsibleHero, HeroSummary } from '../ui/CollapsibleHero';
import { PAGE_HERO } from '../../lib/heroImagery';
import { formatNumber } from '../../lib/formatLocale';
import { useTheme } from '../../hooks/useTheme';
import type { CatalogMeta } from '../../lib/catalogMeta';

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
  /** Every catalog the filter can switch on or off. */
  catalogs: CatalogMeta[];
  /** Catalogs currently hidden by the user. */
  hidden: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onShowAll: () => void;
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

/** Dropdown filter: one row per catalog with a checkbox, plus Show all. */
function CatalogFilterMenu({
  catalogs,
  hidden,
  accent,
  onToggle,
  onShowAll,
}: Pick<Props, 'catalogs' | 'hidden' | 'accent' | 'onToggle' | 'onShowAll'>) {
  const { t } = useTranslation('catalogs');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const selected = catalogs.length - hidden.size;
  const label =
    hidden.size === 0
      ? t('catalogsHero.filterAll')
      : selected === 1
        ? t(catalogs.find((c) => !hidden.has(c.id))!.labelKey)
        : t('catalogsHero.filterCount', { selected, total: catalogs.length });

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        aria-haspopup="true"
        aria-label={t('catalogsHero.filterLabel')}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-w-[12rem] items-center justify-between gap-3 rounded-lg bg-white/10 px-3 py-1.5 text-[0.8125rem] font-medium text-white ring-1 ring-inset ring-white/25 transition-colors hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      >
        <span className="truncate">{label}</span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-white/60 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1.5 w-64 overflow-hidden rounded-xl bg-slate-900/95 py-1 shadow-xl ring-1 ring-white/15 backdrop-blur">
          {catalogs.map((c) => {
            const on = !hidden.has(c.id);
            return (
              <label
                key={c.id}
                className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-[0.8125rem] text-white/90 hover:bg-white/10"
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => onToggle(c.id)}
                  className="sr-only peer"
                />
                <span
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] ring-1 ring-inset ring-white/30 peer-focus-visible:ring-2 peer-focus-visible:ring-white"
                  style={on ? { background: accent } : undefined}
                >
                  {on && <Check className="h-3 w-3 text-slate-950" strokeWidth={3.5} />}
                </span>
                {t(c.labelKey)}
              </label>
            );
          })}
          {hidden.size > 0 && (
            <button
              type="button"
              onClick={onShowAll}
              className="w-full border-t border-white/10 px-3 py-2 text-left text-[0.75rem] font-medium text-white/65 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/70"
            >
              {t('catalogsHero.filterShowAll')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function CatalogsHero({ imaged, total, pct, loaded, accent, catalogs, hidden, onToggle, onShowAll }: Props) {
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

          <div className="mt-5 flex flex-wrap items-end gap-x-12 gap-y-4 sm:gap-x-16">
            {loaded &&
              stats.map(({ value, label }) => (
                <div key={label} className="TAG min-w-0 hidden sm:block">
                  <div className="font-display text-2xl font-bold leading-none tracking-tight text-white tabular-nums">
                    {value}
                  </div>
                  <div className="mt-1.5 text-[0.625rem] font-medium uppercase tracking-[0.14em] text-white/45">
                    {label}
                  </div>
                </div>
              ))}
            <CatalogFilterMenu
              catalogs={catalogs}
              hidden={hidden}
              accent={accent}
              onToggle={onToggle}
              onShowAll={onShowAll}
            />
          </div>
        </div>

        {loaded && <ProgressRing pct={pct} accent={accent} className="hidden sm:block" />}
    </CollapsibleHero>
  );
}
