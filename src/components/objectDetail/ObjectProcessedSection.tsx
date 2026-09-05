import { useCallback, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Star, Trash2, Loader2, FileDown, Layers, Sparkles, ChevronRight, ChevronDown, ImagePlus, AlertTriangle } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { isRenderableProcessed, isFitsProcessed, processedFormatLabel, PROCESSED_UPLOAD_EXTENSIONS } from '../../lib/processedFormats';
import { getAllProcessedImagesForObject, deleteObjectProcessedImage, setGalleryImage, uploadObjectProcessedImage } from '../../lib/api/library';
import { GalleryModal, type GalleryItem } from '../GalleryModal';
import { FitsThumbnail } from '../FitsThumbnail';
import type { ProcessedImage } from '../../types';

/**
 * Object-level rollup of every processed image an object has: the union of
 * ordinary per-session uploads, Dwarf RESTACKED auto-imports (source:
 * 'dwarf-restack', no session date), and images uploaded straight to the
 * object here (source: 'user', no session date). Sits above the observations
 * list because a finished/combined image is what this hobby is ultimately for,
 * not buried inside whichever single night it happened to be filed under.
 *
 * The section is always shown. When the object has no processed images it
 * renders collapsed so it stays out of the way; expanding it explains the two
 * upload paths and offers a drop zone. An empty object always starts
 * collapsed, so that state is not remembered across visits.
 */
