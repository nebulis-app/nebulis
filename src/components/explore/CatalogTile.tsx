import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CATALOG_ART } from '../../lib/exploreArt';
import { formatNumber } from '../../lib/formatLocale';
import { withNight } from './useExploreNight';
import type { ExploreCatalogId, ExploreCatalogStats } from '../../lib/api/explore';

/** Shown behind the tile until its picture has loaded. Catalog names are not translated. */
const CATALOG_TINTS: Record<ExploreCatalogId, string> = {
  messier: '#92400e',
  ngc: '#1e3a8a',
  ic: '#115e59',
  caldwell: '#334155',
  sharpless: '#9f1239',
};

interface Props {
  id: ExploreCatalogId;
  stats: ExploreCatalogStats | undefined;
  locationSet: boolean;
  /** Carried onto the results page so it keeps looking at the same night. */
  night?: string | null;
}

/** A browse tile for one catalog: the same shape, type and counts as a kind tile (CategoryTile), with a picture of an
 *  object that is in that catalog. */
export function CatalogTile({ id, stats, locationSet, night = null }: Props) {
  const { t } = useTranslation('catalogs');
  const label = t(`explore.catalogs.${id}`);
  const art = CATALOG_ART[id];

  return (
    <Link
      to={withNight(`/explore/all?catalog=${id}`, night)}
      className="group relative block aspect-[16/10] overflow-hidden rounded-2xl bg-slate-950 outline-none ring-offset-2 focus-visible:ring-2 focus-visible:ring-accent-500"
      style={{ backgroundColor: CATALOG_TINTS[id] }}
      aria-label={label}
    >
      <img
        src={art.src}
        alt=""
        title={`${art.label}. ${art.credit}`}
        loading="lazy"
        className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 group-hover:scale-105"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-black/10" />
      <div className="absolute inset-x-0 bottom-0 p-4">
        <h3 className="font-display text-xl font-bold leading-tight text-white drop-shadow sm:text-2xl">{label}</h3>
        <p className="mt-0.5 line-clamp-1 text-xs text-white/70">{t(`explore.catalogBlurb.${id}`)}</p>
        {stats && (
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[0.6875rem] font-medium uppercase tracking-wide text-white/80">
            <span>{t('explore.tile.total', { formatted: formatNumber(stats.total) })}</span>
            {locationSet && <span className="text-emerald-300">{t('explore.tile.visibleHere', { formatted: formatNumber(stats.visibleHere) })}</span>}
            {locationSet && stats.goodTonight > 0 && <span className="text-accent-300">{t('explore.tile.upTonight', { formatted: formatNumber(stats.goodTonight) })}</span>}
          </div>
        )}
      </div>
    </Link>
  );
}
