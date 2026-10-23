import { useTranslation } from 'react-i18next';
import { useTheme } from '../../hooks/useTheme';
import type { MediaItem } from '../../lib/api/library';
import { MediaTile } from './MediaTile';
import type { TileSize } from './tileSizing';

/** Wide enough that MediaTile switches to 4:3, so a finished picture is not cropped hard. */
const FEATURED_TILE: TileSize = 260;

/**
 * The finished pictures, large, above the flat grid: of everything an object has,
 * these are the ones to look at first. The grid below no longer repeats them.
 */
export function FeaturedProcessed({ items, total, onOpen, onToggleFavorite, onMarkUnprocessed, onShowAll }: {
  items: MediaItem[];
  /** Every processed picture the object has, so "See all" appears only when more exist than shown. */
  total: number;
  onOpen: (item: MediaItem) => void;
  onToggleFavorite: (item: MediaItem) => void;
  onMarkUnprocessed?: (item: MediaItem) => void;
  onShowAll: () => void;
}) {
  const { t } = useTranslation('library');
  const { isDark } = useTheme();
  if (items.length === 0) return null;

  return (
    <section aria-label={t('objectMedia.featured.title')} className="space-y-2 pb-2">
      <div className="flex items-center gap-2">
        <h3 className={`text-xs font-medium uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          {t('objectMedia.featured.title')}
        </h3>
        {total > items.length && (
          <button
            type="button"
            onClick={onShowAll}
            className={`rounded text-xs font-medium hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${isDark ? 'text-accent-400' : 'text-accent-600'}`}
          >
            {t('objectMedia.featured.seeAll', { count: total })}
          </button>
        )}
      </div>
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${FEATURED_TILE}px, 1fr))` }}>
        {items.map(i => (
          <MediaTile key={i.id} item={i} size={FEATURED_TILE} onOpen={onOpen} onToggleFavorite={onToggleFavorite} onMarkUnprocessed={onMarkUnprocessed} />
        ))}
      </div>
    </section>
  );
}
