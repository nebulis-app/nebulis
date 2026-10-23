/**
 * The "All media" object page body: every picture an object has (processed,
 * telescope images, sub-frames, videos, project archives) across all nights,
 * in one filterable grid. Nights are only a way to group it. The By-night page
 * (`ObservationsSection`) is the alternative, picked in Settings → Library.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Calendar, ImagePlus, LayoutGrid, List, Loader2, RotateCcw } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { GalleryModal, type GalleryItem } from '../GalleryModal';
import { ObjectImageEditor } from '../objectDetail/ObjectImageEditor';
import { editRequestFor, type ObjectEditRequest } from '../objectDetail/objectEditRequest';
import {
  deleteObjectProcessedImage, markFileAsProcessed, unmarkProcessedImage, setGalleryImage, toggleImageFavorite, uploadObjectProcessedImage,
  type MediaItem,
} from '../../lib/api/library';
import { PROCESSED_UPLOAD_EXTENSIONS } from '../../lib/processedFormats';
import { FrameAnalysisModal } from '../FrameAnalysisModal';
import { ConfirmModal } from '../ConfirmModal';
import { MediaGroupSection } from './MediaGroup';
import { FeaturedProcessed } from './FeaturedProcessed';
import { SubframeNights } from './SubframeNights';
import { NightsList } from './NightsList';
import { ObjectProjectArchivesSection } from '../objectDetail/ObjectProjectArchivesSection';
import { MediaTabs, MediaToolbar } from './MediaToolbar';
import { TILE_DEFAULT, opensInViewer, parseTileSize, type TileSize } from './tileSizing';
import { useObjectMedia } from './useObjectMedia';
import type { ProcessedImage } from '../../types';

const SIZE_KEY = 'nebulis_media_tile_size';
const SUBS_VIEW_KEY = 'nebulis_media_subs_view';
const HIDE_FITS_KEY = 'nebulis_media_hide_fits';

type SubsView = 'grid' | 'list';

/** The user's own pick for how sub-frames are shown, or null when they have not chosen. */
function readSubsView(): SubsView | null {
  try {
    const v = localStorage.getItem(SUBS_VIEW_KEY);
    return v === 'grid' || v === 'list' ? v : null;
  } catch { return null; }
}

function readHideFits(): boolean {
  try { return localStorage.getItem(HIDE_FITS_KEY) === '1'; } catch { return false; }
}

function readSize(): TileSize {
  try {
    const stored = parseTileSize(localStorage.getItem(SIZE_KEY));
    if (stored) return stored;
  } catch { /* storage blocked: use the default */ }
  return TILE_DEFAULT;
}

interface Props {
  /** The base object id; the server folds in its variants. */
  objectId: string;
  objectName: string;
  isAdmin: boolean;
  /** Opens the "new observation" dialog, shown on an empty object. */
  onAddObservation: (() => void) | null;
  trashCount: number;
  onOpenTrash: (() => void) | null;
}

