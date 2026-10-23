import { Ban, Check, Download, Heart, Loader2, Pencil, Share2, Star, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AnnotateQuality } from '../../lib/api/annotate';
import { AnnotateIcon } from './AnnotateIcon';
import { QUALITY_DOT } from './annotateStyle';
import { LB_ACTIVE, LB_DANGER_BTN, LB_ICON_BTN, LB_TEXT_BTN } from './chrome';

interface Props {
  /** Keep / reject a frame while paging through a night. */
  review?: { state: 'keep' | 'reject' | null; onToggle: (decision: 'keep' | 'reject') => void };
  /** Text button that opens the FITS header. */
  onFitsHeader?: () => void;
  onEdit?: () => void;
  favorite?: { isFavorite: boolean; onToggle: () => void };
  share?: { busy: boolean; onShare: () => void };
  download: { href: string; fileName: string; onClick: (e: React.MouseEvent) => void };
  setAsGallery?: { busy: boolean; onClick: () => void };
  remove?: { busy: boolean; onClick: () => void };
}

/**
 * The button row every image viewer shows, in one fixed order. Each viewer passes
 * only the actions it supports, so the toolbar looks the same wherever a picture
 * is opened and a new action is added in one place.
 */
export function LightboxActions({
  review, onFitsHeader, onEdit, favorite, share, download, setAsGallery, remove,
}: Props) {
  const { t } = useTranslation('library');
  return (
    <>
      {review && (
        <>
          <button
            type="button"
            onClick={() => review.onToggle('keep')}
            aria-pressed={review.state === 'keep'}
            title={t('galleryModal.keepFrame')}
            aria-label={t('galleryModal.keepFrame')}
            className={`${LB_ICON_BTN} ${review.state === 'keep' ? LB_ACTIVE : ''}`}
          >
            <Check className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => review.onToggle('reject')}
            aria-pressed={review.state === 'reject'}
            title={t('galleryModal.rejectFrame')}
            aria-label={t('galleryModal.rejectFrame')}
            className={`${LB_ICON_BTN} ${review.state === 'reject' ? LB_ACTIVE : ''}`}
          >
            <Ban className="h-4 w-4" />
          </button>
        </>
      )}

      {onFitsHeader && (
        <button type="button" onClick={onFitsHeader} className={`${LB_TEXT_BTN} text-teal-300 hover:text-teal-200`}>
          {t('galleryModal.fitsHeader')}
        </button>
      )}

      {onEdit && (
        <button type="button" onClick={onEdit} title={t('galleryModal.editImage')} aria-label={t('galleryModal.editImage')} className={LB_ICON_BTN}>
          <Pencil className="h-4 w-4" />
        </button>
      )}

      {favorite && (
        <button
          type="button"
          onClick={favorite.onToggle}
          title={favorite.isFavorite ? t('imageViewer.removeFromFavoritesKey') : t('imageViewer.addToFavoritesKey')}
          aria-label={favorite.isFavorite ? t('imageViewer.removeFromFavorites') : t('imageViewer.addToFavorites')}
          aria-pressed={favorite.isFavorite}
          className={`${LB_ICON_BTN} ${favorite.isFavorite ? 'text-rose-400 hover:text-rose-300' : ''}`}
        >
          <Heart className={`h-4 w-4 ${favorite.isFavorite ? 'fill-current' : ''}`} />
        </button>
      )}

      {share && (
        <button type="button" onClick={share.onShare} disabled={share.busy} title={t('imageViewer.share')} aria-label={t('imageViewer.share')} className={LB_ICON_BTN}>
          {share.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
        </button>
      )}

      <a
        href={download.href}
        download={download.fileName}
        onClick={download.onClick}
        title={t('imageViewer.downloadKey')}
        aria-label={t('imageViewer.download')}
        className={LB_ICON_BTN}
      >
        <Download className="h-4 w-4" />
      </a>

      {setAsGallery && (
        <button
          type="button"
          onClick={setAsGallery.onClick}
          disabled={setAsGallery.busy}
          title={t('objectDetail.processedSection.setAsGallery')}
          aria-label={t('objectDetail.processedSection.setAsGallery')}
          className={LB_ICON_BTN}
        >
          {setAsGallery.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Star className="h-4 w-4" />}
        </button>
      )}

      {remove && (
        <>
        {/* A gap before the one destructive action, so it is not hit by a slip on Download. */}
        <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-white/15" />
        <button
          type="button"
          onClick={remove.onClick}
          disabled={remove.busy}
          title={t('objectDetail.processedSection.delete')}
          aria-label={t('objectDetail.processedSection.delete')}
          className={LB_DANGER_BTN}
        >
          {remove.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        </button>
        </>
      )}
    </>
  );
}

/** Toggle for the object-ring overlay. Belongs with the viewing controls, not the file actions. */
export function AnnotateToggle({ active, quality, onToggle }: { active: boolean; quality: AnnotateQuality | null; onToggle: () => void }) {
  const { t } = useTranslation('library');
  return (
    <button
      type="button"
      onClick={onToggle}
      title={active ? t('annotate.toggleHide') : t('annotate.toggle')}
      aria-label={active ? t('annotate.toggleHide') : t('annotate.toggle')}
      aria-pressed={active}
      className={`${LB_ICON_BTN} relative ${active ? LB_ACTIVE : ''}`}
    >
      <AnnotateIcon className="h-4 w-4" />
      {active && quality && (
        <span aria-hidden="true" data-annotation-dot="" className={`absolute right-1 top-1 h-2 w-2 rounded-full ring-1 ring-black/50 ${QUALITY_DOT[quality]}`} />
      )}
    </button>
  );
}
