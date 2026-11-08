/**
 * Compact catalog panel used on the Catalogs hub.
 *
 * Each panel is a poster for one observing program: a deep-sky hero image
 * behind a dark scrim, a short story, and live progress from the user's
 * library. The grid shows several programs at once, so the panel stays
 * deliberately short; the full type breakdown lives on the board itself.
 */
import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getCatalogWall } from '../../lib/api/catalogs';
import { getLibraryFileThumbnailUrl } from '../../lib/api/library';
import type { CatalogMeta } from '../../lib/catalogMeta';
import { CatalogHeroImage } from './CatalogHeroImage';

interface Props {
  meta: CatalogMeta;
  progress: { imagedCount: number } | undefined;
  isLoading: boolean;
  accent: string;
}

/** Poster-sized crop of the catalog's signature object. */
const HERO_WIDTH = 760;
const HERO_HEIGHT = 1140;

export function CatalogPanel({ meta, progress, isLoading, accent }: Props) {
  const { t } = useTranslation('catalogs');
  const imaged = progress?.imagedCount ?? 0;
  const pct = meta.total > 0 ? Math.round((imaged / meta.total) * 100) : 0;
  const remaining = meta.total - imaged;
  const label = t(meta.labelKey);

  // The user's own pictures, for the "My <catalog>" pill's fan. Only asked for
  // once something is imaged, and shares its cache with the wall page.
  const wallQuery = useQuery({
    queryKey: ['catalog-wall', meta.id],
    queryFn: () => getCatalogWall(meta.id),
    enabled: imaged > 0,
    staleTime: 60_000,
  });
  // flatMap rather than filter so the narrowing survives: every fan tile is
  // known to carry an image, no non-null assertion needed at render time.
  const fan = (wallQuery.data?.tiles ?? [])
    .flatMap(x => (x.imaged && x.image ? [{ id: x.id, image: x.image }] : []))
    .sort((a, b) => Number(b.image.kind === 'processed') - Number(a.image.kind === 'processed'))
    .slice(0, 3);

  // A stretched link covers the card, so the "My catalog" pill can be a real
  // sibling link instead of an anchor nested inside an anchor.
  return (
    <div
      className="group relative flex flex-col overflow-hidden rounded-3xl bg-slate-950
        min-h-[18rem] sm:min-h-[19rem] lg:h-[21rem] lg:min-h-[19rem] lg:max-h-[23rem]
        transition-transform duration-300 ease-out hover:-translate-y-1"
      style={{ boxShadow: '0 24px 60px -30px rgba(0,0,0,0.9)' }}
    >
      <Link
        to={`/catalogs/${meta.id}`}
        aria-label={t('catalogPanel.ariaLabel', { label, imaged, total: meta.total })}
        className="absolute inset-0 z-10 rounded-3xl
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
      />
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
      <div className="pointer-events-none relative flex h-full flex-col p-4 sm:p-5">

        {/* Object count */}
        <div className="flex items-center justify-end">
          <span className="rounded-full bg-white/10 px-3 py-1 text-[0.6875rem] font-medium text-white/80 backdrop-blur-md ring-1 ring-inset ring-white/15">
            {t('catalogPanel.objectsCount', { count: meta.total })}
          </span>
        </div>

        <div className="flex-1" />

        {/* Title block */}
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[0.6875rem] font-medium uppercase tracking-[0.18em] text-white/55">
              {meta.credit}
            </div>
            <h2 className="font-display text-2xl sm:text-[1.7rem] font-bold tracking-tight text-white mt-1">
              {label}
            </h2>
          </div>
          <div className="shrink-0 text-right leading-none">
            <div
              className="font-display text-3xl sm:text-4xl font-bold tabular-nums"
              style={{ color: accent, textShadow: `0 0 24px ${accent}59` }}
            >
              {isLoading ? '--' : pct}
              <span className="text-xl align-top">%</span>
            </div>
          </div>
        </div>

        {/* Story. Two lines keeps every panel the same compact height. */}
        <p className="mt-2 min-h-[2.5rem] line-clamp-2 text-[0.75rem] sm:text-[0.8125rem] leading-relaxed text-white/70">
          {t(meta.blurbKey)}
        </p>

        {/* Progress bar */}
        <div className="mt-3">
          <div className="flex items-baseline justify-between text-[0.6875rem] mb-2">
            <span className="font-medium text-white/85 tabular-nums">
              {isLoading ? t('catalogPanel.loadingProgress') : t('catalogPanel.imagedOfTotal', { imaged, total: meta.total })}
            </span>
            <span className="text-white/45 tabular-nums">
              {isLoading ? '' : remaining === 0 ? t('catalogPanel.complete') : t('catalogPanel.toGo', { count: remaining })}
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

        {/* Call to action */}
        <div className="mt-3 flex items-center gap-2">
          <div className="flex items-center gap-2 rounded-full bg-white/[0.07] px-3.5 py-2 text-xs font-semibold text-white ring-1 ring-inset ring-white/15 backdrop-blur-md transition-colors duration-300 group-hover:bg-white/15 w-fit shrink-0">
            {t('catalogPanel.openBoard')}
            <ArrowRight
              className="w-4 h-4 transition-transform duration-300 group-hover:translate-x-1"
              style={{ color: accent }}
            />
          </div>

          {imaged > 0 && (
            <Link
              to={`/catalogs/${meta.id}/mine`}
              aria-label={t('catalogPanel.myCatalogAria', { label, count: imaged })}
              className="pointer-events-auto relative z-20 ml-auto flex min-w-0 items-center gap-1.5 rounded-full py-1 pl-1 pr-3 text-xs font-semibold text-white
                ring-1 ring-inset transition-colors duration-300 hover:bg-white/10
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              style={{ background: `${accent}1f`, '--tw-ring-color': `${accent}99` } as CSSProperties}
            >
              <span className="flex shrink-0 -space-x-2">
                {fan.slice(0, 1).map((tile, i) => (
                  <img
                    key={tile.id}
                    src={getLibraryFileThumbnailUrl(tile.image.path, 96, 96)}
                    alt=""
                    loading="lazy"
                    // Telescope frames are dark; lift them so the fan reads as pictures.
                    className="h-6 w-6 rounded-full object-cover ring-2 ring-white/40 brightness-150 contrast-110"
                    style={{ zIndex: 3 - i }}
                  />
                ))}
              </span>
              <span className="truncate">{t('catalogPanel.myCatalogShort')}</span>
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
