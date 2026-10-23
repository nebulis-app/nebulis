/**
 * One cell of the "My Catalog" wall.
 *
 * Imaged objects show the user's own picture and link to the object page.
 * Everything else is a dark cell carrying only the catalog number. The wall is
 * a night-side surface in every theme (same rule as the hub panels), so these
 * tiles style themselves with fixed dark values rather than theme tokens.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { WallTile as WallTileData } from '../../../lib/api/catalogs';
import { getLibraryFileThumbnailUrl } from '../../../lib/api/library';
import { tileLabel } from '../../../lib/catalogWallTile';
import { hasWallCrop, wallCropStyle } from '../../../lib/catalogWallCrop';

interface Props {
  tile: WallTileData;
  /** Cells the tile actually occupies after clamping to the column count. */
  cols: number;
  rows: number;
  accent: string;
  /** Focal point (0–1) for the image crop; centre when unset. */
  focus?: { x: number; y: number } | null;
  /** 1 = whole cover window; higher zooms in on `focus`. */
  zoom?: number | null;
  /** Edit mode: the tile is not a link, and the host renders controls over it. */
  editing?: boolean;
  onEmptyClick?: (tile: WallTileData, anchor: HTMLElement) => void;
}

/** Source-size ladder: small tiles stay light, big ones stay sharp. */
function thumbSize(cols: number, rows: number, zoom: number): number {
  const base = (cols * rows >= 4 ? 960 : cols * rows >= 2 ? 640 : 360) * Math.max(1, zoom);
  return base <= 360 ? 360 : base <= 640 ? 640 : base <= 960 ? 960 : 2048;
}

export function WallTile({ tile, cols, rows, accent, focus, zoom, editing, onEmptyClick }: Props) {
  const { t } = useTranslation('catalogs');
  const [loaded, setLoaded] = useState(false);
  // The picture's real shape, read once it loads: a chosen image can differ from the tile's default one.
  const [naturalAspect, setNaturalAspect] = useState<number | null>(null);
  const label = tileLabel(tile);
  const big = cols * rows >= 4;

  if (!tile.imaged || !tile.image) {
    return (
      <button
        type="button"
        onClick={e => onEmptyClick?.(tile, e.currentTarget)}
        aria-label={t('wall.emptyAria', { label })}
        className="group relative flex h-full w-full items-center justify-center overflow-hidden bg-[#07080d]
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/50"
      >
        <span
          className="absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
          style={{ background: `radial-gradient(80% 80% at 50% 50%, ${accent}1f 0%, transparent 70%)` }}
        />
        <span className="relative px-1 text-center font-display text-[0.8125rem] font-semibold leading-tight tracking-tight text-white/30 transition-colors group-hover:text-white/70 sm:text-sm">
          {label}
        </span>
      </button>
    );
  }

  const z = zoom ?? 1;
  const cropped = hasWallCrop(focus, z);
  const size = thumbSize(cols, rows, z);
  const src = getLibraryFileThumbnailUrl(tile.image.path, size, size);
  const body = (
    <>
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={e => {
          setLoaded(true);
          const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
          if (w && h) setNaturalAspect(w / h);
        }}
        className={`${cropped ? '' : 'absolute inset-0 h-full w-full object-cover'} transition-all duration-500 motion-reduce:transition-none
          ${loaded ? 'opacity-100' : 'opacity-0'}
          ${editing || cropped ? '' : 'group-hover:scale-[1.04] motion-reduce:group-hover:scale-100'}`}
        style={cropped ? wallCropStyle(naturalAspect ?? tile.image.aspect, focus ?? { x: 0.5, y: 0.5 }, z) : undefined}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/5 to-transparent opacity-80 transition-opacity duration-300 group-hover:opacity-100" />

      {/* Always-visible number */}
      <div className={`absolute inset-x-0 bottom-0 px-2 pb-1.5 transition-transform duration-300
        ${editing ? '' : 'group-hover:-translate-y-5'}`}>
        <span className="block truncate font-display text-[0.6875rem] font-semibold tracking-tight text-white drop-shadow sm:text-xs">
          {label}
        </span>
      </div>

      {/* Hover detail */}
      {!editing && (
        <div className="absolute inset-x-0 bottom-0 flex translate-y-1 items-center gap-1.5 px-2 pb-1.5 opacity-0 transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100">
          <span className="truncate text-[0.625rem] text-white/80">{tile.name}</span>
        </div>
      )}
      {big && !editing && (
        <span
          className="absolute right-2 top-2 rounded-full bg-black/45 px-2 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-wider text-white/85 opacity-0 ring-1 ring-inset ring-white/15 backdrop-blur-md transition-opacity duration-300 group-hover:opacity-100"
        >
          {tile.image.kind === 'processed' ? t('wall.processed') : t('wall.telescope')}
        </span>
      )}
      {tile.inFrame && (
        <span className="absolute left-2 top-2 rounded-full bg-black/45 px-2 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-wider text-white/80 ring-1 ring-inset ring-white/15 backdrop-blur-md">
          {t('wall.inFrame')}
        </span>
      )}
    </>
  );

  const cls = `group relative block h-full w-full overflow-hidden bg-slate-950 [container-type:size]
    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/60`;

  if (editing || !tile.libraryObjectId) {
    return <div className={cls}>{body}</div>;
  }
  return (
    <Link
      to={`/object/${encodeURIComponent(tile.libraryObjectId)}`}
      aria-label={t('wall.openObject', { name: tile.name || label })}
      title={`${label} · ${tile.name}`}
      className={cls}
    >
      {body}
    </Link>
  );
}
