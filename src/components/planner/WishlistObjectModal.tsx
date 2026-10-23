/**
 * Full detail popup for one wishlist target, opened by clicking a row in
 * WishlistList. Modeled on CatalogObjectModal (same image/description/best-
 * window-chart shape) so a wishlist target and a catalog-board target read
 * as the same kind of page, just reached from a different list.
 *
 * The wishlist table doesn't store ra/dec, so this resolves them itself: from
 * `target` when the object is one of tonight's, otherwise a DSO catalog
 * lookup by id (same technique WishlistList's "when is this visible" toggle
 * already uses).
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { X, ExternalLink, Telescope, CalendarDays, CalendarPlus, MapPin, ZoomIn, EyeOff, Plus, Trash2, Star, ChevronLeft, ChevronRight, Frame } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getCatalogThumbnailUrl } from '../../lib/catalogImage';
import { getCatalogObjectInfo } from '../../lib/api/catalog';
import { computeBestImagingWindow, isUpTonight } from '../../lib/bestImagingWindow';
import { filterRecommendations } from '../../lib/filterRecommendations';
import { FilterRecommendationPanel } from '../ui/FilterRecommendationPanel';
import { BestImagingChart } from '../ui/BestImagingChart';
import { AltitudeChart } from '../AltitudeChart';
import { FramingModal, FRAMING_MOSAIC_ENABLED } from '../catalogs/FramingModal';
import { useResolvedFov } from '../../hooks/useResolvedFov';
import { classifyFit, fitDisplayStrings, objectExtentArcmin } from '../../lib/telescopeFov';
import { FitBadge } from '../FitBadge';
import { formatHm } from '../../lib/timeFormat';
import { searchDsoCatalog, type PlannerTarget } from '../../lib/api/planner';
import type { WishlistCandidate } from '../../hooks/useWishlist';
import { WISHLIST_PRIORITIES, type WishlistItem, type WishlistPriority } from '../../lib/api/wishlist';

const PRIORITY_DOT: Record<WishlistPriority, string> = {
  high: 'bg-red-500',
  medium: 'bg-amber-500',
  low: 'bg-slate-400',
};
const PRIORITY_LABEL_KEY: Record<WishlistPriority, string> = {
  high: 'wishlistPanel.priorityHigh',
  medium: 'wishlistPanel.priorityMedium',
  low: 'wishlistPanel.priorityLow',
};

interface Props {
  item: WishlistItem;
  /** True when `item` is a stand-in for a catalog search result that isn't
   *  on the wishlist yet (e.g. opened from the (i) button in "Find things to
   *  image"), rather than a real row from the server. There's nothing to
   *  persist priority/notes against or remove, so those controls fall back
   *  to local-only state and the footer swaps "Remove from wishlist" for
   *  "Add to wishlist" (via `onAdd`), carrying along whatever priority/notes
   *  were set in this session. Everything else about the modal (image,
   *  description, best-window chart, framing, filter recommendations)
   *  behaves identically either way — that parity is the whole point of
   *  reusing this component instead of a separate lighter-weight popup. */
  isPreview?: boolean;
  /** Required when `isPreview` is true; ignored otherwise. */
  onAdd?: (candidate: WishlistCandidate) => void;
  /** Tonight's live target for this object, when it's up tonight — gives
   *  ra/dec/altitude for free. Undefined otherwise, in which case this modal
   *  resolves coordinates itself for the best-window chart. */
  target?: PlannerTarget;
  isImaged: boolean;
  libraryObjectId: string | null;
  observerLat: number | null;
  observerLon: number | null;
  minAlt: number;
  /** Tonight's moon illumination (0-100), for the altitude chart's moon
   *  interference strip. */
  moonIllumination?: number;
  observerTimezone?: string;
  isDark: boolean;
  isNight: boolean;
  isSpace: boolean;
  /** Not needed when `isPreview` is true — see `onAdd` above instead. */
  onSetPriority?: (id: string, priority: WishlistPriority) => void;
  onSetNotes?: (id: string, notes: string) => void;
  onRemove?: (id: string) => void;
  /** When set, adds a "Plan a night…" action that opens the caller's night
   *  picker (Explore supplies one). Omitted by every other caller, so the
   *  Wishlist and Planner popups are unchanged. */
  onPlanNight?: () => void;
  onClose: () => void;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}

