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
import { Images, Clapperboard } from 'lucide-react';
import { HeroBackdrop } from '../ui/HeroBackdrop';
import { PAGE_HERO } from '../../lib/heroImagery';
import type { LibraryImage } from '../../lib/api/library';

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
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

export function ImageGalleryHero({ images, accent, onLaunchPlanetarium, canLaunchPlanetarium }: Props) {
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
      spanLabel = from && to ? (from === to ? from : `${from} to ${to}`) : null;
    }
    return { total: images.length, objects: objectIds.size, processed: proc, favorites: favs, span: spanLabel };
  }, [images]);

  const empty = total === 0;

  const stats: { value: string; label: string }[] = [
    { value: total.toLocaleString(), label: total === 1 ? 'Image' : 'Images' },
    { value: objects.toLocaleString(), label: objects === 1 ? 'Object' : 'Objects' },
  ];
  if (processed > 0) stats.push({ value: processed.toLocaleString(), label: 'Processed' });
  if (favorites > 0) stats.push({ value: favorites.toLocaleString(), label: 'Favorites' });

  return (
    <section
      className="relative overflow-hidden rounded-3xl bg-slate-950 hero-panel"
    >
      <HeroBackdrop image={PAGE_HERO.gallery} />

      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{ background: `radial-gradient(90% 140% at 8% 0%, ${accent}1f 0%, transparent 60%)` }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{ background: `radial-gradient(70% 130% at 95% 100%, ${accent}14 0%, transparent 62%)` }}
      />
      <div
        className="pointer-events-none absolute inset-0 rounded-3xl"
        style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.10)' }}
      />

      <div className="relative flex flex-col gap-6 p-5 sm:p-7">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="font-display flex items-center gap-2.5 text-3xl font-bold tracking-tight text-white sm:text-4xl">
              <Images className="h-6 w-6 sm:h-7 sm:w-7" style={{ color: accent }} />
              Image Gallery
            </h1>
            <p className="mt-2 text-[13px] text-white/55">
              {empty ? 'No frames yet. Images appear here once your telescope captures are imported.' : (
                <>
                  Every frame from your library
                  {span && <span className="text-white/40"> · {span}</span>}
                </>
              )}
            </p>
          </div>

          {canLaunchPlanetarium && (
            <button
              onClick={onLaunchPlanetarium}
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:brightness-110"
              style={{ background: accent, boxShadow: `0 8px 24px -12px ${accent}` }}
            >
              <Clapperboard className="h-4 w-4" />
              Planetarium
            </button>
          )}
        </div>

        {!empty && (
          <div className="flex flex-wrap gap-x-8 gap-y-4">
            {stats.map(({ value, label }) => (
              <div key={label} className="min-w-0">
                <div className="font-display text-2xl font-bold leading-none tracking-tight text-white tabular-nums">
                  {value}
                </div>
                <div className="mt-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-white/45">
                  {label}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
