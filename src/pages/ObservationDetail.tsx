import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient, useMutation, useMutationState } from '@tanstack/react-query';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  ArrowLeft,
  MapPin,
  Layers,
  FileImage,
  Info,
  ExternalLink,
  X,
  Loader2,
  Crown,
  Pencil,
  Columns,
} from 'lucide-react';
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
  getSubframesArchiveTmpUrl,
} from '../lib/api/library';
import { getSettings } from '../lib/api/settings';
import { getTelescopeStatus, listTelescopes } from '../lib/api/telescopes';
import { fetchLocationName } from '../lib/api/catalog';
import { getNote } from '../lib/api/notes';
import { formatObjectTitle } from '../lib/dsoSearch';
import { MoveObservationModal } from '../components/MoveObservationModal';
import { UploadProcessedModal } from '../components/UploadProcessedModal';
import { DeleteSessionModal } from '../components/DeleteSessionModal';
import { GalleryModal, type GalleryItem } from '../components/GalleryModal';
import { FitsHeaderModal } from '../components/FitsHeaderModal';
import { FitsPreview } from '../components/FitsPreview';
import { SessionNotesModal } from '../components/SessionNotesModal';
import { ObservationMap } from '../components/ObservationMap';
import { ImageEditorModal } from '../components/ImageEditorModal';
import { ImageCompareModal, type CompareFile } from '../components/ImageCompareModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { useSyncSubframes } from '../contexts/SyncSubframesContext';
import { SatelliteTrailScanModal } from '../components/SatelliteTrailScanModal';
import { ObservationHeader } from '../components/observationDetail/ObservationHeader';
import { WeatherPanel } from '../components/observationDetail/WeatherPanel';
import { ObservationStatsTiles } from '../components/observationDetail/ObservationStatsTiles';
import { SessionFileGrid } from '../components/observationDetail/SessionFileGrid';
import { SubframesPanel } from '../components/observationDetail/SubframesPanel';
import { ProcessedImagesGrid } from '../components/observationDetail/ProcessedImagesGrid';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../contexts/AuthContext';
import type { SessionFile, ProcessedImage } from '../types';

function formatRa(ra: string): string {
  if (/\d+h/i.test(ra)) return ra; // already sexagesimal (e.g. "05h 34m 31.94s")
  const h = parseFloat(ra); // decimal hours (OpenNGC stores RA in hours, not degrees)
  if (isNaN(h)) return ra;
  const hh = Math.floor(h);
  const mFrac = (h - hh) * 60;
  const m = Math.floor(mFrac);
  const s = (mFrac - m) * 60;
  return `${hh.toString().padStart(2, '0')}h ${m.toString().padStart(2, '0')}m ${s.toFixed(1).padStart(4, '0')}s`;
}

function formatDec(dec: string): string {
  const deg = parseFloat(dec);
  if (isNaN(deg)) return dec; // already formatted (e.g. "+22° 00′ 52.2″")
  const sign = deg >= 0 ? '+' : '-';
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const mFrac = (abs - d) * 60;
  const m = Math.floor(mFrac);
  const s = (mFrac - m) * 60;
  return `${sign}${d.toString().padStart(2, '0')}° ${m.toString().padStart(2, '0')}′ ${s.toFixed(1)}″`;
}

// Compare-mode selection slot — shared by the telescope-file grid and the
// processed-images grid, since either can supply either side of a compare.
export type CompareItem = { key: string; file: CompareFile };

