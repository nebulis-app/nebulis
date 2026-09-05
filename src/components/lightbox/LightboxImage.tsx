import { useState } from 'react';
import { ImageOff, Loader2 } from 'lucide-react';
import type { ZoomPan } from './useZoomPan';

interface Props {
  src: string;
  /** Small already-cached image shown blurred while the full one loads. */
  thumbSrc?: string;
  alt: string;
  zp: ZoomPan;
}

/**
 * The zoomable image, with a loading state that does not leave the pane blank.
 *
 * Full-size stacked frames take a moment to arrive. Rather than an empty pane,
 * the grid thumbnail is blurred up to fill the space immediately (it is
 * already in cache from the page behind the viewer), and the real image fades
 * in over it. The result reads as the image sharpening rather than appearing.
 */
export function LightboxImage({ src, thumbSrc, alt, zp }: Props) {
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
        <p className="text-sm text-white/55">This image could not be loaded.</p>
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

      <img
        src={src}
        alt={alt}
        draggable={false}
        onLoad={e => { zp.onImageLoad(e); setLoaded(true); }}
        onError={() => setFailed(true)}
        // Sized and translated by the zoom engine once natural dimensions are
        // known. Until then it is laid out but invisible, which is what lets
        // the browser report those dimensions in the first place.
        style={zp.imageStyle}
        className={`relative select-none rounded-xl transition-opacity duration-200 ${
          loaded ? 'opacity-100' : 'opacity-0'
        } ${zp.imageStyle ? '' : 'absolute inset-0 w-full h-full object-contain'}`}
      />

      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Loader2 className="w-6 h-6 animate-spin text-accent-500" />
        </div>
      )}
    </>
  );
}
