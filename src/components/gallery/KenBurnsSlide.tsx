import { useEffect, useRef } from 'react';
import type { LibraryImage } from '../../lib/api/library';
import { FADE_MS, KB_MS, randomKenBurns } from './galleryUtils';

// Two of these are stacked; only one is visible (opacity 1) at a time.
// Opacity crossfade is a plain CSS transition driven by the `opacity` prop.
// Ken Burns restarts via double-RAF whenever `image.path` changes so we don't
// rely on the fragile getBoundingClientRect() forced-reflow trick.

interface KenBurnsSlideProps {
  image: LibraryImage;
  opacity: 0 | 1;
  rotateCCW?: boolean;
}

export function KenBurnsSlide({ image, opacity, rotateCCW }: KenBurnsSlideProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    cancelAnimationFrame(rafRef.current);

    const { from, to } = randomKenBurns();

    // Frame 0: snap to start with no transition
    el.style.transition = 'none';
    el.style.transform = from;

    // Frame 1: browser has committed the snap; start the slow drift
    // Frame 2: ensures the transition fires in a fresh paint cycle
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = requestAnimationFrame(() => {
        if (!wrapRef.current) return;
        wrapRef.current.style.transition = `transform ${KB_MS}ms linear`;
        wrapRef.current.style.transform = to;
      });
    });

    return () => cancelAnimationFrame(rafRef.current);
  }, [image.path]);

  return (
    <div
      className="absolute inset-0"
      style={{ opacity, transition: `opacity ${FADE_MS}ms ease-in-out`, zIndex: opacity }}
    >
      <div
        ref={wrapRef}
        className="absolute inset-0"
        style={{ willChange: 'transform', transformOrigin: 'center center' }}
      >
        <img
          src={image.downloadUrl}
          alt={image.objectName}
          draggable={false}
          className="absolute inset-0 w-full h-full object-cover select-none"
          style={rotateCCW ? { transform: 'rotate(-90deg)', transformOrigin: 'center center' } : undefined}
        />
      </div>
    </div>
  );
}
