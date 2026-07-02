import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Image, Check, RotateCw, ImagePlus, RefreshCw } from 'lucide-react';
import {
  getStackedImages,
  getAllProcessedImagesForObject,
  setGalleryImage,
  uploadGalleryImage,
  getLibraryFileUrl,
} from '../lib/api/library';
import { getCatalogSources, prefetchCatalogObject, type CatalogSource } from '../lib/api/catalog';
import {
  getCatalogThumbnailUrl,
  getCatalogSourceThumbnailUrl,
  makeSourceSentinel,
  parseSourceSentinel,
} from '../lib/catalogImage';
import { Modal } from './ui/Modal';

interface GalleryImageModalProps {
  objectId: string;
  catalogId: string;
  currentGalleryImage: string | null;
  onClose: () => void;
  isDark: boolean;
}

export function GalleryImageModal({
  objectId,
  catalogId,
  currentGalleryImage,
  onClose,
  isDark,
}: GalleryImageModalProps) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // undefined = no change pending; null = sky survey selected; string = image path selected
  const [pendingSelection, setPendingSelection] = useState<string | null | undefined>(undefined);

  const { data: stackedImages, isLoading } = useQuery({
    queryKey: ['stacked-images', objectId],
    queryFn: () => getStackedImages(objectId),
  });

  const { data: processedImages = [] } = useQuery({
    queryKey: ['all-processed-images', objectId],
    queryFn: () => getAllProcessedImagesForObject(objectId),
  });

  // What catalog masters are currently cached on disk for this object — drives
  // the "pin to a specific source" tiles below the Auto tile in the Sky Survey
  // section. Empty list → only the Auto tile is shown.
  const { data: sourcesData } = useQuery({
    queryKey: ['catalog-sources', catalogId],
    queryFn: () => getCatalogSources(catalogId),
    staleTime: 30_000,
  });
  const cachedSources = sourcesData?.sources ?? [];

  // Force-refetch this object's DSS2 master — recovers from a missed prefetch
  // (alasky timeout, transient 5xx) without re-running the whole catalog job.
  const refetchMutation = useMutation({
    mutationFn: () => prefetchCatalogObject(catalogId),
    onSuccess: () => {
      // Invalidate the sources query so the tiles re-render with fresh data;
      // also invalidate the gallery-image query so any in-flight image
      // requests get the new file. The library-objects query is invalidated
      // so the tile cache-bust kicks in too.
      queryClient.invalidateQueries({ queryKey: ['catalog-sources', catalogId] });
      queryClient.invalidateQueries({ queryKey: ['gallery-image', objectId] });
      queryClient.invalidateQueries({ queryKey: ['library-objects'] });
    },
  });

  const selectMutation = useMutation({
    mutationFn: (imagePath: string | null) => setGalleryImage(objectId, imagePath),
    onSuccess: (data) => {
      queryClient.setQueryData(['gallery-image', objectId], data);
      queryClient.invalidateQueries({ queryKey: ['library-objects'] });
      onClose();
    },
  });

  const handleSave = () => {
    if (pendingSelection !== undefined) {
      selectMutation.mutate(pendingSelection);
    }
  };

  const handleUpload = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    try {
      const data = await uploadGalleryImage(objectId, file);
      queryClient.setQueryData(['gallery-image', objectId], data);
      queryClient.invalidateQueries({ queryKey: ['library-objects'] });
      queryClient.invalidateQueries({ queryKey: ['stacked-images', objectId] });
      onClose();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed. Check the file and try again.');
    } finally {
      setUploading(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => setUploadPreview(reader.result as string);
    reader.readAsDataURL(file);

    handleUpload(file);
  };

  const skyImageUrl = getCatalogThumbnailUrl(catalogId);
  const [skyImageFailed, setSkyImageFailed] = useState(false);

  // Which image is currently highlighted — pending selection overrides the saved state
  const effectiveSelection = pendingSelection !== undefined ? pendingSelection : currentGalleryImage;
  const effectivePinnedSource = parseSourceSentinel(effectiveSelection);
  // "Auto" tile is selected when galleryImage is null/empty AND no source is pinned.
  const isSkyAutoSelected = !effectiveSelection && !effectivePinnedSource;
  const hasPendingChange = pendingSelection !== undefined;
  // Uploaded files are stored at `<folder>/gallery_<…>.{jpg,jpeg,png}` and are
  // explicitly excluded from `getStackedImages()`. Surface them here as a
  // "Custom Upload" tile so the user can see (and reselect) what's pinned.
  const uploadedPath = typeof effectiveSelection === 'string' && /\/gallery_/i.test(effectiveSelection)
    ? effectiveSelection
    : null;
  // Also surface the *currently saved* upload separately, so when the user
  // is previewing a pending change, they can still see what was previously set.
  const savedUploadedPath = typeof currentGalleryImage === 'string' && /\/gallery_/i.test(currentGalleryImage)
    ? currentGalleryImage
    : null;
  const customUploadPath = uploadedPath ?? savedUploadedPath;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Choose Gallery Image"
      className={`w-full max-w-2xl max-h-[85vh] flex flex-col rounded-2xl overflow-hidden ${
        isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white shadow-xl'
      }`}
    >
        {/* Header */}
        <div className={`flex items-center justify-between px-6 py-4 border-b ${
          isDark ? 'border-slate-800' : 'border-slate-200'
        }`}>
          <h3 className={`font-display font-semibold text-lg ${isDark ? 'text-white' : 'text-slate-900'}`}>
            Choose Gallery Image
          </h3>
          <button
            onClick={onClose}
            className={`p-1.5 rounded-lg transition ${
              isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'
            }`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Sky survey image — Auto tile + one tile per cached master */}
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h4 className={`text-sm font-medium ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                Reference Image
              </h4>
              <div className="flex items-center gap-2.5">
                {cachedSources.length > 0 && (
                  <span className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    {cachedSources.length} cached
                  </span>
                )}
                <button
                  onClick={() => refetchMutation.mutate()}
                  disabled={refetchMutation.isPending}
                  title="Re-fetch sky survey image from CDS DSS2 (recovers from a missed prefetch)"
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition disabled:opacity-50 ${
                    isDark
                      ? 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                      : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  <RefreshCw className={`w-3 h-3 ${refetchMutation.isPending ? 'animate-spin' : ''}`} />
                  {refetchMutation.isPending ? 'Fetching…' : 'Re-fetch'}
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              {/* Auto — server picks best by priority (Hubble → Wikipedia → DSS2) */}
              <SkySourceTile
                src={skyImageUrl}
                label="Auto"
                sublabel="Best available"
                isSelected={isSkyAutoSelected}
                isDark={isDark}
                disabled={selectMutation.isPending}
                onClick={() => setPendingSelection(null)}
                onLoadError={() => setSkyImageFailed(true)}
                showFailedFallback={skyImageFailed}
              />
              {/* One tile per master that's actually on disk for this object */}
              {cachedSources.map(s => (
                <SkySourceTile
                  key={s.source}
                  src={getCatalogSourceThumbnailUrl(catalogId, s.source)}
                  label={s.label}
                  sublabel={formatSourceSize(s)}
                  isSelected={effectivePinnedSource === s.source}
                  isDark={isDark}
                  disabled={selectMutation.isPending}
                  onClick={() => setPendingSelection(makeSourceSentinel(s.source))}
                />
              ))}
            </div>
          </div>

          {/* Upload option */}
          <div className="space-y-3">
            <h4 className={`text-sm font-medium ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              Upload Custom Image
            </h4>
            <div className="flex items-start gap-3 flex-wrap">
              {/* Show the active or saved upload as a selectable tile so the
                  user always sees what's pinned. Excluded from "Your
                  Observations" by design (server filters `gallery_*.jpg`). */}
              {customUploadPath && (
                <SkySourceTile
                  src={getLibraryFileUrl(customUploadPath)}
                  label="Custom Upload"
                  sublabel="Your image"
                  isSelected={effectiveSelection === customUploadPath}
                  isDark={isDark}
                  disabled={selectMutation.isPending || uploading}
                  onClick={() => setPendingSelection(customUploadPath)}
                />
              )}
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className={`flex-1 min-w-[200px] flex items-center gap-3 px-4 py-3 rounded-xl border-2 border-dashed transition ${
                  isDark
                    ? 'border-slate-700 hover:border-accent-500/50 hover:bg-slate-800/50 text-slate-400'
                    : 'border-slate-300 hover:border-accent-400 hover:bg-slate-50 text-slate-500'
                }`}
              >
                {uploading ? (
                  <>
                    <RotateCw className="w-5 h-5 animate-spin text-accent-500" />
                    <span className="text-sm">Uploading...</span>
                  </>
                ) : uploadPreview ? (
                  <>
                    <img src={uploadPreview} alt="Preview" className="w-10 h-10 rounded-lg object-cover" />
                    <span className="text-sm">Processing...</span>
                  </>
                ) : (
                  <>
                    <ImagePlus className="w-5 h-5" />
                    <span className="text-sm">
                      {customUploadPath ? 'Replace with another file' : 'Choose a file from your computer'}
                    </span>
                  </>
                )}
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".jpg,.jpeg,.png"
              onChange={handleFileChange}
              className="hidden"
            />
            {uploadError && (
              <p className="text-sm text-rose-500 mt-1">{uploadError}</p>
            )}
          </div>

          {/* Existing stacked + processed images from sessions */}
          {isLoading ? (
            <div className="flex items-center gap-2 py-4">
              <RotateCw className="w-4 h-4 animate-spin text-accent-500/40" />
              <span className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                Loading images...
              </span>
            </div>
          ) : (stackedImages && stackedImages.length > 0) || processedImages.length > 0 ? (
            <div className="space-y-3">
              <h4 className={`text-sm font-medium ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                Choose from Your Observations
              </h4>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                {stackedImages?.map(img => (
                  <ImageOption
                    key={img.path}
                    src={getLibraryFileUrl(img.path)}
                    label={img.date !== 'unknown'
                      ? new Date(img.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
                      : img.name
                    }
                    isSelected={effectiveSelection === img.path}
                    isDark={isDark}
                    disabled={selectMutation.isPending}
                    onClick={() => setPendingSelection(img.path)}
                  />
                ))}
                {processedImages.map(img => (
                  <ImageOption
                    key={img.id}
                    src={img.url}
                    label={img.title || img.originalName}
                    isSelected={effectiveSelection === img.path}
                    isDark={isDark}
                    disabled={selectMutation.isPending}
                    onClick={() => setPendingSelection(img.path)}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className={`text-center py-6 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
              <Image className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm">No observation images available yet</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={`flex items-center justify-end gap-3 px-6 py-4 border-t ${
          isDark ? 'border-slate-800' : 'border-slate-200'
        }`}>
          <button
            onClick={onClose}
            disabled={selectMutation.isPending}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition ${
              isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'
            }`}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!hasPendingChange || selectMutation.isPending}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {selectMutation.isPending && <RotateCw className="w-4 h-4 animate-spin" />}
            Save
          </button>
        </div>
    </Modal>
  );
}

