import { Upload, ImagePlus, Crown, Download, Star, Trash2, Loader2, FileDown, Layers } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { isRenderableProcessed, processedFormatLabel } from '../../lib/processedFormats';
import type { ProcessedImage } from '../../types';
import type { CompareItem } from './types';

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

  return (
    <div className={`rounded-2xl border ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200 shadow-sm'}`}>
      {/* Header */}
      {/* No title row: the selected tab immediately above already names this
          panel and carries its count, so the bar is only its controls. */}
      <div className={`flex items-center justify-end p-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
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
              // Stored-only formats (XISF, FITS, PSD, RAW) can be downloaded and
              // deleted, and nothing else. Every other action here ends in an
              // <img> somewhere the format cannot render: the lightbox, the
              // compare panes, the object's gallery card, the session image.
              const canRender = isRenderableProcessed(img.originalName);
              return (
              <div
                key={img.id}
                className={`group rounded-xl overflow-hidden border ${canRender ? 'cursor-pointer' : ''} ${
                  procCompareSlot === 1
                    ? 'border-accent-500 ring-2 ring-accent-500/40'
                    : procCompareSlot === 2
                      ? 'border-violet-500 ring-2 ring-violet-500/40'
                      : isDark ? 'border-slate-800 bg-slate-800' : 'border-slate-200 bg-slate-100'
                }`}
                onClick={() => {
                  if (!canRender) return;
                  if (compareMode) {
                    toggleCompareItem(img.id, { name: img.title || img.originalName, downloadUrl: img.url });
                  } else {
                    openProcessedGallery(idx);
                  }
                }}
              >
                {/* Image area */}
                <div className="relative aspect-square">
                  {isRenderableProcessed(img.originalName) ? (
                    <img
                      src={img.url}
                      alt={img.title || img.originalName}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    /* Stored-only format (XISF, FITS, PSD, RAW). Pointing an
                       <img> at one paints a broken-image icon, so show what the
                       file is instead. The download action in the hover overlay
                       is how you get it back out. */
                    <div className={`w-full h-full flex flex-col items-center justify-center gap-2 ${isDark ? 'bg-slate-800/60' : 'bg-slate-100'}`}>
                      <FileDown className={`w-7 h-7 ${isDark ? 'text-slate-600' : 'text-slate-400'}`} />
                      <span className={`font-mono text-xs font-bold tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                        {processedFormatLabel(img.originalName) ?? 'FILE'}
                      </span>
                    </div>
                  )}

                  {/* Session image crown — top-left, z-10 above overlay.
                      Only for renderable formats: the session image is drawn as
                      a thumbnail on the calendar and object pages. */}
                  {canRender && !procCompareSlot && (isProcSessionImage ? (
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

                    {/* Set as gallery image — renderable formats only, since the
                        gallery card is an <img> pointed at this path. */}
                    {canRender && (
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
                    )}

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

                  {/* File type badge (bottom-right, always visible). Suppressed
                      for stored-only formats, whose placeholder above already
                      shows the format prominently. */}
                  {(() => {
                    if (!isRenderableProcessed(img.originalName)) return null;
                    const label = processedFormatLabel(img.originalName);
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
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <p className={`text-[10px] ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                      {new Date(img.uploadedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
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
