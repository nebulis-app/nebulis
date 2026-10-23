import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, FileDown, Play, Sparkles, Star, Undo2 } from 'lucide-react';
import { FitsThumbnail } from '../FitsThumbnail';
import { useTheme } from '../../hooks/useTheme';
import { nightSafeColor } from '../../lib/nightSafeColor';
import { formatDate } from '../../lib/formatLocale';
import { formatBytes } from '../../lib/utils';
import type { MediaItem } from '../../lib/api/library';
import { opensInViewer, TILE_DATE_FROM, TILE_WIDE_FROM, type TileSize } from './tileSizing';

function nightLabel(date: string | null): string | null {
  if (!date) return null;
  return formatDate(new Date(`${date}T12:00:00`), { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * One picture in the grid. No caption: the group header already names the
 * night, so a tile shows only what a picture cannot say for itself (a star if
 * it is a favorite, a format tag for FITS and TIFF, an outline when it is a
 * finished image), and the rest appears on hover.
 */
export const MediaTile = memo(function MediaTile({
  item, size, onOpen, onToggleFavorite, onMarkProcessed, onMarkUnprocessed,
}: {
  item: MediaItem;
  size: TileSize;
  onOpen: (item: MediaItem) => void;
  onToggleFavorite: (item: MediaItem) => void;
  /** Admin only. Offered on the telescope's own pictures, which can be promoted to a processed image. */
  onMarkProcessed?: (item: MediaItem) => void;
  /** Admin only. The undo of the above, on a processed picture a telescope picture can go back to. */
  onMarkUnprocessed?: (item: MediaItem) => void;
}) {
  const { t } = useTranslation('library');
  const { isDark, isNight } = useTheme();
  const [imgFailed, setImgFailed] = useState(false);

  const viewer = opensInViewer(item);
  const isVideo = item.kind === 'video';
  const aspect = size >= TILE_WIDE_FROM ? 'aspect-[4/3]' : 'aspect-square';
  const kindLabel = t(`objectMedia.kind.${item.kind}`);
  const night = nightLabel(item.date);
  // The small date in the corner: the night, else the day a processed file or project was added. Left off the compact tiles.
  const cornerDate = size >= TILE_DATE_FROM ? nightLabel(item.date ?? item.capturedAt?.slice(0, 10) ?? null) : null;
  const label = [kindLabel, night, item.telescope?.name].filter(Boolean).join(', ');
  const showFormat = item.format === 'FITS' || item.format === 'TIFF';
  const canMarkProcessed = !!onMarkProcessed && item.kind === 'telescope' && item.isImage && !item.isFits && !!item.date;
  const canMarkUnprocessed = !!onMarkUnprocessed && item.kind === 'processed' && item.isImage && !!item.recordId && !!item.date;
  const canFavorite = item.kind !== 'video' && (item.isImage || item.isFits);

  const surface = isDark ? 'bg-slate-800' : 'bg-slate-100';
  const outline = item.kind === 'processed' ? 'border border-accent-500/50' : '';

  const fileCard = (
    <div className={`flex h-full w-full flex-col items-center justify-center gap-2 ${isDark ? 'bg-slate-800/60' : 'bg-slate-100'}`}>
      {isVideo
        ? <Play className={`h-7 w-7 ${isDark ? 'text-slate-300' : 'text-slate-600'}`} />
        : <FileDown className={`h-6 w-6 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />}
      <span className={`font-mono text-[0.625rem] font-bold tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
        {item.format}
      </span>
    </div>
  );

  let picture: React.ReactNode;
  if (item.isFits && item.thumbUrl) {
    picture = <FitsThumbnail url={item.downloadUrl} thumbUrl={item.thumbUrl} stretch={1.0} isDark={isDark} />;
  } else if (!isVideo && item.thumbUrl && !imgFailed && (item.isImage || item.previewable)) {
    picture = (
      <img
        src={item.thumbUrl}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setImgFailed(true)}
        className="h-full w-full object-cover"
      />
    );
  } else {
    picture = fileCard;
  }

  const hoverBar = (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent p-2 pt-6 text-[0.6875rem] leading-tight text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      <div className="flex items-center gap-1.5">
        {item.telescope && (
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: nightSafeColor(item.telescope.color, isNight) }} />
        )}
        <span className="truncate font-medium">{item.title || night || item.name}</span>
      </div>
      {(item.exposure || item.filter || item.size > 0) && (
        <div className="truncate text-white/70">
          {[item.exposure, item.filter, item.size ? formatBytes(item.size) : null].filter(Boolean).join(' · ')}
        </div>
      )}
    </div>
  );

  const tileClass = `relative block w-full overflow-hidden rounded-xl ${aspect} ${surface} ${outline} text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500`;
  const external = isVideo && item.videoUrl && !/\.avi$/i.test(item.name) ? item.videoUrl : item.downloadUrl;

  return (
    <div className="group relative">
      {viewer ? (
        <button type="button" onClick={() => onOpen(item)} aria-label={label} className={tileClass}>
          {picture}
          {hoverBar}
        </button>
      ) : (
        <a
          href={external}
          target="_blank"
          rel="noreferrer"
          download={isVideo ? undefined : item.name}
          aria-label={label}
          className={tileClass}
        >
          {picture}
          {hoverBar}
        </a>
      )}

      {showFormat && (
        <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-black/55 px-1.5 py-0.5 font-mono text-[0.5625rem] font-bold tracking-wide text-white/90 group-hover:opacity-0">
          {item.format}
        </span>
      )}

      {cornerDate && (
        <span className="pointer-events-none absolute bottom-1.5 right-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[0.5625rem] font-medium tabular-nums text-white/90 group-hover:opacity-0">
          {cornerDate}
        </span>
      )}

      {canMarkProcessed && (
        <button
          type="button"
          onClick={() => onMarkProcessed(item)}
          aria-label={t('objectMedia.tile.markProcessed')}
          title={t('objectMedia.tile.markProcessed')}
          className="absolute right-9 top-1.5 rounded-full bg-black/45 p-1.5 text-white opacity-0 transition-opacity focus:opacity-100 focus-visible:ring-2 focus-visible:ring-accent-500 group-hover:opacity-100"
        >
          <Sparkles className="h-3.5 w-3.5" />
        </button>
      )}

      {canMarkUnprocessed && (
        <button
          type="button"
          onClick={() => onMarkUnprocessed(item)}
          aria-label={t('objectMedia.tile.markUnprocessed')}
          title={t('objectMedia.tile.markUnprocessed')}
          className="absolute right-9 top-1.5 rounded-full bg-black/45 p-1.5 text-white opacity-0 transition-opacity focus:opacity-100 focus-visible:ring-2 focus-visible:ring-accent-500 group-hover:opacity-100"
        >
          <Undo2 className="h-3.5 w-3.5" />
        </button>
      )}

      {canFavorite && (
        <button
          type="button"
          onClick={() => onToggleFavorite(item)}
          aria-pressed={item.isFavorite}
          aria-label={item.isFavorite ? t('objectMedia.tile.unfavorite') : t('objectMedia.tile.favorite')}
          title={item.isFavorite ? t('objectMedia.tile.unfavorite') : t('objectMedia.tile.favorite')}
          className={`absolute right-1.5 top-1.5 rounded-full bg-black/45 p-1.5 transition-opacity focus:opacity-100 focus-visible:ring-2 focus-visible:ring-accent-500 ${
            item.isFavorite ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
        >
          <Star className={`h-3.5 w-3.5 ${item.isFavorite ? 'fill-accent-400 text-accent-400' : 'text-white'}`} />
        </button>
      )}
    </div>
  );
});

/** A project archive is a bundle of files, not a picture, so it is a card. */
export function ProjectCard({ item }: { item: MediaItem }) {
  const { t } = useTranslation('library');
  const { isDark } = useTheme();
  return (
    <a
      href={item.downloadUrl}
      download={item.name}
      className={`group flex items-center gap-3 rounded-xl border p-3 transition-colors ${
        isDark ? 'border-slate-800 bg-slate-900 hover:border-slate-600' : 'border-slate-200 bg-white hover:border-slate-300'
      } focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500`}
    >
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg font-mono text-[0.625rem] font-bold ${
        isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-500'
      }`}>
        {item.format}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
          {item.title || item.name}
        </span>
        <span className="block truncate text-xs text-slate-500">
          {[item.software, formatBytes(item.size), nightLabel(item.capturedAt?.slice(0, 10) ?? null)].filter(Boolean).join(' · ')}
        </span>
      </span>
      <Download
        aria-label={t('objectMedia.tile.download')}
        className={`h-4 w-4 shrink-0 ${isDark ? 'text-slate-500 group-hover:text-slate-300' : 'text-slate-400 group-hover:text-slate-600'}`}
      />
    </a>
  );
}
