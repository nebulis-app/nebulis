import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Calendar, FolderOpen, RotateCw, Image, Layers, Columns, Download, PlusCircle, Trash2, AlertTriangle, Pencil, ExternalLink } from 'lucide-react';
import { getLibrarySessions, getDownloadUrl, deleteLibraryObject, deleteLibrarySession, getGalleryImage, getLibraryFileUrl, getLibraryObjects } from '../lib/api/library';
import { getCatalogEntry } from '../lib/api/catalog';
import { getCatalogThumbnailUrl, getCatalogSourceThumbnailUrl, parseSourceSentinel } from '../lib/catalogImage';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../contexts/AuthContext';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { GalleryImageModal } from '../components/GalleryImageModal';
import { CompareSessionsModal } from '../components/CompareSessionsModal';
import { CombineSubframesModal } from '../components/CombineSubframesModal';
import { EditObjectModal } from '../components/EditObjectModal';

export function ObjectDetail() {
  const { objectId } = useParams<{ objectId: string }>();
  const { isDark } = useTheme();
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [deleteObjectConfirm, setDeleteObjectConfirm] = useState(false);
  const [deleteSession, setDeleteSession] = useState<{ objectId: string; date: string } | null>(null);
  const [galleryModalOpen, setGalleryModalOpen] = useState(false);
  const [compareModalOpen, setCompareModalOpen] = useState(false);
  const [combineSubframesOpen, setCombineSubframesOpen] = useState(false);
  const [editObjectOpen, setEditObjectOpen] = useState(false);
  const [headerImgLoaded, setHeaderImgLoaded] = useState(false);
  const [headerImgError, setHeaderImgError] = useState(false);
  // Tracks how many times we've force-refetched gallery data after an image load
  // failure. Prevents infinite retry loops while still auto-healing stale paths.
  const [galleryErrorRetries, setGalleryErrorRetries] = useState(0);

  // Find variants by looking up the grouped library objects list.
  // This is cached from the Gallery so it's free when navigating normally;
  // on direct navigation it fetches once.
  const { data: allObjects } = useQuery({
    queryKey: ['library-objects'],
    queryFn: getLibraryObjects,
    staleTime: 5 * 60 * 1000,
  });

  // The current object may itself be a variant (e.g. IC434_Mosaic).
  // Find the base entry that owns it — either the object is the base, or
  // it's listed in another object's variants array.
  const baseObject = allObjects?.find(
    o => o.id === objectId || o.variants?.some(v => v.objectId === objectId),
  );

  // Always work off the base object. If the URL points at a variant, redirect
  // to the base so all variants are visible under one page.
  const baseObjectId = baseObject?.id ?? objectId ?? '';
  const activeObjectId = baseObjectId;

  // Redirect variant URLs (e.g. /object/IC434_Mosaic) to the base (/object/IC434)
  useEffect(() => {
    if (baseObject && baseObject.id !== objectId) {
      navigate(`/object/${encodeURIComponent(baseObject.id)}`, { replace: true });
    }
  }, [baseObject, objectId, navigate]);

  // All objectIds for this entry: base + variants.
  // Memoized as a stable array so the useQueries and allSessions memo below
  // don't recompute on every render.
  // Fall back to [objectId] while allObjects is still loading so sessions are
  // fetched immediately rather than waiting for the catalog lookup.
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
      navigate('/');
    },
  });

  const deleteSessionMutation = useMutation({
    mutationFn: ({ objectId: oid, date }: { objectId: string; date: string }) =>
      deleteLibrarySession(oid, date),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['library-sessions', variables.objectId] });
      setDeleteSession(null);
    },
  });

  // Fetch sessions for every variant (base + all variants) in parallel.
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

  const { data: galleryData } = useQuery({
    queryKey: ['gallery-image', activeObjectId],
    queryFn: () => getGalleryImage(activeObjectId),
    enabled: !!activeObjectId,
    // Prevent background refetches from transiently changing the URL and
    // re-triggering the loading spinner while the image is already displayed.
    staleTime: 5 * 60 * 1000,
  });

  // Reset retry counter when navigating to a different object.
  useEffect(() => {
    setGalleryErrorRetries(0);
  }, [activeObjectId]);

  // Compute the header image URL only when galleryData has resolved.
  // Returning null while loading prevents multiple URL changes (once on mount,
  // once when galleryData arrives, once when catalogEntry arrives) from each
  // resetting the spinner via the useEffect below.
  const headerPinnedSource = parseSourceSentinel(galleryData?.galleryImage);
  const headerImgSrc = galleryData === undefined
    ? null
    : headerPinnedSource
      ? getCatalogSourceThumbnailUrl(catalogEntry?.id || baseObjectId, headerPinnedSource)
      : galleryData.galleryImage
        ? getLibraryFileUrl(galleryData.galleryImage)
        : getCatalogThumbnailUrl(catalogEntry?.id || baseObjectId, catalogEntry?.majorAxisArcmin ?? null);

  // Reset load/error state whenever the image source changes so a newly-saved
  // gallery image is always rendered (headerImgError would otherwise keep the
  // <img> out of the DOM permanently after any prior load failure).
  // Skip the reset while galleryData is still loading (null src) to avoid the
  // spinner being shown before we even know what URL to load.
  // After the reset, check img.complete on the next frame: if the URL was
  // already cached by the browser (via a row thumbnail or prior visit) the
  // load event fired before React attached the listener, so the loaded flag
  // would otherwise stay false and the spinner would never clear.
  const headerImgRef = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    if (headerImgSrc === null) return;
    setHeaderImgLoaded(false);
    setHeaderImgError(false);
    const id = requestAnimationFrame(() => {
      const img = headerImgRef.current;
      if (img && img.complete && img.naturalHeight > 0) setHeaderImgLoaded(true);
    });
    return () => cancelAnimationFrame(id);
  }, [headerImgSrc]);

  // When the gallery image URL fails to load (e.g. file was moved or deleted
  // since the React Query cache was last populated), force-refetch the gallery
  // data once so the server can return an updated path. The server auto-heals:
  // it picks the best available file, or clears a stale path. If the second
  // attempt also fails, fall back to "No image".
  const handleHeaderImgError = useCallback(() => {
    if (galleryErrorRetries === 0) {
      setGalleryErrorRetries(1);
      queryClient.invalidateQueries({ queryKey: ['gallery-image', activeObjectId] });
      // Stay in loading state (headerImgError stays false) — the refetch will
      // update galleryData → headerImgSrc → useEffect resets loading state.
    } else {
      setHeaderImgError(true);
    }
  }, [galleryErrorRetries, queryClient, activeObjectId]);

  // Show a not-found page when the object doesn't exist in the library or catalog.
  // allObjects === undefined means the library query is still loading — wait before deciding.
  const notFound = allObjects !== undefined && !baseObject && catalogNotFound;
  if (notFound) {
    return (
      <div className="space-y-6">
        <Link
          to="/"
          className={`inline-flex items-center gap-2 text-sm font-medium transition ${
            isDark ? 'text-slate-400 hover:text-accent-400' : 'text-slate-500 hover:text-accent-600'
          }`}
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Library
        </Link>
        <div className={`rounded-2xl border p-12 text-center ${
          isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
        }`}>
          <AlertTriangle className={`w-10 h-10 mx-auto mb-4 ${isDark ? 'text-slate-600' : 'text-slate-300'}`} />
          <p className={`text-lg font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
            Object not found
          </p>
          <p className={`mt-1 text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            <span className="font-mono">{objectId}</span> does not exist in your library or the catalog.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Breadcrumb */}
      <Link
        to="/"
        className={`inline-flex items-center gap-2 text-sm font-medium transition ${
          isDark ? 'text-slate-400 hover:text-accent-400' : 'text-slate-500 hover:text-accent-600'
        }`}
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Library
      </Link>

      {/* Object header */}
      <div className={`relative rounded-2xl border p-8 ${
        isDark
          ? 'bg-gradient-to-br from-slate-900 to-slate-900/50 border-slate-800'
          : 'bg-gradient-to-br from-white to-slate-50 border-slate-200 shadow-sm'
      }`}>
        {isAdmin && (
          <button
            onClick={() => setDeleteObjectConfirm(true)}
            title="Delete object"
            className={`absolute top-4 right-4 p-2 rounded-lg transition ${
              isDark
                ? 'text-slate-600 hover:text-red-400 hover:bg-red-900/20'
                : 'text-slate-300 hover:text-red-500 hover:bg-red-50'
            }`}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
        <div className="flex flex-col md:flex-row md:items-start gap-6">
          {/* Object image — stock or custom gallery */}
          <div
            className={`group/img relative flex-shrink-0 w-36 h-36 md:w-44 md:h-44 rounded-xl overflow-hidden ${isAdmin ? 'cursor-pointer' : ''}`}
            onClick={() => isAdmin && setGalleryModalOpen(true)}
          >
            <div className={`absolute inset-0 ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
              {headerImgSrc === null ? (
                /* galleryData still loading — show neutral placeholder, not spinner */
                null
              ) : !headerImgError ? (
                <>
                  {!headerImgLoaded && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <RotateCw className="w-5 h-5 animate-spin text-accent-500/40" />
                    </div>
                  )}
                  <img
                    ref={headerImgRef}
                    src={headerImgSrc}
                    alt={catalogEntry?.name || objectId}
                    onLoad={() => setHeaderImgLoaded(true)}
                    onError={handleHeaderImgError}
                    className={`w-full h-full object-cover transition-opacity duration-300 ${
                      headerImgLoaded ? 'opacity-100' : 'opacity-0'
                    }`}
                  />
                </>
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5">
                  <Image className={`w-8 h-8 ${isDark ? 'text-slate-600' : 'text-slate-300'}`} />
                  <span className={`text-xs ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>No image</span>
                </div>
              )}
            </div>
            {/* Hover overlay with centered edit icon — admin only */}
            {isAdmin && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover/img:bg-black/40 transition-all duration-200 pointer-events-none">
                <Pencil className="w-6 h-6 text-white opacity-0 group-hover/img:opacity-100 transition-opacity duration-200 drop-shadow-lg" />
              </div>
            )}
          </div>

          {/* Text info */}
          <div className="flex-1 min-w-0">
            {/* Badges row - full width above main content */}
            <div className="flex items-center gap-2 flex-wrap mb-5">
              <span className={`font-display text-sm font-semibold px-3 py-1 rounded-lg ${
                isDark ? 'bg-accent-500/10 text-accent-400' : 'bg-accent-50 text-accent-700'
              }`}>
                {baseObjectId}
              </span>
              {catalogEntry?.type && (
                <span className={`text-sm px-2.5 py-0.5 rounded-md ${
                  isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-500'
                }`}>
                  {catalogEntry.type}
                </span>
              )}
            </div>

            <div className="flex items-start gap-6">
              {/* Left: title, description, wiki */}
              <div className="flex-1 min-w-0 space-y-4">
                <div className="flex items-center gap-3">
                  <h1 className={`font-display text-3xl font-bold tracking-tight ${
                    isDark ? 'text-white' : 'text-slate-900'
                  }`}>
                    {catalogEntry?.name || objectId}
                  </h1>
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => setEditObjectOpen(true)}
                      title="Edit object details"
                      className={`p-1.5 rounded-lg transition ${
                        isDark
                          ? 'text-slate-500 hover:text-slate-200 hover:bg-slate-800'
                          : 'text-slate-400 hover:text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                  )}
                </div>
                {catalogEntry?.description?.trim() && (
                  <p className={`leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                    {catalogEntry.description.trim()}
                  </p>
                )}
                {catalogEntry?.wikiUrl && (
                  <a
                    href={catalogEntry.wikiUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`inline-flex items-center gap-1.5 text-sm font-medium transition ${isDark ? 'text-accent-400 hover:text-accent-300' : 'text-accent-600 hover:text-accent-700'} hover:underline`}
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    Wikipedia
                  </a>
                )}

                {(catalogEntry?.alsoKnownAs?.length ?? 0) > 0 && (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 pt-1">
                    <span className={`text-[11px] font-semibold uppercase tracking-widest ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                      Also known as
                    </span>
                    {catalogEntry?.alsoKnownAs?.map(aka => (
                      <span
                        key={aka}
                        className={`text-xs font-medium px-2 py-0.5 rounded-md ${isDark ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600'}`}
                      >
                        {aka}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Right: catalog panel */}
              {(catalogEntry?.constellation || catalogEntry?.magnitude != null || catalogEntry?.distanceLy != null || catalogEntry?.ra || catalogEntry?.dec || catalogEntry?.size) && (
                <div className={`shrink-0 w-44 border-l pl-6 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
                  <p className="text-[11px] font-semibold uppercase tracking-widest mb-3 text-amber-500/80">
                    Catalog
                  </p>
                <div className="space-y-2.5">
                  {catalogEntry?.constellation && catalogEntry.constellation !== 'Unknown' && (
                    <div>
                      <p className={`text-xs ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>Constellation</p>
                      <p className={`text-sm font-medium leading-tight ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{catalogEntry.constellation}</p>
                    </div>
                  )}
                  {catalogEntry?.magnitude != null && (
                    <div>
                      <p className={`text-xs ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>Magnitude</p>
                      <p className={`text-sm font-medium leading-tight ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                        {typeof catalogEntry.magnitude === 'number' ? catalogEntry.magnitude.toFixed(2) : catalogEntry.magnitude}
                      </p>
                    </div>
                  )}
                  {catalogEntry?.distanceLy != null && (
                    <div>
                      <p className={`text-xs ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>Distance</p>
                      <p className={`text-sm font-medium leading-tight ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                        {catalogEntry.distanceLy >= 1_000_000
                          ? `${(catalogEntry.distanceLy / 1_000_000).toFixed(2)}M ly`
                          : `${catalogEntry.distanceLy.toLocaleString()} ly`}
                      </p>
                    </div>
                  )}
                  {catalogEntry?.size && (
                    <div>
                      <p
                        title="Apparent angular size as seen from Earth, measured in arcminutes (′). The full Moon is ~30′ across for comparison."
                        className={`text-xs cursor-help underline decoration-dotted underline-offset-2 ${isDark ? 'text-slate-600 decoration-slate-700' : 'text-slate-400 decoration-slate-300'}`}
                      >
                        Angular size
                      </p>
                      <p className={`text-sm font-medium leading-tight ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{catalogEntry.size}</p>
                    </div>
                  )}
                  {catalogEntry?.ra != null && (
                    <div>
                      <p className={`text-xs ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>RA</p>
                      <p className={`text-sm font-medium leading-tight ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{formatRA(catalogEntry.ra)}</p>
                    </div>
                  )}
                  {catalogEntry?.dec != null && (
                    <div>
                      <p className={`text-xs ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>Dec</p>
                      <p className={`text-sm font-medium leading-tight ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{formatDec(catalogEntry.dec)}</p>
                    </div>
                  )}
                </div>
              </div>
            )}
            </div>
          </div>

        </div>
      </div>

      {/* Compare sessions modal */}
      {compareModalOpen && (
        <CompareSessionsModal
          objectId={activeObjectId}
          onClose={() => setCompareModalOpen(false)}
        />
      )}

      {/* Combine subframes modal */}
      {combineSubframesOpen && (
        <CombineSubframesModal
          objectId={activeObjectId}
          onClose={() => setCombineSubframesOpen(false)}
        />
      )}

      {/* Edit object metadata modal */}
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

      {/* Gallery image modal */}
      {galleryModalOpen && (
        <GalleryImageModal
          objectId={activeObjectId}
          catalogId={catalogEntry?.id || baseObjectId}
          currentGalleryImage={galleryData?.galleryImage ?? null}
          onClose={() => setGalleryModalOpen(false)}
          isDark={isDark}
        />
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap gap-3">
        <button
          onClick={() => { if (allSessions.length >= 2) setCompareModalOpen(true); }}
          aria-disabled={allSessions.length < 2}
          title={allSessions.length < 2 ? 'Need 2 or more observations to use compare' : undefined}
          className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium border transition ${
            allSessions.length < 2
              ? `cursor-not-allowed opacity-50 ${isDark ? 'border-slate-800 text-slate-500' : 'border-slate-200 text-slate-400'}`
              : isDark ? 'border-slate-800 text-slate-300 hover:bg-slate-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
          }`}
        >
          <Columns className={`w-4 h-4 ${allSessions.length < 2 ? 'text-slate-400' : 'text-violet-500'}`} />
          Compare
        </button>
        <button
          onClick={() => setCombineSubframesOpen(true)}
          className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium border transition ${
            isDark ? 'border-slate-800 text-slate-300 hover:bg-slate-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
          }`}
        >
          <Layers className="w-4 h-4 text-emerald-500" />
          Combine Subframes &amp; Download
        </button>
        <a
          href={getDownloadUrl(activeObjectId, { fileType: 'all' })}
          className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium border transition ${
            isDark ? 'border-slate-800 text-slate-300 hover:bg-slate-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
          }`}
        >
          <Download className="w-4 h-4 text-accent-500" />
          Download All
        </a>
      </div>

      {/* Observations */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className={`font-display text-xl font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
            <Calendar className="w-5 h-5 inline mr-2 text-accent-500" />
            Observations
          </h2>
          <div className="flex items-center gap-3">
            {allSessions.length > 0 && (
              <span className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                {allSessions.length} observation{allSessions.length !== 1 ? 's' : ''}
              </span>
            )}
            {isAdmin && (
              <Link
                to={`/observations/new?objectId=${encodeURIComponent(activeObjectId)}&objectName=${encodeURIComponent(catalogEntry?.name || baseObjectId)}`}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                  isDark
                    ? 'bg-accent-500/15 text-accent-400 hover:bg-accent-500/25 border border-accent-500/30'
                    : 'bg-accent-300 text-accent-700 hover:bg-accent-400 border border-accent-400'
                }`}
              >
                <PlusCircle className="w-3.5 h-3.5" />
                Add Observation
              </Link>
            )}
          </div>
        </div>

        {sessionsLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className={`rounded-2xl overflow-hidden border ${
                  isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
                }`}
              >
                <div className={`h-56 img-placeholder ${isDark ? '' : 'bg-gradient-to-br from-slate-100 to-slate-200'}`} />
                <div className="p-4">
                  <div className={`h-4 rounded w-2/3 ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`} />
                </div>
              </div>
            ))}
          </div>
        ) : allSessions.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {allSessions.map(session => (
              <SessionCard
                key={`${session.sessionObjectId}-${session.id}`}
                objectId={session.sessionObjectId}
                session={session}
                variantLabel={session.variantLabel ?? undefined}
                isDark={isDark}
                onDelete={isAdmin ? () => setDeleteSession({ objectId: session.sessionObjectId, date: session.date }) : undefined}
              />
            ))}
          </div>
        ) : (
          <div className={`text-center py-12 rounded-xl border ${
            isDark ? 'bg-slate-900/50 border-slate-800 text-slate-500' : 'bg-white border-slate-200 text-slate-400'
          }`}>
            <FolderOpen className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p>No observations found for this object</p>
          </div>
        )}
      </div>
      {/* Delete object confirmation */}
      {deleteObjectConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className={`w-full max-w-md rounded-2xl p-6 space-y-4 ${
            isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white shadow-xl'
          }`}>
            <div className="flex items-center gap-3 text-red-500">
              <AlertTriangle className="w-6 h-6" />
              <h3 className="font-display font-semibold text-lg">Delete Object</h3>
            </div>
            <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              This will permanently delete all local image files for <strong>{objectId}</strong> and prevent
              them from being re-synced from the telescope. Observation notes will not be deleted. This cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setDeleteObjectConfirm(false)}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition ${
                  isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'
                }`}
              >
                Cancel
              </button>
              <button
                onClick={() => deleteObjectMutation.mutate()}
                disabled={deleteObjectMutation.isPending}
                className="px-4 py-2 rounded-xl text-sm font-medium bg-red-600 text-white hover:bg-red-700 transition disabled:opacity-50 flex items-center gap-2"
              >
                {deleteObjectMutation.isPending && <RotateCw className="w-4 h-4 animate-spin" />}
                Delete Permanently
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete session confirmation */}
      {deleteSession && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className={`w-full max-w-md rounded-2xl p-6 space-y-4 ${
            isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white shadow-xl'
          }`}>
            <div className="flex items-center gap-3 text-red-500">
              <AlertTriangle className="w-6 h-6" />
              <h3 className="font-display font-semibold text-lg">Delete Observation</h3>
            </div>
            <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              This will permanently delete all local files for the{' '}
              <strong>{deleteSession.objectId}</strong>{' '}observation on{' '}
              <strong>
                {new Date(deleteSession.date + 'T12:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
              </strong>
              {' '}and prevent it from being re-synced from the telescope. This cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setDeleteSession(null)}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition ${
                  isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'
                }`}
              >
                Cancel
              </button>
              <button
                onClick={() => deleteSessionMutation.mutate(deleteSession)}
                disabled={deleteSessionMutation.isPending}
                className="px-4 py-2 rounded-xl text-sm font-medium bg-red-600 text-white hover:bg-red-700 transition disabled:opacity-50 flex items-center gap-2"
              >
                {deleteSessionMutation.isPending && <RotateCw className="w-4 h-4 animate-spin" />}
                Delete Permanently
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatRA(ra: string): string {
  // Already sexagesimal — display as-is
  if (/\d+h/i.test(ra)) return ra;
  const h = parseFloat(ra);
  if (isNaN(h)) return ra;
  // Decimal hours → HH h MM m SS.s s
  const hh = Math.floor(h);
  const mRem = (h - hh) * 60;
  const mm = Math.floor(mRem);
  const ss = ((mRem - mm) * 60).toFixed(1).padStart(4, '0');
  return `${String(hh).padStart(2, '0')}h ${String(mm).padStart(2, '0')}m ${ss}s`;
}

function formatDec(dec: string): string {
  // Already sexagesimal — display as-is
  if (/°/.test(dec)) return dec;
  const d = parseFloat(dec);
  if (isNaN(d)) return dec;
  // Decimal degrees → ±DD° MM′ SS″
  const sign = d < 0 ? '−' : '+';
  const abs = Math.abs(d);
  const dd = Math.floor(abs);
  const mRem = (abs - dd) * 60;
  const mm = Math.floor(mRem);
  const ss = Math.round((mRem - mm) * 60);
  return `${sign}${String(dd).padStart(2, '0')}° ${String(mm).padStart(2, '0')}′ ${String(ss).padStart(2, '0')}″`;
}

function variantBadgeClass(label: string, isDark: boolean) {
  const l = label.toLowerCase();
  if (l.includes('mosaic')) return isDark ? 'bg-amber-500/85 text-white' : 'bg-amber-500 text-white';
  if (l === 'hα' || l === 'ha') return isDark ? 'bg-red-500/85 text-white' : 'bg-red-500 text-white';
  if (l === 'oiii') return isDark ? 'bg-cyan-500/85 text-white' : 'bg-cyan-500 text-white';
  if (l === 'sii') return isDark ? 'bg-blue-500/85 text-white' : 'bg-blue-500 text-white';
  return isDark ? 'bg-violet-500/85 text-white' : 'bg-violet-500 text-white';
}

function SessionCard({
  objectId,
  session,
  variantLabel,
  isDark,
  onDelete,
}: {
  objectId: string;
  session: { id: string; date: string; fileCount: number; stackedCount: number; fitsCount: number; imageCount: number; subFrameCount: number; processedCount: number; thumbnailUrl: string };
  variantLabel?: string;
  isDark: boolean;
  onDelete?: () => void;
}) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);

  const thumbUrl = session.thumbnailUrl || `/api/library/objects/${encodeURIComponent(objectId)}/thumbnail`;

  const formattedDate = session.date !== 'unknown'
    ? new Date(session.date + 'T12:00:00').toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : 'Unknown date';

  return (
    <div className={`group relative card-hover rounded-2xl overflow-hidden border transition-all ${
      isDark
        ? 'bg-slate-900 border-slate-800 hover:border-slate-700'
        : 'bg-white border-slate-200 hover:border-slate-300 shadow-sm hover:shadow-md'
    }`}>
      <Link to={`/observations/${encodeURIComponent(objectId)}/${encodeURIComponent(session.date)}`}>
        <div className={`relative h-56 overflow-hidden ${
          isDark ? 'bg-slate-800' : 'bg-slate-100'
        }`}>
          {variantLabel && (
            <div className={`absolute top-2 left-2 z-10 flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${variantBadgeClass(variantLabel, isDark)}`}>
              {variantLabel.toLowerCase().includes('mosaic') && <Layers className="w-3 h-3" />}
              {variantLabel}
            </div>
          )}
          {!imgError ? (
            <>
              {!imgLoaded && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <RotateCw className="w-6 h-6 animate-spin text-accent-500/40" />
                </div>
              )}
              <img
                src={thumbUrl}
                alt={session.date}
                onLoad={() => setImgLoaded(true)}
                onError={() => setImgError(true)}
                className={`w-full h-full object-cover transition-opacity duration-300 ${
                  imgLoaded ? 'opacity-100' : 'opacity-0'
                }`}
              />
            </>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
              <Image className={`w-8 h-8 ${isDark ? 'text-slate-600' : 'text-slate-300'}`} />
              <span className={`text-xs ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>No preview</span>
            </div>
          )}
        </div>

        <div className="p-4 space-y-2">
          <p className={`font-medium text-sm ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
            <Calendar className="w-3.5 h-3.5 inline mr-1.5" />
            {formattedDate}
          </p>
          <div className={`flex items-center gap-3 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {session.stackedCount > 0 && (
              <span className="flex items-center gap-1">
                <Layers className="w-3 h-3" />
                {session.stackedCount} stacked
              </span>
            )}
            {session.subFrameCount > 0 && (
              <span className="flex items-center gap-1">
                <Image className="w-3 h-3" />
                {session.subFrameCount} subs
              </span>
            )}
            {session.processedCount > 0 && (
              <span className="flex items-center gap-1">
                <Pencil className="w-3 h-3" />
                {session.processedCount} processed
              </span>
            )}
            {session.stackedCount === 0 && session.subFrameCount === 0 && session.processedCount === 0 && (
              <span>No files</span>
            )}
          </div>
        </div>
      </Link>

      {onDelete && (
        <button
          onClick={e => { e.preventDefault(); onDelete(); }}
          className="absolute top-2 right-2 p-1.5 rounded-lg bg-red-600/80 text-white hover:bg-red-600 transition opacity-0 group-hover:opacity-100"
          title="Delete session"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
