/**
 * A library object: everything you have shot of one target.
 *
 * The page reads in three passes. The hero says what the target is, shows the
 * best picture you have of it, and totals what it has cost you. The panel row
 * says what it is in the catalog and whether it is worth going out for tonight.
 * The grid below is the record: one card per night, newest first.
 *
 * What changed from the old layout, and why:
 *   - The picture was a 176px square. It is the reason the object is in your
 *     library, so it now gets the same mat the observation page gives a frame.
 *   - The catalog values were a 176px rail of 11px label/value pairs ruled off
 *     the header's right edge, which made a magnitude the smallest text on the
 *     page. They are a panel now, at the same scale as every other fact.
 *   - Four equally loud bordered buttons sat in a row under the header. One
 *     accent button now carries the thing you came to do; the rest are quiet.
 *   - Nothing anywhere said whether the object is up tonight, which is the
 *     question that decides whether you shoot it again. The Tonight panel
 *     answers it from your active observing site.
 */
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { AlertTriangle, ArrowLeft, RotateCcw, RotateCw } from 'lucide-react';
import {
  getLibrarySessions, requestObjectDownloadUrl, deleteLibraryObject, deleteLibrarySession,
  getGalleryImage, getLibraryFileUrl, getLibraryObjects, getObjectCapture, toggleFavorite,
  getDeletedObjects, getDeletedSessions, restoreLibraryObject, restoreLibrarySession,
} from '../lib/api/library';
import { getCatalogEntry } from '../lib/api/catalog';
import { getObservations } from '../lib/api/observations';
import { listTelescopes } from '../lib/api/telescopes';
import { getActiveSite } from '../lib/api/sites';
import { getSettings } from '../lib/api/settings';
import { getCatalogThumbnailUrl, getCatalogSourceThumbnailUrl, parseSourceSentinel } from '../lib/catalogImage';
import { parseRaHours, parseDecDegrees } from '../lib/observationDisplay';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../contexts/AuthContext';
import { useSyncSubframes } from '../contexts/SyncSubframesContext';
import { GalleryImageModal } from '../components/GalleryImageModal';
import { CompareSessionsModal } from '../components/CompareSessionsModal';
import { CombineSubframesModal } from '../components/CombineSubframesModal';
import { EditObjectModal } from '../components/EditObjectModal';
import { FramingModal, FRAMING_MOSAIC_ENABLED } from '../components/catalogs/FramingModal';
import { NewObservationModal } from '../components/NewObservationModal';
import { ObjectPanel } from '../components/observationDetail/ObjectPanel';
import { ObjectHero } from '../components/objectDetail/ObjectHero';
import { TonightPanel } from '../components/objectDetail/TonightPanel';
import { ObservationsSection } from '../components/objectDetail/ObservationsSection';
import { ObjectTrashModal } from '../components/objectDetail/ObjectTrashModal';
import { DangerConfirm } from '../components/objectDetail/DangerConfirm';
import { buildObjectMetrics, summarizeObject } from '../components/objectDetail/objectStats';
import { ObjectProcessedSection } from '../components/objectDetail/ObjectProcessedSection';
import { TourAnchor } from '../components/tour/TourAnchor';
import { DWARF_STARTRAILS_OBJECT_TYPE, DWARF_STARTRAILS_PLACEHOLDER_IMAGE } from '../lib/dwarfStartrails';
import type { ObservationCardModel } from '../components/objectDetail/ObservationCard';
import type { AstroObject } from '../types';

/**
 * Requested size for the hero's fallback catalog image, when the object has no
 * gallery image of its own. `getCatalogThumbnailUrl`'s default (384×384) is
 * sized for a grid tile; at that size the hero's `<img>` has nothing to scale
 * up to (CSS `max-height`/`max-width` only ever shrink, never grow a small
 * source), so the picture rendered at a fraction of the space the hero gives
 * it. 960 matches the hero's own max-height headroom for a high-DPI screen and
 * is comfortably under both `MAX_REQUEST_DIMENSION` (1920) and the DSS2
 * master's native resolution, so nothing here is upscaled and blurred — this
 * is the same trick the catalog lightbox already uses (see `CatalogObjectModal`'s
 * `800×800` request), just sized for a wider surface. A personal gallery image
 * (`getLibraryFileUrl`) is untouched: it serves the original file directly and
 * is already full resolution.
 */