export function WishlistObjectModal({
  item,
  isPreview = false,
  onAdd,
  target,
  isImaged,
  libraryObjectId,
  observerLat,
  observerLon,
  minAlt,
  moonIllumination,
  observerTimezone,
  isDark,
  isNight,
  isSpace,
  onSetPriority,
  onSetNotes,
  onRemove,
  onPlanNight,
  onClose,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
}: Props) {
  const { t } = useTranslation('planner');
  const { t: tCatalogs } = useTranslation('catalogs');
  const navigate = useNavigate();
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [framingOpen, setFramingOpen] = useState(false);
  const [notesDraft, setNotesDraft] = useState(item.notes);
  // Preview-only: a not-yet-added candidate has no server row to persist a
  // priority pick against, so the picked priority lives here instead until
  // "Add to wishlist" carries it into the actual create call.
  const [previewPriority, setPreviewPriority] = useState<WishlistPriority>(item.priority);
  const currentPriority = isPreview ? previewPriority : item.priority;
  const hasLocation = observerLat != null && observerLon != null;

  // Render-phase reset (not an effect + extra render) when prev/next switches
  // to a different item — same trick CatalogObjectModal's shownObjectId uses.
  const [shownItemId, setShownItemId] = useState(item.id);
  if (shownItemId !== item.id) {
    setShownItemId(item.id);
    setNotesDraft(item.notes);
    setPreviewPriority(item.priority);
    setLightboxOpen(false);
  }

  // Same fit-from-live-FOV-setup computation as SessionDetailsModal (the
  // Planner's (i) popup) — Wishlist has no precomputed per-object fit map
  // the way CatalogBoard does, so it resolves the active rig itself.
  const fov = useResolvedFov();
  const fit = useMemo(() => classifyFit(fov, objectExtentArcmin(null, item.majorAxisArcmin)), [fov, item.majorAxisArcmin]);
  const fitStrings = useMemo(() => (fit ? fitDisplayStrings(fit, tCatalogs) : null), [fit, tCatalogs]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); if (hasPrev) onPrev(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); if (hasNext) onNext(); }
      else if (e.key === 'Escape') {
        // FramingModal is a nested overlay with its own window-level Escape
        // handler — see the identical guard in CatalogObjectModal/SessionDetailsModal.
        if (lightboxOpen) setLightboxOpen(false);
        else if (!framingOpen) onClose();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hasPrev, hasNext, onPrev, onNext, onClose, lightboxOpen, framingOpen]);

  // Not Infinity: a freshly-imported object's description/wikiUrl often
  // aren't populated yet — the server kicks off background enrichment
  // (Wikipedia/SIMBAD lookups) and fills them in a few seconds to minutes
  // later. An infinite staleTime would cache that first, incomplete
  // response for the rest of the tab's life (and this query key is shared
  // with CatalogObjectModal/PlannerPage, so the empty result would follow
  // the object between the Catalogs board, Planner, and here too), showing
  // "No description available." forever even after the server has the real
  // one. A short staleTime lets the next open pick it up without needing a
  // hard reload.
  const { data: info } = useQuery({
    queryKey: ['catalog-info', item.objectId],
    queryFn: () => getCatalogObjectInfo(item.objectId),
    staleTime: 5 * 60_000,
  });

  // Coordinates: free from tonight's target when visible, otherwise a DSO
  // lookup by id — the same fallback WishlistList's expandable row uses.
  const coordsQuery = useQuery({
    queryKey: ['dso-lookup', item.objectId],
    queryFn: () => searchDsoCatalog(item.objectId, 5),
    enabled: !target,
    staleTime: 5 * 60_000,
  });
  const resolvedEntry = coordsQuery.data?.results.find(r => r.id === item.objectId);
  const ra = target?.ra ?? resolvedEntry?.ra ?? null;
  const dec = target?.dec ?? resolvedEntry?.dec ?? null;

  const bestWindow = useMemo(() => {
    if (!hasLocation || ra == null || dec == null) return null;
    return computeBestImagingWindow(ra, dec, observerLat, observerLon, minAlt);
  }, [ra, dec, observerLat, observerLon, minAlt, hasLocation]);

  const upTonight = useMemo(
    () => (ra != null && dec != null ? isUpTonight(ra, dec, observerLat, observerLon) : null),
    [ra, dec, observerLat, observerLon],
  );
  const notVisibleTonight = upTonight === false;
  // Drives the hoverable tonight-only altitude curve, next to the filter
  // recommendations. Independent of `notVisibleTonight`: the curve is still
  // useful for an object that's below the horizon right now but rises later,
  // or one whose peak this window just misses the minimum-altitude line.
  const tonightAltitudeAvailable = hasLocation && ra != null && dec != null;

  const imgUrl = getCatalogThumbnailUrl(item.objectId, item.majorAxisArcmin);
  const lightboxImgUrl = getCatalogThumbnailUrl(item.objectId, item.majorAxisArcmin, 800, 800);
  const description = info?.description?.trim() || '';
  const wikiUrl = info?.wikiUrl || null;
  const filterRec = (info?.type ?? item.type)?.trim() ? filterRecommendations(info?.type || item.type) : null;

  const accentBg = isNight ? 'bg-red-500' : isSpace ? 'bg-violet-500' : 'bg-amber-500';
  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-amber-400';
  const borderColor = isDark ? 'border-slate-700/40' : 'border-slate-200';

  function handlePlannerClick() {
    navigate('/planner', { state: { searchQuery: item.objectId } });
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div className="flex items-center gap-1.5 sm:gap-3 w-full max-w-[820px]" onClick={(e) => e.stopPropagation()}>
        {/* Smaller and tighter on a phone: at a 375px viewport, two full-size
            circular buttons plus their gaps were eating a quarter of the
            width the card itself needed. */}
        <button
          onClick={onPrev}
          className={`shrink-0 p-1.5 sm:p-2.5 rounded-full text-white border border-white/20 transition-all ${
            hasPrev ? 'bg-black/50 hover:bg-black/70' : 'invisible pointer-events-none'
          }`}
          aria-label={t('wishlistObjectModal.previousObject')}
        >
          <ChevronLeft className="w-4 h-4 sm:w-5 sm:h-5" />
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
                <h2 className="text-xl font-display font-bold tracking-tight">{item.objectId}</h2>
                {item.name !== item.objectId && (
                  <span className={`text-base font-medium ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                    {item.name}
                  </span>
                )}
                {isImaged && (
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[0.6875rem] font-medium text-white ${accentBg}`}>
                    {t('wishlistObjectModal.imaged')}
                  </span>
                )}
                {fit && fitStrings && (
                  <FitBadge tag={fit.tag} label={fitStrings.short} title={fitStrings.label} isDark={isDark} />
                )}
              </div>
              <div className={`flex items-center flex-wrap gap-3 mt-1 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                <span>{item.type}</span>
                {item.constellation && <span>· {item.constellation}</span>}
                {item.magnitude != null && <span>· {tCatalogs('catalogObjectModal.mag', { value: item.magnitude.toFixed(1) })}</span>}
                {ra != null && dec != null && (
                  <span>· {tCatalogs('catalogObjectModal.raDec', { ra: ra.toFixed(2), dec: dec.toFixed(2) })}</span>
                )}
              </div>
              <div className="flex items-center gap-1 mt-2">
                {WISHLIST_PRIORITIES.map(p => (
                  <button
                    key={p}
                    onClick={() => { if (isPreview) setPreviewPriority(p); else onSetPriority?.(item.id, p); }}
                    aria-pressed={currentPriority === p}
                    className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium transition ${
                      currentPriority === p
                        ? isDark ? 'bg-slate-700 text-slate-100' : 'bg-slate-200 text-slate-900'
                        : isDark ? 'text-slate-500 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${PRIORITY_DOT[p]}`} />
                    {t(PRIORITY_LABEL_KEY[p])}
                  </button>
                ))}
              </div>
            </div>
            <button
              onClick={onClose}
              className={`shrink-0 p-2 rounded-lg transition ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
              aria-label={t('wishlistObjectModal.close')}
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Body — the part that scrolls when everything doesn't fit the
              viewport. Actions stay out of this div, pinned below instead,
              so they're always reachable without hunting for a scrollbar
              (macOS hides them by default). */}
          <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-5">
            <div className="flex flex-col sm:flex-row gap-4 items-start">
              <button
                onClick={() => setLightboxOpen(true)}
                className={`w-24 h-24 sm:w-36 sm:h-36 shrink-0 rounded-xl overflow-hidden border group relative cursor-pointer ${
                  isDark ? 'border-slate-800 bg-slate-950' : 'border-slate-200 bg-slate-100'
                }`}
                aria-label={t('wishlistObjectModal.viewLargerImage')}
              >
                <img
                  src={imgUrl}
                  alt={t('wishlistObjectModal.referenceImageAlt', { id: item.objectId })}
                  loading="lazy"
                  className="w-full h-full object-cover transition-opacity group-hover:opacity-75"
                />
                {/* No hover on a touchscreen, so this hint stays visible there
                    rather than only on the mouse-driven `group-hover`. */}
                <div className="absolute inset-0 flex items-center justify-center opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
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
                    {tCatalogs('catalogObjectModal.noDescription')}
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
                    {tCatalogs('catalogObjectModal.wikipedia')}
                  </a>
                )}
              </div>
            </div>

            {(filterRec || tonightAltitudeAvailable) && (
              <div className={filterRec && tonightAltitudeAvailable ? 'grid grid-cols-1 sm:grid-cols-2 gap-4' : ''}>
                {filterRec && <FilterRecommendationPanel recommendations={filterRec} isDark={isDark} />}
                {tonightAltitudeAvailable && (
                  <AltitudeChart
                    ra={ra}
                    dec={dec}
                    lat={observerLat}
                    lon={observerLon}
                    minAlt={minAlt}
                    moonIllumination={moonIllumination}
                    timeZone={observerTimezone}
                    isDark={isDark}
                  />
                )}
              </div>
            )}

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
                    {tCatalogs('catalogObjectModal.belowMinimumAltitude', { deg: minAlt })}
                  </p>
                )}
              </div>
            ) : !hasLocation ? (
              <div className={`rounded-xl p-4 flex items-center gap-2 text-sm ${isDark ? 'bg-slate-800/60 text-slate-400' : 'bg-slate-50 text-slate-500'}`}>
                <MapPin className="w-4 h-4 shrink-0" />
                {tCatalogs('catalogObjectModal.setLocationForWindow')}
              </div>
            ) : ra == null ? (
              <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{t('wishlistPanel.windowUnavailable')}</p>
            ) : null}

            {target && (
              <div className="rounded-xl p-3 flex items-start gap-2 text-sm bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                <Star className="w-4 h-4 shrink-0 mt-0.5 fill-current" />
                <span>
                  {target.maxAltTime
                    ? t('wishlistPanel.visibleTonightAt', { deg: Math.round(target.maxAlt), time: formatHm(new Date(target.maxAltTime), observerTimezone) })
                    : t('wishlistPanel.visibleTonight', { deg: Math.round(target.maxAlt) })}
                </span>
              </div>
            )}
            {notVisibleTonight && !target && (
              <div className="rounded-xl p-3 flex items-start gap-2 text-sm bg-red-500/10 text-red-400 border border-red-500/30">
                <EyeOff className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{tCatalogs('catalogObjectModal.notVisibleTonight')}</span>
              </div>
            )}

            <div>
              <label className={`block text-xs font-medium mb-1.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                {t('wishlistObjectModal.notesLabel')}
              </label>
              <textarea
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                onBlur={() => { if (!isPreview && notesDraft !== item.notes) onSetNotes?.(item.id, notesDraft); }}
                placeholder={t('wishlistPanel.notesPlaceholder')}
                rows={2}
                className={`w-full rounded-lg px-3 py-2 text-sm outline-none transition resize-none ${
                  isDark
                    ? 'bg-slate-800 text-slate-200 placeholder:text-slate-600 focus:ring-1 focus:ring-amber-500/50'
                    : 'bg-slate-100 text-slate-800 placeholder:text-slate-400 focus:ring-1 focus:ring-amber-500/50'
                }`}
              />
            </div>
          </div>

          {/* Actions — pinned footer, never part of the scrolling body. */}
          <div className={`shrink-0 flex flex-wrap gap-2 p-5 pt-3 border-t ${borderColor}`}>
              {isImaged && libraryObjectId && (
                <button
                  onClick={() => { navigate(`/object/${encodeURIComponent(libraryObjectId)}`); onClose(); }}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition text-white ${
                    isNight ? 'bg-red-600 hover:bg-red-500' : isSpace ? 'bg-violet-600 hover:bg-violet-500' : 'bg-amber-600 hover:bg-amber-500'
                  }`}
                >
                  <Telescope className="w-4 h-4" />
                  {tCatalogs('catalogObjectModal.viewObservations')}
                </button>
              )}
              <button
                onClick={handlePlannerClick}
                disabled={notVisibleTonight}
                title={notVisibleTonight ? tCatalogs('catalogObjectModal.notVisibleTitle') : undefined}
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
                {tCatalogs('catalogObjectModal.openInPlanner')}
              </button>
              {onPlanNight && (
                <button
                  onClick={onPlanNight}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition border ${
                    isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <CalendarPlus className="w-4 h-4" />
                  {t('wishlistObjectModal.planNight')}
                </button>
              )}
              {FRAMING_MOSAIC_ENABLED && (
                <button
                  onClick={() => setFramingOpen(true)}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition border ${
                    isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                  title={tCatalogs('catalogObjectModal.framingButtonTitle')}
                >
                  <Frame className="w-4 h-4 text-sky-500" />
                  {tCatalogs('catalogObjectModal.framingButton')}
                </button>
              )}
              {isPreview ? (
                <button
                  onClick={() => {
                    onAdd?.({
                      objectId: item.objectId,
                      name: item.name,
                      type: item.type,
                      constellation: item.constellation,
                      magnitude: item.magnitude,
                      majorAxisArcmin: item.majorAxisArcmin,
                      priority: previewPriority,
                      notes: notesDraft,
                    });
                    onClose();
                  }}
                  className="ml-auto inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition text-white bg-amber-500 hover:bg-amber-600"
                >
                  <Plus className="w-4 h-4" />
                  {t('wishlistObjectModal.addToWishlist')}
                </button>
              ) : (
                <button
                  onClick={() => { onRemove?.(item.id); onClose(); }}
                  className={`ml-auto inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition border ${
                    isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-red-400' : 'border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-red-600'
                  }`}
                >
                  <Trash2 className="w-4 h-4" />
                  {t('wishlistObjectModal.removeFromWishlist')}
                </button>
              )}
            </div>
        </div>

        <button
          onClick={onNext}
          className={`shrink-0 p-1.5 sm:p-2.5 rounded-full text-white border border-white/20 transition-all ${
            hasNext ? 'bg-black/50 hover:bg-black/70' : 'invisible pointer-events-none'
          }`}
          aria-label={t('wishlistObjectModal.nextObject')}
        >
          <ChevronRight className="w-4 h-4 sm:w-5 sm:h-5" />
        </button>
      </div>

      {lightboxOpen && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/85 backdrop-blur-sm"
          onClick={() => setLightboxOpen(false)}
        >
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <img
              src={lightboxImgUrl}
              alt={t('wishlistObjectModal.referenceImageAlt', { id: item.objectId })}
              className="max-w-[85vw] max-h-[85vh] rounded-2xl object-contain shadow-2xl"
            />
            <button
              onClick={() => setLightboxOpen(false)}
              className="absolute -top-3 -right-3 p-1.5 bg-black/80 hover:bg-black rounded-full text-white transition"
              aria-label={t('wishlistObjectModal.close')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {framingOpen && (
        <FramingModal
          catalogId={item.objectId}
          objectName={item.name}
          isDark={isDark}
          onClose={() => setFramingOpen(false)}
        />
      )}
    </div>
  );
}
