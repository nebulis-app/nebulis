import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient, useMutation, useMutationState } from '@tanstack/react-query';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { ArrowLeft, X, Loader2, Columns, Frame } from 'lucide-react';
import { getObservationDetail, getObjectInfo } from '../lib/api/observations';
import {
  deleteSessionSubFrames,
  setSessionImage as apiSetSessionImage,
  getProcessedImages,
  deleteProcessedImage as apiDeleteProcessedImage,
  setGalleryImage,
  getImageFavorites,
  toggleImageFavorite,
  startSubframesArchive,
  getSubframesArchiveStatus,
  cancelSubframesArchive,
  getSubframesArchiveTmpUrl,
} from '../lib/api/library';
import { getSettings } from '../lib/api/settings';
import { getTelescopeStatus, listTelescopes } from '../lib/api/telescopes';
import { fetchLocationName } from '../lib/api/catalog';
import { getNote } from '../lib/api/notes';
import { formatObjectTitle } from '../lib/dsoSearch';
import { formatObservationDate } from '../lib/observationDisplay';
import { previewSrcFor, thumbSrcFor, isPoorHeroCandidate } from '../lib/sessionImageSrc';
import { isRenderableProcessed } from '../lib/processedFormats';
import { MoveObservationModal } from '../components/MoveObservationModal';
import { UploadProcessedModal } from '../components/UploadProcessedModal';
import { DeleteSessionModal } from '../components/DeleteSessionModal';
import { GalleryModal, type GalleryItem } from '../components/GalleryModal';
import { FitsHeaderModal } from '../components/FitsHeaderModal';
import { SessionNotesModal } from '../components/SessionNotesModal';
import { ImageEditorModal, type OverwriteTarget } from '../components/ImageEditorModal';
import { ImageCompareModal, type CompareFile } from '../components/ImageCompareModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { useSyncSubframes } from '../contexts/SyncSubframesContext';
import { SatelliteTrailScanModal } from '../components/SatelliteTrailScanModal';
import { FramingModal, FRAMING_MOSAIC_ENABLED } from '../components/catalogs/FramingModal';
import { SessionHero, type HeroBadge, type HeroMedia } from '../components/observationDetail/SessionHero';
import { buildCaptureMetrics } from '../lib/captureMetrics';
import { ObjectPanel } from '../components/observationDetail/ObjectPanel';
import { ConditionsPanel } from '../components/observationDetail/ConditionsPanel';
import { SitePanel } from '../components/observationDetail/SitePanel';
import { ObservationTabs, type ObservationTab } from '../components/observationDetail/ObservationTabs';
import { VideoPanel } from '../components/observationDetail/VideoPanel';
import { SessionFileGrid } from '../components/observationDetail/SessionFileGrid';
import { SubframesPanel } from '../components/observationDetail/SubframesPanel';
import { ProcessedImagesGrid } from '../components/observationDetail/ProcessedImagesGrid';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../contexts/AuthContext';
import type { SessionFile, ProcessedImage } from '../types';
import type { CompareItem } from '../components/observationDetail/types';

/** `YYYYMMDD-HHMMSS` (what the telescope writes) or an ISO timestamp, as
 *  `HH:MM` in 24-hour time. */
function formatClock(timestamp: string): string {
  try {
    const m = timestamp.match(/^\d{8}-(\d{2})(\d{2})/);
    if (m) return `${m[1]}:${m[2]}`;
    return new Date(timestamp).toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
  } catch {
    return timestamp;
  }
}

/**
 * An observation, laid out as: the picture and what it cost, then what the
 * object is, what the sky was doing and where you stood, then the files.
 *
 * The reading half of the page is always visible; only the file grids are
 * behind tabs. That is the reverse of the old arrangement, where the capture
 * settings, the conditions and the location all sat in a Details tab nobody
 * opened while the picture itself was capped at 420px beside a rail of 10px
 * labels.
 */
// Stable across renders (unlike `observation?.files || []`, a fresh array
// literal every time observation is loading) so `files` itself is a safe
// useMemo dependency below without needing its own memo layer.
const EMPTY_FILES: SessionFile[] = [];

