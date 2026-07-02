import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient, useMutation, useMutationState } from '@tanstack/react-query';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  ArrowLeft,
  Calendar,
  Clock,
  MapPin,
  Star,
  Layers,
  FileImage,
  Info,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  X,
  Loader2,
  Download,
  Trash2,
  ArrowRightLeft,
  Cloud,
  Thermometer,
  Droplets,
  Wind,
  Sparkles,
  Upload,
  ImagePlus,
  Crown,
  Pencil,
  Columns,
  Heart,
  NotebookPen,
  CheckCircle2,
  Satellite,
  Telescope,
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
import { getTelescopeStatus, listTelescopes, reassignSessionTelescope } from '../lib/api/telescopes';
import { fetchLocationName } from '../lib/api/catalog';
import { getNote } from '../lib/api/notes';
import { formatObjectTitle } from '../lib/dsoSearch';
import { MoveObservationModal } from '../components/MoveObservationModal';
import { UploadProcessedModal } from '../components/UploadProcessedModal';
import { DeleteSessionModal } from '../components/DeleteSessionModal';
import { GalleryModal, type GalleryItem } from '../components/GalleryModal';
import { FitsThumbnail } from '../components/FitsThumbnail';
import { FitsHeaderModal } from '../components/FitsHeaderModal';
import { SessionNotesModal } from '../components/SessionNotesModal';
import { ObservationMap } from '../components/ObservationMap';
import { ImageEditorModal } from '../components/ImageEditorModal';
import { ImageCompareModal, type CompareFile } from '../components/ImageCompareModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { useSyncSubframes } from '../contexts/SyncSubframesContext';
import { SatelliteTrailScanModal } from '../components/SatelliteTrailScanModal';
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
  const GALLERY_PAGE_SIZE = 12; // 3 rows × 4 columns (md breakpoint)

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
  type CompareItem = { key: string; file: CompareFile };
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

  // Subframes grid — how many tiles fit in the available width × height (measured)
  const subFramesRowRef = useRef<HTMLDivElement>(null);
  const [subFramesVisible, setSubFramesVisible] = useState(20);
  useEffect(() => {
    const el = subFramesRowRef.current;
    if (!el) return;
    const TILE = 64 + 6; // w-16 + gap-1.5
    const PADDING = 24;  // p-3 each side
    const measure = () => {
      const cols = Math.max(1, Math.floor((el.offsetWidth - PADDING + 6) / TILE));
      const rows = Math.max(1, Math.floor((el.offsetHeight - PADDING + 6) / TILE));
      setSubFramesVisible(cols * rows);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
  const [showReassign, setShowReassign] = useState(false);
  const reassignWrapRef = useRef<HTMLSpanElement>(null);
  // Close on outside click / Escape so the popover doesn't linger after the
  // user moves on. Listener is only attached while open.
  useEffect(() => {
    if (!showReassign) return;
    function handleClick(e: MouseEvent) {
      if (
        reassignWrapRef.current &&
        e.target instanceof Node &&
        !reassignWrapRef.current.contains(e.target)
      ) {
        setShowReassign(false);
      }
    }
    function handleKey(e: KeyboardEvent) { if (e.key === 'Escape') setShowReassign(false); }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [showReassign]);
  const reassignMutation = useMutation({
    mutationFn: (newTelescopeId: string) => {
      if (!objectId || !date) throw new Error('No session loaded');
      return reassignSessionTelescope(objectId, date, newTelescopeId);
    },
    onSuccess: () => {
      setShowReassign(false);
      queryClient.invalidateQueries({ queryKey: ['observation', objectId, date] });
      queryClient.invalidateQueries({ queryKey: ['observations'] });
      queryClient.invalidateQueries({ queryKey: ['telescopes'] });
      queryClient.invalidateQueries({ queryKey: ['library-sessions', objectId] });
    },
  });

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
  const hasSubFrames = subFrames.length > 0;
  const filteredFiles = files.filter(f => {
    if (f.fileType === 'sub') return false;
    if (viewMode === 'fits') return f.type === 'fits';
    if (viewMode === 'image') return f.type === 'image';
    return f.type === 'fits' || f.type === 'image';
  });

const stackedImage = files.find(f => f.fileType === 'stacked' && f.type === 'image');

  // Designated session image (falls back to stacked, then first image)
  const designatedSessionFile = observation?.sessionImage
    ? files.find(f => f.path === observation.sessionImage) ?? null
    : null;
  const designatedProcessedImage = observation?.sessionImage
    ? processedImages.find(img => img.path === observation.sessionImage) ?? null
    : null;
  const heroFile = designatedSessionFile ?? stackedImage ?? files.find(f => f.type === 'image' && !f.isThumbnail) ?? null;
  const heroIsUserDesignated = (!!designatedSessionFile && designatedSessionFile !== stackedImage) || !!designatedProcessedImage;

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
      {/* Breadcrumbs */}
      <div className="flex items-center gap-2 text-sm">
        <Link to="/observations" className={`transition ${isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600'}`}>
          Observations
        </Link>
        <span className={isDark ? 'text-slate-700' : 'text-slate-300'}>/</span>
        <Link to={`/object/${encodeURIComponent(objectId)}`} className={`transition ${isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600'}`}>
          {displayName}
        </Link>
        <span className={isDark ? 'text-slate-700' : 'text-slate-300'}>/</span>
        <span className={isDark ? 'text-slate-300' : 'text-slate-700'}>{formattedDate}</span>
      </div>

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <Link
            to={`/object/${encodeURIComponent(objectId)}`}
            className={`inline-flex items-center gap-2 text-sm font-medium mb-2 transition ${isDark ? 'text-slate-400 hover:text-accent-400' : 'text-slate-500 hover:text-accent-600'}`}
          >
            <ArrowLeft className="w-4 h-4" />
            Back to {displayName}
          </Link>
          <h1 className={`font-display text-3xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
            {displayName}
          </h1>
          <div className={`flex flex-wrap items-center gap-4 text-sm mt-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            <span className="flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5" />
              {formattedDate}
            </span>
            {observation?.startTime && (
              <span className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" />
                {formatTime(observation.startTime)}
                {observation.endTime && observation.endTime !== observation.startTime && (
                  <> - {formatTime(observation.endTime)}</>
                )}
              </span>
            )}
            {observation?.type && (
              <span className={`px-2 py-0.5 rounded-full text-xs ${isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>
                {observation.type}
              </span>
            )}
            {/* Telescope chip — only when multiple telescopes are configured.
                Click to filter the calendar; admins can reassign via popover. */}
            {showTelescopeUI && telescopeForObs && (
              <span ref={reassignWrapRef} className="relative inline-flex items-center">
                <Link
                  to={`/observations?telescopeId=${encodeURIComponent(telescopeForObs.id)}`}
                  className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium transition ${
                    isDark ? 'bg-slate-800 hover:bg-slate-700' : 'bg-slate-100 hover:bg-slate-200'
                  }`}
                  title={`Captured on ${telescopeForObs.name}. Click to filter.`}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ backgroundColor: telescopeForObs.color }}
                    aria-hidden="true"
                  />
                  <span className={isDark ? 'text-slate-300' : 'text-slate-600'}>
                    {telescopeForObs.name}
                  </span>
                </Link>
                {isAdmin && (
                  <button
                    onClick={() => setShowReassign(s => !s)}
                    className={`ml-1 p-1 rounded transition ${
                      isDark ? 'text-slate-500 hover:text-accent-400 hover:bg-slate-800' : 'text-slate-400 hover:text-accent-600 hover:bg-slate-100'
                    }`}
                    title="Reassign to a different telescope"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                )}
                {showReassign && (
                  <div className={`absolute left-0 top-full mt-1 z-30 w-56 rounded-xl border shadow-lg p-2 ${
                    isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'
                  }`}>
                    <div className={`px-2 py-1 text-[11px] font-semibold uppercase tracking-wider ${
                      isDark ? 'text-slate-500' : 'text-slate-400'
                    }`}>
                      Reassign to
                    </div>
                    {telescopes.map(t => (
                      <button
                        key={t.id}
                        onClick={() => reassignMutation.mutate(t.id)}
                        disabled={reassignMutation.isPending || t.id === telescopeForObs.id}
                        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-left transition disabled:opacity-50 ${
                          isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-50 text-slate-700'
                        }`}
                      >
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: t.color }}
                        />
                        <span className="flex-1 truncate">{t.name}</span>
                        {t.id === telescopeForObs.id && <CheckCircle2 className="w-3 h-3 text-teal-500" />}
                      </button>
                    ))}
                    {reassignMutation.isError && (
                      <div className={`mt-1 px-2 py-1 text-[11px] rounded ${
                        isDark ? 'text-red-400' : 'text-red-600'
                      }`}>
                        Reassignment failed
                      </div>
                    )}
                  </div>
                )}
              </span>
            )}
          </div>
        </div>
        <div className={`flex items-center gap-3 text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          {observation && (
            <>
              {isAdmin && (
                <button
                  onClick={() => setShowMoveModal(true)}
                  className={`ml-2 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition ${isDark ? 'text-slate-500 hover:text-accent-400 hover:bg-accent-500/10' : 'text-slate-400 hover:text-accent-500 hover:bg-accent-50'}`}
                  title="Move observation to different object"
                >
                  <ArrowRightLeft className="w-4 h-4" />
                  Move
                </button>
              )}
              {isAdmin && (
                <button
                  onClick={() => setShowDeleteModal(true)}
                  className={`p-1.5 rounded-lg transition ${isDark ? 'text-slate-600 hover:text-red-400 hover:bg-red-500/10' : 'text-slate-400 hover:text-red-500 hover:bg-red-50'}`}
                  title="Delete observation"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </>
          )}
        </div>
      </div>

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
                const idx = filteredFiles.findIndex(f => f.path === heroFile.path);
                if (idx >= 0) openGallery(idx);
              }}
            >
              <img
                src={heroFile.downloadUrl}
                alt={displayName}
                className="w-full object-contain"
              />
              {/* Crown badge for user-designated session image */}
              {heroIsUserDesignated && (
                <div className="absolute top-2 left-2 px-2 py-1 rounded-md bg-amber-500/90 text-white text-[11px] font-semibold flex items-center gap-1 shadow">
                  <Crown className="w-3 h-3" />
                  Session Image
                </div>
              )}
              <button
                onClick={e => { e.stopPropagation(); openImageEditor(heroFile.downloadUrl, heroFile.name, 'telescope'); }}
                className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/40 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/60"
                title="Edit image"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
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
                    Stacked{heroFile.frameCount ? ` · ${heroFile.frameCount} frames` : ''}
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
            <div className={`rounded-xl border p-4 ${isDark ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
              <h3 className={`font-display font-semibold text-sm flex items-center gap-2 mb-3 ${isDark ? 'text-white' : 'text-slate-900'}`}>
                <Cloud className={`w-3.5 h-3.5 ${accentText}`} />
                Weather Conditions
              </h3>
              <div className={`grid grid-cols-2 gap-x-4 gap-y-2 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                {observation.weather.cloudCover != null && (
                  <div className="flex items-center justify-between">
                    <span className={`flex items-center gap-1.5 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                      <Cloud className="w-3 h-3" /> Clouds
                    </span>
                    <span className="font-medium">{Math.round(observation.weather.cloudCover)}%</span>
                  </div>
                )}
                {observation.weather.temperature != null && (
                  <div className="flex items-center justify-between">
                    <span className={`flex items-center gap-1.5 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                      <Thermometer className="w-3 h-3" /> Temp
                    </span>
                    <span className="font-medium">{tempUnit === 'fahrenheit' ? `${Math.round(observation.weather.temperature! * 9 / 5 + 32)}°F` : `${Math.round(observation.weather.temperature!)}°C`}</span>
                  </div>
                )}
                {observation.weather.humidity != null && (
                  <div className="flex items-center justify-between">
                    <span className={`flex items-center gap-1.5 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                      <Droplets className="w-3 h-3" /> Humidity
                    </span>
                    <span className="font-medium">{Math.round(observation.weather.humidity)}%</span>
                  </div>
                )}
                {observation.weather.windSpeed != null && (
                  <div className="flex items-center justify-between">
                    <span className={`flex items-center gap-1.5 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                      <Wind className="w-3 h-3" /> Wind
                    </span>
                    <span className="font-medium">{Math.round(observation.weather.windSpeed * 0.621371)} mph</span>
                  </div>
                )}
                {observation.weather.dewPoint != null && (
                  <div className="flex items-center justify-between">
                    <span className={`${isDark ? 'text-slate-600' : 'text-slate-400'}`}>Dew Point</span>
                    <span className="font-medium">{tempUnit === 'fahrenheit' ? `${Math.round(observation.weather.dewPoint! * 9 / 5 + 32)}°F` : `${Math.round(observation.weather.dewPoint!)}°C`}</span>
                  </div>
                )}
                {observation.weather.precipProb != null && observation.weather.precipProb > 0 && (
                  <div className="flex items-center justify-between">
                    <span className={`${isDark ? 'text-slate-600' : 'text-slate-400'}`}>Precip</span>
                    <span className="font-medium">{Math.round(observation.weather.precipProb)}%</span>
                  </div>
                )}
              </div>
            </div>
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
          {(() => {
            const stackedFile = files.find(f => f.fileType === 'stacked');
            const subCount = files.filter(f => f.fileType === 'sub').length;
            const canOpenNotes = !!objectId && !!date;

            const frameCount = stackedFile?.frameCount ?? null;
            const exposure = stackedFile?.exposure ?? null;
            const filter = stackedFile?.filter ?? null;
            const expSeconds = exposure ? parseFloat(exposure.replace('s', '')) : null;
            const totalSeconds = (frameCount && expSeconds) ? frameCount * expSeconds : null;

            const formatIntegration = (secs: number) => {
              if (secs < 60) return `${Math.round(secs)}s`;
              const m = Math.floor(secs / 60);
              const s = Math.round(secs % 60);
              if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
              const h = Math.floor(m / 60);
              const rem = m % 60;
              return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
            };

            const filterDisplay = (f: string) => {
              if (f.toUpperCase() === 'LP') return 'LP Filter';
              if (f.toUpperCase() === 'IRCUT') return 'IR Cut';
              return f;
            };

            const tiles: { value: string; label: string }[] = [];
            if (frameCount != null) tiles.push({ value: frameCount.toLocaleString(), label: 'Frames Stacked' });
            if (totalSeconds != null) tiles.push({ value: formatIntegration(totalSeconds), label: 'Total Integration' });
            if (exposure) tiles.push({ value: exposure, label: 'Exp. per Frame' });
            if (filter) tiles.push({ value: filterDisplay(filter), label: 'Filter' });
            if (subCount > 0) tiles.push({ value: subCount.toLocaleString(), label: 'Sub-frames' });

            if (tiles.length === 0 && !canOpenNotes) return null;

            return (
              <div className={`rounded-xl border p-4 ${isDark ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
                <h3 className={`font-display font-semibold text-sm flex items-center gap-2 mb-3 ${isDark ? 'text-white' : 'text-slate-900'}`}>
                  <Layers className={`w-3.5 h-3.5 ${accentText}`} />
                  Session Metrics and Notes
                </h3>
                <div className="grid grid-cols-2 gap-2">
                  {tiles.map(({ value, label }) => (
                    <div
                      key={label}
                      className={`rounded-lg px-3 py-2.5 ${isDark ? 'bg-slate-800/60' : 'bg-slate-50'}`}
                    >
                      <div className={`text-base font-semibold leading-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
                        {value}
                      </div>
                      <div className={`text-[10px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                        {label}
                      </div>
                    </div>
                  ))}
                  {canOpenNotes && (isAdmin || !!existingNote) && (
                    <button
                      onClick={() => setNotesModalOpen(true)}
                      title={isAdmin ? (existingNote ? 'Edit session notes' : 'Add session notes') : 'View session notes'}
                      className={`group rounded-lg px-3 py-2.5 text-left transition border ${
                        isDark
                          ? 'bg-amber-500/10 hover:bg-amber-500/20 border-amber-500/30'
                          : 'bg-amber-50 hover:bg-amber-100 border-amber-200'
                      }`}
                    >
                      <div className={`text-base font-semibold leading-tight flex items-center gap-1.5 ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
                        <NotebookPen className="w-4 h-4" />
                        Session Notes
                        {existingNote && (
                          <CheckCircle2 className={`w-3.5 h-3.5 ${isDark ? 'text-amber-400' : 'text-amber-600'}`} />
                        )}
                      </div>
                      <div className={`text-[10px] mt-0.5 ${isDark ? 'text-amber-500/70' : 'text-amber-700/70'}`}>
                        {isAdmin
                          ? (existingNote ? 'Saved. Click to edit.' : 'Click to add')
                          : 'Click to view'}
                      </div>
                    </button>
                  )}
                </div>
              </div>
            );
          })()}

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
        {/* Telescope Images */}
        <div className={`rounded-2xl border ${isDark ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
          <div className={`flex items-center justify-between p-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
            <h2 className={`font-display font-semibold flex items-center gap-2 ${isDark ? 'text-white' : 'text-slate-900'}`}>
              <Telescope className="w-4 h-4 flex-shrink-0 text-teal-500" />
              Images
              {filteredFiles.length > 0 && (
                <span className={`text-xs px-2 py-0.5 rounded-full ${isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>
                  {filteredFiles.length}
                </span>
              )}
            </h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() => compareMode ? exitCompareMode() : setCompareMode(true)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition ${
                  compareMode
                    ? isDark ? 'bg-accent-500/10 text-accent-400 border border-accent-500/30' : 'bg-accent-300 text-accent-700 border border-accent-400'
                    : isDark ? 'text-slate-500 hover:text-accent-400 hover:bg-accent-500/10 border border-transparent' : 'text-slate-400 hover:text-accent-500 hover:bg-accent-50 border border-transparent'
                }`}
                title={compareMode ? 'Exit compare mode' : 'Compare images side by side'}
              >
                <Columns className="w-3.5 h-3.5" />
                {compareMode ? 'Exit Compare' : 'Compare'}
              </button>
              <div className={`flex rounded-xl overflow-hidden border ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
                {(['all', 'image', 'fits'] as const).map(mode => (
                  <button
                    key={mode}
                    onClick={() => { setViewMode(mode); setGalleryPage(0); }}
                    className={`px-3 py-1.5 text-xs font-medium capitalize transition ${
                      viewMode === mode
                        ? isDark ? 'bg-accent-500/15 text-accent-400' : 'bg-accent-300 text-accent-700'
                        : isDark ? 'bg-slate-900 text-slate-400 hover:bg-slate-800' : 'bg-white text-slate-500 hover:bg-slate-50'
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {filteredFiles.length > 0 ? (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 p-4">
                {filteredFiles.slice(galleryPage * GALLERY_PAGE_SIZE, (galleryPage + 1) * GALLERY_PAGE_SIZE).map((file, localIdx) => {
                  const globalIdx = galleryPage * GALLERY_PAGE_SIZE + localIdx;
                  const isSessionImage = observation?.sessionImage
                    ? file.path === observation.sessionImage
                    : file === stackedImage && !observation?.sessionImage;
                  const isImageFile = file.type === 'image' && !file.isThumbnail;
                  const compareSlot = compareItems[0]?.key === file.path ? 1 : compareItems[1]?.key === file.path ? 2 : null;
                  const isFitsInCompareMode = compareMode && file.type === 'fits';
                  return (
                    <div
                      key={file.path}
                      className={`group rounded-xl overflow-hidden border cursor-pointer ${
                        compareSlot === 1
                          ? 'border-accent-500 ring-2 ring-accent-500/40'
                          : compareSlot === 2
                            ? 'border-violet-500 ring-2 ring-violet-500/40'
                            : isFitsInCompareMode
                              ? `opacity-40 cursor-not-allowed ${isDark ? 'border-slate-800 bg-slate-800' : 'border-slate-200 bg-slate-100'}`
                              : isDark ? 'border-slate-800 bg-slate-800' : 'border-slate-200 bg-slate-100'
                      }`}
                    >
                      {/* Image area */}
                      <div className="relative aspect-square">
                        <button
                          onClick={() => (compareMode && !isFitsInCompareMode) ? toggleCompareItem(file.path, { name: file.name, downloadUrl: file.downloadUrl, exposure: file.exposure, frameCount: file.frameCount, filter: file.filter }) : openGallery(globalIdx)}
                          className="w-full h-full block cursor-pointer"
                        >
                          {file.type === 'fits' ? (
                            <FitsThumbnail url={file.downloadUrl} stretch={1.0} isDark={isDark} />
                          ) : (
                            <img
                              src={file.downloadUrl}
                              alt={file.name}
                              className="w-full h-full object-cover"
                              onError={e => { if (e.target instanceof HTMLImageElement) e.target.style.display = 'none'; }}
                            />
                          )}
                        </button>

                        {/* Session image crown badge */}
                        {isSessionImage && isImageFile && (
                          <div className="absolute top-1 left-1 p-1 rounded-md bg-amber-400/90 text-white pointer-events-none">
                            <Crown className="w-3 h-3" />
                          </div>
                        )}

                        {/* Set as session image button (visible on hover) */}
                        {isImageFile && !isSessionImage && isAdmin && (
                          <button
                            onClick={e => { e.stopPropagation(); handleSetSessionImage(file.path); }}
                            disabled={settingSessionImage}
                            className="absolute top-1 left-1 p-1 rounded-md bg-black/60 text-white/70 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80 hover:text-amber-400"
                            title="Set as session image"
                          >
                            <Crown className="w-3 h-3" />
                          </button>
                        )}

                        {/* Download button (images only, top-right on hover) */}
                        {file.type === 'image' && (
                          <a
                            href={file.downloadUrl}
                            download={file.name}
                            onClick={e => e.stopPropagation()}
                            className="absolute top-1 right-1 p-1.5 rounded-lg bg-white/20 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-white/30"
                            title="Download"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </a>
                        )}

                        {/* Favorite button (images only, bottom-left) */}
                        {file.type === 'image' && !file.isThumbnail && (
                          <button
                            onClick={e => {
                              e.stopPropagation();
                              const isFav = imageFavoriteSet.has(file.path);
                              imageFavoriteMutation.mutate({ imagePath: file.path, isFavorite: !isFav });
                            }}
                            title={imageFavoriteSet.has(file.path) ? 'Remove from favorites' : 'Add to favorites'}
                            className={`absolute bottom-1 left-1 p-1.5 rounded-lg transition-all ${
                              imageFavoriteSet.has(file.path)
                                ? 'opacity-100 bg-rose-500/90 text-white hover:bg-rose-600'
                                : 'bg-black/50 text-white/70 opacity-0 group-hover:opacity-100 hover:bg-black/70 hover:text-rose-400'
                            }`}
                          >
                            <Heart className={`w-3.5 h-3.5 ${imageFavoriteSet.has(file.path) ? 'fill-current' : ''}`} />
                          </button>
                        )}

                        {/* File type badge (bottom-right, always visible) */}
                        {(() => {
                          const ext = file.name.split('.').pop()?.toUpperCase();
                          let label: string | null = null;
                          if (file.type === 'fits') label = 'FIT';
                          else if (ext === 'JPG' || ext === 'JPEG') label = 'JPG';
                          else if (ext === 'PNG') label = 'PNG';
                          else if (ext === 'TIFF' || ext === 'TIF') label = 'TIFF';
                          if (!label) return null;
                          return (
                            <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wide bg-black/60 text-white/80 pointer-events-none">
                              {label}
                            </div>
                          );
                        })()}

                        {/* Compare selection badge */}
                        {compareSlot && (
                          <div className={`absolute top-1 left-1 w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-bold shadow-lg pointer-events-none ${
                            compareSlot === 1 ? 'bg-accent-500' : 'bg-violet-500'
                          }`}>
                            {compareSlot}
                          </div>
                        )}
                      </div>

                      {/* Footer — name + date, never darkened by hover */}
                      <div className={`px-2 py-1.5 ${isDark ? 'bg-slate-900/80' : 'bg-white/90'}`}>
                        <p className={`text-xs font-medium truncate ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                          {file.name}
                        </p>
                        <p className={`text-[10px] mt-0.5 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                          {date && date !== 'unknown'
                            ? new Date(date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                            : ''}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Pagination */}
              {filteredFiles.length > GALLERY_PAGE_SIZE && (
                <div className={`flex items-center justify-between px-4 pb-4 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  <span className="text-xs">
                    Showing {galleryPage * GALLERY_PAGE_SIZE + 1}–{Math.min((galleryPage + 1) * GALLERY_PAGE_SIZE, filteredFiles.length)} of {filteredFiles.length}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setGalleryPage(p => Math.max(0, p - 1))}
                      disabled={galleryPage === 0}
                      className={`min-w-[44px] min-h-[44px] p-1.5 rounded-lg transition disabled:opacity-30 ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    {Array.from({ length: Math.ceil(filteredFiles.length / GALLERY_PAGE_SIZE) }, (_, i) => (
                      <button
                        key={i}
                        onClick={() => setGalleryPage(i)}
                        className={`min-w-[44px] min-h-[44px] rounded-lg text-xs font-medium transition ${
                          galleryPage === i
                            ? isDark ? 'bg-accent-500/15 text-accent-400' : 'bg-accent-300 text-accent-700'
                            : isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'
                        }`}
                      >
                        {i + 1}
                      </button>
                    )).slice(
                      Math.max(0, galleryPage - 2),
                      Math.min(Math.ceil(filteredFiles.length / GALLERY_PAGE_SIZE), galleryPage + 3)
                    )}
                    <button
                      onClick={() => setGalleryPage(p => Math.min(Math.ceil(filteredFiles.length / GALLERY_PAGE_SIZE) - 1, p + 1))}
                      disabled={galleryPage >= Math.ceil(filteredFiles.length / GALLERY_PAGE_SIZE) - 1}
                      className={`min-w-[44px] min-h-[44px] p-1.5 rounded-lg transition disabled:opacity-30 ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className={`p-8 text-center ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
              No files found
            </div>
          )}
        </div>

        {/* ─── Telescope Subframes ───────────────────────────────────────────── */}
        <div className={`rounded-2xl border min-w-0 flex flex-col ${isDark ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
          <div className={`flex items-center justify-between p-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
            <h2 className={`font-display font-semibold flex items-center gap-2 ${isDark ? 'text-white' : 'text-slate-900'}`}>
              <Telescope className="w-4 h-4 flex-shrink-0 text-teal-500" />
              Subframes
              {hasSubFrames && (
                <span className={`text-xs px-2 py-0.5 rounded-full ${isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>
                  {subFrames.length}
                </span>
              )}
            </h2>
            <div className="flex items-center gap-2">
              {isAdmin && hasSubFrames && subFrames.some(f => f.type === 'fits') && (
                <button
                  onClick={() => setSatelliteScanOpen(true)}
                  title="Scan all FITS subframes for satellite trails"
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                    isDark
                      ? 'border-amber-500/30 text-amber-400 hover:bg-amber-500/10'
                      : 'border-amber-300 text-amber-600 hover:bg-amber-50'
                  }`}
                >
                  <Satellite className="w-3.5 h-3.5" />
                  Scan Trails
                </button>
              )}
              {isAdmin && (
                <span
                  title={!telescopeOnline ? 'Telescope is offline - connect to download subs' : 'Download all raw subframes for this session from the telescope to your library'}
                  className={!telescopeOnline ? 'cursor-not-allowed' : undefined}
                >
                  <button
                    onClick={() => objectId && date && openSync(objectId, date)}
                    disabled={!telescopeOnline}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                      !telescopeOnline
                        ? isDark
                          ? 'border-slate-800 text-slate-600 cursor-not-allowed'
                          : 'border-slate-200 text-slate-300 cursor-not-allowed'
                        : isDark
                          ? 'border-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                          : 'border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <Download className="w-3.5 h-3.5" />
                    Sync Subs
                  </button>
                </span>
              )}
              {hasSubFrames && (
                <button
                  onClick={handleDownloadToComputer}
                  disabled={archiveState !== 'idle'}
                  title={
                    archiveState === 'error'
                      ? 'Failed. Try again.'
                      : 'Zip the locally-stored subframes for this session and download to your computer'
                  }
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition disabled:cursor-wait ${
                    archiveState === 'error'
                      ? isDark
                        ? 'border-red-500/30 text-red-400'
                        : 'border-red-300 text-red-600'
                      : isDark
                        ? 'border-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                        : 'border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <Download className="w-3.5 h-3.5" />
                  {archiveState === 'idle'
                    ? 'Download to Computer'
                    : archiveState === 'error'
                      ? 'Download failed'
                      : `Zipping ${archiveState.done}/${archiveState.total}…`}
                </button>
              )}
              {isAdmin && hasSubFrames && (
                <button
                  onClick={() => setConfirmDeleteSubframes(true)}
                  title="Delete all subframes for this session"
                  className={`p-1.5 rounded-lg transition ${isDark ? 'text-slate-600 hover:text-red-400 hover:bg-red-500/10' : 'text-slate-400 hover:text-red-500 hover:bg-red-50'}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {subFrames.length > 0 ? (
            <div ref={subFramesRowRef} className="flex flex-wrap gap-1.5 p-3 flex-1 min-h-0 content-start">
              {(() => {
                // Always reserve the last slot for the "···" viewer button
                const capacity = subFramesVisible - 1;
                const shown = Math.min(capacity, subFrames.length);
                const overflow = subFrames.length - shown;
                return (
                  <>
                    {subFrames.slice(0, shown).map((file, idx) => (
                      <button
                        key={file.path}
                        onClick={() => openGallery(idx, subFrames)}
                        title={file.name}
                        className={`flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden border-2 ${
                          isDark ? 'border-slate-700 hover:border-slate-500 bg-slate-800' : 'border-slate-200 hover:border-slate-400 bg-slate-100'
                        }`}
                      >
                        {file.type === 'fits' ? (
                          <FitsThumbnail url={file.downloadUrl} thumbUrl={file.thumbUrl} stretch={1.0} isDark={isDark} />
                        ) : (
                          <img
                            src={file.downloadUrl}
                            alt={file.name}
                            className="w-full h-full object-cover"
                            onError={e => { if (e.target instanceof HTMLImageElement) e.target.style.display = 'none'; }}
                          />
                        )}
                      </button>
                    ))}
                    <button
                      onClick={() => openGallery(overflow > 0 ? shown : 0, subFrames)}
                      title={overflow > 0 ? `${overflow} more subframes. Open viewer.` : 'Open subframe viewer'}
                      className={`flex-shrink-0 w-16 h-16 rounded-lg border-2 flex flex-col items-center justify-center gap-0.5 ${
                        isDark ? 'border-slate-700 hover:border-slate-500 bg-slate-800 text-slate-400 hover:text-slate-200' : 'border-slate-200 hover:border-slate-400 bg-slate-100 text-slate-500 hover:text-slate-700'
                      }`}
                    >
                      <span className="text-lg leading-none tracking-widest">···</span>
                      {overflow > 0 && <span className="text-[10px] font-medium">+{overflow}</span>}
                    </button>
                  </>
                );
              })()}
            </div>
          ) : (
            <div className={`p-8 text-center ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
              No subframes downloaded yet - connect your telescope and use Download Subs to sync them.
            </div>
          )}
        </div>
        </div>{/* end side-by-side grid */}

        {/* ─── Processed Images ──────────────────────────────────────────────── */}
        <div className={`rounded-2xl border ${isDark ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
          {/* Header */}
          <div className={`flex items-center justify-between p-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
            <div className="flex items-center gap-2">
              <h2 className={`font-display font-semibold flex items-center gap-2 ${isDark ? 'text-white' : 'text-slate-900'}`}>
                <Sparkles className={`w-5 h-5 ${accentText}`} />
                Processed Images
              </h2>
              {processedImages.length > 0 && (
                <span className={`text-xs px-2 py-0.5 rounded-full ${isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>
                  {processedImages.length}
                </span>
              )}
            </div>
            {isAdmin && (
              <button
                onClick={() => { setPendingUploadFile(null); setShowUploadModal(true); }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                  isDark
                    ? 'bg-accent-500/10 text-accent-400 hover:bg-accent-500/20 border border-accent-500/20'
                    : 'bg-accent-300 text-accent-700 hover:bg-accent-400 border border-accent-400'
                }`}
              >
                <Upload className="w-3.5 h-3.5" />
                Upload
              </button>
            )}
          </div>

          {processedImages.length === 0 ? (
            /* Empty state */
            <div
              className={`m-4 rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-3 py-10 transition ${isAdmin ? 'cursor-pointer' : ''} ${
                isDragging && isAdmin
                  ? isDark ? 'border-accent-500/60 bg-accent-500/10' : 'border-accent-400 bg-accent-50'
                  : isDark ? 'border-slate-700 hover:border-slate-600' : 'border-slate-200 hover:border-slate-300'
              }`}
              onClick={() => { if (!isAdmin) return; setPendingUploadFile(null); setShowUploadModal(true); }}
              onDragOver={e => { if (!isAdmin) return; e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={e => {
                e.preventDefault();
                setIsDragging(false);
                if (!isAdmin) return;
                const file = e.dataTransfer.files[0];
                if (file) { setPendingUploadFile(file); setShowUploadModal(true); }
              }}
            >
              <div className={`p-3 rounded-full ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                <ImagePlus className={`w-6 h-6 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
              </div>
              <div className="text-center">
                <p className={`text-sm font-medium ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  {isAdmin ? 'Upload your processed images' : 'No processed images yet'}
                </p>
                {isAdmin && (
                  <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                    JPG, PNG, TIFF · up to 300 MB · drag & drop or click
                  </p>
                )}
              </div>
            </div>
          ) : (
            /* Processed images grid */
            <div className="p-4 space-y-4">
              {/* Drop zone hint when grid has content */}
              <div
                className={`grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3`}
                onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={e => {
                  e.preventDefault();
                  setIsDragging(false);
                  const file = e.dataTransfer.files[0];
                  if (file) { setPendingUploadFile(file); setShowUploadModal(true); }
                }}
              >
                {processedImages.map((img, idx) => {
                  const procCompareSlot = compareItems[0]?.key === img.id ? 1 : compareItems[1]?.key === img.id ? 2 : null;
                  const isProcSessionImage = img.path === observation?.sessionImage;
                  return (
                  <div
                    key={img.id}
                    className={`group rounded-xl overflow-hidden border cursor-pointer ${
                      procCompareSlot === 1
                        ? 'border-accent-500 ring-2 ring-accent-500/40'
                        : procCompareSlot === 2
                          ? 'border-violet-500 ring-2 ring-violet-500/40'
                          : isDark ? 'border-slate-800 bg-slate-800' : 'border-slate-200 bg-slate-100'
                    }`}
                    onClick={() => compareMode
                      ? toggleCompareItem(img.id, { name: img.title || img.originalName, downloadUrl: img.url })
                      : openProcessedGallery(idx)
                    }
                  >
                    {/* Image area */}
                    <div className="relative aspect-square">
                      <img
                        src={img.url}
                        alt={img.title || img.originalName}
                        className="w-full h-full object-cover"
                      />

                      {/* Session image crown — top-left, z-10 above overlay */}
                      {!procCompareSlot && (isProcSessionImage ? (
                        <div className="absolute top-1 left-1 z-10 p-1 rounded-md bg-amber-400/90 text-white pointer-events-none">
                          <Crown className="w-3 h-3" />
                        </div>
                      ) : isAdmin && (
                        <button
                          onClick={e => { e.stopPropagation(); handleSetSessionImage(img.path); }}
                          disabled={settingSessionImage}
                          className="absolute top-1 left-1 z-10 p-1 rounded-md bg-black/60 text-white/70 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80 hover:text-amber-400"
                          title="Set as session image"
                        >
                          <Crown className="w-3 h-3" />
                        </button>
                      ))}

                      {/* Hover action overlay — only covers image, not footer */}
                      <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-start justify-end gap-1 p-2">
                        {/* Download */}
                        <a
                          href={img.url}
                          download={img.originalName}
                          onClick={e => e.stopPropagation()}
                          className="p-1.5 rounded-lg bg-white/20 text-white hover:bg-white/30 transition"
                          title="Download"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </a>

                        {/* Set as gallery image */}
                        <button
                          onClick={e => { e.stopPropagation(); handleSetProcessedAsGallery(img); }}
                          disabled={!!settingGalleryId}
                          className="p-1.5 rounded-lg bg-white/20 text-white hover:bg-white/30 transition disabled:opacity-50"
                          title="Set as gallery image"
                        >
                          {settingGalleryId === img.id
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <Star className="w-3.5 h-3.5" />
                          }
                        </button>

                        {/* Delete — admin only */}
                        {isAdmin && (
                          <button
                            onClick={e => { e.stopPropagation(); setConfirmDeleteProcessedId(img.id); }}
                            disabled={!!deletingProcessedId}
                            className="p-1.5 rounded-lg bg-red-500/80 text-white hover:bg-red-500 transition disabled:opacity-50"
                            title="Delete"
                          >
                            {deletingProcessedId === img.id
                              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              : <Trash2 className="w-3.5 h-3.5" />
                            }
                          </button>
                        )}
                      </div>

                      {/* File type badge (bottom-right, always visible) */}
                      {(() => {
                        const ext = img.originalName.split('.').pop()?.toUpperCase();
                        let label: string | null = null;
                        if (ext === 'JPG' || ext === 'JPEG') label = 'JPG';
                        else if (ext === 'PNG') label = 'PNG';
                        else if (ext === 'TIFF' || ext === 'TIF') label = 'TIFF';
                        if (!label) return null;
                        return (
                          <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wide bg-black/60 text-white/80 pointer-events-none">
                            {label}
                          </div>
                        );
                      })()}

                      {/* Compare selection badge */}
                      {procCompareSlot && (
                        <div className={`absolute top-1 left-1 w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-bold shadow-lg pointer-events-none ${
                          procCompareSlot === 1 ? 'bg-accent-500' : 'bg-violet-500'
                        }`}>
                          {procCompareSlot}
                        </div>
                      )}
                    </div>

                    {/* Footer — never darkened by hover */}
                    <div className={`px-2 py-1.5 ${isDark ? 'bg-slate-900/80' : 'bg-white/90'}`}>
                      {img.title ? (
                        <p className={`text-xs font-medium truncate ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{img.title}</p>
                      ) : (
                        <p className={`text-xs truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{img.originalName}</p>
                      )}
                      <p className={`text-[10px] mt-0.5 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                        {new Date(img.uploadedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                      </p>
                    </div>
                  </div>
                  );
                })}

                {/* Add more card */}
                <button
                  onClick={() => { setPendingUploadFile(null); setShowUploadModal(true); }}
                  className={`aspect-square rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-2 transition ${
                    isDark ? 'border-slate-700 hover:border-accent-500/50 hover:bg-accent-500/5 text-slate-600 hover:text-accent-400' : 'border-slate-200 hover:border-accent-400 hover:bg-accent-50 text-slate-400 hover:text-accent-500'
                  }`}
                >
                  <Upload className="w-5 h-5" />
                  <span className="text-[11px] font-medium">Add more</span>
                </button>
              </div>
            </div>
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

function formatTime(timestamp: string): string {
  try {
    // YYYYMMDD-HHMMSS format (e.g. 20260330-201431)
    const m = timestamp.match(/^\d{8}-(\d{2})(\d{2})/);
    if (m) return `${m[1]}:${m[2]}`;
    const d = new Date(timestamp);
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  } catch {
    return timestamp;
  }
}
