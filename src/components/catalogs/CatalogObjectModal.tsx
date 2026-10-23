import { useEffect, useRef, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { X, ExternalLink, Telescope, CalendarDays, MapPin, ChevronLeft, ChevronRight, ZoomIn, EyeOff, Frame, Star, Layers } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CatalogProgressObject } from '../../lib/api/catalogs';
import { getCatalogObjectInfo } from '../../lib/api/catalog';
import { getCatalogThumbnailUrl } from '../../lib/catalogImage';
import { computeBestImagingWindow, isUpTonight } from '../../lib/bestImagingWindow';
import { filterRecommendations } from '../../lib/filterRecommendations';
import type { FitAssessment } from '../../lib/telescopeFov';
import { fitDisplayStrings } from '../../lib/telescopeFov';
import { FitBadge } from '../FitBadge';
import { FramingModal, FRAMING_MOSAIC_ENABLED } from './FramingModal';
import { FilterRecommendationPanel } from '../ui/FilterRecommendationPanel';
import { BestImagingChart } from '../ui/BestImagingChart';

interface Props {
  object: CatalogProgressObject;
  /** How this object sits in the current telescope's frame, precomputed by
   *  `CatalogBoard` (the same map that drives its tiles' badges and the
   *  "Best frame fit" sort). `null` when the angular size isn't known. */
  fit: FitAssessment | null;
  inWishlist: boolean;
  onToggleWishlist: () => void;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  observerLat: number | null;
  observerLon: number | null;
  minAlt?: number;
  isDark: boolean;
  isNight: boolean;
  isSpace: boolean;
  onClose: () => void;
}


