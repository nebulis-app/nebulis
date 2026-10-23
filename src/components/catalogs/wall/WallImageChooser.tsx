/**
 * Pick which of the user's own pictures a tile shows, then frame it: the same
 * drag-the-box, zoom and pan framer the object page uses, with the box fixed to
 * the tile's shape. Only the object's own images are offered, never a survey
 * image.
 */
import { useEffect, useState } from 'react';
import { useQuery, skipToken } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { getWallImageChoices, type WallSpan, type WallTile } from '../../../lib/api/catalogs';
import { getLibraryFileThumbnailUrl } from '../../../lib/api/library';
import type { WallOverride } from '../../../lib/catalogWallOverrides';
import { tileLabel } from '../../../lib/catalogWallTile';
import { wallCropStyle } from '../../../lib/catalogWallCrop';
import { ImageFramer } from '../../ImageFramer';
import type { GalleryCrop } from '../../../types';

interface Props {
  tile: WallTile;
  /** The span the tile occupies now, so the frame has the right shape. */
  span: WallSpan;
  value: WallOverride | undefined;
  accent: string;
  onChange: (patch: Pick<WallOverride, 'imagePath' | 'focus' | 'zoom'>) => void;
  onClose: () => void;
}

export function WallImageChooser({ tile, span, value, accent, onChange, onClose }: Props) {
  const { t } = useTranslation('catalogs');
  const objectId = tile.libraryObjectId;
  const choices = useQuery({
    queryKey: ['wall-image-choices', objectId],
    queryFn: objectId ? () => getWallImageChoices(objectId) : skipToken,
    enabled: !!objectId,
    staleTime: 30_000,
  });

  const current = value?.imagePath ?? tile.image?.path ?? null;
  const focus = value?.focus ?? { x: 0.5, y: 0.5 };
  const zoom = value?.zoom ?? 1;
  const crop: GalleryCrop | null = value?.focus || value?.zoom ? { x: focus.x, y: focus.y, zoom } : null;
  const [measured, setMeasured] = useState<number | null>(null);
  const aspect = measured ?? choices.data?.find(c => c.path === current)?.aspect ?? tile.image?.aspect ?? 1;
  const frameAspect = span.cols / span.rows;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const pick = (path: string) => {
    // Picking the automatic choice again clears the override; a new picture also
    // resets the framing, since the old point means nothing on a different frame.
    setMeasured(null);
    onChange({ imagePath: path === tile.image?.path ? undefined : path, focus: undefined, zoom: undefined });
  };

  const setCrop = (next: GalleryCrop | null) => {
    onChange({
      imagePath: value?.imagePath,
      focus: next ? { x: Math.round(next.x * 1000) / 1000, y: Math.round(next.y * 1000) / 1000 } : undefined,
      zoom: next ? Math.round(next.zoom * 100) / 100 : undefined,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-label={t('wall.edit.chooseImage')}>
      <div className="flex max-h-[94vh] w-full max-w-4xl flex-col overflow-hidden rounded-t-3xl bg-slate-950 ring-1 ring-white/15 sm:rounded-3xl">
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-3">
          <div className="min-w-0">
            <div className="truncate font-display text-base font-semibold text-white">{tileLabel(tile)}</div>
            <div className="truncate text-xs text-white/50">{tile.name}</div>
          </div>
          <button type="button" onClick={onClose} aria-label={t('wall.edit.close')} className="rounded-full p-1.5 text-white/70 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto p-5 md:grid-cols-[1fr_13rem]">
          <div className="min-w-0">
            <p className="mb-2 text-xs text-white/55">{t('wall.edit.focusHint')}</p>
            {current ? (
              <ImageFramer
                key={current}
                src={getLibraryFileThumbnailUrl(current, 1600, 1600)}
                crop={crop}
                onChange={setCrop}
                isDark
                frameAspect={frameAspect}
                onAspect={setMeasured}
                hint={t('wall.edit.frameHint')}
              />
            ) : (
              <p className="text-sm text-white/50">{t('wall.edit.noImages')}</p>
            )}
          </div>

          <div>
            <p className="mb-2 text-xs text-white/55">{t('wall.edit.cropPreview', { cols: span.cols, rows: span.rows })}</p>
            {current && (
              <div
                className="relative overflow-hidden rounded-lg bg-black ring-1 ring-white/15 [container-type:size]"
                style={{ aspectRatio: `${span.cols} / ${span.rows}`, maxWidth: '100%' }}
              >
                <img
                  src={getLibraryFileThumbnailUrl(current, 960, 960)}
                  alt=""
                  style={wallCropStyle(aspect, focus, zoom)}
                />
              </div>
            )}
          </div>
        </div>

        <div className="border-t border-white/10 px-5 py-3">
          <div className="mb-2 text-xs font-medium text-white/60">{t('wall.edit.yourImages')}</div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {(choices.data ?? []).map(c => {
              const active = c.path === current;
              return (
                <button
                  key={c.path}
                  type="button"
                  onClick={() => pick(c.path)}
                  aria-pressed={active}
                  title={c.label}
                  className="relative h-20 w-28 shrink-0 overflow-hidden rounded-lg ring-1 ring-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                  style={active ? { boxShadow: `0 0 0 2px ${accent}` } : undefined}
                >
                  <img src={getLibraryFileThumbnailUrl(c.path, 200, 200)} alt="" className="h-full w-full object-cover" loading="lazy" />
                  <span className="absolute inset-x-0 bottom-0 truncate bg-black/65 px-1 py-0.5 text-center text-[0.5rem] font-semibold uppercase tracking-wide text-white/85">
                    {(c.path.split('.').pop() ?? '').toUpperCase()} · {c.kind === 'processed' ? t('wall.processed') : t('wall.telescope')}
                  </span>
                </button>
              );
            })}
            {choices.isLoading && <span className="text-xs text-white/40">…</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