function ImageOption({
  src,
  label,
  isSelected,
  isDark,
  disabled,
  onClick,
}: {
  src: string;
  label: string;
  isSelected: boolean;
  isDark: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`relative rounded-xl overflow-hidden border-2 transition aspect-square ${
        isSelected
          ? isDark
            ? 'border-accent-500 ring-2 ring-accent-500/20'
            : 'border-accent-500 ring-2 ring-accent-200'
          : isDark
            ? 'border-slate-700 hover:border-slate-600'
            : 'border-slate-200 hover:border-slate-300'
      }`}
    >
      {!error ? (
        <>
          {!loaded && (
            <div className={`absolute inset-0 flex items-center justify-center ${
              isDark ? 'bg-slate-800' : 'bg-slate-100'
            }`}>
              <RotateCw className="w-4 h-4 animate-spin text-accent-500/30" />
            </div>
          )}
          <img
            src={src}
            alt={label}
            loading="lazy"
            onLoad={() => setLoaded(true)}
            onError={() => setError(true)}
            className={`w-full h-full object-cover transition-opacity ${loaded ? 'opacity-100' : 'opacity-0'}`}
          />
        </>
      ) : (
        <div className={`absolute inset-0 flex items-center justify-center ${
          isDark ? 'bg-slate-800' : 'bg-slate-100'
        }`}>
          <Image className={`w-5 h-5 ${isDark ? 'text-slate-600' : 'text-slate-300'}`} />
        </div>
      )}

      {/* Date label */}
      <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent px-2 py-1.5">
        <span className="text-[10px] text-white/90 font-medium">{label}</span>
      </div>

      {isSelected && (
        <div className="absolute top-1.5 right-1.5 p-0.5 rounded-full bg-accent-500 text-white">
          <Check className="w-3 h-3" />
        </div>
      )}
    </button>
  );
}

