import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image } from 'lucide-react';
import { LightboxFrame, LightboxPane } from '../lightbox/LightboxFrame';
import { LightboxImage } from '../lightbox/LightboxImage';
import { useZoomPan } from '../lightbox/useZoomPan';
import { zoomControlsFromPan } from '../lightbox/zoomControls';
import { useLightboxKeys } from '../lightbox/useLightboxKeys';

interface Props {
  /** The full-size picture. */
  src: string;
  /** A small picture that is already loaded, shown blurred while `src` arrives. */
  thumbSrc: string;
  /** The object's name. */
  name: string;
  onClose: () => void;
}

/**
 * One sky picture of an object, large, with the same zoom, pan, fullscreen and keys as the library viewers. They are
 * built around a list of library files with favorites, deleting and annotation; this is the one picture with none of
 * that.
 */
export function CatalogImageViewer({ src, thumbSrc, name, onClose }: Props) {
  const { t } = useTranslation('planner');
  const [immersive, setImmersive] = useState(false);
  const zp = useZoomPan(src);
  const zoom = zoomControlsFromPan(zp);
  const noop = () => {};

  useLightboxKeys({
    onPrev: noop,
    onNext: noop,
    onFirst: noop,
    onLast: noop,
    // Escape backs out of fullscreen first, then out of the viewer.
    onClose: immersive ? () => setImmersive(false) : onClose,
    onFit: zp.setFit,
    onActualSize: zp.setActualSize,
    onZoomIn: zoom.zoomIn,
    onZoomOut: zoom.zoomOut,
  });

  return (
    <LightboxFrame
      isOpen
      onClose={onClose}
      dialogTitle={t('plannerPage.referenceImageViewerTitle', { name })}
      titleIcon={<Image className="h-4.5 w-4.5 flex-shrink-0 text-accent-400" />}
      title={name}
      index={0}
      count={1}
      onPrev={noop}
      onNext={noop}
      onSelectIndex={noop}
      zoom={zoom}
      immersive={immersive}
      onToggleImmersive={() => setImmersive(v => !v)}
      swipeDisabled={!zp.isFit}
      ambientSrc={thumbSrc}
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
      >
        <LightboxImage src={src} thumbSrc={thumbSrc} alt={t('plannerPage.referenceImageAlt', { name })} zp={zp} />
      </LightboxPane>
    </LightboxFrame>
  );
}