export function CatalogObjectModal({
  object,
  fit,
  inWishlist,
  onToggleWishlist,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  observerLat,
  observerLon,
  minAlt = 20,
  isDark,
  isNight,
  isSpace,
  onClose,
}: Props) {
  const { t } = useTranslation('catalogs');
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasLocation = observerLat != null && observerLon != null;
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [framingOpen, setFramingOpen] = useState(false);
  const fitStrings = fit ? fitDisplayStrings(fit, t) : null;

  // Close the lightbox when switching to a different catalog object.
  // Render-phase reset; the scroll-to-top is a real DOM effect, kept separate.
  const [shownObjectId, setShownObjectId] = useState(object.id);
  if (shownObjectId !== object.id) {
    setShownObjectId(object.id);
    setLightboxOpen(false);
  }
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [object.id]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); if (hasPrev) onPrev(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); if (hasNext) onNext(); }
      else if (e.key === 'Escape') {
        // FramingModal is a nested overlay with its own window-level Escape
        // handler; both listeners see the same keydown, so without this guard
        // one Escape press would close Framing & Mosaic AND this modal at once.
        if (lightboxOpen) setLightboxOpen(false);
        else if (!framingOpen) onClose();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hasPrev, hasNext, onPrev, onNext, onClose, lightboxOpen, framingOpen]);

  // Not Infinity — see the matching comment in WishlistObjectModal, which
  // shares this same query key: a freshly-imported object's description
  // can still be mid-enrichment when this first loads, and an infinite
  // staleTime would pin the empty result for the rest of the tab's life.
  const { data: info } = useQuery({
    queryKey: ['catalog-info', object.id],
    queryFn: () => getCatalogObjectInfo(object.id),
    staleTime: 5 * 60_000,
  });

  const imgUrl = getCatalogThumbnailUrl(object.id, object.majorAxisArcmin);
  const lightboxImgUrl = getCatalogThumbnailUrl(object.id, object.majorAxisArcmin, 800, 800);

  const bestWindow = useMemo(() => {
    if (!hasLocation || object.ra == null || object.dec == null) return null;
    return computeBestImagingWindow(
      object.ra,
      object.dec,
      observerLat,
      observerLon,
      minAlt,
    );
  }, [object.ra, object.dec, observerLat, observerLon, minAlt, hasLocation]);

  // Does the object ever clear the horizon during tonight's dark window from
  // this location? null = can't tell (no location / no coords / no dark window),
  // in which case we don't warn or disable anything.
  const upTonight = useMemo(
    () => isUpTonight(object.ra, object.dec, observerLat, observerLon),
    [object.ra, object.dec, observerLat, observerLon],
  );
  const notVisibleTonight = upTonight === false;

  const description = info?.description?.trim() || '';
  const wikiUrl = info?.wikiUrl || null;

  // Filter guidance follows from the object's type, which the catalog info
  // response already carries, so this costs no extra request. An object with
  // no type at all gets no panel rather than a generic one.
  const filterRec = info?.type?.trim() ? filterRecommendations(info.type) : null;

  const accentBg = isNight ? 'bg-red-500' : isSpace ? 'bg-violet-500' : 'bg-amber-500';
  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-amber-400';
  // Imaged through another object's frame: an outlined, tinted pill rather than the
  // solid one, so it reads as "credited via" and not "imaged directly". Light text on
  // a dark tint (and dark text on a light one) keeps contrast well above 4.5:1.
  const inFrameBadge = isNight
    ? 'border-red-400/60 bg-red-500/15 text-red-200'
    : isSpace
      ? 'border-violet-400/60 bg-violet-500/15 text-violet-200'
      : isDark
        ? 'border-amber-400/60 bg-amber-500/15 text-amber-200'
        : 'border-amber-600/50 bg-amber-100 text-amber-900';
  const borderColor = isDark ? 'border-slate-700/40' : 'border-slate-200';

  function handleGoToObservations() {
    if (object.libraryObjectId) {
      navigate(`/object/${encodeURIComponent(object.libraryObjectId)}`);
      onClose();
    }
  }

  function handlePlannerClick() {
    if (notVisibleTonight) return; // not above the horizon tonight — nothing to plan
    // Use the canonical NGC/IC ID so the planner's search finds it.
    // Caldwell IDs like 'C61' don't appear in the planner — 'NGC4039' does.
    const searchQuery = object.ngcName || object.id;
    navigate('/planner', { state: { searchQuery } });
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      {/* Wrapper: flex row so arrows flank the card */}
      <div className="flex items-center gap-3 w-full max-w-[820px]" onClick={(e) => e.stopPropagation()}>

        {/* Left arrow */}
        <button
          onClick={onPrev}
          className={`shrink-0 p-2.5 rounded-full text-white border border-white/20 transition-all ${
            hasPrev ? 'bg-black/50 hover:bg-black/70' : 'invisible pointer-events-none'
          }`}
          aria-label={t('catalogObjectModal.previousObject')}
        >
          <ChevronLeft className="w-5 h-5" />
        </button>

      <div
        className={`flex flex-1 min-w-0 flex-col rounded-2xl shadow-2xl max-h-[92vh] ${
          isDark ? 'bg-slate-900 text-slate-100' : 'bg-white text-slate-900'
        }`}
      >
        {/* Header — stays pinned so the object identity and close button
            are always visible, even when the body below scrolls. */}
        <div className={`shrink-0 flex items-start justify-between p-5 border-b ${borderColor} gap-4`}>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-xl font-display font-bold tracking-tight">
                {object.id}
              </h2>
              {object.name !== object.id && (
                <span className={`text-base font-medium ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                  {object.name}
                </span>
              )}
              {object.isImaged && (object.imagedVia?.[0] ? (
                <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[0.8125rem] font-semibold leading-none ${inFrameBadge}`}>
                  <Layers className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  {t('catalogObjectModal.imagedInFrame', { host: object.imagedVia[0].name })}
                </span>
              ) : (
                <span className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-[0.8125rem] font-semibold leading-none text-slate-950 ${accentBg}`}>
                  {t('catalogObjectModal.imagedSessions', { count: object.sessionCount })}
                </span>
              ))}
              {fit && fitStrings && (
                <FitBadge tag={fit.tag} label={fitStrings.short} title={fitStrings.label} isDark={isDark} />
              )}
              <button
                onClick={onToggleWishlist}
                aria-pressed={inWishlist}
                title={inWishlist ? t('catalogObjectModal.removeFromWishlist') : t('catalogObjectModal.addToWishlist')}
                className={`rounded-full p-1 transition ${
                  inWishlist
                    ? 'text-amber-400'
                    : isDark ? 'text-slate-500 hover:text-amber-300' : 'text-slate-400 hover:text-amber-500'
                }`}
              >
                <Star className={`w-4 h-4 ${inWishlist ? 'fill-current' : ''}`} />
                <span className="sr-only">
                  {inWishlist ? t('catalogObjectModal.removeFromWishlist') : t('catalogObjectModal.addToWishlist')}
                </span>
              </button>
            </div>
            <div className={`flex items-center flex-wrap gap-3 mt-1 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              <span>{object.type}</span>
              {object.constellation && <span>· {object.constellation}</span>}
              {object.magnitude != null && <span>· {t('catalogObjectModal.mag', { value: object.magnitude.toFixed(1) })}</span>}
              {object.ra != null && object.dec != null && (
                <span className="flex items-center gap-1">
                  · {t('catalogObjectModal.raDec', { ra: object.ra.toFixed(2), dec: object.dec.toFixed(2) })}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className={`shrink-0 p-2 rounded-lg transition ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
            aria-label={t('catalogObjectModal.close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body — the part that scrolls when everything doesn't fit the
            viewport. Actions stay out of this div, pinned below instead, so
            they're always reachable without hunting for a scrollbar (macOS
            hides them by default). */}
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-5 space-y-5">
          {/* Image + description row */}
          <div className="flex gap-4 items-start">
            <button
              onClick={() => setLightboxOpen(true)}
              className={`w-36 h-36 shrink-0 rounded-xl overflow-hidden border group relative cursor-pointer ${
                isDark ? 'border-slate-800 bg-slate-950' : 'border-slate-200 bg-slate-100'
              }`}
              aria-label={t('catalogObjectModal.viewLargerImage')}
            >
              <img
                src={imgUrl}
                alt={t('catalogObjectModal.referenceImageAlt', { id: object.id })}
                loading="lazy"
                className="w-full h-full object-cover transition-opacity group-hover:opacity-75"
              />
              <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <div className="bg-black/50 rounded-full p-1.5">
                  <ZoomIn className="w-4 h-4 text-white" />
                </div>
              </div>
            </button>
            <div className="min-w-0">
              {description ? (
                <p className={`text-sm leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                  {description}
                </p>
              ) : (
                <p className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  {t('catalogObjectModal.noDescription')}
                </p>
              )}
              {wikiUrl && (
                <a
                  href={wikiUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`inline-flex items-center gap-1 text-xs mt-2 ${accentText} hover:opacity-80`}
                >
                  <ExternalLink className="w-3 h-3" />
                  {t('catalogObjectModal.wikipedia')}
                </a>
              )}
            </div>
          </div>

          {/* Filter recommendations for this object's type */}
          {filterRec && (
            <FilterRecommendationPanel recommendations={filterRec} isDark={isDark} />
          )}

          {/* Best imaging window chart */}
          {hasLocation && bestWindow ? (
            <div className={`rounded-xl p-4 ${isDark ? 'bg-slate-800/60' : 'bg-slate-50'}`}>
              <BestImagingChart
                months={bestWindow.months}
                windowStart={bestWindow.windowStart}
                windowEnd={bestWindow.windowEnd}
                minAlt={minAlt}
                isDark={isDark}
                isNight={isNight}
                isSpace={isSpace}
              />
              {!bestWindow.everVisible && (
                <p className={`text-xs mt-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  {t('catalogObjectModal.belowMinimumAltitude', { deg: minAlt })}
                </p>
              )}
            </div>
          ) : !hasLocation ? (
            <div className={`rounded-xl p-4 flex items-center gap-2 text-sm ${isDark ? 'bg-slate-800/60 text-slate-400' : 'bg-slate-50 text-slate-500'}`}>
              <MapPin className="w-4 h-4 shrink-0" />
              {t('catalogObjectModal.setLocationForWindow')}
            </div>
          ) : null}

          {/* Not-visible-tonight warning */}
          {notVisibleTonight && (
            <div className="rounded-xl p-3 flex items-start gap-2 text-sm bg-red-500/10 text-red-400 border border-red-500/30">
              <EyeOff className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{t('catalogObjectModal.notVisibleTonight')}</span>
            </div>
          )}
        </div>

        {/* Actions — pinned footer, never part of the scrolling body. */}
        <div className={`shrink-0 flex flex-wrap gap-2 p-5 pt-3 border-t ${borderColor}`}>
            {object.isImaged ? (
              <button
                onClick={handleGoToObservations}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition text-white ${
                  isNight ? 'bg-red-600 hover:bg-red-500' : isSpace ? 'bg-violet-600 hover:bg-violet-500' : 'bg-amber-600 hover:bg-amber-500'
                }`}
              >
                <Telescope className="w-4 h-4" />
                {t('catalogObjectModal.viewObservations')}
              </button>
            ) : null}
            <button
              onClick={handlePlannerClick}
              disabled={notVisibleTonight}
              title={notVisibleTonight ? t('catalogObjectModal.notVisibleTitle') : undefined}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition border ${
                notVisibleTonight
                  ? isDark
                    ? 'bg-slate-800 text-slate-500 border-slate-700 cursor-not-allowed'
                    : 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
                  : isNight
                    ? 'bg-red-500/15 text-red-400 hover:bg-red-500/25 border-red-500/30'
                    : isSpace
                      ? 'bg-violet-500/15 text-violet-400 hover:bg-violet-500/25 border-violet-500/30'
                      : isDark
                        ? 'bg-accent-500/15 text-accent-400 hover:bg-accent-500/25 border-accent-500/30'
                        : 'bg-accent-300 text-accent-700 hover:bg-accent-400 border-accent-400'
              }`}
            >
              <CalendarDays className="w-4 h-4" />
              {t('catalogObjectModal.openInPlanner')}
            </button>
            {FRAMING_MOSAIC_ENABLED && (
              <button
                onClick={() => setFramingOpen(true)}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition border ${
                  isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
                title={t('catalogObjectModal.framingButtonTitle')}
              >
                <Frame className="w-4 h-4 text-sky-500" />
                {t('catalogObjectModal.framingButton')}
              </button>
            )}
        </div>
      </div>

        {/* Right arrow */}
        <button
          onClick={onNext}
          className={`shrink-0 p-2.5 rounded-full text-white border border-white/20 transition-all ${
            hasNext ? 'bg-black/50 hover:bg-black/70' : 'invisible pointer-events-none'
          }`}
          aria-label={t('catalogObjectModal.nextObject')}
        >
          <ChevronRight className="w-5 h-5" />
        </button>

      </div>

      {lightboxOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 backdrop-blur-sm"
          onClick={() => setLightboxOpen(false)}
        >
          <div
            className="relative"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={lightboxImgUrl}
              alt={t('catalogObjectModal.referenceImageAlt', { id: object.id })}
              className="max-w-[85vw] max-h-[85vh] rounded-2xl object-contain shadow-2xl"
            />
            <button
              onClick={() => setLightboxOpen(false)}
              className="absolute -top-3 -right-3 p-1.5 bg-black/80 hover:bg-black rounded-full text-white transition"
              aria-label={t('catalogObjectModal.close')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {framingOpen && (
        <FramingModal
          catalogId={object.id}
          objectName={object.name}
          isDark={isDark}
          onClose={() => setFramingOpen(false)}
        />
      )}
    </div>
  );
}
