import { useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Loader2, X } from 'lucide-react';
import type { FrameAnnotation } from '../../lib/api/annotate';
import { getCatalogObjectInfo } from '../../lib/api/catalog';
import { getCatalogThumbnailUrl } from '../../lib/catalogImage';
import { formatAliases, formatDesignation } from '../../lib/formatDesignation';
import type { ZoomPan } from './useZoomPan';

const LINK =
  'inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[0.7188rem] font-medium text-white/85 '
  + 'outline-none transition hover:bg-white/20 hover:text-white focus-visible:ring-2 focus-visible:ring-white/60';

/** External pages for an object. Built from the designation, so they work for
 *  anything in the catalog, and only ever opened by the user clicking them. */
function externalLinks(a: FrameAnnotation, wikiUrl: string | null) {
  const wiki = wikiUrl
    ?? `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(a.label !== a.id ? a.label : a.id)}`;
  return {
    wiki,
    simbad: `https://simbad.cds.unistra.fr/simbad/sim-id?Ident=${encodeURIComponent(a.id)}`,
    commons: `https://commons.wikimedia.org/w/index.php?search=${encodeURIComponent(a.label)}&title=Special:MediaSearch&type=image`,
  };
}

const EDGE = 8;
const GAP = 18;
/** Narrower panes keep the bottom sheet: there is no room to sit beside a ring. */
const MIN_ANCHORED_PANE = 480;

/**
 * Where to put the card so it sits beside the ring's (i) button and stays
 * inside the pane. Null when there is no button on screen to sit beside (it
 * is panned or zoomed out of view), so the caller falls back to the corner.
 */
function anchoredPosition(card: HTMLElement, id: string): { left: number; top: number } | null {
  const pane = card.offsetParent;
  if (!(pane instanceof HTMLElement)) return null;
  const paneBox = pane.getBoundingClientRect();
  if (paneBox.width < MIN_ANCHORED_PANE) return null;
  const btn = Array.from(pane.querySelectorAll<HTMLElement>('[data-annotation-info]'))
    .find(b => b.dataset.annotationInfo === id);
  if (!btn) return null;
  const b = btn.getBoundingClientRect();
  const x = b.left + b.width / 2 - paneBox.left;
  const y = b.top + b.height / 2 - paneBox.top;
  if (x < 0 || y < 0 || x > paneBox.width || y > paneBox.height) return null;
  const w = card.offsetWidth;
  const h = card.offsetHeight;
  const left = Math.min(Math.max(x - w / 2, EDGE), Math.max(EDGE, paneBox.width - w - EDGE));
  const below = y + GAP;
  const top = below + h <= paneBox.height - EDGE ? below : y - GAP - h;
  return { left, top: Math.min(Math.max(top, EDGE), Math.max(EDGE, paneBox.height - h - EDGE)) };
}

/**
 * What an identified object is: a picture, the basic facts, a short
 * description, other names, and where to read or see more.
 *
 * Details come from the same `/catalog/:id/info` the catalog pages use (so
 * the text matches what the user sees elsewhere, including their own
 * overrides) and load only when a ring's (i) is pressed. Sits over a corner of
 * the stage rather than inside the picture, so it stays readable at any zoom.
 */
