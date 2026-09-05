/**
 * Full-height catalog panel used on the Catalogs hub.
 *
 * Each panel is a tall poster for one observing program: a deep-sky hero
 * image behind a dark scrim, the story of the catalog, and live progress
 * pulled from the user's library.
 */
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import type { ByTypeStats, ObjectClass } from '../../lib/api/catalogs';
import type { CatalogMeta } from '../../lib/catalogMeta';
import { CatalogHeroImage } from './CatalogHeroImage';

interface Props {
  meta: CatalogMeta;
  progress: { imagedCount: number; byType: ByTypeStats } | undefined;
  isLoading: boolean;
  accent: string;
}

const TYPE_META: Record<ObjectClass, { label: string; dot: string }> = {
  galaxy:  { label: 'Galaxies', dot: '#a78bfa' },
  nebula:  { label: 'Nebulae',  dot: '#22d3ee' },
  cluster: { label: 'Clusters', dot: '#fbbf24' },
  other:   { label: 'Other',    dot: '#94a3b8' },
};

const TYPE_ORDER: ObjectClass[] = ['galaxy', 'nebula', 'cluster', 'other'];

/** Poster-sized crop of the catalog's signature object. */
const HERO_WIDTH = 760;
const HERO_HEIGHT = 1140;

export function CatalogPanel({ meta, progress, isLoading, accent }: Props) {
  const imaged = progress?.imagedCount ?? 0;
  const pct = meta.total > 0 ? Math.round((imaged / meta.total) * 100) : 0;
  const remaining = meta.total - imaged;

  return (
    <Link
      to={`/catalogs/${meta.id}`}
      aria-label={`${meta.label} catalog, ${imaged} of ${meta.total} objects imaged`}
      className="group relative flex flex-col overflow-hidden rounded-3xl bg-slate-950
        min-h-[30rem] lg:h-[calc(100vh-22rem)] lg:min-h-[30rem] lg:max-h-[38rem]
        transition-transform duration-300 ease-out hover:-translate-y-1
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
      style={{ boxShadow: '0 24px 60px -30px rgba(0,0,0,0.9)' }}
    >
      {/* Hero imagery */}
      <div className="absolute inset-0 overflow-hidden">
        <CatalogHeroImage
          ids={meta.heroIds}
          width={HERO_WIDTH}
          height={HERO_HEIGHT}
          className="saturate-125 contrast-[1.08] brightness-[0.95]
            group-hover:scale-[1.06] group-hover:brightness-105"
        />
      </div>

      {/* Scrim: keeps every line of text readable over any sky field */}
      <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/80 to-slate-950/25" />
      <div className="absolute inset-0 bg-gradient-to-br from-slate-950/60 via-transparent to-transparent" />

      {/* Accent bloom that lifts on hover */}
      <div
        className="absolute inset-x-0 bottom-0 h-1/2 opacity-40 transition-opacity duration-500 group-hover:opacity-75"
        style={{ background: `radial-gradient(120% 80% at 50% 100%, ${accent}33 0%, transparent 70%)` }}
      />

      {/* Border, brightened to the accent on hover */}
      <div
        className="absolute inset-0 rounded-3xl transition-all duration-300 pointer-events-none"
        style={{ boxShadow: `inset 0 0 0 1px rgba(255,255,255,0.10)` }}
      />
      <div
        className="absolute inset-0 rounded-3xl opacity-0 transition-opacity duration-300 group-hover:opacity-100 pointer-events-none"
        style={{ boxShadow: `inset 0 0 0 1.5px ${accent}99` }}
      />

      {/* Content */}
      <div className="relative flex h-full flex-col p-6 sm:p-7">

        {/* Object count */}
        <div className="flex items-center justify-end">
          <span className="rounded-full bg-white/10 px-3 py-1 text-[11px] font-medium text-white/80 backdrop-blur-md ring-1 ring-inset ring-white/15">
            {meta.total} objects
          </span>
        </div>

        <div className="flex-1" />

        {/* Title block */}
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/55">
              {meta.credit}
            </div>
            <h2 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-white mt-1">
              {meta.label}
            </h2>
          </div>
          <div className="shrink-0 text-right leading-none">
            <div
              className="font-display text-4xl sm:text-5xl font-bold tabular-nums"
              style={{ color: accent, textShadow: `0 0 24px ${accent}59` }}
            >
              {isLoading ? '--' : pct}
              <span className="text-2xl align-top">%</span>
            </div>
          </div>
        </div>

        {/* Story. Fixed minimum keeps the titles on one line across panels. */}
        <p className="mt-3 min-h-[5.75rem] text-[13px] sm:text-sm leading-relaxed text-white/70">
          {meta.blurb}
        </p>

        {/* Progress bar */}
        <div className="mt-5">
          <div className="flex items-baseline justify-between text-[11px] mb-2">
            <span className="font-medium text-white/85 tabular-nums">
              {isLoading ? 'Loading progress' : `${imaged} of ${meta.total} imaged`}
            </span>
            <span className="text-white/45 tabular-nums">
              {isLoading ? '' : remaining === 0 ? 'Complete' : `${remaining} to go`}
            </span>
          </div>
          <div className={`h-2 rounded-full bg-white/10 overflow-hidden ${isLoading ? 'animate-pulse' : ''}`}>
            <div
              className="h-full rounded-full transition-all duration-700 ease-out"
              style={{
                width: `${pct}%`,
                background: `linear-gradient(90deg, ${accent}b3, ${accent})`,
                boxShadow: `0 0 14px ${accent}80`,
              }}
            />
          </div>
        </div>

        {/* Type breakdown */}
        <div className="mt-4 grid grid-cols-2 gap-1.5">
          {TYPE_ORDER.map((cls) => {
            const stats = progress?.byType[cls];
            if (!stats || stats.total === 0) return null;
            const { label, dot } = TYPE_META[cls];
            return (
              <span
                key={cls}
                className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.07] px-2.5 py-1 text-[11px] text-white/75 ring-1 ring-inset ring-white/10 backdrop-blur-md"
              >
                <span className="w-1.5 h-1.5 shrink-0 rounded-full" style={{ background: dot }} />
                {label}
                <span className="ml-auto tabular-nums text-white/50">{stats.imaged}/{stats.total}</span>
              </span>
            );
          })}
        </div>

        {/* Call to action */}
        <div className="mt-6 flex items-center gap-2 rounded-full bg-white/[0.07] px-4 py-2.5 text-sm font-semibold text-white ring-1 ring-inset ring-white/15 backdrop-blur-md transition-colors duration-300 group-hover:bg-white/15 w-fit">
          Open board
          <ArrowRight
            className="w-4 h-4 transition-transform duration-300 group-hover:translate-x-1"
            style={{ color: accent }}
          />
        </div>
      </div>
    </Link>
  );
}