const HERO_IMAGE_SIZE = 960;

export function ObjectDetail() {
  const { objectId } = useParams<{ objectId: string }>();
  const { isDark, isNight, isSpace } = useTheme();
  const { isAdmin } = useAuth();
  const { openObjectSync } = useSyncSubframes();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // The hero is night-side in every theme, so it takes the bright accent hex
  // rather than the light-mode-darkened token. Same rule as every other hero.
  const accent = isNight ? '#f87171' : isSpace ? '#a78bfa' : '#fbbf24';

  const [deleteObjectConfirm, setDeleteObjectConfirm] = useState(false);
  const [deleteSession, setDeleteSession] = useState<{ objectId: string; date: string } | null>(null);
  const [galleryModalOpen, setGalleryModalOpen] = useState(false);
  const [newObservationOpen, setNewObservationOpen] = useState(false);
  const [compareModalOpen, setCompareModalOpen] = useState(false);
  const [combineSubframesOpen, setCombineSubframesOpen] = useState(false);
  const [editObjectOpen, setEditObjectOpen] = useState(false);
  const [framingOpen, setFramingOpen] = useState(false);
  const [trashModalOpen, setTrashModalOpen] = useState(false);
  const [trashError, setTrashError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadPending, setDownloadPending] = useState(false);
  const [headerImgError, setHeaderImgError] = useState(false);
  // Tracks how many times we've force-refetched gallery data after an image load
  // failure. Prevents infinite retry loops while still auto-healing stale paths.
  const [galleryErrorRetries, setGalleryErrorRetries] = useState(0);

  // Find variants by looking up the grouped library objects list. Cached from
  // the Library grid, so it is free when navigating normally; on a direct load
  // it fetches once.
  const { data: allObjects } = useQuery({
    queryKey: ['library-objects'],
    queryFn: getLibraryObjects,
    staleTime: 5 * 60 * 1000,
  });

  // The current object may itself be a variant (e.g. IC434_Mosaic). Find the
  // base entry that owns it: either the object is the base, or it is listed in
  // another object's variants array.
  const baseObject = allObjects?.find(
    o => o.id === objectId || o.variants?.some(v => v.objectId === objectId),
  );

  const baseObjectId = baseObject?.id ?? objectId ?? '';
  const activeObjectId = baseObjectId;

  // The synthetic "DWARF Star Trails" object (see server/lib/library/dwarfStartrails.ts):
  // not a real celestial target, so it gets a distinct presentation below —
  // no Tonight visibility panel, a curated description/type instead of a
  // (nonexistent) catalog lookup, and a bundled cover until a real capture
  // sets one.
  const isStartrails = baseObject?.type === DWARF_STARTRAILS_OBJECT_TYPE;

  // Redirect variant URLs (e.g. /object/IC434_Mosaic) to the base, so every
  // variant is visible under one page.
  useEffect(() => {
    if (baseObject && baseObject.id !== objectId) {
      navigate(`/object/${encodeURIComponent(baseObject.id)}`, { replace: true });
    }
  }, [baseObject, objectId, navigate]);

  // All objectIds for this entry: base + variants. Memoized as a stable array
  // so the useQueries and allSessions memo below don't recompute every render.
  // Falls back to [objectId] while allObjects is loading so sessions are
  // fetched immediately rather than waiting on the catalog lookup.
  const allVariantIds = useMemo<string[]>(() =>
    allObjects === undefined
      ? [objectId ?? '']
      : baseObject
        ? [baseObject.id, ...(baseObject.variants ?? []).map(v => v.objectId)]
        : [objectId ?? ''],
  [allObjects, objectId, baseObject]);

  const deleteObjectMutation = useMutation({
    mutationFn: () => deleteLibraryObject(activeObjectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library-objects'] });
      // The delete lands in the same trash the restore button reads from, so
      // without this the "N deleted" count on the page you land back on stays
      // stale until something else happens to refetch it (its 15s staleTime
      // means that can be a while). This object's own page is about to
      // navigate away, so this is for whichever object list the user returns
      // to next.
      queryClient.invalidateQueries({ queryKey: ['deleted-objects'] });
      navigate('/');
    },
  });

  const deleteSessionMutation = useMutation({
    mutationFn: ({ objectId: oid, date }: { objectId: string; date: string }) =>
      deleteLibrarySession(oid, date),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['library-sessions', variables.objectId] });
      // Without this the "N deleted" restore link never appears after
      // deleting an observation: the trash query has a 15s staleTime and
      // nothing else on this page would trigger a refetch of it.
      queryClient.invalidateQueries({ queryKey: ['deleted-sessions'] });
      // Counts/last-observed on the Library grid and the Observations
      // calendar are derived from these and go stale the same way.
      queryClient.invalidateQueries({ queryKey: ['library-objects'] });
      queryClient.invalidateQueries({ queryKey: ['observations'] });
      setDeleteSession(null);
    },
  });

  // Global trash lists, filtered down to this object's own ids. Kept as one
  // global fetch (the trash is normally tiny) rather than a per-object
  // endpoint, then narrowed client-side so every object page can show its own
  // "N deleted" affordance without a bespoke query per object.
  //
  // `allVariantIds` already falls back to `[objectId]` when the object was
  // fully deleted (it no longer appears in `allObjects`), so this also covers
  // the not-found branch below without any extra lookup.
  const { data: deletedObjectsAll } = useQuery({
    queryKey: ['deleted-objects'],
    queryFn: getDeletedObjects,
    enabled: isAdmin,
    staleTime: 15_000,
  });
  const { data: deletedSessionsAll } = useQuery({
    queryKey: ['deleted-sessions'],
    queryFn: getDeletedSessions,
    enabled: isAdmin,
    staleTime: 15_000,
  });
  const deletedObjectsForThis = useMemo(
    () => (deletedObjectsAll ?? []).filter(o => allVariantIds.includes(o.objectId)),
    [deletedObjectsAll, allVariantIds],
  );
  const deletedSessionsForThis = useMemo(
    () => (deletedSessionsAll ?? []).filter(s => allVariantIds.includes(s.objectId)),
    [deletedSessionsAll, allVariantIds],
  );
  const trashCount = deletedObjectsForThis.length + deletedSessionsForThis.length;

  const restoreObjectMutation = useMutation({
    mutationFn: (id: string) => restoreLibraryObject(id),
    onSuccess: () => {
      setTrashError(null);
      queryClient.invalidateQueries({ queryKey: ['deleted-objects'] });
      queryClient.invalidateQueries({ queryKey: ['library-objects'] });
    },
    onError: (err: Error) => setTrashError(err.message),
  });

  const restoreSessionMutation = useMutation({
    mutationFn: ({ objectId: oid, date }: { objectId: string; date: string }) => restoreLibrarySession(oid, date),
    onSuccess: (_data, variables) => {
      setTrashError(null);
      queryClient.invalidateQueries({ queryKey: ['deleted-sessions'] });
      queryClient.invalidateQueries({ queryKey: ['library-sessions', variables.objectId] });
    },
    onError: (err: Error) => setTrashError(err.message),
  });

  // Optimistic, like the Library grid's star: the whole point of a favorite is
  // that it reacts instantly.
  const favoriteMutation = useMutation({
    mutationFn: (next: boolean) => toggleFavorite(activeObjectId, next),
    onSuccess: (_data, next) => {
      queryClient.setQueryData<AstroObject[]>(['library-objects'], old =>
        old?.map(o => (o.id === activeObjectId ? { ...o, isFavorite: next } : o)));
      queryClient.invalidateQueries({ queryKey: ['library-objects'] });
    },
  });
  const isFavorite = favoriteMutation.isPending
    ? (favoriteMutation.variables ?? false)
    : (baseObject?.isFavorite ?? false);

  // Sessions for every variant, in parallel.
  const sessionQueries = useQueries({
    queries: allVariantIds.map(id => ({
      queryKey: ['library-sessions', id],
      queryFn: () => getLibrarySessions(id),
      enabled: allVariantIds.length > 0,
    })),
  });

  const sessionsLoading = sessionQueries.some(q => q.isLoading);

  // Merge all variant sessions, annotate each with which variant it came from,
  // and sort newest first.
  const allSessions = useMemo(() =>
    sessionQueries
      .flatMap((result, i) =>
        (result.data ?? []).map(session => ({
          ...session,
          sessionObjectId: allVariantIds[i],
          variantLabel: i === 0 ? null : (baseObject?.variants?.[i - 1]?.label ?? null),
        }))
      )
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
  [sessionQueries, allVariantIds, baseObject?.variants]);

  // Catalog metadata is shared across all variants — always use the base id.
  const { data: catalogEntry, isError: catalogNotFound } = useQuery({
    queryKey: ['catalog', baseObjectId],
    queryFn: () => getCatalogEntry(baseObjectId),
    enabled: !!baseObjectId,
    retry: false,
  });

  // What the telescope itself recorded per night: exposure, frames, integration.
  // One indexed query, and empty for a telescope that writes no sidecar.
  const { data: captureByDate } = useQuery({
    queryKey: ['object-capture', activeObjectId],
    queryFn: () => getObjectCapture(activeObjectId),
    enabled: !!activeObjectId,
    staleTime: 5 * 60 * 1000,
  });

  // Observation summaries carry the two things the sessions endpoint does not:
  // which telescope shot a night, and whether it has notes. Shared cache with
  // the Observations page, so this is usually already warm.
  const { data: observationSummaries } = useQuery({
    queryKey: ['observations'],
    queryFn: getObservations,
    staleTime: 60_000,
  });

  const { data: telescopes = [] } = useQuery({
    queryKey: ['telescopes'],
    queryFn: listTelescopes,
    staleTime: 5 * 60 * 1000,
  });

  const { data: site } = useQuery({
    queryKey: ['active-site'],
    queryFn: getActiveSite,
    staleTime: 60_000,
  });

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
    staleTime: Infinity,
  });

  const { data: galleryData } = useQuery({
    queryKey: ['gallery-image', activeObjectId],
    queryFn: () => getGalleryImage(activeObjectId),
    enabled: !!activeObjectId,
    // Prevent background refetches from transiently changing the URL and
    // re-triggering the loading state while the image is already displayed.
    staleTime: 5 * 60 * 1000,
  });

  // Computed only once galleryData resolves. Returning null while loading keeps
  // the hero from swapping its source twice on the way in.
  const headerPinnedSource = parseSourceSentinel(galleryData?.galleryImage);
  // Only the personal-file branch can produce a different URL on a retry: a
  // stale path can be re-resolved by the server. The two catalog-thumbnail
  // branches always recompute to the exact same URL from the exact same
  // inputs, so retrying them is not a second attempt, it is the same 404
  // again — see handleHeaderImgError below.
  const headerImgHealable = !headerPinnedSource && !!galleryData?.galleryImage;
  const headerImgSrc = galleryData === undefined
    ? null
    : headerPinnedSource
      ? getCatalogSourceThumbnailUrl(catalogEntry?.id || baseObjectId, headerPinnedSource, HERO_IMAGE_SIZE, HERO_IMAGE_SIZE)
      : galleryData.galleryImage
        ? getLibraryFileUrl(galleryData.galleryImage)
        // Star Trails has no catalog entry to fall back to (getCatalogThumbnailUrl
        // would just 404) — show the bundled placeholder until a real capture
        // sets a galleryImage, at which point the branch above wins instead.
        : isStartrails
          ? DWARF_STARTRAILS_PLACEHOLDER_IMAGE
          : getCatalogThumbnailUrl(catalogEntry?.id || baseObjectId, catalogEntry?.majorAxisArcmin ?? null, HERO_IMAGE_SIZE, HERO_IMAGE_SIZE);

  /**
   * Both image-state resets, done during render rather than in effects.
   *
   * A new object starts its retry budget over; a new source (the user just
   * chose a different gallery image) gets a fresh chance to load even if the
   * previous one had failed twice. As effects, each of these repainted one
   * frame of the previous object's state first, and cascaded a second render.
   */
  const [imageStateFor, setImageStateFor] = useState<{ objectId: string; src: string | null }>(
    { objectId: activeObjectId, src: headerImgSrc },
  );
  if (imageStateFor.objectId !== activeObjectId) {
    setImageStateFor({ objectId: activeObjectId, src: headerImgSrc });
    setGalleryErrorRetries(0);
    setHeaderImgError(false);
  } else if (headerImgSrc !== null && imageStateFor.src !== headerImgSrc) {
    setImageStateFor({ objectId: activeObjectId, src: headerImgSrc });
    setHeaderImgError(false);
  }

  // When the image URL fails to load, and it names a personal file (the file
  // moved or was deleted since the cache was populated), force-refetch the
  // gallery data once: the server auto-heals by picking the best available
  // file, or clearing a stale path. If the second attempt also fails, fall
  // back to "No image yet".
  //
  // The two catalog-thumbnail branches skip the retry and fail immediately:
  // invalidating `gallery-image` there just re-derives the identical URL from
  // the identical inputs, so the `<img>` src never changes, the browser never
  // re-requests it, and `onError` never fires a second time — `headerImgError`
  // would otherwise never be set and the broken image would sit there forever
  // instead of falling through to the empty state.
  const handleHeaderImgError = useCallback(() => {
    if (headerImgHealable && galleryErrorRetries === 0) {
      setGalleryErrorRetries(1);
      queryClient.invalidateQueries({ queryKey: ['gallery-image', activeObjectId] });
    } else {
      setHeaderImgError(true);
    }
  }, [headerImgHealable, galleryErrorRetries, queryClient, activeObjectId]);

  // The "Download" button can't be a plain <a href>: the ZIP route needs a
  // credential, and a browser download navigation can't send the auth header.
  // Mint a short-lived signed URL, then click a synthetic <a> at it.
  const handleDownloadAll = useCallback(async () => {
    setDownloadError(null);
    setDownloadPending(true);
    try {
      const { url } = await requestObjectDownloadUrl(activeObjectId, { fileType: 'all', includeVariants: true });
      const a = document.createElement('a');
      a.href = url;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Could not start the download. Try again.');
    } finally {
      setDownloadPending(false);
    }
  }, [activeObjectId]);

  const displayName = catalogEntry?.name || baseObject?.name || objectId || baseObjectId;

  const totals = useMemo(() => summarizeObject(allSessions, captureByDate), [allSessions, captureByDate]);
  const metrics = useMemo(() => buildObjectMetrics(totals), [totals]);

  // Telescopes that have actually been on this target, in the library's own
  // recency order, resolved to names and colours.
  const heroTelescopes = useMemo(() => {
    const ids = baseObject?.telescopeIds ?? [];
    return ids
      .map(id => telescopes.find(t => t.id === id))
      .filter((t): t is NonNullable<typeof t> => !!t)
      .map(t => ({ id: t.id, name: t.name, color: t.color }));
  }, [baseObject?.telescopeIds, telescopes]);

  const observationCards = useMemo<ObservationCardModel[]>(() => {
    // Keyed by `objectId|date`, which is how a variant's night stays distinct
    // from the base object's night on the same date.
    const summaryByKey = new Map(
      (observationSummaries ?? []).map(o => [`${o.objectId}|${o.date}`, o]),
    );
    return allSessions.map(s => {
      const summary = summaryByKey.get(`${s.sessionObjectId}|${s.date}`);
      const telescope = summary?.telescopeId
        ? telescopes.find(t => t.id === summary.telescopeId)
        : undefined;
      return {
        objectId: s.sessionObjectId,
        id: s.id,
        date: s.date,
        stackedCount: s.stackedCount,
        subFrameCount: s.subFrameCount,
        processedCount: s.processedCount,
        imageCount: s.imageCount,
        videoCount: s.videoCount ?? 0,
        thumbnailUrl: s.thumbnailUrl
          || `/api/library/objects/${encodeURIComponent(s.sessionObjectId)}/thumbnail`,
        weather: s.weather ?? null,
        variantLabel: s.variantLabel,
        capture: captureByDate?.[s.date] ?? null,
        telescope: telescope ? { name: telescope.name, color: telescope.color } : null,
        hasNote: summary?.hasNotes ?? false,
      };
    });
  }, [allSessions, observationSummaries, telescopes, captureByDate]);

  const raHours = parseRaHours(catalogEntry?.ra);
  const decDegrees = parseDecDegrees(catalogEntry?.dec);

  const eyebrow = [
    baseObjectId,
    catalogEntry?.type || (isStartrails ? baseObject?.type : undefined),
    catalogEntry?.constellation && catalogEntry.constellation !== 'Unknown'
      ? catalogEntry.constellation
      : null,
  ].filter((v): v is string => !!v);

  // Show a not-found page when the object exists in neither the library nor the
  // catalog. `allObjects === undefined` means the query is still loading.
  const notFound = allObjects !== undefined && !baseObject && catalogNotFound;
  if (notFound) {
    // A deleted (not merely nonexistent) object still lands here whenever it
    // isn't a recognized catalog id — a custom/non-cataloged target has no
    // other page to show its restore button on, so it goes here instead of
    // the generic empty state.
    const deletedEntry = deletedObjectsForThis[0];
    return (
      <div className="space-y-6">
        <Link
          to="/"
          className={`inline-flex items-center gap-2 text-sm font-medium transition ${
            isDark ? 'text-slate-400 hover:text-accent-400' : 'text-slate-500 hover:text-accent-600'
          }`}
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Library
        </Link>
        <div className={`rounded-2xl border p-12 text-center ${
          isDark ? 'border-slate-800 bg-slate-900' : 'border-slate-200 bg-white shadow-sm'
        }`}>
          {deletedEntry ? (
            <>
              <RotateCcw className={`mx-auto mb-4 h-10 w-10 ${isDark ? 'text-slate-600' : 'text-slate-300'}`} />
              <p className={`text-lg font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                {deletedEntry.objectName || deletedEntry.objectId} was deleted
              </p>
              <p className={`mt-1 text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                Its local files are gone, and it is blocked from re-syncing. Restoring only lifts
                the block, so the telescope can send it back next time it images this target.
              </p>
              <button
                type="button"
                onClick={() => restoreObjectMutation.mutate(deletedEntry.objectId)}
                disabled={restoreObjectMutation.isPending}
                className={`mt-5 inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed ${
                  isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-200' : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                }`}
              >
                {restoreObjectMutation.isPending
                  ? <RotateCw className="h-3.5 w-3.5 animate-spin" />
                  : <RotateCcw className="h-3.5 w-3.5" />}
                Restore
              </button>
              {trashError && (
                <p className={`mt-3 text-sm ${isDark ? 'text-red-300' : 'text-red-600'}`}>{trashError}</p>
              )}
            </>
          ) : (
            <>
              <AlertTriangle className={`mx-auto mb-4 h-10 w-10 ${isDark ? 'text-slate-600' : 'text-slate-300'}`} />
              <p className={`text-lg font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                Object not found
              </p>
              <p className={`mt-1 text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                <span className="font-mono">{objectId}</span> does not exist in your library or the catalog.
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <TourAnchor id="object-processed" className="block">
      <ObjectHero
        displayName={displayName}
        eyebrow={eyebrow}
        imageSrc={headerImgSrc}
        imageFailed={headerImgError}
        onImageError={handleHeaderImgError}
        onEditImage={isAdmin ? () => setGalleryModalOpen(true) : null}
        telescopes={heroTelescopes}
        metrics={metrics}
        accent={accent}
        isFavorite={isFavorite}
        onToggleFavorite={() => favoriteMutation.mutate(!isFavorite)}
        onAddObservation={isAdmin ? () => setNewObservationOpen(true) : null}
        onCompare={allSessions.length >= 2 ? () => setCompareModalOpen(true) : null}
        onCombine={() => setCombineSubframesOpen(true)}
        onDownloadAll={handleDownloadAll}
        downloadPending={downloadPending}
        onSyncAllSubframes={isAdmin && !isStartrails && allSessions.length > 0
          ? () => openObjectSync(activeObjectId)
          : null}
        // The planner searches by catalog id, so an object the catalog does not
        // know cannot be handed to it.
        onPlan={catalogEntry?.id
          ? () => navigate('/planner', { state: { searchQuery: catalogEntry.id } })
          : null}
        onEditDetails={isAdmin ? () => setEditObjectOpen(true) : null}
        onDelete={isAdmin ? () => setDeleteObjectConfirm(true) : null}
        objectId={activeObjectId}
        hideTargetActions={isStartrails}
      />
      </TourAnchor>

      {downloadError && (
        <p className={`text-sm ${isDark ? 'text-red-300' : 'text-red-600'}`} role="alert">{downloadError}</p>
      )}

      {FRAMING_MOSAIC_ENABLED && (
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => setFramingOpen(true)}
            className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition ${
              isDark ? 'border-slate-800 text-slate-300 hover:bg-slate-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}
            title="Preview how this object frames in your telescope, and plan a mosaic"
          >
            Framing &amp; Mosaic
          </button>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <ObjectPanel
          displayName={displayName}
          info={{
            type: catalogEntry?.type || (isStartrails ? baseObject?.type : undefined),
            constellation: catalogEntry?.constellation && catalogEntry.constellation !== 'Unknown'
              ? catalogEntry.constellation
              : null,
            size: catalogEntry?.size,
            ra: catalogEntry?.ra != null ? String(catalogEntry.ra) : null,
            dec: catalogEntry?.dec != null ? String(catalogEntry.dec) : null,
            // Star Trails has no catalog entry (getCatalogEntry 404s), so its
            // curated description — already sitting on the library row itself
            // — is the only source of one.
            description: catalogEntry?.description || (isStartrails ? baseObject?.description : undefined),
            wikiUrl: catalogEntry?.wikiUrl,
          }}
          magnitude={typeof catalogEntry?.magnitude === 'number' ? catalogEntry.magnitude : null}
          distanceLy={catalogEntry?.distanceLy ?? null}
          alsoKnownAs={catalogEntry?.alsoKnownAs ?? undefined}
        />

        {/* Visibility-tonight math doesn't apply to a non-celestial synthetic
            target, so the row collapses to one column instead. */}
        {!isStartrails && <TonightPanel raHours={raHours} decDegrees={decDegrees} site={site} />}
      </div>

      <ObjectProcessedSection objectId={activeObjectId} isAdmin={isAdmin} />

      <ObservationsSection
        observations={observationCards}
        isDark={isDark}
        loading={sessionsLoading}
        tempUnit={settings?.temperatureUnit === 'fahrenheit' ? 'fahrenheit' : 'celsius'}
        onDelete={isAdmin
          ? o => setDeleteSession({ objectId: o.objectId, date: o.date })
          : null}
        trashCount={isAdmin ? trashCount : 0}
        onOpenTrash={isAdmin ? () => setTrashModalOpen(true) : null}
      />

      {trashModalOpen && (
        <ObjectTrashModal
          isDark={isDark}
          objectName={displayName}
          deletedObjects={deletedObjectsForThis}
          deletedSessions={deletedSessionsForThis}
          onRestoreObject={id => restoreObjectMutation.mutate(id)}
          onRestoreSession={args => restoreSessionMutation.mutate(args)}
          restoringObjectId={restoreObjectMutation.isPending ? (restoreObjectMutation.variables ?? null) : null}
          restoringSession={restoreSessionMutation.isPending ? (restoreSessionMutation.variables ?? null) : null}
          error={trashError}
          onClose={() => setTrashModalOpen(false)}
        />
      )}

      {compareModalOpen && (
        <CompareSessionsModal objectId={activeObjectId} onClose={() => setCompareModalOpen(false)} />
      )}

      {combineSubframesOpen && (
        <CombineSubframesModal objectId={activeObjectId} onClose={() => setCombineSubframesOpen(false)} />
      )}

      {editObjectOpen && (
        <EditObjectModal
          objectId={baseObjectId}
          current={{
            name: catalogEntry?.name,
            type: catalogEntry?.type,
            constellation: catalogEntry?.constellation,
            magnitude: typeof catalogEntry?.magnitude === 'number' ? catalogEntry.magnitude : null,
            description: catalogEntry?.description,
            ra: catalogEntry?.ra,
            dec: catalogEntry?.dec,
            distanceLy: catalogEntry?.distanceLy ?? null,
          }}
          onClose={() => setEditObjectOpen(false)}
        />
      )}

      {framingOpen && (
        <FramingModal
          catalogId={catalogEntry?.id || baseObjectId}
          objectName={displayName}
          isDark={isDark}
          onClose={() => setFramingOpen(false)}
        />
      )}

      {galleryModalOpen && (
        <GalleryImageModal
          objectId={activeObjectId}
          catalogId={catalogEntry?.id || baseObjectId}
          currentGalleryImage={galleryData?.galleryImage ?? null}
          onClose={() => setGalleryModalOpen(false)}
          isDark={isDark}
        />
      )}

      <NewObservationModal
        isOpen={newObservationOpen}
        onClose={() => setNewObservationOpen(false)}
        objectId={activeObjectId}
        objectName={displayName}
        onSuccess={result => {
          setNewObservationOpen(false);
          queryClient.invalidateQueries({ queryKey: ['library-sessions', result.objectId] });
          navigate(`/observations/${encodeURIComponent(result.objectId)}/${encodeURIComponent(result.date)}`);
        }}
      />

      {deleteObjectConfirm && (
        <DangerConfirm
          title="Delete object"
          pending={deleteObjectMutation.isPending}
          error={deleteObjectMutation.error}
          onCancel={() => setDeleteObjectConfirm(false)}
          onConfirm={() => deleteObjectMutation.mutate()}
          body={
            <>
              This permanently deletes every local image file for <strong>{baseObjectId}</strong>.
              That part cannot be undone. It also blocks {baseObjectId} from being re-synced from
              the telescope, but that part can: come back to this object's page and restore it.
              Observation notes are kept.
            </>
          }
        />
      )}

      {deleteSession && (
        <DangerConfirm
          title="Delete observation"
          pending={deleteSessionMutation.isPending}
          error={deleteSessionMutation.error}
          onCancel={() => setDeleteSession(null)}
          onConfirm={() => deleteSessionMutation.mutate(deleteSession)}
          body={
            <>
              This permanently deletes every local file for the{' '}
              <strong>{deleteSession.objectId}</strong> observation on{' '}
              <strong>
                {new Date(deleteSession.date + 'T12:00:00').toLocaleDateString(undefined, {
                  year: 'numeric', month: 'long', day: 'numeric',
                })}
              </strong>. That part cannot be undone. It also blocks this observation from being
              re-synced from the telescope, but that part can: restore it from the Observations
              section on this page.
            </>
          }
        />
      )}
    </div>
  );
}