export function ObservationDetail() {
  const { objectId = '', date = '' } = useParams<{ objectId: string; date: string }>();
  const { isDark, isNight, isSpace } = useTheme();
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const { openSync } = useSyncSubframes();

  // Intent only — which live list the open gallery is showing, not a frozen
  // copy of its contents. galleryItems below is derived from the current
  // query data every render, so an open lightbox can't go stale the moment a
  // favorite toggles or the observation refetches while it's open.
  const [gallerySource, setGallerySource] = useState<
    { kind: 'files' } | { kind: 'subframes' } | { kind: 'processed' } | { kind: 'single'; file: SessionFile } | null
  >(null);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [galleryOpen, setGalleryOpen] = useState(false);
  // Defaults to 'all' so the tab's contents match the count on its badge. A
  // session whose stack is a FITS looked empty under the old image-only default.
  const [viewMode, setViewMode] = useState<'all' | 'fits' | 'image'>('all');
  const [headerFile, setHeaderFile] = useState<SessionFile | null>(null);
  const [galleryPage, setGalleryPage] = useState(0);
  // Reset paging when the file-type filter changes (render-phase, no extra render).
  const [pagedViewMode, setPagedViewMode] = useState(viewMode);
  if (pagedViewMode !== viewMode) {
    setPagedViewMode(viewMode);
    setGalleryPage(0);
  }
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showMoveModal, setShowMoveModal] = useState(false);

  // Session image state
  const [settingSessionImage, setSettingSessionImage] = useState(false);

  // Processed images state
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [pendingUploadFile, setPendingUploadFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [deletingProcessedId, setDeletingProcessedId] = useState<string | null>(null);
  const [confirmDeleteProcessedId, setConfirmDeleteProcessedId] = useState<string | null>(null);
  const [settingGalleryId, setSettingGalleryId] = useState<string | null>(null);

  // Image editor state
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorSrc, setEditorSrc] = useState<{
    url: string;
    name: string;
    sourceKind: 'telescope' | 'processed';
    overwriteTarget?: OverwriteTarget;
  } | null>(null);

  // Compare state — key is file.path (telescope) or img.id (processed)
  const [compareMode, setCompareMode] = useState(false);
  const [compareItems, setCompareItems] = useState<[CompareItem | null, CompareItem | null]>([null, null]);
  const [compareModalOpen, setCompareModalOpen] = useState(false);
  const [satelliteScanOpen, setSatelliteScanOpen] = useState(false);
  const [confirmDeleteSubframes, setConfirmDeleteSubframes] = useState(false);
  const [archiveState, setArchiveState] = useState<{ done: number; total: number } | 'idle' | 'error'>('idle');
  const archiveAbortRef = useRef(false);
  // In-flight ZIP job id so leaving the page stops the server-side build, not
  // just the client poll.
  const archiveJobIdRef = useRef<string | null>(null);
  const [notesModalOpen, setNotesModalOpen] = useState(false);
  const [framingOpen, setFramingOpen] = useState(false);
  const [locationName, setLocationName] = useState<string | null>(null);
  // `null` until the user picks a tab; the shown tab is then derived (see
  // `activeTab` below, after the file tallies it depends on).
  const [pinnedTab, setPinnedTab] = useState<ObservationTab | null>(null);
  const tabsSectionRef = useRef<HTMLDivElement | null>(null);
  const isFirstTabRender = useRef(true);

  // Note existence, which switches the hero's Notes action to "edit".
  const { data: existingNote } = useQuery({
    queryKey: ['note', objectId, date],
    queryFn: () => getNote(objectId, date),
    enabled: !!objectId && !!date,
  });

  const openImageEditor = (
    url: string,
    name: string,
    sourceKind: 'telescope' | 'processed',
    overwriteTarget?: OverwriteTarget,
  ) => {
    setGalleryOpen(false);
    setEditorSrc({ url, name, sourceKind, overwriteTarget });
    setEditorOpen(true);
  };

  function toggleCompareItem(key: string, file: CompareFile) {
    setCompareItems(prev => {
      if (prev[0]?.key === key) return [null, prev[1]];
      if (prev[1]?.key === key) return [prev[0], null];
      if (!prev[0]) return [{ key, file }, prev[1]];
      if (!prev[1]) return [prev[0], { key, file }];
      return [prev[1], { key, file }];
    });
  }

  function exitCompareMode() {
    setCompareMode(false);
    setCompareItems([null, null]);
    setCompareModalOpen(false);
  }

  const { data: appSettings } = useQuery({ queryKey: ['settings'], queryFn: getSettings, staleTime: Infinity });
  const tempUnit = appSettings?.temperatureUnit ?? 'fahrenheit';

  const { data: observation, isLoading, isError: observationError } = useQuery({
    queryKey: ['observation', objectId, date],
    queryFn: () => getObservationDetail(objectId, date),
    enabled: !!objectId && !!date,
    staleTime: 5 * 60 * 1000,
  });

  const { data: telescopes = [] } = useQuery({
    queryKey: ['telescopes'],
    queryFn: listTelescopes,
  });
  const showTelescopeUI = telescopes.length >= 2;
  const telescopeForObs = observation?.telescopeId
    ? telescopes.find(t => t.id === observation.telescopeId) ?? null
    : null;

  useEffect(() => {
    const coords = observation?.coordinates;
    if (!coords) return;
    const controller = new AbortController();
    fetchLocationName(coords.lat, coords.lon, controller.signal).then(name => {
      setLocationName(name);
    }).catch(() => {});
    return () => controller.abort();
  }, [observation?.coordinates?.lat, observation?.coordinates?.lon]);

  const { data: objectInfo } = useQuery({
    queryKey: ['objectInfo', objectId],
    queryFn: () => getObjectInfo(objectId),
    enabled: !!objectId,
    staleTime: Infinity,
  });

  const { data: processedImages = [] } = useQuery({
    queryKey: ['processedImages', objectId, date],
    queryFn: () => getProcessedImages(objectId, date),
    enabled: !!objectId && !!date,
    staleTime: 30 * 1000,
  });

  const { data: telescopeStatus } = useQuery({
    queryKey: ['telescope-status'],
    queryFn: getTelescopeStatus,
    refetchInterval: 30_000,
    staleTime: 25_000,
  });
  const telescopeOnline = telescopeStatus?.online ?? false;

  const { data: imageFavoritePaths = [] } = useQuery({
    queryKey: ['image-favorites'],
    queryFn: getImageFavorites,
    staleTime: 60 * 1000,
  });

  const imageFavoriteMutation = useMutation({
    mutationKey: ['toggle-image-favorite'],
    mutationFn: ({ imagePath, isFavorite }: { imagePath: string; isFavorite: boolean }) =>
      toggleImageFavorite(imagePath, isFavorite),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['image-favorites'] });
      queryClient.invalidateQueries({ queryKey: ['all-library-images'] });
    },
  });

  // Unifying Lens: derive the favorite set by overlaying in-flight mutations
  // on the server cache. No setQueryData, no rollback — when each mutation
  // settles, its overlay entry disappears and the invalidated query takes over.
  const pendingFavorites = useMutationState<{ imagePath: string; isFavorite: boolean }>({
    filters: { mutationKey: ['toggle-image-favorite'], status: 'pending' },
    select: m => m.state.variables as { imagePath: string; isFavorite: boolean },
  });
  const imageFavoriteSet = useMemo(() => {
    const set = new Set(imageFavoritePaths);
    for (const p of pendingFavorites) {
      if (p.isFavorite) set.add(p.imagePath);
      else set.delete(p.imagePath);
    }
    return set;
  }, [imageFavoritePaths, pendingFavorites]);

  const files = observation?.files ?? EMPTY_FILES;
  // Memoized: both are passed down as props to SubframesPanel/SessionFileGrid
  // and read by the galleryItems derivation below — a fresh array reference
  // every render would defeat any memoization those children rely on.
  const subFrames = useMemo(() => files.filter(f => f.fileType === 'sub'), [files]);
  const filteredFiles = useMemo(() => files.filter(f => {
    if (f.fileType === 'sub') return false;
    if (viewMode === 'fits') return f.type === 'fits';
    if (viewMode === 'image') return f.type === 'image';
    return f.type === 'fits' || f.type === 'image';
  }), [files, viewMode]);

  // The Images tab badge counts everything that tab can ever show, not what the
  // current All/Image/FITS filter happens to leave visible. Using the filtered
  // length would make the badge change every time the user flips that toggle.
  const imageTabCount = files.filter(
    f => f.fileType !== 'sub' && (f.type === 'image' || f.type === 'fits'),
  ).length;

  // Lunar/planetary video and timelapse captures. Their own tab: a video has no
  // thumbnail to crown or compare, and the gallery lightbox only knows stills.
  const videoFiles = useMemo(() => files.filter(f => f.type === 'video'), [files]);

  const stackedImages = files.filter(f => f.fileType === 'stacked' && f.type === 'image');
  const stackedImage = stackedImages.find(f => !isPoorHeroCandidate(f)) ?? stackedImages[0];
  // Stacked FITS fallback: some sessions have a stacked .fit but no rendered .jpg.
  const stackedFits = files.find(f => f.fileType === 'stacked' && f.type === 'fits');

  // The shown tab: whatever the user pinned, else Images — unless the night is
  // video-only (a lunar timelapse with no stills, subframes, or processed
  // uploads), in which case Videos leads so the page never opens on an empty
  // grid.
  const activeTab: ObservationTab = pinnedTab ?? (
    imageTabCount === 0 && subFrames.length === 0 && processedImages.length === 0 && videoFiles.length > 0
      ? 'videos'
      : 'images'
  );

  /** Tabs swap in content of very different heights (a tall image grid vs. a
   *  short or empty Subframes panel). Left alone, the document shrinks when a
   *  shorter tab mounts and the browser clamps scrollY to whatever the new
   *  height allows, landing mid-page instead of at the top of the new content.
   *  Switching back then lands at that same clamped position rather than where
   *  the grid had actually been scrolled to, cutting off rows that were visible
   *  before. Anchoring to the tab bar on every switch keeps the landing spot the
   *  same no matter how tall each tab's content is. Skips the initial mount so
   *  loading the page doesn't itself cause a scroll.
   */
  useEffect(() => {
    if (isFirstTabRender.current) { isFirstTabRender.current = false; return; }
    tabsSectionRef.current?.scrollIntoView({ block: 'start' });
  }, [activeTab]);

  // Designated session image (falls back to stacked image, then any image, then stacked FITS)
  const designatedSessionFile = observation?.sessionImage
    ? files.find(f => f.path === observation.sessionImage) ?? null
    : null;
  const designatedProcessedImage = observation?.sessionImage
    ? processedImages.find(img => img.path === observation.sessionImage) ?? null
    : null;
  /**
   * When nothing has been explicitly crowned, the most recent processed image
   * (if any) becomes the primary image automatically — a processed result is
   * almost always what the observer actually wanted shown, and requiring a
   * manual "set as session image" click every time defeats the point of
   * uploading one. Restricted to formats a browser can render inline
   * (jpg/png/tif): an XISF/FITS/PSD/RAW processed upload can't become the hero
   * even automatically, the same rule the upload picker and file grid already
   * enforce (see processedFormats.ts). `processedImages` is already sorted
   * newest-first by the server, so the first renderable match is the most
   * recent one.
   *
   * An explicit crown of any file — raw or processed — always wins over this;
   * see designatedSessionFile/designatedProcessedImage above, which this only
   * applies when both come back null.
   */
  const autoProcessedImage = !observation?.sessionImage
    ? processedImages.find(img => isRenderableProcessed(img.filename)) ?? null
    : null;
  const effectiveProcessedImage = designatedProcessedImage ?? autoProcessedImage;
  /**
   * Hero pick, ordered so a cheaply displayable image always beats an expensive
   * one even when the expensive one is the better-classified "stack".
   *
   * A Dwarf session holds both `img_stacked_all.tif` (a ~100 MB 32-bit float
   * master, classified `stacked`) and `stacked.jpg` (the device's own preview,
   * which classifies only as a plain image). Preferring the `stacked` category
   * first therefore featured the 100 MB TIFF, which crashed Safari when it was
   * handed to an `<img>` and still costs a full decode server-side even after
   * routing it through the preview tier. Cheap-first fixes the cause rather than
   * the symptom; the TIFF is still used when it is the only image there.
   */
  const anyImage = files.filter(f => f.type === 'image' && !f.isThumbnail);
  const heroFile = designatedSessionFile
    ?? (stackedImage && !isPoorHeroCandidate(stackedImage) ? stackedImage : undefined)
    ?? anyImage.find(f => !isPoorHeroCandidate(f))
    ?? stackedImage
    ?? anyImage[0]
    ?? stackedFits
    ?? null;
  const heroIsUserDesignated = (!!designatedSessionFile && designatedSessionFile !== stackedImage) || !!designatedProcessedImage;
  const heroIsFits = heroFile?.type === 'fits';

  const formattedDate = date && date !== 'unknown'
    ? new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    : 'Unknown date';
  const shortDate = date && date !== 'unknown' ? formatObservationDate(date) : 'Unknown date';

  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500';
  // The hero sits on dark imagery in every theme, and only a fixed set of
  // accent-* utilities is re-mapped for night and space, so it takes the bright
  // accent value directly rather than the light-mode-darkened token.
  const accent = isNight ? '#f87171' : isSpace ? '#a78bfa' : '#fbbf24';
  const displayName = formatObjectTitle(observation?.catalogId, observation?.objectName, objectId);

  const timeRange = observation?.startTime
    ? observation.endTime && observation.endTime !== observation.startTime
      ? `${formatClock(observation.startTime)} - ${formatClock(observation.endTime)}`
      : formatClock(observation.startTime)
    : null;

  function openGallery(index: number, source: 'files' | 'subframes' = 'files') {
    setGallerySource({ kind: source });
    setGalleryIndex(index);
    setGalleryOpen(true);
  }

  function openSingleFileGallery(file: SessionFile) {
    setGallerySource({ kind: 'single', file });
    setGalleryIndex(0);
    setGalleryOpen(true);
  }

  function openProcessedGallery(index: number) {
    setGallerySource({ kind: 'processed' });
    setGalleryIndex(index);
    setGalleryOpen(true);
  }

  const galleryItems = useMemo((): GalleryItem[] => {
    if (!gallerySource) return [];
    switch (gallerySource.kind) {
      case 'files': return filteredFiles.map(f => ({ kind: 'file' as const, file: f }));
      case 'subframes': return subFrames.map(f => ({ kind: 'file' as const, file: f }));
      case 'processed': return processedImages.map(img => ({ kind: 'processed' as const, img }));
      case 'single': return [{ kind: 'file' as const, file: gallerySource.file }];
      default: {
        const _exhaustive: never = gallerySource;
        void _exhaustive;
        return [];
      }
    }
  }, [gallerySource, filteredFiles, subFrames, processedImages]);

  // ─── What the hero shows ────────────────────────────────────────────────────
  // A processed image, when one is crowned or auto-picked, otherwise the best
  // telescope frame. The badge distinguishes the three: an explicit crown is the
  // observer's choice and gets the amber treatment, the other two are the page's
  // own pick and say plainly which kind of file they are.

  let heroMedia: HeroMedia = null;
  let heroBadge: HeroBadge = null;
  let openHeroMedia = () => {};

  if (effectiveProcessedImage) {
    const img = effectiveProcessedImage;
    heroMedia = {
      kind: 'image',
      src: img.url,
      alt: img.title || img.originalName,
      onEdit: () => openImageEditor(img.url, img.title || img.originalName, 'processed', { kind: 'processed', id: img.id }),
    };
    heroBadge = designatedProcessedImage
      ? { tone: 'crown', text: 'Session image' }
      : { tone: 'processed', text: 'Processed' };
    openHeroMedia = () => {
      const idx = processedImages.findIndex(p => p.id === img.id);
      if (idx >= 0) openProcessedGallery(idx);
    };
  } else if (heroFile) {
    const file = heroFile;
    heroMedia = heroIsFits
      ? { kind: 'fits', url: file.downloadUrl }
      : {
        kind: 'image',
        src: previewSrcFor(file),
        alt: displayName,
        onEdit: () => openImageEditor(
          file.downloadUrl, file.name, 'telescope',
          // Overwriting in place only makes sense for a JPEG original — the
          // editor always exports JPEG.
          /\.jpe?g$/i.test(file.name) ? { kind: 'telescope', path: file.path } : undefined,
        ),
      };
    heroBadge = heroIsUserDesignated
      ? { tone: 'crown', text: 'Session image' }
      : {
        tone: 'stacked',
        text: [
          `Stacked${heroIsFits ? ' FITS' : ''}`,
          file.frameCount ? `${file.frameCount} frames` : null,
          file.exposure,
        ].filter(Boolean).join(' · '),
      };
    openHeroMedia = () => {
      const idx = filteredFiles.findIndex(f => f.path === file.path);
      // A stacked FITS is in filteredFiles under the default 'all' view but not
      // once the user switches to Image, so fall back to a gallery of just it.
      if (idx >= 0) openGallery(idx);
      else openSingleFileGallery(file);
    };
  } else if (videoFiles.length > 0) {
    // Lunar/planetary sessions that produced only video. Without this the hero
    // fell to "No images captured" even though the session has a capture to
    // show, and the object-page card (which borrows the object thumbnail) made
    // it look like a still existed. Prefer the main capture over its timelapse,
    // and a browser-playable container over an AVI.
    const isTimelapse = (n: string) => /-timelapse\.[^.]+$/i.test(n);
    const isPlayable = (n: string) => /\.(mp4|mov)$/i.test(n);
    const pick = videoFiles.find(f => isPlayable(f.name) && !isTimelapse(f.name))
      ?? videoFiles.find(f => isPlayable(f.name))
      ?? videoFiles.find(f => !isTimelapse(f.name))
      ?? videoFiles[0];
    const goToVideos = () => {
      setPinnedTab('videos');
      tabsSectionRef.current?.scrollIntoView({ block: 'start' });
    };
    heroMedia = {
      kind: 'video',
      src: pick.videoUrl ?? pick.downloadUrl,
      playable: isPlayable(pick.name),
      onOpen: goToVideos,
    };
    heroBadge = { tone: 'video', text: videoFiles.length > 1 ? `${videoFiles.length} videos` : 'Video' };
    openHeroMedia = goToVideos;
  }

  const canResetCrown = isAdmin && (!!designatedProcessedImage || heroIsUserDesignated);

  const captureMetrics = buildCaptureMetrics({
    capture: observation?.capture,
    files,
    tempUnit,
  });

  // The catalog id is only worth its own slot when the title does not already
  // carry it, which for most objects it does ("M42 (Orion Nebula)").
  const eyebrowCatalogId = observation?.catalogId && !displayName.includes(observation.catalogId)
    ? observation.catalogId
    : null;
  const eyebrow = [
    eyebrowCatalogId,
    objectInfo?.type || observation?.type,
    objectInfo?.constellation || observation?.constellation,
  ].filter((v): v is string => !!v);

  // ─── Session image handlers ─────────────────────────────────────────────────

  const handleSetSessionImage = useCallback(async (imagePath: string | null) => {
    if (!objectId || !date || settingSessionImage) return;
    setSettingSessionImage(true);
    try {
      await apiSetSessionImage(objectId, date, imagePath);
      // Crown changes a per-session preview that is read by:
      //   - this page (observation detail)
      //   - ObjectDetail's session cards (library-sessions)
      //   - the global observations list (library-observations)
      // Invalidate all three so the new image appears everywhere immediately.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['observation', objectId, date] }),
        queryClient.invalidateQueries({ queryKey: ['library-sessions', objectId] }),
        queryClient.invalidateQueries({ queryKey: ['observations'] }),
      ]);
    } catch { /* best-effort */ }
    finally { setSettingSessionImage(false); }
  }, [objectId, date, settingSessionImage, queryClient]);

  // ─── Download local subframes as ZIP ────────────────────────────────────────

  const handleDownloadToComputer = useCallback(async () => {
    if (!objectId || !date || archiveState !== 'idle') return;
    archiveAbortRef.current = false;
    try {
      const { jobId, filesTotal } = await startSubframesArchive(objectId, [date]);
      if (archiveAbortRef.current) { void cancelSubframesArchive(jobId).catch(() => {}); return; }
      archiveJobIdRef.current = jobId;
      setArchiveState({ done: 0, total: filesTotal });

      // Poll until done. ~500ms cadence matches the server's docstring contract.
      while (true) {
        await new Promise(r => setTimeout(r, 500));
        if (archiveAbortRef.current) return;
        const s = await getSubframesArchiveStatus(jobId);
        if (archiveAbortRef.current) return;
        if (s.status === 'running') {
          setArchiveState({ done: s.filesDone, total: s.filesTotal });
          continue;
        }
        archiveJobIdRef.current = null;
        if (s.status === 'cancelled') { setArchiveState('idle'); return; }
        if (s.status === 'error' || !s.token) {
          setArchiveState('error');
          setTimeout(() => { if (!archiveAbortRef.current) setArchiveState('idle'); }, 4000);
          return;
        }
        // status === 'done' — kick off the browser download via a hidden anchor.
        const a = document.createElement('a');
        a.href = getSubframesArchiveTmpUrl(s.token);
        a.download = s.filename ?? `${objectId}-${date}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setArchiveState('idle');
        return;
      }
    } catch {
      if (archiveAbortRef.current) return;
      setArchiveState('error');
      setTimeout(() => { if (!archiveAbortRef.current) setArchiveState('idle'); }, 4000);
    }
  }, [objectId, date, archiveState]);

  // ─── Processed image handlers ───────────────────────────────────────────────

  const handleDeleteProcessed = useCallback(async (id: string) => {
    if (!objectId || !date || deletingProcessedId) return;
    setDeletingProcessedId(id);
    try {
      await apiDeleteProcessedImage(objectId, date, id);
      await queryClient.invalidateQueries({ queryKey: ['processedImages', objectId, date] });
      setGalleryOpen(false);
    } catch { /* best-effort */ }
    finally { setDeletingProcessedId(null); }
  }, [objectId, date, deletingProcessedId, queryClient]);

  const handleSetProcessedAsGallery = useCallback(async (img: ProcessedImage) => {
    if (!objectId || settingGalleryId) return;
    setSettingGalleryId(img.id);
    try {
      const relativePath = img.path;
      await setGalleryImage(objectId, relativePath);
      queryClient.invalidateQueries({ queryKey: ['gallery-image', objectId] });
    } catch { /* best-effort */ }
    finally { setSettingGalleryId(null); }
  }, [objectId, settingGalleryId, queryClient]);

  useEffect(() => {
    archiveAbortRef.current = false;
    return () => {
      archiveAbortRef.current = true;
      if (archiveJobIdRef.current) {
        void cancelSubframesArchive(archiveJobIdRef.current).catch(() => {});
        archiveJobIdRef.current = null;
      }
    };
  }, []);

if (!objectId || !date) return null;

if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className={`w-8 h-8 animate-spin ${accentText}`} />
      </div>
    );
  }

  if (observationError) {
    return (
      <div className="max-w-lg mx-auto pt-20 text-center">
        <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          Failed to load observation details. The observation may have been deleted.
        </p>
        <Link
          to="/observations"
          className={`mt-6 inline-flex items-center gap-2 text-sm font-medium transition ${isDark ? 'text-accent-400 hover:text-accent-300' : 'text-accent-600 hover:text-accent-700'}`}
        >
          <ArrowLeft className="w-4 h-4" />
          Back to observations
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SessionHero
        objectId={objectId}
        date={date}
        displayName={displayName}
        formattedDate={formattedDate}
        shortDate={shortDate}
        timeRange={timeRange}
        eyebrow={eyebrow}
        media={heroMedia}
        badge={heroBadge}
        onOpenMedia={openHeroMedia}
        onResetCrown={canResetCrown && !settingSessionImage ? () => handleSetSessionImage(null) : null}
        emptyReason={files.some(f => f.type === 'fits') ? 'Raw FITS frames only' : 'No images captured'}
        telescope={showTelescopeUI ? telescopeForObs : null}
        telescopes={telescopes}
        isAdmin={isAdmin}
        captureMetrics={captureMetrics}
        accent={accent}
        onOpenNotes={observation && (isAdmin || !!existingNote) ? () => setNotesModalOpen(true) : null}
        hasNote={!!existingNote}
        onCombine={observation && isAdmin ? () => setShowMoveModal(true) : null}
        onDelete={observation && isAdmin ? () => setShowDeleteModal(true) : null}
      />

      {FRAMING_MOSAIC_ENABLED && (
      <div className="flex flex-wrap gap-3">
        <button
          onClick={() => setFramingOpen(true)}
          className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium border transition ${
            isDark ? 'border-slate-800 text-slate-300 hover:bg-slate-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
          }`}
          title="Preview how this object frames in your telescope, and plan a mosaic"
        >
          <Frame className="w-4 h-4 text-sky-500" />
          Framing &amp; Mosaic
        </button>
      </div>
      )}

      {framingOpen && (
        <FramingModal
          catalogId={observation?.catalogId || objectId}
          objectName={displayName}
          isDark={isDark}
          onClose={() => setFramingOpen(false)}
        />
      )}

      {/* Compare mode page-level banner */}
      {compareMode && (
        <div className={`flex items-center justify-between px-4 py-2.5 rounded-xl border text-sm ${
          isDark ? 'bg-accent-500/10 border-accent-500/30 text-accent-300' : 'bg-accent-50 border-accent-200 text-accent-700'
        }`}>
          <span>
            <Columns className="w-4 h-4 inline mr-1.5" />
            {!compareItems[0] && !compareItems[1] && 'Select two images to compare - from either Telescope Images or Processed Images'}
            {compareItems[0] && !compareItems[1] && `"${compareItems[0].file.name}" selected - pick a second image`}
            {compareItems[0] && compareItems[1] && 'Ready - tap Compare Images below'}
          </span>
          <button onClick={exitCompareMode} className="p-1 rounded-lg hover:opacity-70 transition">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* The three questions an observation raises once you have looked at the
          picture: what is it, what was the sky doing, and where were you. These
          lived in a Details tab, next to a Capture Settings card whose numbers
          the hero now carries, so they were a click away from a page that had
          room for them. */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <ObjectPanel
          displayName={displayName}
          info={objectInfo}
          magnitude={observation?.magnitude}
          distanceLy={observation?.distanceLy}
        />

        <ConditionsPanel
          weather={observation?.weather}
          sky={observation?.note}
          tempUnit={tempUnit}
        />

        {observation && (
          <SitePanel
            objectId={objectId}
            date={date}
            siteId={observation.siteId}
            coordinates={observation.coordinates}
            fileCoordinates={observation.fileCoordinates}
            locationName={locationName}
            isAdmin={isAdmin}
          />
        )}
      </div>

      {/* The session's files. One grid at a time, each with the full page
          width, so a new file category becomes a tab rather than another band
          down the page. */}
      <div ref={tabsSectionRef}>
        <ObservationTabs
          active={activeTab}
          onChange={setPinnedTab}
          counts={{
            images: imageTabCount,
            subframes: subFrames.length,
            processed: processedImages.length,
            videos: videoFiles.length,
          }}
        />

        <div className="pt-5">
        {activeTab === 'images' && (
        <SessionFileGrid
          files={filteredFiles}
          viewMode={viewMode}
          onViewModeChange={mode => { setViewMode(mode); setGalleryPage(0); }}
          galleryPage={galleryPage}
          setGalleryPage={setGalleryPage}
          compareMode={compareMode}
          onToggleCompareMode={() => compareMode ? exitCompareMode() : setCompareMode(true)}
          compareItems={compareItems}
          toggleCompareItem={toggleCompareItem}
          sessionImagePath={observation?.sessionImage}
          // The crown marks whatever is actually being shown as the hero, so it
          // has to be heroFile, not the raw "first stacked file" pick. Those
          // diverge: hero selection prefers a cheaply displayable image, so a
          // Dwarf's `stacked.jpg` beats `img_stacked_all.tif` even though the
          // TIFF classifies as the stack.
          stackedImagePath={(heroFile ?? stackedFits)?.path}
          handleSetSessionImage={handleSetSessionImage}
          settingSessionImage={settingSessionImage}
          imageFavoriteSet={imageFavoriteSet}
          onToggleFavorite={(imagePath, isFavorite) => imageFavoriteMutation.mutate({ imagePath, isFavorite })}
          date={date}
          openGallery={openGallery}
          isAdmin={isAdmin}
        />
        )}

        {activeTab === 'videos' && (
        <VideoPanel videos={videoFiles} date={date} />
        )}

        {activeTab === 'subframes' && (
        <SubframesPanel
          subFrames={subFrames}
          isAdmin={isAdmin}
          telescopeOnline={telescopeOnline}
          archiveState={archiveState}
          onDownloadToComputer={handleDownloadToComputer}
          onOpenSync={() => objectId && date && openSync(objectId, date)}
          onScanTrails={() => setSatelliteScanOpen(true)}
          onDeleteAllSubframes={() => setConfirmDeleteSubframes(true)}
          onOpenGallery={openGallery}
        />
        )}

        {activeTab === 'processed' && (
        <ProcessedImagesGrid
          processedImages={processedImages}
          compareMode={compareMode}
          compareItems={compareItems}
          toggleCompareItem={toggleCompareItem}
          openProcessedGallery={openProcessedGallery}
          sessionImagePath={observation?.sessionImage}
          isAdmin={isAdmin}
          handleSetSessionImage={handleSetSessionImage}
          settingSessionImage={settingSessionImage}
          handleSetProcessedAsGallery={handleSetProcessedAsGallery}
          settingGalleryId={settingGalleryId}
          deletingProcessedId={deletingProcessedId}
          onRequestDelete={setConfirmDeleteProcessedId}
          isDragging={isDragging}
          setIsDragging={setIsDragging}
          onUploadClick={() => { setPendingUploadFile(null); setShowUploadModal(true); }}
          onDropFile={file => { setPendingUploadFile(file); setShowUploadModal(true); }}
        />
        )}

        </div>
      </div>

      <UploadProcessedModal
        isOpen={showUploadModal}
        onClose={() => setShowUploadModal(false)}
        objectId={objectId}
        date={date}
        initialFile={pendingUploadFile}
      />

      <MoveObservationModal
        isOpen={showMoveModal}
        onClose={() => setShowMoveModal(false)}
        objectId={objectId}
        date={date}
        displayName={displayName}
        formattedDate={formattedDate}
      />

      <DeleteSessionModal
        isOpen={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        objectId={objectId}
        date={date}
        displayName={displayName}
        formattedDate={formattedDate}
      />

      <GalleryModal
        isOpen={galleryOpen}
        items={galleryItems}
        defaultIndex={galleryIndex}
        objectId={objectId}
        objectName={displayName}
        date={date}
        isAdmin={isAdmin}
        onClose={() => setGalleryOpen(false)}
        onEditImage={openImageEditor}
        onHeaderFileClick={setHeaderFile}
        onSetAsGallery={handleSetProcessedAsGallery}
        onDeleteProcessed={handleDeleteProcessed}
        settingGalleryId={settingGalleryId}
        deletingProcessedId={deletingProcessedId}
      />

      {/* Satellite Trail Scan Modal */}
      {satelliteScanOpen && (
        <SatelliteTrailScanModal
          isOpen={satelliteScanOpen}
          onClose={() => setSatelliteScanOpen(false)}
          files={subFrames}
          onFilesDeleted={() => {
            queryClient.invalidateQueries({ queryKey: ['observation', objectId, date] });
            queryClient.invalidateQueries({ queryKey: ['observation-files', objectId, date] });
          }}
          isDark={isDark}
        />
      )}

      {/* Session Notes Modal */}
      {notesModalOpen && objectId && date && (
        <SessionNotesModal
          objectId={objectId}
          date={date}
          onClose={() => setNotesModalOpen(false)}
        />
      )}

      {/* FITS Header Modal */}
      {headerFile && (
        <FitsHeaderModal
          filePath={headerFile.path}
          fileName={headerFile.name}
          onClose={() => setHeaderFile(null)}
        />
      )}

      {/* Confirm delete subframes */}
      {confirmDeleteProcessedId && (
        <ConfirmModal
          title="Delete image?"
          message="This will permanently delete the processed image. This cannot be undone."
          confirmLabel="Delete"
          onCancel={() => setConfirmDeleteProcessedId(null)}
          onConfirm={() => {
            handleDeleteProcessed(confirmDeleteProcessedId);
            setConfirmDeleteProcessedId(null);
          }}
        />
      )}

      {confirmDeleteSubframes && objectId && date && (
        <ConfirmModal
          title="Delete all subframes?"
          message={`This will permanently delete all ${subFrames.length} raw sub-frame file${subFrames.length !== 1 ? 's' : ''} for this session. Your stacked images and processed files will not be affected. This cannot be undone.`}
          confirmLabel="Delete Subframes"
          onCancel={() => setConfirmDeleteSubframes(false)}
          onConfirm={async () => {
            setConfirmDeleteSubframes(false);
            await deleteSessionSubFrames(objectId, date);
            queryClient.invalidateQueries({ queryKey: ['observation-files', objectId, date] });
            queryClient.invalidateQueries({ queryKey: ['observation', objectId, date] });
          }}
        />
      )}


      {/* Compare floating action bar */}
      {compareMode && compareItems[0] && compareItems[1] && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-4 px-4 py-3 rounded-2xl shadow-2xl border ${
          isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'
        }`}>
          <div className="flex items-center gap-2">
            <img src={thumbSrcFor(compareItems[0].file)} alt="Image 1" className="w-12 h-12 rounded-lg object-cover border-2 border-accent-500" />
            <span className={`text-xs font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>vs</span>
            <img src={thumbSrcFor(compareItems[1].file)} alt="Image 2" className="w-12 h-12 rounded-lg object-cover border-2 border-violet-500" />
          </div>
          <button
            onClick={() => setCompareModalOpen(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-accent-500 text-white text-sm font-semibold hover:bg-accent-600 transition"
          >
            <Columns className="w-4 h-4" />
            Compare Images
          </button>
          <button
            onClick={exitCompareMode}
            className={`p-2 rounded-xl transition ${isDark ? 'hover:bg-slate-800 text-slate-500' : 'hover:bg-slate-100 text-slate-400'}`}
            title="Cancel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Compare modal */}
      {compareModalOpen && compareItems[0] && compareItems[1] && (
        <ImageCompareModal
          leftFile={compareItems[0].file}
          rightFile={compareItems[1].file}
          onClose={() => setCompareModalOpen(false)}
          isDark={isDark}
        />
      )}

      {/* Image Editor Modal */}
      {editorOpen && editorSrc && objectId && date && (
        <ImageEditorModal
          imageUrl={editorSrc.url}
          imageName={editorSrc.name}
          objectId={objectId}
          date={date}
          isDark={isDark}
          sourceKind={editorSrc.sourceKind}
          overwriteTarget={editorSrc.overwriteTarget}
          onClose={() => { setEditorOpen(false); setEditorSrc(null); }}
          onSaved={() => {
            if (editorSrc.sourceKind === 'telescope') {
              queryClient.invalidateQueries({ queryKey: ['observation', objectId, date] });
              queryClient.invalidateQueries({ queryKey: ['observation-files', objectId, date] });
            } else {
              queryClient.invalidateQueries({ queryKey: ['processedImages', objectId, date] });
            }
          }}
        />
      )}
    </div>
  );
}