export function ObservationDetail() {
  const { objectId = '', date = '' } = useParams<{ objectId: string; date: string }>();
  const { isDark, isNight, isSpace } = useTheme();
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const { openSync } = useSyncSubframes();

  const [galleryItems, setGalleryItems] = useState<GalleryItem[]>([]);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'all' | 'fits' | 'image'>('image');
  const [headerFile, setHeaderFile] = useState<SessionFile | null>(null);
  const [galleryPage, setGalleryPage] = useState(0);
  useEffect(() => { setGalleryPage(0); }, [viewMode]);
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
  const [editorSrc, setEditorSrc] = useState<{ url: string; name: string; sourceKind: 'telescope' | 'processed' } | null>(null);

  // Compare state — key is file.path (telescope) or img.id (processed)
  const [compareMode, setCompareMode] = useState(false);
  const [compareItems, setCompareItems] = useState<[CompareItem | null, CompareItem | null]>([null, null]);
  const [compareModalOpen, setCompareModalOpen] = useState(false);
  const [satelliteScanOpen, setSatelliteScanOpen] = useState(false);
  const [confirmDeleteSubframes, setConfirmDeleteSubframes] = useState(false);
  const [archiveState, setArchiveState] = useState<{ done: number; total: number } | 'idle' | 'error'>('idle');
  const archiveAbortRef = useRef(false);
  const [notesModalOpen, setNotesModalOpen] = useState(false);
  const [locationName, setLocationName] = useState<string | null>(null);

  // Note existence (for Session Notes tile indicator)
  const { data: existingNote } = useQuery({
    queryKey: ['note', objectId, date],
    queryFn: () => getNote(objectId, date),
    enabled: !!objectId && !!date,
  });

  const openImageEditor = (url: string, name: string, sourceKind: 'telescope' | 'processed') => {
    setGalleryOpen(false);
    setEditorSrc({ url, name, sourceKind });
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

  const files = observation?.files || [];
  const subFrames = files.filter(f => f.fileType === 'sub');
  const filteredFiles = files.filter(f => {
    if (f.fileType === 'sub') return false;
    if (viewMode === 'fits') return f.type === 'fits';
    if (viewMode === 'image') return f.type === 'image';
    return f.type === 'fits' || f.type === 'image';
  });

  const stackedImage = files.find(f => f.fileType === 'stacked' && f.type === 'image');
  // Stacked FITS fallback: some sessions have a stacked .fit but no rendered .jpg.
  const stackedFits = files.find(f => f.fileType === 'stacked' && f.type === 'fits');

  // Designated session image (falls back to stacked image, then any image, then stacked FITS)
  const designatedSessionFile = observation?.sessionImage
    ? files.find(f => f.path === observation.sessionImage) ?? null
    : null;
  const designatedProcessedImage = observation?.sessionImage
    ? processedImages.find(img => img.path === observation.sessionImage) ?? null
    : null;
  const heroFile = designatedSessionFile ?? stackedImage ?? files.find(f => f.type === 'image' && !f.isThumbnail) ?? stackedFits ?? null;
  const heroIsUserDesignated = (!!designatedSessionFile && designatedSessionFile !== stackedImage) || !!designatedProcessedImage;
  const heroIsFits = heroFile?.type === 'fits';

  const formattedDate = date && date !== 'unknown'
    ? new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    : 'Unknown date';

  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500';
  const displayName = formatObjectTitle(observation?.catalogId, observation?.objectName, objectId);

  function openGallery(index: number, fileList?: SessionFile[]) {
    const list = fileList || filteredFiles;
    setGalleryItems(list.map(f => ({ kind: 'file' as const, file: f })));
    setGalleryIndex(index);
    setGalleryOpen(true);
  }

  function openProcessedGallery(index: number) {
    setGalleryItems(processedImages.map(img => ({ kind: 'processed' as const, img })));
    setGalleryIndex(index);
    setGalleryOpen(true);
  }

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
      if (archiveAbortRef.current) return;
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
    return () => { archiveAbortRef.current = true; };
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
      <ObservationHeader
        objectId={objectId}
        date={date}
        displayName={displayName}
        formattedDate={formattedDate}
        observation={observation}
        isAdmin={isAdmin}
        showTelescopeUI={showTelescopeUI}
        telescopeForObs={telescopeForObs}
        telescopes={telescopes}
        onMove={() => setShowMoveModal(true)}
        onDelete={() => setShowDeleteModal(true)}
      />

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

      {/* Top section: Image + Details side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-5 items-start">
        {/* Left: Session image (user-designated or stacked fallback — click to enlarge) */}
        {designatedProcessedImage ? (
          <div className={`rounded-xl border overflow-hidden ${isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
            <div
              className="cursor-pointer relative group"
              onClick={() => {
                const idx = processedImages.findIndex(img => img.id === designatedProcessedImage.id);
                if (idx >= 0) openProcessedGallery(idx);
              }}
            >
              <img
                src={designatedProcessedImage.url}
                alt={designatedProcessedImage.title || designatedProcessedImage.originalName}
                className="w-full object-contain"
              />
              <div className="absolute top-2 left-2 px-2 py-1 rounded-md bg-amber-500/90 text-white text-[11px] font-semibold flex items-center gap-1 shadow">
                <Crown className="w-3 h-3" />
                Session Image
              </div>
              <button
                onClick={e => { e.stopPropagation(); openImageEditor(designatedProcessedImage.url, designatedProcessedImage.title || designatedProcessedImage.originalName, 'processed'); }}
                className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/40 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/60"
                title="Edit image"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className={`px-3 py-1.5 border-t flex items-center justify-between gap-2 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
              <span className="px-2 py-0.5 rounded-md bg-amber-500/20 text-amber-500 text-[11px] font-semibold flex items-center gap-1">
                <Crown className="w-3 h-3" />
                Session Image
              </span>
              {isAdmin && (
                <button
                  onClick={() => handleSetSessionImage(null)}
                  disabled={settingSessionImage}
                  className={`text-[11px] transition shrink-0 ${isDark ? 'text-slate-600 hover:text-slate-400' : 'text-slate-400 hover:text-slate-600'}`}
                  title="Clear session image (revert to stacked)"
                >
                  Reset
                </button>
              )}
            </div>
          </div>
        ) : heroFile ? (
          <div className={`rounded-xl border overflow-hidden ${isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
            <div
              className="cursor-pointer relative group"
              onClick={() => {
                if (heroIsFits) {
                  // Stacked FITS may not be in the (image-only) default filteredFiles list,
                  // so open the gallery with just this file.
                  const idx = filteredFiles.findIndex(f => f.path === heroFile.path);
                  if (idx >= 0) openGallery(idx);
                  else openGallery(0, [heroFile]);
                  return;
                }
                const idx = filteredFiles.findIndex(f => f.path === heroFile.path);
                if (idx >= 0) openGallery(idx);
              }}
            >
              {heroIsFits ? (
                <FitsPreview url={heroFile.downloadUrl} isDark={isDark} />
              ) : (
                <img
                  src={heroFile.downloadUrl}
                  alt={displayName}
                  className="w-full object-contain"
                />
              )}
              {/* Crown badge for user-designated session image */}
              {heroIsUserDesignated && (
                <div className="absolute top-2 left-2 px-2 py-1 rounded-md bg-amber-500/90 text-white text-[11px] font-semibold flex items-center gap-1 shadow">
                  <Crown className="w-3 h-3" />
                  Session Image
                </div>
              )}
              {/* The image editor works on rasterized images only, not raw FITS. */}
              {!heroIsFits && (
                <button
                  onClick={e => { e.stopPropagation(); openImageEditor(heroFile.downloadUrl, heroFile.name, 'telescope'); }}
                  className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/40 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/60"
                  title="Edit image"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <div className={`px-3 py-1.5 border-t flex items-center justify-between gap-2 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
              <div className="flex items-center gap-2 min-w-0">
                {heroIsUserDesignated ? (
                  <span className="px-2 py-0.5 rounded-md bg-amber-500/20 text-amber-500 text-[11px] font-semibold flex items-center gap-1">
                    <Crown className="w-3 h-3" />
                    Session Image
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded-md bg-accent-500/90 text-white text-[11px] font-semibold flex items-center gap-1">
                    <Layers className="w-3 h-3" />
                    Stacked{heroIsFits ? ' FITS' : ''}{heroFile.frameCount ? ` · ${heroFile.frameCount} frames` : ''}
                  </span>
                )}
                {heroFile.exposure && (
                  <span className={`text-[11px] truncate ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{heroFile.exposure}</span>
                )}
              </div>
              {heroIsUserDesignated && isAdmin && (
                <button
                  onClick={() => handleSetSessionImage(null)}
                  disabled={settingSessionImage}
                  className={`text-[11px] transition shrink-0 ${isDark ? 'text-slate-600 hover:text-slate-400' : 'text-slate-400 hover:text-slate-600'}`}
                  title="Clear session image (revert to stacked)"
                >
                  Reset
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className={`rounded-xl border flex flex-col items-center justify-center gap-3 py-14 ${isDark ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
            <FileImage className={`w-8 h-8 ${isDark ? 'text-slate-700' : 'text-slate-300'}`} />
            <div className="text-center space-y-1">
              <p className={`text-sm font-medium ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>No stacked image</p>
              <p className={`text-xs ${isDark ? 'text-slate-600' : 'text-slate-500'}`}>
                {files.some(f => f.type === 'fits') ? 'Raw FITS frames only' : 'No images captured'}
              </p>
            </div>
          </div>
        )}

        {/* Right: About, Location, Notes */}
        <div className="space-y-4">
          {/* Object Information */}
          {objectInfo && (
            <div className={`rounded-xl border p-4 ${isDark ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
              <div className="flex items-start gap-4">
                {/* Left: header + description + wiki link */}
                <div className="flex-1 min-w-0">
                  <h3 className={`font-display font-semibold text-sm flex items-center gap-2 mb-3 ${isDark ? 'text-white' : 'text-slate-900'}`}>
                    <Info className={`w-3.5 h-3.5 ${accentText}`} />
                    About {displayName}
                  </h3>
                  {objectInfo.description && (
                    <div className="flex flex-col gap-3">
                      <p className={`text-xs leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                        {objectInfo.description}
                      </p>
                      {objectInfo.wikiUrl && (
                        <a
                          href={objectInfo.wikiUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`inline-flex items-center gap-1.5 text-xs font-medium transition ${accentText} hover:underline`}
                        >
                          <ExternalLink className="w-3 h-3" />
                          Wikipedia
                        </a>
                      )}
                    </div>
                  )}
                  {!objectInfo.description && objectInfo.wikiUrl && (
                    <a
                      href={objectInfo.wikiUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`inline-flex items-center gap-1.5 text-xs font-medium transition ${accentText} hover:underline`}
                    >
                      <ExternalLink className="w-3 h-3" />
                      Wikipedia
                    </a>
                  )}
                </div>

                {/* Catalog panel */}
                {(objectInfo.type || objectInfo.constellation || observation?.magnitude != null || observation?.distanceLy != null || objectInfo.size || objectInfo.ra || objectInfo.dec) && (
                  <div className={`shrink-0 w-36 ${objectInfo.description ? `border-l pl-4 ${isDark ? 'border-slate-800' : 'border-slate-200'}` : 'flex-1'}`}>
                    <p className="text-[10px] font-semibold uppercase tracking-widest mb-2.5 text-amber-500/80">
                      Catalog
                    </p>
                    <div className="space-y-2">
                      {objectInfo.type && (
                        <div>
                          <p className={`text-[10px] ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>Type</p>
                          <p className={`text-[11px] font-medium leading-tight ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{objectInfo.type}</p>
                        </div>
                      )}
                      {objectInfo.constellation && (
                        <div>
                          <p className={`text-[10px] ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>Constellation</p>
                          <p className={`text-[11px] font-medium leading-tight ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{objectInfo.constellation}</p>
                        </div>
                      )}
                      {observation?.magnitude != null && (
                        <div>
                          <p className={`text-[10px] ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>Magnitude</p>
                          <p className={`text-[11px] font-medium leading-tight ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                            {observation.magnitude.toFixed(2)}
                          </p>
                        </div>
                      )}
                      {observation?.distanceLy != null && (
                        <div>
                          <p className={`text-[10px] ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>Distance</p>
                          <p className={`text-[11px] font-medium leading-tight ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                            {formatDistanceLy(observation.distanceLy)}
                          </p>
                        </div>
                      )}
                      {objectInfo.size && (
                        <div>
                          <p
                            title="Apparent angular size as seen from Earth, measured in arcminutes (′). The full Moon is ~30′ across for comparison."
                            className={`text-[10px] cursor-help underline decoration-dotted underline-offset-2 ${isDark ? 'text-slate-600 decoration-slate-700' : 'text-slate-400 decoration-slate-300'}`}
                          >
                            Angular size
                          </p>
                          <p className={`text-[11px] font-medium leading-tight ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{objectInfo.size}</p>
                        </div>
                      )}
                      {objectInfo.ra && (
                        <div>
                          <p className={`text-[10px] ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>RA</p>
                          <p className={`text-[11px] font-medium leading-tight ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                            {formatRa(String(objectInfo.ra))}
                          </p>
                        </div>
                      )}
                      {objectInfo.dec && (
                        <div>
                          <p className={`text-[10px] ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>Dec</p>
                          <p className={`text-[11px] font-medium leading-tight ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                            {formatDec(String(objectInfo.dec))}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Weather conditions */}
          {observation?.weather && (
            <WeatherPanel weather={observation.weather} tempUnit={tempUnit} />
          )}

          {/* Observation Location Map */}
          {observation?.coordinates && (
            <div
              className={`rounded-xl border overflow-hidden ${isDark ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}
              style={{ isolation: 'isolate', position: 'relative', zIndex: 0 }}
            >
              <div className={`px-4 py-2 border-b flex items-center justify-between ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
                <h3 className={`font-display font-semibold text-sm flex items-center gap-2 ${isDark ? 'text-white' : 'text-slate-900'}`}>
                  <MapPin className={`w-3.5 h-3.5 ${accentText}`} />
                  Location
                </h3>
                <span className={`text-[11px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  {locationName && <span className="mr-1">{locationName} ·</span>}
                  {observation.coordinates.lat.toFixed(2)}°, {observation.coordinates.lon.toFixed(2)}°
                </span>
              </div>
              <div className="h-[150px]">
                <ObservationMap
                  lat={observation.coordinates.lat}
                  lon={observation.coordinates.lon}
                  isDark={isDark}
                />
              </div>
            </div>
          )}

          {/* Session Metrics and Notes */}
          <ObservationStatsTiles
            files={files}
            hasNote={!!existingNote}
            canOpenNotes={!!objectId && !!date}
            isAdmin={isAdmin}
            onOpenNotes={() => setNotesModalOpen(true)}
          />

          {/* Sky Conditions */}
          {observation?.note && (
            <div className={`rounded-xl border p-4 space-y-2 ${isDark ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
              <h3 className={`font-display font-semibold text-sm ${isDark ? 'text-white' : 'text-slate-900'}`}>
                Sky Conditions
              </h3>
              <div className={`flex flex-wrap gap-3 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                {observation.note.bortleClass && (
                  <div>
                    <span className={isDark ? 'text-slate-600' : 'text-slate-400'}>Bortle </span>
                    <span className="font-medium">Class {observation.note.bortleClass}</span>
                  </div>
                )}
                {observation.note.seeingRating && (
                  <div>
                    <span className={isDark ? 'text-slate-600' : 'text-slate-400'}>Seeing </span>
                    <span className="font-medium">{observation.note.seeingRating}/5</span>
                  </div>
                )}
                {observation.note.transparencyRating && (
                  <div>
                    <span className={isDark ? 'text-slate-600' : 'text-slate-400'}>Transparency </span>
                    <span className="font-medium">{observation.note.transparencyRating}/5</span>
                  </div>
                )}
                {observation.note.moonPhase && (
                  <div>
                    <span className={isDark ? 'text-slate-600' : 'text-slate-400'}>Moon </span>
                    <span className="font-medium">
                      {observation.note.moonPhase}
                      {observation.note.moonIllumination != null && ` (${observation.note.moonIllumination}%)`}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Below: FITS Gallery + Satellite Trail Detection (full width) */}
      <div className="space-y-6">
        {/* Telescope Images + Subframes side by side */}
        <div className="grid grid-cols-2 gap-6">
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
          stackedImagePath={(stackedImage ?? stackedFits)?.path}
          handleSetSessionImage={handleSetSessionImage}
          settingSessionImage={settingSessionImage}
          imageFavoriteSet={imageFavoriteSet}
          onToggleFavorite={(imagePath, isFavorite) => imageFavoriteMutation.mutate({ imagePath, isFavorite })}
          date={date}
          openGallery={openGallery}
          isAdmin={isAdmin}
        />

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
        </div>{/* end side-by-side grid */}

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
            <img src={compareItems[0].file.downloadUrl} alt="Image 1" className="w-12 h-12 rounded-lg object-cover border-2 border-accent-500" />
            <span className={`text-xs font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>vs</span>
            <img src={compareItems[1].file.downloadUrl} alt="Image 2" className="w-12 h-12 rounded-lg object-cover border-2 border-violet-500" />
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

function formatDistanceLy(ly: number): string {
  if (ly >= 1_000_000) {
    const mly = ly / 1_000_000;
    return `${mly % 1 === 0 ? mly.toFixed(0) : mly.toFixed(2)} million ly`;
  }
  return `${ly.toLocaleString('en-US')} ly`;
}