export function ObjectProcessedSection({
  objectId,
  isAdmin,
}: {
  objectId: string;
  isAdmin: boolean;
}) {
  const { isDark } = useTheme();
  const queryClient = useQueryClient();

  const { data: images = [] } = useQuery({
    queryKey: ['processed-images-all', objectId],
    queryFn: () => getAllProcessedImagesForObject(objectId),
    enabled: !!objectId,
  });

  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [settingGalleryId, setSettingGalleryId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Off by default and un-persisted (plain useState, no localStorage) — every
  // fresh visit to the object page starts with FITS restacks hidden, since
  // they're raw material underneath the deliverable JPG/PNG, not something
  // most visits need to see.
  const [showFits, setShowFits] = useState(false);

  const hasImages = images.length > 0;
  // null = follow the default (collapsed when empty, open when there are
  // images); true/false = the user clicked the header. Reset when the object
  // changes so a different object still starts from its own default.
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  // Reset the manual override when the object changes (this component is not
  // remounted on navigation) so a different object starts from its own
  // default. See react.dev "resetting state when a prop changes".
  const [prevObjectId, setPrevObjectId] = useState(objectId);
  if (objectId !== prevObjectId) {
    setPrevObjectId(objectId);
    setManualOpen(null);
  }
  const isOpen = manualOpen ?? hasImages;

  const { imageItems, fitsItems } = useMemo(() => ({
    imageItems: images.filter(img => isRenderableProcessed(img.originalName)),
    fitsItems: images.filter(img => !isRenderableProcessed(img.originalName)),
  }), [images]);

  const visibleItems = showFits ? images : imageItems;

  const openGalleryAt = useCallback((img: ProcessedImage) => {
    // Indexes into the full `images` list (see galleryItems below), not the
    // tab-filtered one, so the lightbox's prev/next can still page through
    // everything rather than getting stuck at the edge of one tab's items.
    const index = images.findIndex(i => i.id === img.id);
    if (index < 0) return;
    setGalleryIndex(index);
    setGalleryOpen(true);
  }, [images]);

  const handleSetAsGallery = useCallback(async (img: ProcessedImage) => {
    if (!objectId || settingGalleryId) return;
    setSettingGalleryId(img.id);
    try {
      await setGalleryImage(objectId, img.path);
      queryClient.invalidateQueries({ queryKey: ['gallery-image', objectId] });
      queryClient.invalidateQueries({ queryKey: ['library-objects'] });
    } catch { /* best-effort */ }
    finally { setSettingGalleryId(null); }
  }, [objectId, settingGalleryId, queryClient]);

  const handleDelete = useCallback(async (id: string) => {
    if (!objectId || deletingId) return;
    setDeletingId(id);
    try {
      await deleteObjectProcessedImage(objectId, id);
      await queryClient.invalidateQueries({ queryKey: ['processed-images-all', objectId] });
      setGalleryOpen(false);
    } catch { /* best-effort */ }
    finally { setDeletingId(null); }
  }, [objectId, deletingId, queryClient]);

  const galleryItems: GalleryItem[] = images.map(img => ({ kind: 'processed', img }));

  return (
    <div className={`rounded-2xl border ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200 shadow-sm'}`}>
      <div className={`flex items-center gap-2 p-4 ${isOpen ? `border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}` : ''}`}>
        <button
          type="button"
          onClick={() => setManualOpen(!isOpen)}
          aria-expanded={isOpen}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
        >
          {isOpen
            ? <ChevronDown className={`w-4 h-4 shrink-0 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
            : <ChevronRight className={`w-4 h-4 shrink-0 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />}
          <Sparkles className={`w-4 h-4 shrink-0 ${isDark ? 'text-accent-400' : 'text-accent-600'}`} />
          <span className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>Processed Images</span>
          <span className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {hasImages ? `${images.length} across every observation` : 'None yet'}
          </span>
        </button>
        {isOpen && fitsItems.length > 0 && (
          <button
            type="button"
            onClick={() => setShowFits(v => !v)}
            aria-pressed={showFits}
            title={showFits ? 'Hide raw .fit files' : 'Show raw .fit files'}
            className={`shrink-0 text-[11px] font-mono font-semibold tracking-wide px-2 py-1 rounded-full border transition-colors ${
              showFits
                ? isDark ? 'bg-accent-500/15 border-accent-500/40 text-accent-400' : 'bg-accent-50 border-accent-300 text-accent-700'
                : isDark ? 'bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-300' : 'bg-slate-100 border-slate-200 text-slate-400 hover:text-slate-600'
            }`}
          >
            FIT ({fitsItems.length})
          </button>
        )}
      </div>

      {isOpen && (
        <>
          {!hasImages && (
            <div className="p-4 space-y-3">
              <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                No processed images yet. Upload one to a specific observing session, or add one to the whole object right here.
              </p>
              {isAdmin
                ? <ObjectProcessedUploader objectId={objectId} isDark={isDark} />
                : (
                  <p className={`text-xs ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                    Sign in as an admin to upload.
                  </p>
                )}
            </div>
          )}

          {hasImages && (
            <div className="p-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {visibleItems.map(img => {
                const canRender = isRenderableProcessed(img.originalName);
                const isFits = !canRender && isFitsProcessed(img.originalName);
                return (
                  <div
                    key={img.id}
                    className={`group rounded-xl overflow-hidden border ${canRender ? 'cursor-pointer' : ''} ${
                      isDark ? 'border-slate-800 bg-slate-800' : 'border-slate-200 bg-slate-100'
                    }`}
                    onClick={() => { if (canRender) openGalleryAt(img); }}
                  >
                    <div className="relative aspect-square">
                      {canRender ? (
                        <img src={img.url} alt={img.title || img.originalName} className="w-full h-full object-cover" />
                      ) : isFits ? (
                        <FitsThumbnail url={img.url} thumbUrl={img.thumbUrl ?? undefined} stretch={1.0} isDark={isDark} />
                      ) : (
                        <div className={`w-full h-full flex flex-col items-center justify-center gap-2 ${isDark ? 'bg-slate-800/60' : 'bg-slate-100'}`}>
                          <FileDown className={`w-6 h-6 ${isDark ? 'text-slate-600' : 'text-slate-400'}`} />
                          <span className={`font-mono text-[10px] font-bold tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                            {processedFormatLabel(img.originalName) ?? 'FILE'}
                          </span>
                        </div>
                      )}

                      <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-start justify-end gap-1 p-2">
                        <a
                          href={img.url}
                          download={img.originalName}
                          onClick={e => e.stopPropagation()}
                          className="p-1.5 rounded-lg bg-white/20 text-white hover:bg-white/30 transition"
                          title="Download"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </a>
                        {canRender && isAdmin && (
                          <button
                            onClick={e => { e.stopPropagation(); handleSetAsGallery(img); }}
                            disabled={!!settingGalleryId}
                            className="p-1.5 rounded-lg bg-white/20 text-white hover:bg-white/30 transition disabled:opacity-50"
                            title="Set as gallery image"
                          >
                            {settingGalleryId === img.id
                              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              : <Star className="w-3.5 h-3.5" />}
                          </button>
                        )}
                        {isAdmin && (
                          <button
                            onClick={e => { e.stopPropagation(); handleDelete(img.id); }}
                            disabled={!!deletingId}
                            className="p-1.5 rounded-lg bg-red-500/80 text-white hover:bg-red-500 transition disabled:opacity-50"
                            title="Delete"
                          >
                            {deletingId === img.id
                              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              : <Trash2 className="w-3.5 h-3.5" />}
                          </button>
                        )}
                      </div>

                      {(canRender || isFits) && processedFormatLabel(img.originalName) && (
                        <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wide bg-black/60 text-white/80 pointer-events-none">
                          {processedFormatLabel(img.originalName)}
                        </div>
                      )}
                    </div>

                    <div className={`px-2 py-1.5 ${isDark ? 'bg-slate-900/80' : 'bg-white/90'}`}>
                      {img.source === 'dwarf-restack' ? (
                        <p className={`text-xs font-medium truncate ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                          DWARF Restack
                        </p>
                      ) : img.title ? (
                        <p className={`text-xs font-medium truncate ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{img.title}</p>
                      ) : (
                        <p className={`text-xs truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{img.originalName}</p>
                      )}
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <p className={`text-[10px] ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                          {img.date
                            ? new Date(img.date + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
                            : 'No specific session'}
                        </p>
                        {img.runDates && img.runDates.length > 1 && (
                          <span
                            title={`Combines ${img.runDates.length} nights: ${img.runDates.join(', ')}`}
                            className={`inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-medium ${
                              isDark ? 'bg-accent-500/10 text-accent-400' : 'bg-accent-50 text-accent-600'
                            }`}
                          >
                            <Layers className="w-2.5 h-2.5" />
                            {img.runDates.length}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {hasImages && isAdmin && (
            <div className={`px-4 pb-4 pt-0`}>
              <ObjectProcessedUploader objectId={objectId} isDark={isDark} compact />
            </div>
          )}
        </>
      )}

      <GalleryModal
        isOpen={galleryOpen}
        items={galleryItems}
        defaultIndex={galleryIndex}
        objectId={objectId}
        // Every item here is kind:'processed' (see galleryItems above); GalleryModal
        // only reads `date` for kind:'file' cache invalidation, so this placeholder
        // is never actually consulted.
        date=""
        isAdmin={isAdmin}
        onClose={() => setGalleryOpen(false)}
        onEditImage={() => {}}
        onHeaderFileClick={() => {}}
        onSetAsGallery={handleSetAsGallery}
        onDeleteProcessed={handleDelete}
        settingGalleryId={settingGalleryId}
        deletingProcessedId={deletingId}
        hideEditButton
      />
    </div>
  );
}

/**
 * Drop zone + file picker for an object-level processed-image upload (no
 * session date). Uploads immediately on selection — no title/notes step,
 * since object-level uploads carry no metadata. `compact` shrinks it to a
 * single-line strip for the "already has images" case.
 */
function ObjectProcessedUploader({
  objectId,
  isDark,
  compact = false,
}: {
  objectId: string;
  isDark: boolean;
  compact?: boolean;
}) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState('');

  const accepted = useMemo(() => new Set(PROCESSED_UPLOAD_EXTENSIONS.map(e => e.toLowerCase())), []);

  const handleFile = useCallback(async (file: File) => {
    if (isUploading) return;
    const ext = `.${file.name.split('.').pop()?.toLowerCase() ?? ''}`;
    if (!accepted.has(ext)) {
      setError(`${ext || 'That file'} is not a supported image format.`);
      return;
    }
    setError('');
    setIsUploading(true);
    try {
      await uploadObjectProcessedImage(objectId, file);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['processed-images-all', objectId] }),
        queryClient.invalidateQueries({ queryKey: ['all-processed-images', objectId] }),
        queryClient.invalidateQueries({ queryKey: ['all-library-images'] }),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setIsUploading(false);
    }
  }, [accepted, isUploading, objectId, queryClient]);

  return (
    <div className="space-y-2">
      <div
        className={`rounded-xl border-2 border-dashed transition cursor-pointer ${
          isDragging
            ? isDark ? 'border-accent-500/60 bg-accent-500/10' : 'border-accent-400 bg-accent-50'
            : isDark ? 'border-slate-700 hover:border-slate-600' : 'border-slate-200 hover:border-slate-300'
        } ${compact ? 'py-3 px-4' : 'py-8 px-4'}`}
        onClick={() => { if (!isUploading) fileInputRef.current?.click(); }}
        onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={e => {
          e.preventDefault();
          setIsDragging(false);
          const f = e.dataTransfer.files[0];
          if (f) void handleFile(f);
        }}
      >
        <div className={`flex items-center justify-center gap-2 ${compact ? '' : 'flex-col'}`}>
          {isUploading ? (
            <Loader2 className={`w-5 h-5 animate-spin ${isDark ? 'text-slate-400' : 'text-slate-500'}`} />
          ) : (
            <ImagePlus className={`${compact ? 'w-4 h-4' : 'w-6 h-6'} ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
          )}
          <p className={`text-sm font-medium ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
            {isUploading ? 'Uploading…' : compact ? 'Add another image' : 'Drop your image here or click to browse'}
          </p>
          {!compact && !isUploading && (
            <p className={`text-xs ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
              JPG, PNG, TIFF, FITS, XISF, PSD, RAW. Up to 2 GB.
            </p>
          )}
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept={PROCESSED_UPLOAD_EXTENSIONS.join(',')}
        className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = ''; }}
      />
      {error && (
        <div className="flex items-center gap-2 text-sm text-red-500">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}
    </div>
  );
}
