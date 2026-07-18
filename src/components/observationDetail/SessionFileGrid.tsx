import { Telescope, Columns, Crown, Download, Heart, ChevronLeft, ChevronRight } from 'lucide-react';
import { FitsThumbnail } from '../FitsThumbnail';
import { useTheme } from '../../hooks/useTheme';
import type { SessionFile } from '../../types';
import type { CompareItem } from '../../pages/ObservationDetail';
import type { CompareFile } from '../ImageCompareModal';

const GALLERY_PAGE_SIZE = 12; // 3 rows × 4 columns (md breakpoint)

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
  date,
  openGallery,
  isAdmin,
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
  date: string;
  openGallery: (index: number, fileList?: SessionFile[]) => void;
  isAdmin: boolean;
}) {
  const { isDark } = useTheme();

  return (
    <div className={`rounded-2xl border ${isDark ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
      <div className={`flex items-center justify-between p-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <h2 className={`font-display font-semibold flex items-center gap-2 ${isDark ? 'text-white' : 'text-slate-900'}`}>
          <Telescope className="w-4 h-4 flex-shrink-0 text-teal-500" />
          Images
          {files.length > 0 && (
            <span className={`text-xs px-2 py-0.5 rounded-full ${isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>
              {files.length}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          <button
            onClick={onToggleCompareMode}
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
                onClick={() => onViewModeChange(mode)}
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

      {files.length > 0 ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 p-4">
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
                          onToggleFavorite(file.path, !imageFavoriteSet.has(file.path));
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
          {files.length > GALLERY_PAGE_SIZE && (
            <div className={`flex items-center justify-between px-4 pb-4 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              <span className="text-xs">
                Showing {galleryPage * GALLERY_PAGE_SIZE + 1}–{Math.min((galleryPage + 1) * GALLERY_PAGE_SIZE, files.length)} of {files.length}
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
          No files found
        </div>
      )}
    </div>
  );
}