/** Format a CatalogSource as "1280×1280 · 245 KB" for the tile sublabel. */
function formatSourceSize(s: CatalogSource): string {
  const dims = s.width && s.height ? `${s.width}×${s.height}` : '';
  const kb = s.sizeBytes / 1024;
  const sizeLabel = kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`;
  return dims ? `${dims} · ${sizeLabel}` : sizeLabel;
}

/**
 * Sky survey source tile — used by the Auto pick + each cached master variant.
 * Larger than `ImageOption` (128px tall) so the sublabel (dims + size) is
 * legible. Same selection / hover / failed-load behavior throughout.
 */
function SkySourceTile({
  src,
  label,
  sublabel,
  isSelected,
  isDark,
  disabled,
  onClick,
  onLoadError,
  showFailedFallback,
}: {
  src: string;
  label: string;
  sublabel: string;
  isSelected: boolean;
  isDark: boolean;
  disabled: boolean;
  onClick: () => void;
  /** Optional handler — only used by the Auto tile to surface the
   *  "Not cached, run catalog download" hint. */
  onLoadError?: () => void;
  showFailedFallback?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`relative w-32 h-32 rounded-xl overflow-hidden border-2 transition group ${
        isSelected
          ? isDark
            ? 'border-accent-500 ring-2 ring-accent-500/20'
            : 'border-accent-500 ring-2 ring-accent-200'
          : isDark
            ? 'border-slate-700 hover:border-slate-600'
            : 'border-slate-200 hover:border-slate-300'
      }`}
    >
      {showFailedFallback ? (
        <div className={`w-full h-full flex items-center justify-center text-[10px] text-center px-2 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
          Not cached -<br />run catalog download
        </div>
      ) : (
        <img
          src={src}
          alt={label}
          loading="lazy"
          onError={() => onLoadError?.()}
          className="w-full h-full object-cover"
        />
      )}
      <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent px-2 py-1.5">
        <div className="text-[11px] text-white font-semibold leading-tight">{label}</div>
        {sublabel && <div className="text-[9px] text-white/70 leading-tight mt-0.5">{sublabel}</div>}
      </div>
      {isSelected && (
        <div className="absolute top-1.5 right-1.5 p-0.5 rounded-full bg-accent-500 text-white">
          <Check className="w-3 h-3" />
        </div>
      )}
    </button>
  );
}
