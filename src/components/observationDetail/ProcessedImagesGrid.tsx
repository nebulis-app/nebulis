import { Sparkles, Upload, ImagePlus, Crown, Download, Star, Trash2, Loader2 } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import type { ProcessedImage } from '../../types';
import type { CompareItem } from '../../pages/ObservationDetail';

/** The "Processed Images" panel: uploaded/edited images with an upload drop
 *  zone, compare-mode selection, session-image designation, set-as-gallery,
 *  and delete. */
export function ProcessedImagesGrid({
  processedImages,
  compareMode,
  compareItems,
  toggleCompareItem,
  openProcessedGallery,
  sessionImagePath,
  isAdmin,
  handleSetSessionImage,
  settingSessionImage,
  handleSetProcessedAsGallery,
  settingGalleryId,
  deletingProcessedId,
  onRequestDelete,
  isDragging,
  setIsDragging,
  onUploadClick,
  onDropFile,
}: {
  processedImages: ProcessedImage[];
  compareMode: boolean;
  compareItems: [CompareItem | null, CompareItem | null];
  toggleCompareItem: (key: string, file: { name: string; downloadUrl: string }) => void;
  openProcessedGallery: (index: number) => void;
  sessionImagePath: string | null | undefined;
  isAdmin: boolean;
  handleSetSessionImage: (path: string | null) => void;
  settingSessionImage: boolean;
  handleSetProcessedAsGallery: (img: ProcessedImage) => void;
  settingGalleryId: string | null;
  deletingProcessedId: string | null;
  onRequestDelete: (id: string) => void;
  isDragging: boolean;
  setIsDragging: (dragging: boolean) => void;
  onUploadClick: () => void;
  onDropFile: (file: File) => void;
}) {
  const { isDark } = useTheme();
  const accentTextGlow = isDark ? 'text-accent-400' : 'text-accent-500';

  return (
    <div className={`rounded-2xl border ${isDark ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
      {/* Header */}
      <div className={`flex items-center justify-between p-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <div className="flex items-center gap-2">
          <h2 className={`font-display font-semibold flex items-center gap-2 ${isDark ? 'text-white' : 'text-slate-900'}`}>
            <Sparkles className={`w-5 h-5 ${accentTextGlow}`} />
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
            onClick={onUploadClick}
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
          onClick={() => { if (!isAdmin) return; onUploadClick(); }}
          onDragOver={e => { if (!isAdmin) return; e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={e => {
            e.preventDefault();
            setIsDragging(false);
            if (!isAdmin) return;
            const file = e.dataTransfer.files[0];
            if (file) onDropFile(file);
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
              if (file) onDropFile(file);
            }}
          >
            {processedImages.map((img, idx) => {
              const procCompareSlot = compareItems[0]?.key === img.id ? 1 : compareItems[1]?.key === img.id ? 2 : null;
              const isProcSessionImage = img.path === sessionImagePath;
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
                        onClick={e => { e.stopPropagation(); onRequestDelete(img.id); }}
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
              onClick={onUploadClick}
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
  );
}
