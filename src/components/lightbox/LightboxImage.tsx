import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageOff, Loader2 } from 'lucide-react';
import type { ZoomPan } from './useZoomPan';

interface Props {
  src: string;
  /** Small already-cached image shown blurred while the full one loads. */
  thumbSrc?: string;
  alt: string;
  zp: ZoomPan;
  /** Drawn on top of the image and carried with it through zoom, pan and
   *  rotation (the annotation rings). Sized to exactly the image's box. */
  overlay?: ReactNode;
}

/**
 * The zoomable image, with a loading state that does not leave the pane blank.
 *
 * Full-size stacked frames take a moment to arrive. Rather than an empty pane,
 * the grid thumbnail is blurred up to fill the space immediately (it is
 * already in cache from the page behind the viewer), and the real image fades
 * in over it. The result reads as the image sharpening rather than appearing.
 */
export function LightboxImage({ src, thumbSrc, alt, zp, overlay }: Props) {
  const { t } = useTranslation('library');
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  // Reset during render rather than in an effect, so a new src never shows one
  // frame of the previous image's loaded state before the reset lands.
  const [seenSrc, setSeenSrc] = useState(src);
  if (seenSrc !== src) {
    setSeenSrc(src);
    setLoaded(false);
    setFailed(false);
  }

  if (failed) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
        <ImageOff className="h-10 w-10 text-white/25" />
        <p className="text-sm text-white/55">{t('lightboxImage.loadFailed')}</p>
      </div>
    );
  }

  return (
    <>
      {!loaded && thumbSrc && (
        <img
          src={thumbSrc}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 w-full h-full object-contain blur-xl scale-105 opacity-60"
        />
      )}

      {/* The zoom engine's size and transform live on this wrapper rather than
          the <img>, so anything inside it (the overlay) tracks the picture
          exactly. It is always rendered, measured or not, so the <img> is never
          re-parented when the engine finishes measuring. */}
      <div
        style={zp.imageStyle}
        className={`select-none ${zp.imageStyle ? 'relative flex-none' : 'absolute inset-0'}`}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          onLoad={e => { zp.onImageLoad(e); setLoaded(true); }}
          onError={() => setFailed(true)}
          className={`block h-full w-full select-none rounded-xl transition-opacity duration-200 ${
            zp.imageStyle ? '' : 'object-contain'
          } ${loaded ? 'opacity-100' : 'opacity-0'}`}
        />
        {loaded && overlay}
      </div>

      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Loader2 className="w-6 h-6 animate-spin text-accent-500" />
        </div>
      )}
    </>
  );
}
