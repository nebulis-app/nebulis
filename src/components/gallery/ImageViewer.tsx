import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Image, Heart, Share2, Loader2 } from 'lucide-react';
import { getLibraryFileThumbnailUrl, type LibraryImage } from '../../lib/api/library';
import { LightboxFrame, LightboxPane } from '../lightbox/LightboxFrame';
import { LightboxImage } from '../lightbox/LightboxImage';
import { useZoomPan } from '../lightbox/useZoomPan';
import { zoomControlsFromPan } from '../lightbox/zoomControls';
import { useLightboxKeys } from '../lightbox/useLightboxKeys';
import { useAdjacentPreload } from '../lightbox/useAdjacentPreload';
import { shareImage, shareOutcomeMessage } from '../lightbox/shareImage';
import type { ThumbEntry } from '../lightbox/LightboxThumbStrip';

interface ImageViewerProps {
  images: LibraryImage[];
  initialIndex: number;
  onClose: () => void;
  onToggleFavorite: (img: LibraryImage) => void;
  isDark: boolean;
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
  images, initialIndex, onClose, onToggleFavorite, isDark,
}: ImageViewerProps) {
  const [index, setIndex] = useState(initialIndex);
  const [sharing, setSharing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((msg: string | null) => {
    if (statusTimer.current) clearTimeout(statusTimer.current);
    setStatus(msg);
    if (msg) statusTimer.current = setTimeout(() => setStatus(null), 3000);
  }, []);
  useEffect(() => () => { if (statusTimer.current) clearTimeout(statusTimer.current); }, []);

  const zp = useZoomPan(index);
  const zoom = useMemo(() => zoomControlsFromPan(zp), [zp]);

  const image = images[index];

  const srcs = useMemo(() => images.map(i => i.downloadUrl), [images]);
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
      flash(shareOutcomeMessage(await shareImage(image.downloadUrl, image.name, title)));
    } finally {
      setSharing(false);
    }
  }, [image, flash]);

  const handleDownload = useCallback(() => {
    if (!image) return;
    const a = document.createElement('a');
    a.href = image.downloadUrl;
    a.download = image.name;
    a.click();
  }, [image]);

  useLightboxKeys({
    onPrev: () => navigate(-1),
    onNext: () => navigate(1),
    onFirst: () => setIndex(0),
    onLast: () => setIndex(images.length - 1),
    onClose,
    onFit: zp.setFit,
    onActualSize: zp.setActualSize,
    onZoomIn: zoom.zoomIn,
    onZoomOut: zoom.zoomOut,
    onDownload: handleDownload,
    onToggleFavorite: image ? () => onToggleFavorite(image) : undefined,
  });

  const thumbs = useMemo<ThumbEntry[]>(() => images.map(img => ({
    key: img.path,
    label: `${img.objectName || img.name}${img.date !== 'unknown' ? `, ${img.date}` : ''}`,
    content: (
      <img
        src={getLibraryFileThumbnailUrl(img.path, 56, 56)}
        alt=""
        className="w-full h-full object-cover"
        loading="lazy"
      />
    ),
  })), [images]);

  if (!image) return null;

  const iconBtn = `p-2 rounded-lg transition disabled:opacity-40 ${
    isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'
  }`;

  const actions = (
    <>
      <button
        type="button"
        onClick={() => onToggleFavorite(image)}
        title={image.isFavorite ? 'Remove from favorites (L)' : 'Add to favorites (L)'}
        aria-label={image.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
        aria-pressed={image.isFavorite}
        className={`p-2 rounded-lg transition ${
          image.isFavorite
            ? 'text-rose-400 hover:text-rose-500'
            : isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'
        }`}
      >
        <Heart className={`w-4 h-4 ${image.isFavorite ? 'fill-current' : ''}`} />
      </button>
      <button type="button" onClick={handleShare} disabled={sharing} title="Share" aria-label="Share" className={iconBtn}>
        {sharing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Share2 className="w-4 h-4" />}
      </button>
      <a href={image.downloadUrl} download={image.name} title="Download (D)" aria-label="Download" className={iconBtn}>
        <Download className="w-4 h-4" />
      </a>
      <div className={`w-px h-5 mx-1 flex-shrink-0 ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`} />
    </>
  );

  const subtitle = [
    image.objectType,
    image.date !== 'unknown' ? image.date : null,
    image.name,
  ].filter(Boolean).join(' · ');

  return (
    <LightboxFrame
      isOpen
      onClose={onClose}
      isDark={isDark}
      dialogTitle={`Image viewer: ${image.objectName || image.name}`}
      titleIcon={<Image className="w-5 h-5 text-accent-500 flex-shrink-0" />}
      title={image.objectName || image.name}
      subtitle={subtitle}
      index={index}
      count={images.length}
      onPrev={() => navigate(-1)}
      onNext={() => navigate(1)}
      onSelectIndex={setIndex}
      zoom={zoom}
      actions={actions}
      thumbs={thumbs}
      swipeDisabled={!zp.isFit}
      status={status}
    >
      <LightboxPane
        zpRef={zp.containerRef}
        isPanning={zp.isPanning}
        canPan={zp.overflows}
        handlers={zp.paneHandlers}
      >
        <LightboxImage
          src={image.downloadUrl}
          thumbSrc={getLibraryFileThumbnailUrl(image.path, 400, 400)}
          alt={image.objectName || image.name}
          zp={zp}
          isDark={isDark}
        />
      </LightboxPane>
    </LightboxFrame>
  );
}