export function ObjectMediaView({ objectId, objectName, isAdmin, onAddObservation, trashCount, onOpenTrash }: Props) {
  const { t } = useTranslation('library');
  const { isDark } = useTheme();
  const queryClient = useQueryClient();
  const media = useObjectMedia(objectId);
  const { state, groups } = media;
  // All is the pictures and videos: processed ones, the telescope's own and its stacked files. Sub-frames and project
  // archives each have a tab of their own, so they are left out here.
  const items = useMemo(
    () => (state.tab === 'all' ? media.items.filter(i => i.kind !== 'sub' && i.kind !== 'project') : media.items),
    [media.items, state.tab],
  );
  const tabCounts = useMemo(
    () => (media.counts
      ? { ...media.counts, all: Math.max(0, media.counts.all - media.counts.sub - media.counts.project) }
      : media.counts),
    [media.counts],
  );

  const [analysisOpen, setAnalysisOpen] = useState(false);
  const subNights = media.facets?.nights ?? [];

  // The list is the default: scores and flags are what tell frames apart, and 150 near-identical star fields
  // are not. A choice the user made always wins.
  const [subsViewPref, setSubsViewPref] = useState<SubsView | null>(readSubsView);
  const subsView: SubsView = subsViewPref ?? 'list';
  const listMode = state.tab === 'sub' && subsView === 'list';
  const chooseSubsView = useCallback((next: SubsView) => {
    setSubsViewPref(next);
    try { localStorage.setItem(SUBS_VIEW_KEY, next); } catch { /* per-viewer convenience only */ }
  }, []);

  // Quality analysis reads raw FITS frames, so it is offered on the Subframes tab, and only to admins (it is CPU work).
  const canAnalyze = isAdmin && state.tab === 'sub' && subNights.length > 0;

  const [hideFits, setHideFits] = useState(readHideFits);
  const toggleHideFits = useCallback(() => {
    setHideFits(prev => {
      const next = !prev;
      try { localStorage.setItem(HIDE_FITS_KEY, next ? '1' : '0'); } catch { /* per-viewer convenience only */ }
      return next;
    });
  }, []);

  const [size, setSize] = useState<TileSize>(readSize);
  const changeSize = useCallback((next: TileSize) => {
    setSize(next);
    try { localStorage.setItem(SIZE_KEY, String(next)); } catch { /* per-viewer convenience only */ }
  }, []);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['object-media', objectId] });
  }, [queryClient, objectId]);

  // ── Viewer ────────────────────────────────────────────────────────────────
  const viewerItems = useMemo(() => items.filter(opensInViewer), [items]);
  const galleryItems = useMemo<GalleryItem[]>(() => viewerItems.flatMap((i): GalleryItem[] => {
    if (i.kind === 'processed' && i.processed) return [{ kind: 'processed', img: i.processed }];
    if (i.file) return [{ kind: 'file', file: i.file }];
    return [];
  }), [viewerItems]);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const openItem = useCallback((item: MediaItem) => {
    const idx = viewerItems.findIndex(i => i.id === item.id);
    if (idx >= 0) setViewerIndex(idx);
  }, [viewerItems]);

  const closeViewer = useCallback(() => {
    setViewerIndex(null);
    // A delete or cover change in the viewer must show up behind it.
    refresh();
  }, [refresh]);

  const [editRequest, setEditRequest] = useState<ObjectEditRequest | null>(null);
  const openEditor = useCallback((
    url: string, name: string, sourceKind: 'telescope' | 'processed', overwriteTarget?: Parameters<typeof editRequestFor>[5],
  ) => {
    setEditRequest(editRequestFor(galleryItems, objectId, url, name, sourceKind, overwriteTarget));
  }, [galleryItems, objectId]);

  const [settingCoverId, setSettingCoverId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const setCover = useCallback(async (img: ProcessedImage) => {
    if (settingCoverId) return;
    setSettingCoverId(img.id);
    try {
      await setGalleryImage(objectId, img.path);
      void queryClient.invalidateQueries({ queryKey: ['gallery-image', objectId] });
      void queryClient.invalidateQueries({ queryKey: ['library-objects'] });
    } catch { /* best-effort, same as the processed section */ }
    finally { setSettingCoverId(null); }
  }, [objectId, settingCoverId, queryClient]);

  const deleteProcessed = useCallback(async (id: string) => {
    if (deletingId) return;
    setDeletingId(id);
    try {
      const owner = items.find(i => i.recordId === id)?.objectId ?? objectId;
      await deleteObjectProcessedImage(owner, id);
      void queryClient.invalidateQueries({ queryKey: ['processed-images-all', owner] });
      void queryClient.invalidateQueries({ queryKey: ['all-library-images'] });
      setViewerIndex(null);
      refresh();
    } catch { /* best-effort */ }
    finally { setDeletingId(null); }
  }, [deletingId, items, objectId, queryClient, refresh]);

  // ── Favorites ─────────────────────────────────────────────────────────────
  const favorite = useMutation({
    mutationFn: (item: MediaItem) => toggleImageFavorite(item.path, !item.isFavorite),
    onSuccess: () => {
      refresh();
      void queryClient.invalidateQueries({ queryKey: ['image-favorites'] });
      void queryClient.invalidateQueries({ queryKey: ['all-library-images'] });
    },
  });
  const onToggleFavorite = useCallback((item: MediaItem) => favorite.mutate(item), [favorite]);

  // ── Mark a telescope picture as processed (admin) ─────────────────────────
  const [markCandidate, setMarkCandidate] = useState<MediaItem | null>(null);
  const [markError, setMarkError] = useState<string | null>(null);
  const markProcessed = useMutation({
    mutationFn: (item: MediaItem) => markFileAsProcessed(objectId, item.date ?? '', item.path),
    onSuccess: () => {
      setMarkError(null);
      refresh();
      void queryClient.invalidateQueries({ queryKey: ['processed-images-all', objectId] });
      void queryClient.invalidateQueries({ queryKey: ['all-library-images'] });
    },
    onError: err => setMarkError(err instanceof Error ? err.message : t('objectMedia.tile.markProcessedFailed')),
  });
  const [unmarkCandidate, setUnmarkCandidate] = useState<MediaItem | null>(null);
  const markUnprocessed = useMutation({
    mutationFn: (item: MediaItem) => unmarkProcessedImage(objectId, item.date ?? '', item.recordId ?? ''),
    onSuccess: () => {
      setMarkError(null);
      refresh();
      void queryClient.invalidateQueries({ queryKey: ['processed-images-all', objectId] });
      void queryClient.invalidateQueries({ queryKey: ['all-library-images'] });
    },
    onError: err => setMarkError(err instanceof Error ? err.message : t('objectMedia.tile.markUnprocessedFailed')),
  });
  const askMarkUnprocessed = useCallback((item: MediaItem) => setUnmarkCandidate(item), []);
  const askMarkProcessed = useCallback((item: MediaItem) => setMarkCandidate(item), []);

  // ── Upload (admin) ────────────────────────────────────────────────────────
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [dragging, setDragging] = useState(false);
  const accepted = useMemo(() => new Set(PROCESSED_UPLOAD_EXTENSIONS.map(e => e.toLowerCase())), []);

  const upload = useCallback(async (file: File) => {
    if (uploading) return;
    const ext = `.${file.name.split('.').pop()?.toLowerCase() ?? ''}`;
    if (!accepted.has(ext)) {
      setUploadError(t('objectDetail.processedUploader.unsupportedFormat', { ext }));
      return;
    }
    setUploadError('');
    setUploading(true);
    try {
      await uploadObjectProcessedImage(objectId, file);
      refresh();
      void queryClient.invalidateQueries({ queryKey: ['processed-images-all', objectId] });
      void queryClient.invalidateQueries({ queryKey: ['all-library-images'] });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : t('objectDetail.processedUploader.uploadFailed'));
    } finally {
      setUploading(false);
    }
  }, [accepted, objectId, queryClient, refresh, t, uploading]);

  // ── Infinite scroll ───────────────────────────────────────────────────────
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = media;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
    }, { rootMargin: '800px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, items.length]);

  // ── Grouping ──────────────────────────────────────────────────────────────
  // A flat, unfiltered All tab leads with the finished pictures, large. They come first in the
  // list already (the server orders by kind), and the grid below leaves them out.
  const FEATURED_MAX = 4;
  const showFeatured = state.tab === 'all' && state.group === 'none' && media.activeFilterCount === 0;
  const featured = useMemo(
    () => (showFeatured ? items.filter(i => i.kind === 'processed' && i.isImage).slice(0, FEATURED_MAX) : []),
    [items, showFeatured],
  );
  const byGroup = useMemo(() => {
    const featuredIds = new Set(featured.map(i => i.id));
    const m = new Map<string, MediaItem[]>();
    for (const i of items) {
      if (featuredIds.has(i.id)) continue;
      const list = m.get(i.groupKey);
      if (list) list.push(i); else m.set(i.groupKey, [i]);
    }
    return m;
  }, [items, featured]);
  const visibleGroups = groups.filter(g => byGroup.has(g.key));

  const showAllSubs = useCallback((date: string) => media.update({ tab: 'sub', night: date }), [media]);

  const nothingAtAll = !media.isLoading && (tabCounts?.all ?? 0) === 0 && media.activeFilterCount === 0 && state.tab === 'all';
  // The Subframes tab opens on a list of nights; a night's frames are one click in, with a way back.
  const subEmpty = !media.isLoading && state.tab === 'sub' && (media.counts?.sub ?? 0) === 0;
  // With a single night there is nothing to choose between, so it opens straight to its frames.
  const nightsWithSubs = groups.filter(g => g.subCount > 0);
  const showNightOverview = state.tab === 'sub' && listMode && !state.night && state.group === 'night' && nightsWithSubs.length > 1;
  const overviewNights = showNightOverview ? nightsWithSubs : [];
  const noMatch = !media.isLoading && items.length === 0 && !nothingAtAll && !subEmpty && state.tab !== 'project';
  const muted = 'text-slate-500';

  return (
    <section
      aria-label={t('objectMedia.heading', { name: objectName })}
      className="space-y-4"
      onDragOver={isAdmin ? e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } } : undefined}
      onDragLeave={isAdmin ? e => { if (e.currentTarget === e.target) setDragging(false); } : undefined}
      onDrop={isAdmin ? e => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files[0];
        if (f) void upload(f);
      } : undefined}
    >
      <div className={`rounded-2xl border p-3 sm:p-4 ${
        dragging
          ? isDark ? 'border-accent-500/60 bg-accent-500/10' : 'border-accent-400 bg-accent-50'
          : isDark ? 'border-slate-800 bg-slate-900/40' : 'border-slate-200 bg-white/60'
      }`}>
        <div className="space-y-3">
          <MediaToolbar
            leading={<MediaTabs state={state} update={media.update} counts={tabCounts} isAdmin={isAdmin} />}
            state={state}
            update={media.update}
            clearFilters={media.clearFilters}
            activeFilterCount={media.activeFilterCount}
            counts={media.counts}
            facets={media.facets}
            size={size}
            onSizeChange={changeSize}
            onUpload={isAdmin ? () => fileInput.current?.click() : null}
            onReview={canAnalyze ? () => setAnalysisOpen(true) : null}
          />
          {state.tab === 'sub' && (
            <div className="flex flex-wrap items-center gap-2">
              <div
                role="group"
                aria-label={t('objectMedia.subsView.label')}
                className={`flex overflow-hidden rounded-lg border ${isDark ? 'border-slate-700' : 'border-slate-200'}`}
              >
                {(['grid', 'list'] as const).map(v => {
                  const Icon = v === 'grid' ? LayoutGrid : List;
                  return (
                    <button
                      key={v}
                      type="button"
                      onClick={() => chooseSubsView(v)}
                      aria-pressed={subsView === v}
                      title={t(`objectMedia.subsView.${v}Title`)}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${
                        subsView === v
                          ? isDark ? 'bg-slate-700 text-slate-100' : 'bg-slate-200 text-slate-800'
                          : isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-50'
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {t(`objectMedia.subsView.${v}`)}
                    </button>
                  );
                })}
              </div>

            </div>
          )}
        </div>

        <input
          ref={fileInput}
          type="file"
          accept={PROCESSED_UPLOAD_EXTENSIONS.join(',')}
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }}
        />

        {(uploading || uploadError) && (
          <p className={`mt-3 flex items-center gap-2 text-sm ${uploadError ? 'text-red-500' : muted}`} role={uploadError ? 'alert' : 'status'}>
            {uploadError
              ? <AlertTriangle className="h-4 w-4 shrink-0" />
              : <Loader2 className="h-4 w-4 shrink-0 animate-spin" />}
            {uploadError || t('objectDetail.processedUploader.uploading')}
          </p>
        )}

        <div className={`mt-4 transition-opacity ${media.isPlaceholder ? 'opacity-60' : ''}`}>
          {media.isLoading && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6" aria-busy="true" aria-label={t('objectMedia.loading')}>
              {Array.from({ length: 12 }, (_, i) => (
                <div key={i} className={`aspect-square animate-pulse rounded-xl ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`} />
              ))}
            </div>
          )}

          {media.isError && !media.isLoading && (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <AlertTriangle className={`h-8 w-8 ${isDark ? 'text-slate-600' : 'text-slate-300'}`} />
              <p className={`text-sm ${muted}`}>{t('objectMedia.error')}</p>
              <button
                type="button"
                onClick={() => void media.refetch()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t('objectMedia.retry')}
              </button>
            </div>
          )}

          {nothingAtAll && !media.isError && (
            <div className="flex flex-col items-center gap-3 py-14 text-center">
              <ImagePlus className={`h-9 w-9 ${isDark ? 'text-slate-600' : 'text-slate-300'}`} />
              <p className={`text-base font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>{t('objectMedia.empty.title')}</p>
              <p className={`max-w-sm text-sm ${muted}`}>{t('objectMedia.empty.hint')}</p>
              {onAddObservation && (
                <button
                  type="button"
                  onClick={onAddObservation}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-accent-500 px-3 py-2 text-sm font-semibold text-white hover:bg-accent-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400"
                >
                  <Calendar className="h-4 w-4" />
                  {t('objectMedia.empty.add')}
                </button>
              )}
            </div>
          )}

          {noMatch && !media.isError && (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <p className={`text-sm ${muted}`}>{t('objectMedia.noMatch')}</p>
              <button
                type="button"
                onClick={media.clearFilters}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${
                  isDark ? 'border-slate-700 text-slate-200 hover:bg-slate-800' : 'border-slate-300 text-slate-700 hover:bg-slate-50'
                }`}
              >
                {t('objectMedia.filters.clear')}
              </button>
            </div>
          )}

          <FeaturedProcessed
            items={featured}
            total={media.counts?.processed ?? featured.length}
            onOpen={openItem}
            onToggleFavorite={onToggleFavorite}
            onMarkUnprocessed={isAdmin ? askMarkUnprocessed : undefined}
            onShowAll={() => media.update({ tab: 'processed' })}
          />

          {subEmpty && (
            <div className="flex flex-col items-center gap-1 py-12 text-center">
              <p className={`text-sm ${muted}`}>{t('objectMedia.subNights.empty')}</p>
              <p className={`max-w-md text-xs ${muted}`}>{t('objectMedia.subNights.emptyHint')}</p>
            </div>
          )}

          {state.tab === 'sub' && state.night && subNights.length > 1 && (
            <button
              type="button"
              onClick={() => media.update({ night: '' })}
              className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${
                isDark ? 'text-accent-400 hover:bg-slate-800' : 'text-accent-600 hover:bg-slate-100'
              }`}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              {t('objectMedia.subNights.back')}
            </button>
          )}

          {showNightOverview && (
            <SubframeNights objectId={objectId} nights={overviewNights} onOpen={date => media.update({ night: date })} />
          )}

          {state.tab === 'nights' && (
            <NightsList objectId={objectId} nights={groups.filter(g => g.date)} items={items} />
          )}

          {state.tab === 'project' && (
            <ObjectProjectArchivesSection objectId={objectId} isAdmin={isAdmin} bare alwaysOpen />
          )}

          {!showNightOverview && state.tab !== 'nights' && state.tab !== 'project' && visibleGroups.map(g => (
            <MediaGroupSection
              key={g.key}
              group={g}
              items={byGroup.get(g.key) ?? []}
              groupBy={state.group}
              tab={state.tab === 'nights' ? 'all' : state.tab}
              size={size}
              showHeader={groups.length > 1}
              onOpen={openItem}
              onToggleFavorite={onToggleFavorite}
              onMarkProcessed={isAdmin ? askMarkProcessed : undefined}
              onMarkUnprocessed={isAdmin ? askMarkUnprocessed : undefined}
              fitsHidden={hideFits}
              onToggleFits={toggleHideFits}
              onShowAllSubs={showAllSubs}
              list={listMode ? { objectId, objectName, isAdmin, onFramesDeleted: refresh } : undefined}
            />
          ))}

          {hasNextPage && !showNightOverview && state.tab !== 'nights' && state.tab !== 'project' && (
            <div ref={sentinel} className="flex justify-center py-4">
              <button
                type="button"
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
                className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${
                  isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-slate-300 text-slate-700 hover:bg-slate-50'
                }`}
              >
                {isFetchingNextPage && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {isFetchingNextPage ? t('objectMedia.loadingMore') : t('objectMedia.loadMore')}
              </button>
            </div>
          )}
        </div>

        {trashCount > 0 && onOpenTrash && (
          <div className="mt-2 text-center">
            <button
              type="button"
              onClick={onOpenTrash}
              className="rounded text-xs font-medium text-slate-500 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
            >
              {t('objectMedia.deletedItems', { count: trashCount })}
            </button>
          </div>
        )}
      </div>

      {markError && (
        <p role="alert" className="text-sm text-red-400">{markError}</p>
      )}
      {markCandidate && (
        <ConfirmModal
          title={t('objectMedia.tile.markProcessedTitle')}
          message={t('objectMedia.tile.markProcessedMessage')}
          confirmLabel={t('objectMedia.tile.markProcessed')}
          onCancel={() => setMarkCandidate(null)}
          onConfirm={() => { markProcessed.mutate(markCandidate); setMarkCandidate(null); }}
        />
      )}

      {unmarkCandidate && (
        <ConfirmModal
          title={t('objectMedia.tile.markUnprocessedTitle')}
          message={t('objectMedia.tile.markUnprocessedMessage')}
          confirmLabel={t('objectMedia.tile.markUnprocessed')}
          onCancel={() => setUnmarkCandidate(null)}
          onConfirm={() => { markUnprocessed.mutate(unmarkCandidate); setUnmarkCandidate(null); }}
        />
      )}

      {analysisOpen && subNights.length > 0 && (
        <FrameAnalysisModal
          isOpen={analysisOpen}
          onClose={() => {
            setAnalysisOpen(false);
            void queryClient.invalidateQueries({ queryKey: ['frame-analysis', objectId] });
          }}
          objectId={objectId}
          objectName={objectName}
          nights={subNights}
          initialDate={state.night && subNights.some(n => n.date === state.night) ? state.night : subNights[0].date}
          includeVariants
          onFilesDeleted={() => {
            refresh();
            void queryClient.invalidateQueries({ queryKey: ['frame-analysis', objectId] });
          }}
          isDark={isDark}
        />
      )}

      <GalleryModal
        isOpen={viewerIndex !== null}
        items={galleryItems}
        defaultIndex={viewerIndex ?? 0}
        objectId={objectId}
        date=""
        isAdmin={isAdmin}
        objectName={objectName}
        onClose={closeViewer}
        onEditImage={openEditor}
        onHeaderFileClick={() => {}}
        onSetAsGallery={setCover}
        onDeleteProcessed={deleteProcessed}
        settingGalleryId={settingCoverId}
        deletingProcessedId={deletingId}
      />

      <ObjectImageEditor request={editRequest} onClose={() => setEditRequest(null)} onSaved={closeViewer} />
    </section>
  );
}
