import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Image } from 'lucide-react';
import { getLibraryFileThumbnailUrl, deleteLibraryFile, type LibraryImage } from '../../lib/api/library';
import { isLinkedPath } from '../../lib/linkedPaths';
import { LightboxFrame, LightboxPane } from '../lightbox/LightboxFrame';
import { LightboxImage } from '../lightbox/LightboxImage';
import { useZoomPan } from '../lightbox/useZoomPan';
import { zoomControlsFromPan } from '../lightbox/zoomControls';
import { useLightboxKeys } from '../lightbox/useLightboxKeys';
import { useAdjacentPreload } from '../lightbox/useAdjacentPreload';
import { shareImage, shareOutcomeMessage } from '../lightbox/shareImage';
import { useAnnotatedExport } from '../lightbox/useAnnotatedExport';
import { AnnotationOverlay } from '../lightbox/AnnotationOverlay';
import { LightboxActions, AnnotateToggle } from '../lightbox/LightboxActions';
import { AnnotationDock } from '../lightbox/AnnotationDock';
import { useDockReserve } from '../lightbox/dockReserve';
import { fadesEstimate, zoomRatio } from '../../lib/annotateFade';
import { AnnotationInfoCard } from '../lightbox/AnnotationInfoCard';
import { useImageAnnotations } from '../lightbox/useImageAnnotations';
import type { ThumbEntry } from '../lightbox/LightboxThumbStrip';
import { ConfirmModal } from '../ConfirmModal';

interface ImageViewerProps {
  images: LibraryImage[];
  initialIndex: number;
  isAdmin: boolean;
  onClose: () => void;
  onToggleFavorite: (img: LibraryImage) => void;
  /** Opens the image editor on a picture. Omit to hide the Edit action. */
  onEditImage?: (img: LibraryImage) => void;
}

/**
 * Library-wide image viewer.
 *
 * Shares its chrome, zoom engine, keyboard handling, and thumbnail strip with
 * the observation viewer (`GalleryModal`) through `LightboxFrame`. The two used
 * to be separate implementations of the same thing and had drifted: only one
 * had wheel zoom, only one had a working thumbnail window, and neither was an
 * accessible dialog.
 */
