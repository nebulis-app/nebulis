import { useTranslation } from 'react-i18next';
import { Columns, Crown, Download, Heart, ChevronLeft, ChevronRight, FileImage, FolderInput } from 'lucide-react';
import { FitsThumbnail } from '../FitsThumbnail';
import { useTheme } from '../../hooks/useTheme';
import type { SessionFile } from '../../types';
import type { CompareItem } from './types';
import type { CompareFile } from '../ImageCompareModal';
import { thumbSrcFor, canPreviewImage } from '../../lib/sessionImageSrc';
import { processedFormatLabel as formatLabel } from '../../lib/processedFormats';
import { formatBytes } from '../../lib/utils';
import { SESSION_FILE_DRAG_TYPE } from './ObservationTabs';

const GALLERY_PAGE_SIZE = 24;

/** The "Images" panel: telescope-captured files (stacked + individual, not
 *  subframes), with view-mode filtering, pagination, compare-mode selection,
 *  session-image designation, and per-image favoriting. */
export function SessionFileGrid({
  files,
  viewMode,
  onViewModeChange,
  galleryPage,
  setGalleryPage,
  compareMode,
  onToggleCompareMode,
  compareItems,
  toggleCompareItem,
  sessionImagePath,
  stackedImagePath,
  handleSetSessionImage,
  settingSessionImage,
  imageFavoriteSet,
  onToggleFavorite,
  openGallery,
  isAdmin,
  onMarkProcessed,
  draggingPath,
  onDragPathChange,
}: {
  files: SessionFile[];
  viewMode: 'all' | 'fits' | 'image';
  onViewModeChange: (mode: 'all' | 'fits' | 'image') => void;
  galleryPage: number;
  setGalleryPage: React.Dispatch<React.SetStateAction<number>>;
  compareMode: boolean;
  onToggleCompareMode: () => void;
  compareItems: [CompareItem | null, CompareItem | null];
  toggleCompareItem: (key: string, file: CompareFile) => void;
  sessionImagePath: string | null | undefined;
  stackedImagePath: string | undefined;
  handleSetSessionImage: (path: string | null) => void;
  settingSessionImage: boolean;
  imageFavoriteSet: Set<string>;
  onToggleFavorite: (imagePath: string, isFavorite: boolean) => void;
  openGallery: (index: number) => void;
  isAdmin: boolean;
  /** Admin action: mark this image as processed (moves it to the Processed tab). */
  onMarkProcessed: (path: string) => void;
  /** Path of the tile currently being dragged, so it can dim while in flight. */
  draggingPath: string | null;
  onDragPathChange: (path: string | null) => void;
}) {
  const { isDark } = useTheme();
  const { t } = useTranslation('observations');
  const viewModeLabels: Record<'all' | 'image' | 'fits', string> = {
    all: t('observationDetail.sessionFileGrid.viewModeAll'),
    image: t('observationDetail.sessionFileGrid.viewModeImage'),
    fits: t('observationDetail.sessionFileGrid.viewModeFits'),
  };

  return (
    <div className={`rounded-2xl border ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200 shadow-sm'}`}>
      {/* No title row: the selected tab immediately above already names this
          panel and carries its count, so the bar is only its controls. */}
      <div className={`flex items-center justify-end p-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <div className="flex items-center gap-2">
          <button
            onClick={onToggleCompareMode}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition ${
              compareMode
                ? isDark ? 'bg-accent-500/10 text-accent-400 border border-accent-500/30' : 'bg-accent-300 text-accent-700 border border-accent-400'
                : isDark ? 'text-slate-500 hover:text-accent-400 hover:bg-accent-500/10 border border-transparent' : 'text-slate-400 hover:text-accent-500 hover:bg-accent-50 border border-transparent'
            }`}
            title={compareMode ? t('observationDetail.sessionFileGrid.exitCompareTitle') : t('observationDetail.sessionFileGrid.compareTitle')}
          >
            <Columns className="w-3.5 h-3.5" />
            {compareMode ? t('observationDetail.sessionFileGrid.exitCompare') : t('observationDetail.sessionFileGrid.compare')}
          </button>
          <div className={`flex rounded-xl overflow-hidden border ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
            {(['all', 'image', 'fits'] as const).map(mode => (
              <button
                key={mode}
                onClick={() => onViewModeChange(mode)}
                className={`px-3 py-1.5 text-xs font-medium transition ${
                  viewMode === mode
                    ? isDark ? 'bg-accent-500/15 text-accent-400' : 'bg-accent-300 text-accent-700'
                    : isDark ? 'bg-slate-900 text-slate-400 hover:bg-slate-800' : 'bg-white text-slate-500 hover:bg-slate-50'
                }`}
              >
                {viewModeLabels[mode]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {files.length > 0 ? (
        <>
          {/* auto-fill, not auto-fit: a night with two files keeps two tile-sized
              columns instead of stretching each across half the page. */}
          <div
            className="grid gap-3 p-4"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 200px), 1fr))' }}
          >
            {files.slice(galleryPage * GALLERY_PAGE_SIZE, (galleryPage + 1) * GALLERY_PAGE_SIZE).map((file, localIdx) => {
              const globalIdx = galleryPage * GALLERY_PAGE_SIZE + localIdx;
              const isSessionImage = sessionImagePath
                ? file.path === sessionImagePath
                : file.path === stackedImagePath && !sessionImagePath;
              const isImageFile = file.type === 'image' && !file.isThumbnail;
              const compareSlot = compareItems[0]?.key === file.path ? 1 : compareItems[1]?.key === file.path ? 2 : null;
              const isFitsInCompareMode = compareMode && file.type === 'fits';
              return (
                <div
                  key={file.path}
                  // An admin can drag a finished image onto the Processed tab to
                  // mark it processed (see ObservationTabs). Not in compare mode,
                  // where a click selects instead.
                  draggable={isAdmin && isImageFile && !compareMode}
                  onDragStart={e => {
                    e.dataTransfer.setData(SESSION_FILE_DRAG_TYPE, file.path);
                    e.dataTransfer.effectAllowed = 'move';
                    onDragPathChange(file.path);
                  }}
                  onDragEnd={() => onDragPathChange(null)}
                  className={`group rounded-xl overflow-hidden border cursor-pointer transition-opacity ${draggingPath === file.path ? 'opacity-40' : ''} ${
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
                      onClick={() => (compareMode && !isFitsInCompareMode) ? toggleCompareItem(file.path, { name: file.name, downloadUrl: file.downloadUrl, thumbUrl: file.thumbUrl, previewUrl: file.previewUrl, exposure: file.exposure, frameCount: file.frameCount, filter: file.filter }) : openGallery(globalIdx)}
                      className="w-full h-full block cursor-pointer [&_canvas]:object-cover"
                    >
                      {file.type === 'fits' ? (
                        <FitsThumbnail url={file.downloadUrl} thumbUrl={file.thumbUrl} stretch={1.0} isDark={isDark} />
                      ) : !canPreviewImage(file) ? (
                        // Defensive fallback for a format the server has flagged as
                        // untrustworthy to render (or an older response with no
                        // thumbUrl at all) — say what the file is instead of
                        // showing a blank or broken image.
                        <div className={`w-full h-full flex flex-col items-center justify-center gap-1.5 ${
                          isDark ? 'bg-slate-800/60 text-slate-400' : 'bg-slate-100 text-slate-500'
                        }`}>
                          <FileImage className="w-6 h-6" />
                          <span className="text-[0.625rem] font-medium tracking-wide">
                            {formatLabel(file.name)}
                          </span>
                          <span className="text-[0.625rem] opacity-70">{t('observationDetail.sessionFileGrid.noPreview')}</span>
                        </div>
                      ) : (
                        <img
                          src={thumbSrcFor(file)}
                          alt={file.name}
                          draggable={false}
                          className="w-full h-full object-cover"
                          onError={e => { if (e.target instanceof HTMLImageElement) e.target.style.display = 'none'; }}
                        />
                      )}
                    </button>

                    {/* Session image crown badge */}
                    {isSessionImage && isImageFile && (
                      <div className="absolute top-1 left-1 p-1.5 rounded-lg bg-amber-400/90 text-white pointer-events-none">
                        <Crown className="w-3.5 h-3.5" />
                      </div>
                    )}

                    {/* Set as session image button (visible on hover) */}
                    {isImageFile && !isSessionImage && isAdmin && (
                      <button
                        onClick={e => { e.stopPropagation(); handleSetSessionImage(file.path); }}
                        disabled={settingSessionImage}
                        className="absolute top-1 left-1 p-1.5 rounded-lg bg-black/50 text-white/70 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/70 hover:text-amber-400"
                        title={t('observationDetail.sessionFileGrid.setAsSessionImage')}
                      >
                        <Crown className="w-3.5 h-3.5" />
                      </button>
                    )}

                    {/* Mark as processed (admin, images only, on hover). Beside the crown
                        so it reads as another per-image action; the drag onto the
                        Processed tab is the shortcut for the same thing. */}
                    {isImageFile && isAdmin && !compareMode && (
                      <button
                        onClick={e => { e.stopPropagation(); onMarkProcessed(file.path); }}
                        className="absolute top-1 left-9 p-1.5 rounded-lg bg-black/50 text-white/70 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity hover:bg-black/70 hover:text-accent-400"
                        title={t('observationDetail.sessionFileGrid.markAsProcessed')}
                        aria-label={t('observationDetail.sessionFileGrid.markAsProcessed')}
                      >
                        <FolderInput className="w-3.5 h-3.5" />
                      </button>
                    )}

                    {/* Download button (images only, top-right on hover) */}
                    {file.type === 'image' && (
                      <a
                        href={file.downloadUrl}
                        download={file.name}
                        onClick={e => e.stopPropagation()}
                        className="absolute top-1 right-1 p-1.5 rounded-lg bg-white/20 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-white/30"
                        title={t('observationDetail.sessionFileGrid.download')}
                      >
                        <Download className="w-3.5 h-3.5" />
                      </a>
                    )}

                    {/* Favorite button (images only, bottom-left) */}
                    {file.type === 'image' && !file.isThumbnail && (
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          onToggleFavorite(file.path, !imageFavoriteSet.has(file.path));
                        }}
                        title={imageFavoriteSet.has(file.path) ? t('observationDetail.sessionFileGrid.removeFromFavorites') : t('observationDetail.sessionFileGrid.addToFavorites')}
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
                        <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded text-[0.5625rem] font-bold tracking-wide bg-black/60 text-white/80 pointer-events-none">
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

                  {/* Footer — name + size (every tile shares the page's date), never darkened by hover */}
                  <div className={`px-2 py-1.5 ${isDark ? 'bg-slate-900/80' : 'bg-white/90'}`}>
                    <p className={`flex items-center justify-between gap-2 text-[0.6875rem] ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                      <span className="truncate font-medium" title={file.name}>
                        {/* A stack's filename is mostly the same for every
                            file of the night; say what the file is instead. */}
                        {file.fileType === 'stacked' && file.frameCount
                          ? `${t('observationDetail.page.stacked')} · ${file.frameCount}${file.exposure ? ` × ${file.exposure}` : ''}`
                          : file.name}
                      </span>
                      {file.size > 0 && (
                        <span className={`shrink-0 tabular-nums text-[0.625rem] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{formatBytes(file.size)}</span>
                      )}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          {files.length > GALLERY_PAGE_SIZE && (
            <div className={`flex items-center justify-between px-4 pb-4 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              <span className="text-xs">
                {t('observationDetail.sessionFileGrid.showingRange', {
                  from: galleryPage * GALLERY_PAGE_SIZE + 1,
                  to: Math.min((galleryPage + 1) * GALLERY_PAGE_SIZE, files.length),
                  total: files.length,
                })}
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setGalleryPage(p => Math.max(0, p - 1))}
                  disabled={galleryPage === 0}
                  className={`min-w-[44px] min-h-[44px] p-1.5 rounded-lg transition disabled:opacity-30 ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                {Array.from({ length: Math.ceil(files.length / GALLERY_PAGE_SIZE) }, (_, i) => (
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
                  Math.min(Math.ceil(files.length / GALLERY_PAGE_SIZE), galleryPage + 3)
                )}
                <button
                  onClick={() => setGalleryPage(p => Math.min(Math.ceil(files.length / GALLERY_PAGE_SIZE) - 1, p + 1))}
                  disabled={galleryPage >= Math.ceil(files.length / GALLERY_PAGE_SIZE) - 1}
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
          {t('observationDetail.sessionFileGrid.empty')}
        </div>
      )}
    </div>
  );
}
