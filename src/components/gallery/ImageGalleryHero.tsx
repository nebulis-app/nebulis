/**
 * Banner for the image gallery.
 *
 * The page is a wall of frames, so the hero does not repeat them as a mosaic.
 * It answers the questions the grid cannot: how many frames, of how many
 * objects, over what stretch of time, and how many have been processed or
 * starred. The one action that belongs to the whole gallery, Planetarium,
 * rides along here rather than floating beside the title.
 *
 * Dark in every theme, matching the Catalogs panels, the planner's night hero
 * and the observations record, which is also why it takes the bright `accent`
 * hex directly rather than `accent-*` utilities and styles its own text white.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Images, Clapperboard } from 'lucide-react';
import { CollapsibleHero, HeroSummary } from '../ui/CollapsibleHero';
import { PAGE_HERO } from '../../lib/heroImagery';
import type { LibraryImage } from '../../lib/api/library';
import { formatDate, formatNumber } from '../../lib/formatLocale';

interface Props {
  /** The full image set, before search and chip filters. The counts describe
   *  the whole gallery, so they do not move as the user narrows the grid. */
  images: LibraryImage[];
  accent: string;
  onLaunchPlanetarium: () => void;
  canLaunchPlanetarium: boolean;
}

/** `YYYY-MM-DD` (or any parseable date) as "Mar 2024". */
function monthYear(date: string): string | null {
  const [y, m] = date.split('-').map(Number);
  if (!y || !m) return null;
  return formatDate(new Date(y, m - 1, 1), { month: 'short', year: 'numeric' });
}

export function ImageGalleryHero({ images, accent, onLaunchPlanetarium, canLaunchPlanetarium }: Props) {
  const { t } = useTranslation('library');
  const { total, objects, processed, favorites, span } = useMemo(() => {
    const objectIds = new Set<string>();
    let proc = 0;
    let favs = 0;
    let min: string | null = null;
    let max: string | null = null;
    for (const img of images) {
      if (img.objectId) objectIds.add(img.objectId);
      if (img.isProcessed) proc += 1;
      if (img.isFavorite) favs += 1;
      if (img.date) {
        if (min === null || img.date < min) min = img.date;
        if (max === null || img.date > max) max = img.date;
      }
    }
    let spanLabel: string | null = null;
    if (min && max) {
      const from = monthYear(min);
      const to = monthYear(max);
      spanLabel = from && to ? (from === to ? from : t('galleryHero.spanRange', { from, to })) : null;
    }
    return { total: images.length, objects: objectIds.size, processed: proc, favorites: favs, span: spanLabel };
  }, [images, t]);

  const empty = total === 0;

  const stats: { value: string; label: string }[] = [
    { value: formatNumber(total), label: t('galleryHero.images', { count: total }) },
    { value: formatNumber(objects), label: t('galleryHero.objects', { count: objects }) },
  ];
  if (processed > 0) stats.push({ value: formatNumber(processed), label: t('galleryHero.processed') });
  if (favorites > 0) stats.push({ value: formatNumber(favorites), label: t('galleryHero.favorites') });

  const planetariumButton = canLaunchPlanetarium ? (
    <button
      onClick={onLaunchPlanetarium}
      className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full px-3 py-2 text-xs font-semibold text-slate-950 transition hover:brightness-110 sm:px-4 sm:py-2.5 sm:text-sm"
      style={{ background: accent, boxShadow: `0 8px 24px -12px ${accent}` }}
    >
      <Clapperboard className="h-4 w-4" />
      {t('galleryHero.planetarium')}
    </button>
  ) : null;

  return (
    <CollapsibleHero
      page="gallery"
      image={PAGE_HERO.gallery}
      accent={accent}
      icon={<Images className="h-5 w-5 sm:h-7 sm:w-7" style={{ color: accent }} />}
      title={t('galleryHero.title')}
      summary={empty ? undefined : <HeroSummary stats={stats} />}
      actions={planetariumButton}
      contentClassName="flex hero-min-h flex-col justify-center gap-6 p-4 sm:p-6"
    >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="font-display flex items-center gap-2.5 text-xl font-bold tracking-tight text-white sm:text-4xl">
              <Images className="h-5 w-5 sm:h-7 sm:w-7" style={{ color: accent }} />
              {t('galleryHero.title')}
            </h1>
            <p className="mt-2 hidden text-[0.8125rem] text-white/55 sm:block">
              {empty ? t('galleryHero.empty') : (
                <>
                  {t('galleryHero.everyFrame')}
                  {span && <span className="text-white/40"> · {span}</span>}
                </>
              )}
            </p>
          </div>

          {planetariumButton}
        </div>

        {!empty && (
          <div className="hidden flex-wrap gap-x-8 gap-y-4 sm:flex">
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
    </CollapsibleHero>
  );
}