export function ImageViewer({
  images: rawImages, initialIndex, isAdmin, onClose, onToggleFavorite, onEditImage,
}: ImageViewerProps) {
  const { t } = useTranslation('library');
  const queryClient = useQueryClient();
  const [rawIndex, setIndex] = useState(initialIndex);
  const [sharing, setSharing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // AstroBin-style fullscreen, left on across navigation like GalleryModal's.
  const [immersive, setImmersive] = useState(false);
  // Object rings and names over the picture. Left on across navigation, like
  // fullscreen, so paging through a night stays annotated.
  const [annotate, setAnnotate] = useState(false);

  // Deleted paths are hidden immediately rather than waiting on the parent's
  // query to refetch, the same reasoning GalleryModal's `localItems` snapshot
  // uses: without it, the just-deleted frame stays in the strip until the
  // invalidated `all-library-images` query resolves.
  const [removedPaths, setRemovedPaths] = useState<Set<string>>(() => new Set());
  const images = useMemo(
    () => rawImages.filter(img => !removedPaths.has(img.path)),
    [rawImages, removedPaths],
  );
  const [pendingDelete, setPendingDelete] = useState<LibraryImage | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);

  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((msg: string | null) => {
    if (statusTimer.current) clearTimeout(statusTimer.current);
    setStatus(msg);
    if (msg) statusTimer.current = setTimeout(() => setStatus(null), 3000);
  }, []);
  useEffect(() => () => { if (statusTimer.current) clearTimeout(statusTimer.current); }, []);

  // Derived rather than stored: clamps onto a sensible neighbour the instant
  // the list shrinks (a deletion here, or the parent's own list narrowing)
  // without a corrective setState-in-effect.
  const index = images.length === 0 ? 0 : Math.min(rawIndex, images.length - 1);

  // Closing is a real external effect (it tells the parent to unmount this
  // viewer), so it stays in an effect; nothing else here needs to be.
  useEffect(() => {
    if (images.length === 0) onClose();
  }, [images.length, onClose]);

  const zp = useZoomPan(index);
  const zoom = useMemo(() => zoomControlsFromPan(zp), [zp]);

  const image = images[index];
  const annotations = useImageAnnotations(image?.path, annotate);
  const selectedAnnotation = annotations.visibleData?.annotations.find(a => a.id === annotations.selectedId) ?? null;
  const dock = useDockReserve();
  // The tile is hidden once a zoomed picture leaves it no room, which is exactly when an estimate starts to look wrong,
  // so the first time the rings fade the reason is said once, as a brief notice.
  const estimateFaded = annotate && annotations.data?.quality === 'approximate'
    && fadesEstimate('approximate', zoomRatio(zp.zoom, zp.fitZoom));
  const wasFaded = useRef(false);
  useEffect(() => {
    if (estimateFaded && !wasFaded.current) flash(t('annotate.zoomedToast'));
    wasFaded.current = estimateFaded;
  }, [estimateFaded, flash, t]);

  // Display + preload the bounded 2048 px preview tier, never the raw original.
  // A processed TIFF master can be 100-200 MB and stalls the tab; even a large
  // stacked JPEG is a needless multi-MB decode. Download/Share still use
  // `downloadUrl` for the true file.
  const srcs = useMemo(() => images.map(i => i.previewUrl), [images]);
  useAdjacentPreload(srcs, index);

  const navigate = useCallback((dir: -1 | 1) => {
    setIndex(prev => {
      const next = prev + dir;
      return next < 0 || next >= images.length ? prev : next;
    });
  }, [images.length]);

  const handleShare = useCallback(async () => {
    if (!image) return;
    setSharing(true);
    try {
      const title = image.objectName || image.name;
      flash(shareOutcomeMessage(await shareImage(image.downloadUrl, image.name, title), {
        copiedImage: t('imageViewer.copiedImage'),
        copiedLink: t('imageViewer.copiedLink'),
        failed: t('imageViewer.shareFailed'),
      }));
    } finally {
      setSharing(false);
    }
  }, [image, flash, t]);

  const handleDownload = useCallback(() => {
    if (!image) return;
    const a = document.createElement('a');
    a.href = image.downloadUrl;
    a.download = image.name;
    a.click();
  }, [image]);

  const exporter = useAnnotatedExport({
    data: annotate ? annotations.visibleData : undefined,
    original: image ? { url: image.downloadUrl, name: image.name } : null,
    previewUrl: image?.previewUrl ?? null,
    title: image?.objectName || image?.name || '',
    plainDownload: handleDownload,
    plainShare: handleShare,
    flash,
  });

  const confirmDelete = useCallback(async () => {
    // Re-entry guard: the confirm dialog stays mounted through the request, so
    // a double-click would otherwise fire two DELETEs for the same path.
    if (deletingRef.current) return;
    const target = pendingDelete;
    if (!target) return;
    deletingRef.current = true;
    setDeleting(true);
    try {
      await deleteLibraryFile(target.path, { deleteLinked: isLinkedPath(target.path) });
      queryClient.invalidateQueries({ queryKey: ['all-library-images'] });
      queryClient.invalidateQueries({ queryKey: ['library-objects'] });
      setRemovedPaths(prev => new Set(prev).add(target.path));
      setPendingDelete(null);
    } catch (err) {
      flash(err instanceof Error ? err.message : t('galleryModal.deleteFailed'));
      setPendingDelete(null);
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  }, [pendingDelete, queryClient, flash, t]);

  const canDelete = isAdmin && !!image;

  useLightboxKeys({
    onPrev: () => navigate(-1),
    onNext: () => navigate(1),
    onFirst: () => setIndex(0),
    onLast: () => setIndex(images.length - 1),
    // Escape backs out of fullscreen first, then out of the viewer — see
    // GalleryModal's identical handling and LightboxFrame's effectiveOnClose.
    onClose: immersive
      ? () => setImmersive(false)
      : selectedAnnotation ? () => annotations.select(null) : onClose,
    onFit: zp.setFit,
    onActualSize: zp.setActualSize,
    onZoomIn: zoom.zoomIn,
    onZoomOut: zoom.zoomOut,
    onRotate: zp.rotate,
    onDownload: exporter.download,
    onDelete: canDelete ? () => setPendingDelete(image) : undefined,
    onToggleFavorite: image ? () => onToggleFavorite(image) : undefined,
    // Escape must reach the confirmation dialog, not tear down the viewer
    // underneath it.
    suspended: !!pendingDelete || exporter.asking,
  });

  const thumbs = useMemo<ThumbEntry[]>(() => images.map(img => ({
    key: img.path,
    label: `${img.objectName || img.name}${img.date !== 'unknown' ? `, ${img.date}` : ''}`,
    content: (
      <img
        src={getLibraryFileThumbnailUrl(img.path, 160, 160)}
        alt=""
        className="w-full h-full object-cover"
        loading="lazy"
      />
    ),
  })), [images]);

  if (!image) return null;

  const actions = (
    <LightboxActions
      onEdit={isAdmin && onEditImage && /\.(jpe?g|png|webp)$/i.test(image.name) ? () => onEditImage(image) : undefined}
      favorite={{ isFavorite: image.isFavorite, onToggle: () => onToggleFavorite(image) }}
      share={{ busy: sharing, onShare: exporter.share }}
      download={{
        href: image.downloadUrl,
        fileName: image.name,
        onClick: e => { if (exporter.burnable) { e.preventDefault(); exporter.download(); } },
      }}
      remove={canDelete ? { busy: deleting, onClick: () => setPendingDelete(image) } : undefined}
    />
  );

  const subtitle = [
    image.objectType,
    image.date !== 'unknown' ? image.date : null,
    image.name,
  ].filter(Boolean).join(' · ');

  const displayName = image.objectName || image.name;
  const title = image.objectId ? (
    <Link
      to={`/object/${encodeURIComponent(image.objectId)}`}
      title={t('imageViewer.goTo', { name: displayName })}
      className="transition-colors hover:text-accent-400 hover:underline underline-offset-2"
    >
      {displayName}
    </Link>
  ) : displayName;

  return (
    <>
      <LightboxFrame
        isOpen
        onClose={onClose}
        onEscape={selectedAnnotation ? () => annotations.select(null) : undefined}
        dialogTitle={t('imageViewer.dialogTitle', { name: displayName })}
        titleIcon={<Image className="h-4.5 w-4.5 flex-shrink-0 text-accent-400" />}
        title={title}
        subtitle={subtitle}
        index={index}
        count={images.length}
        onPrev={() => navigate(-1)}
        onNext={() => navigate(1)}
        onSelectIndex={setIndex}
        zoom={zoom}
        actions={actions}
        viewActions={<AnnotateToggle active={annotate} quality={annotations.data?.quality ?? null} onToggle={() => setAnnotate(v => !v)} />}
        immersive={immersive}
        onToggleImmersive={() => setImmersive(v => !v)}
        thumbs={thumbs}
        swipeDisabled={!zp.isFit}
        status={status}
        ambientSrc={getLibraryFileThumbnailUrl(image.path, 400, 400)}
        contentAspect={zp.natural
          ? (zp.rotation % 180 === 90 ? zp.natural.h / zp.natural.w : zp.natural.w / zp.natural.h)
          : null}
      >
        <LightboxPane
          zpRef={zp.containerRef}
          isPanning={zp.isPanning}
          canPan={zp.overflows}
          handlers={zp.paneHandlers}
          flush={immersive}
          reserve={dock.reserve}
        >
          <LightboxImage
            src={image.previewUrl}
            thumbSrc={getLibraryFileThumbnailUrl(image.path, 400, 400)}
            alt={image.objectName || image.name}
            zp={zp}
            overlay={annotate && annotations.visibleData
              ? <AnnotationOverlay data={annotations.visibleData} zp={zp} selectedId={annotations.selectedId} onSelect={annotations.select} />
              : null}
          />
          {annotate && selectedAnnotation && (
            <AnnotationInfoCard annotation={selectedAnnotation} onClose={() => annotations.select(null)} />
          )}
        </LightboxPane>
        {/* Sized to the free strip beside the picture, hidden when there is none: never over the picture, never moving it. */}
        {annotate && !immersive && (
          <AnnotationDock
            annotations={annotations}
            canInstall={isAdmin}
            zoomedPastEstimate={fadesEstimate('approximate', zoomRatio(zp.zoom, zp.fitZoom))}
            zp={zp}
            onReserve={dock.onReserve}
          />
        )}
      </LightboxFrame>

      {exporter.dialog}

      {pendingDelete && (
        <ConfirmModal
          title={t('galleryModal.deleteFileTitle')}
          message={t(isLinkedPath(pendingDelete.path) ? 'galleryModal.deleteLinkedFileMessage' : 'galleryModal.deleteFileMessage', { name: pendingDelete.name })}
          confirmLabel={deleting ? t('galleryModal.deleting') : t('objectDetail.processedSection.delete')}
          pending={deleting}
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
    </>
  );
}
