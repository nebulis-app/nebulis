/**
 * Deep-sky backdrop for catalog posters and banners.
 *
 * Walks a candidate list of catalog ids on error, because the first choice
 * may have no cached master and the live DSS2 fetch can fail (offline, or a
 * cold cache with no network). Fades in once a candidate resolves, and
 * renders nothing at all once every candidate has failed, leaving the
 * caller's scrim as a plain dark surface.
 */
import { useState } from 'react';

interface Props {
  ids: string[];
  /** Requested crop size. Pick the aspect the container actually uses. */
  width: number;
  height: number;
  /** Extra classes for filters and hover behaviour. */
  className?: string;
}

function heroUrl(id: string, width: number, height: number): string {
  return `/api/catalog/${encodeURIComponent(id)}/image`
    + `?w=${width}&h=${height}&fill=cover`;
}

export function CatalogHeroImage({ ids, width, height, className = '' }: Props) {
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  if (exhausted || ids.length === 0) return null;

  return (
    <img
      src={heroUrl(ids[index], width, height)}
      alt=""
      aria-hidden="true"
      onLoad={() => setLoaded(true)}
      onError={() => {
        if (index < ids.length - 1) setIndex(index + 1);
        else setExhausted(true);
      }}
      className={`absolute inset-0 w-full h-full object-cover
        transition-all duration-[900ms] ease-out
        ${loaded ? 'opacity-100' : 'opacity-0'} ${className}`}
    />
  );
}