export function AnnotationInfoCard({ annotation: a, zp, onClose }: { annotation: FrameAnnotation; zp: ZoomPan; onClose: () => void }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const { zoom, rotation, pan } = zp;
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const place = () => setPos(prev => {
      const next = anchoredPosition(card, a.id);
      return prev?.left === next?.left && prev?.top === next?.top ? prev : next;
    });
    place();
    // The card grows when its details arrive and the pane changes with the window.
    const observer = new ResizeObserver(place);
    observer.observe(card);
    if (card.offsetParent) observer.observe(card.offsetParent);
    return () => observer.disconnect();
  }, [a.id, zoom, rotation, pan.x, pan.y]);

  const { t } = useTranslation('library');
  const { data: info, isLoading, isError } = useQuery({
    queryKey: ['catalog-info', a.id],
    queryFn: () => getCatalogObjectInfo(a.id),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const links = externalLinks(a, info?.wikiUrl ?? null);

  const facts = [
    info?.type ?? a.type,
    info?.constellation && info.constellation !== 'Unknown' ? info.constellation : null,
    (info?.magnitude ?? a.magnitude) != null ? t('annotate.info.magnitude', { value: info?.magnitude ?? a.magnitude }) : null,
    info?.size ? t('annotate.info.size', { value: info.size }) : null,
    info?.distance ? t('annotate.info.distance', { value: info.distance }) : null,
  ].filter((f): f is string => !!f);

  const aka = formatAliases(info?.alsoKnownAs ?? [])
    .filter(n => n !== formatDesignation(a.id) && n !== formatDesignation(a.label))
    .slice(0, 6);

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={a.label}
      onPointerDown={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      onWheel={e => e.stopPropagation()}
      style={pos ? { left: pos.left, top: pos.top } : undefined}
      className={`absolute z-30 max-h-[70%] cursor-default select-text overflow-y-auto rounded-xl bg-black/75 p-3
        text-xs text-white/80 ring-1 ring-inset ring-white/10 backdrop-blur-md ${
        pos ? 'w-80 max-w-[calc(100%-1rem)]' : 'inset-x-2 bottom-2 sm:inset-x-auto sm:bottom-auto sm:right-2 sm:top-2 sm:w-80'
      }`}
    >
      <div className="flex items-start gap-3">
        <img
          src={getCatalogThumbnailUrl(a.id, null, 160, 160)}
          alt=""
          loading="lazy"
          className="h-14 w-14 flex-shrink-0 rounded-lg bg-white/5 object-cover ring-1 ring-white/10"
          onError={e => { e.currentTarget.style.visibility = 'hidden'; }}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white">{info?.name ?? a.label}</p>
          {(a.designation ?? (a.label !== a.id ? a.id : null)) && (
            <p className="text-white/55">{a.designation ?? a.id}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          title={t('annotate.info.close')}
          aria-label={t('annotate.info.close')}
          className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-white/60 outline-none transition
            hover:bg-white/15 hover:text-white focus-visible:ring-2 focus-visible:ring-white/60"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      {facts.length > 0 && <p className="mt-2 leading-snug text-white/60">{facts.join(' · ')}</p>}
      {a.isTarget && <p className="mt-1 leading-snug text-accent-300">{t('annotate.info.target')}</p>}
      {a.oversized && <p className="mt-1 leading-snug text-accent-300">{t('annotate.info.beyondFrame')}</p>}

      {isLoading && (
        <p className="mt-2 flex items-center gap-1.5 text-white/55">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          {t('annotate.info.loading')}
        </p>
      )}
      {info?.description && <p className="mt-2 line-clamp-6 leading-relaxed text-white/80">{info.description}</p>}
      {(isError || (info && !info.description)) && <p className="mt-2 text-white/50">{t('annotate.info.noDescription')}</p>}

      {aka.length > 0 && (
        <p className="mt-2 leading-snug text-white/50">
          {t('annotate.info.alsoKnownAs')}: {aka.join(', ')}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {a.isTarget && (
          <Link to={`/object/${encodeURIComponent(a.id)}`} className={LINK}>
            {t('annotate.info.openInNebulis')}
          </Link>
        )}
        <a href={links.wiki} target="_blank" rel="noopener noreferrer" className={LINK}>
          {t('annotate.info.wikipedia')}
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
        <a href={links.simbad} target="_blank" rel="noopener noreferrer" className={LINK}>
          {t('annotate.info.simbad')}
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
        <a href={links.commons} target="_blank" rel="noopener noreferrer" className={LINK}>
          {t('annotate.info.morePhotos')}
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}
