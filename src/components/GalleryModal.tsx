import { useState, useEffect, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ChevronLeft,
  ChevronRight,
  X,
  Loader2,
  Download,
  Trash2,
  FileImage,
  Image,
  Pencil,
  ZoomIn,
  ZoomOut,
  Contrast,
  Star,
} from 'lucide-react';
import { deleteLibraryFile } from '../lib/api/library';
import { useTheme } from '../hooks/useTheme';
import { useSwipeDownToClose } from '../hooks/useSwipeDownToClose';
import { FitsViewer } from './FitsViewer';
import { FitsThumbnail } from './FitsThumbnail';
import { ConfirmModal } from './ConfirmModal';
import type { SessionFile, ProcessedImage } from '../types';

export type GalleryItem =
  | { kind: 'file'; file: SessionFile }
  | { kind: 'processed'; img: ProcessedImage };

interface Props {
  isOpen: boolean;
  items: GalleryItem[];
  defaultIndex: number;
  objectId: string;
  date: string;
  isAdmin: boolean;
  onClose: () => void;
  onEditImage: (url: string, name: string, kind: 'telescope' | 'processed') => void;
  onHeaderFileClick: (file: SessionFile) => void;
  onSetAsGallery: (img: ProcessedImage) => void;
  onDeleteProcessed: (id: string) => void;
  settingGalleryId: string | null;
  deletingProcessedId: string | null;
}

export function GalleryModal({
  isOpen,
  items,
  defaultIndex,
  objectId,
  date,
  isAdmin,
  onClose,
  onEditImage,
  onHeaderFileClick,
  onSetAsGallery,
  onDeleteProcessed,
  settingGalleryId,
  deletingProcessedId,
}: Props) {
  const { isDark } = useTheme();
  const queryClient = useQueryClient();

  // Internal items list — snapshot from props on open; mutated when files are deleted
  const [localItems, setLocalItems] = useState<GalleryItem[]>([]);
  const [index, setIndex] = useState(0);
  const [zoom, setZoom] = useState(1.0);
  const [fit, setFit] = useState(true);
  const [fitsZoom, setFitsZoom] = useState<number | null>(null);
  const [fitsStretch, setFitsStretch] = useState(0.5);
  const [fitsFitZoom, setFitsFitZoom] = useState<number>(1);
  const [confirmDeleteFilePath, setConfirmDeleteFilePath] = useState<string | null>(null);
  const [deletingFile, setDeletingFile] = useState(false);
  const [confirmDeleteProcessedId, setConfirmDeleteProcessedId] = useState<string | null>(null);

  const imageAreaRef = useRef<HTMLDivElement>(null);
  const fitImgRef = useRef<HTMLImageElement>(null);
  const activeThumbRef = useRef<HTMLButtonElement>(null);
  const thumbStripRef = useRef<HTMLDivElement>(null);

  // Snapshot items + reset on open
  useEffect(() => {
    if (!isOpen) return;
    setLocalItems(items);
    setIndex(defaultIndex);
    setZoom(1);
    setFit(true);
    setFitsZoom(null);
    setFitsStretch(0.5);
    setConfirmDeleteFilePath(null);
    setConfirmDeleteProcessedId(null);
  // Intentionally only re-snapshot when isOpen changes to true
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const activeItem = localItems[index];
  const isFitsItem = activeItem?.kind === 'file' && activeItem.file.type === 'fits';
  const isFitMode = isFitsItem ? fitsZoom === null : fit;

  const { handlers: swipeHandlers, dy: swipeDy, dragging: swipeDragging } =
    useSwipeDownToClose(onClose, { disabled: !isFitMode });

  const getFitZoom = useCallback(() => {
    if (!fitImgRef.current || !imageAreaRef.current) return 1.0;
    const { naturalWidth, naturalHeight } = fitImgRef.current;
    if (!naturalWidth || !naturalHeight) return 1.0;
    const containerW = imageAreaRef.current.clientWidth - 32;
    const containerH = imageAreaRef.current.clientHeight - 32;
    if (containerW <= 0 || containerH <= 0) return 1.0;
    const scale = Math.min(containerW / naturalWidth, containerH / naturalHeight);
    return (naturalWidth * scale) / containerW;
  }, []);

  const navigate = useCallback((direction: -1 | 1) => {
    setIndex(prev => {
      const next = prev + direction;
      if (next < 0 || next >= localItems.length) return prev;
      return next;
    });
    setZoom(1);
  }, [localItems.length]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); navigate(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); navigate(1); }
      else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, navigate, onClose]);

  // Reset fit/zoom when navigating or gallery opens/closes
  useEffect(() => {
    setFit(true);
    setFitsZoom(null);
    setFitsStretch(0.5);
    setConfirmDeleteFilePath(null);
  }, [isOpen, index]);

  // Keep active thumbnail scrolled into view
  useEffect(() => {
    const thumb = activeThumbRef.current;
    const strip = thumbStripRef.current;
    if (!thumb || !strip) return;
    const offset = thumb.offsetLeft - strip.clientWidth / 2 + thumb.offsetWidth / 2;
    strip.scrollTo({ left: Math.max(0, offset), behavior: 'smooth' });
  }, [index]);

  if (!isOpen || localItems.length === 0) return null;

  const item = localItems[index];
  if (!item) return null;

  const isFile = item.kind === 'file';
  const isFits = isFile && item.file.type === 'fits';
  const src = isFile ? item.file.downloadUrl : item.img.url;
  const itemTitle = isFile ? item.file.name : (item.img.title || item.img.originalName);
  const itemSub = isFile
    ? [item.file.exposure, item.file.filter].filter(Boolean).join(' · ')
    : item.img.notes || null;

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
        style={{ backgroundColor: `rgba(0, 0, 0, ${0.9 * Math.max(0, 1 - swipeDy / 400)})` }}
      >
        <div
          {...swipeHandlers}
          className={`relative w-full max-w-6xl h-[95dvh] flex flex-col rounded-2xl touch-pan-y overscroll-contain ${isDark ? 'bg-slate-900' : 'bg-white'}`}
          style={{
            transform: swipeDy ? `translateY(${swipeDy}px)` : undefined,
            transition: swipeDragging ? 'none' : 'transform 200ms ease-out',
            paddingBottom: 'env(safe-area-inset-bottom)',
          }}
        >
          {/* Header */}
          <div className={`flex-shrink-0 flex items-center justify-between p-4 border-b ${isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
            <div className="flex items-center gap-3 min-w-0 mr-3">
              {isFile && isFits
                ? <FileImage className="w-5 h-5 text-teal-500 flex-shrink-0" />
                : <Image className="w-5 h-5 text-accent-500 flex-shrink-0" />
              }
              <div className="min-w-0">
                <span className={`font-medium text-sm truncate block ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                  {itemTitle}
                </span>
                {itemSub && (
                  <span className={`text-xs truncate block ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    {itemSub}
                  </span>
                )}
              </div>
            </div>

            <div className="flex items-center gap-1 flex-shrink-0">
              {/* Navigation */}
              <button
                onClick={() => navigate(-1)}
                disabled={index <= 0}
                className={`p-2 rounded-lg transition disabled:opacity-30 ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <span className={`text-sm font-medium tabular-nums px-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                {index + 1} / {localItems.length}
              </span>
              <button
                onClick={() => navigate(1)}
                disabled={index >= localItems.length - 1}
                className={`p-2 rounded-lg transition disabled:opacity-30 ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
              >
                <ChevronRight className="w-5 h-5" />
              </button>

              <div className={`w-px h-5 mx-1 ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`} />

              {/* Zoom controls */}
              {isFits ? (
                <>
                  <button
                    onClick={() => setFitsZoom(z => Math.max(0.05, +((z ?? fitsFitZoom) - 0.1).toFixed(2)))}
                    title="Zoom out"
                    className={`p-2 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
                  >
                    <ZoomOut className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setFitsZoom(null)}
                    title="Fit to window"
                    className={`px-2 py-1 rounded text-xs font-medium tabular-nums min-w-[3rem] text-center transition ${
                      fitsZoom === null
                        ? isDark ? 'text-accent-400 bg-accent-500/10' : 'text-accent-700 bg-accent-300'
                        : isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'
                    }`}
                  >
                    {fitsZoom === null ? 'Fit' : `${Math.round(fitsZoom * 100)}%`}
                  </button>
                  <button
                    onClick={() => setFitsZoom(z => Math.min(4, +((z ?? fitsFitZoom) + 0.1).toFixed(2)))}
                    title="Zoom in"
                    className={`p-2 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
                  >
                    <ZoomIn className="w-4 h-4" />
                  </button>
                  <div className={`w-px h-5 mx-1 ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`} />
                  <Contrast className={`w-4 h-4 flex-shrink-0 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
                  <input
                    type="range" min="0" max="1" step="0.01" value={fitsStretch}
                    onChange={e => setFitsStretch(parseFloat(e.target.value))}
                    className="w-20 accent-accent-500"
                    title="Stretch"
                  />
                  <div className={`w-px h-5 mx-1 ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`} />
                  <button
                    onClick={() => onHeaderFileClick(item.file)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${isDark ? 'hover:bg-slate-800 text-teal-400' : 'hover:bg-slate-100 text-teal-600'}`}
                  >
                    FITS Header
                  </button>
                  <a
                    href={item.file.downloadUrl}
                    download={item.file.name}
                    title="Download"
                    className={`p-2 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
                  >
                    <Download className="w-4 h-4" />
                  </a>
                  {isAdmin && (confirmDeleteFilePath === item.file.path ? (
                    <>
                      <span className={`text-xs px-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Delete?</span>
                      <button
                        onClick={async () => {
                          setDeletingFile(true);
                          try {
                            await deleteLibraryFile(item.file.path);
                            queryClient.invalidateQueries({ queryKey: ['observation-files', objectId, date] });
                            queryClient.invalidateQueries({ queryKey: ['observation', objectId, date] });
                            setConfirmDeleteFilePath(null);
                            setLocalItems(prev => {
                              const next = prev.filter((_, i) => i !== index);
                              if (next.length <= 1) {
                                onClose();
                              } else if (index >= next.length) {
                                setIndex(next.length - 1);
                              }
                              return next;
                            });
                          } finally {
                            setDeletingFile(false);
                          }
                        }}
                        disabled={deletingFile}
                        className="px-2.5 py-1 rounded-lg text-xs font-medium bg-red-500 text-white hover:bg-red-600 transition disabled:opacity-50"
                      >
                        {deletingFile ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Yes'}
                      </button>
                      <button
                        onClick={() => setConfirmDeleteFilePath(null)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium transition ${isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}
                      >
                        No
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmDeleteFilePath(item.file.path)}
                      title="Delete file"
                      className={`p-2 rounded-lg transition text-red-400 hover:text-red-500 ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  ))}
                  <div className={`w-px h-5 mx-1 ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`} />
                </>
              ) : (
                <>
                  <button
                    onClick={() => { if (!fit) setZoom(z => Math.max(0.1, +(z - 0.1).toFixed(2))); }}
                    disabled={fit || zoom <= 0.1}
                    title="Zoom out"
                    className={`p-2 rounded-lg transition disabled:opacity-30 ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
                  >
                    <ZoomOut className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setFit(true)}
                    title="Fit to window"
                    className={`px-2 py-1 rounded text-xs font-medium tabular-nums min-w-[3rem] text-center transition ${
                      fit
                        ? isDark ? 'text-accent-400 bg-accent-500/10' : 'text-accent-700 bg-accent-300'
                        : isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'
                    }`}
                  >
                    {fit ? 'Fit' : `${Math.round(zoom * 100)}%`}
                  </button>
                  <button
                    onClick={() => {
                      if (fit) { const base = getFitZoom(); setFit(false); setZoom(+(base + 0.1).toFixed(2)); }
                      else setZoom(z => Math.min(4, +(z + 0.1).toFixed(2)));
                    }}
                    disabled={!fit && zoom >= 4}
                    title="Zoom in"
                    className={`p-2 rounded-lg transition disabled:opacity-30 ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
                  >
                    <ZoomIn className="w-4 h-4" />
                  </button>
                  <div className={`w-px h-5 mx-1 ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`} />
                </>
              )}

              {/* Actions for telescope image files (JPG/PNG) */}
              {isFile && !isFits && (
                <>
                  {isAdmin && (
                    <button
                      onClick={() => onEditImage(item.file.downloadUrl, item.file.name, 'telescope')}
                      title="Edit image"
                      className={`p-2 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                  )}
                  <a
                    href={item.file.downloadUrl}
                    download={item.file.name}
                    title="Download"
                    className={`p-2 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
                  >
                    <Download className="w-4 h-4" />
                  </a>
                  {isAdmin && (confirmDeleteFilePath === item.file.path ? (
                    <>
                      <span className={`text-xs px-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Delete?</span>
                      <button
                        onClick={async () => {
                          setDeletingFile(true);
                          try {
                            await deleteLibraryFile(item.file.path);
                            queryClient.invalidateQueries({ queryKey: ['observation-files', objectId, date] });
                            queryClient.invalidateQueries({ queryKey: ['observation', objectId, date] });
                            setConfirmDeleteFilePath(null);
                            if (localItems.length <= 1) {
                              onClose();
                            } else if (index >= localItems.length - 1) {
                              setIndex(i => i - 1);
                            }
                            setLocalItems(prev => prev.filter((_, i) => i !== index));
                          } finally {
                            setDeletingFile(false);
                          }
                        }}
                        disabled={deletingFile}
                        className="px-2.5 py-1 rounded-lg text-xs font-medium bg-red-500 text-white hover:bg-red-600 transition disabled:opacity-50"
                      >
                        {deletingFile ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Yes'}
                      </button>
                      <button
                        onClick={() => setConfirmDeleteFilePath(null)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium transition ${isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}
                      >
                        No
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmDeleteFilePath(item.file.path)}
                      title="Delete file"
                      className={`p-2 rounded-lg transition text-red-400 hover:text-red-500 ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  ))}
                </>
              )}

              {/* Processed image actions */}
              {!isFile && (
                <>
                  {isAdmin && (
                    <button
                      onClick={() => onEditImage(item.img.url, item.img.originalName, 'processed')}
                      title="Edit image"
                      className={`p-2 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                  )}
                  <a
                    href={item.img.url}
                    download={item.img.originalName}
                    title="Download"
                    className={`p-2 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
                  >
                    <Download className="w-4 h-4" />
                  </a>
                  {isAdmin && (
                    <>
                      <button
                        onClick={() => onSetAsGallery(item.img)}
                        disabled={!!settingGalleryId}
                        title="Set as gallery image"
                        className={`p-2 rounded-lg transition disabled:opacity-50 ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
                      >
                        {settingGalleryId === item.img.id
                          ? <Loader2 className="w-4 h-4 animate-spin" />
                          : <Star className="w-4 h-4" />
                        }
                      </button>
                      <button
                        onClick={() => setConfirmDeleteProcessedId(item.img.id)}
                        disabled={!!deletingProcessedId}
                        title="Delete"
                        className={`p-2 rounded-lg transition disabled:opacity-50 text-red-400 hover:text-red-500 ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
                      >
                        {deletingProcessedId === item.img.id
                          ? <Loader2 className="w-4 h-4 animate-spin" />
                          : <Trash2 className="w-4 h-4" />
                        }
                      </button>
                      <div className={`w-px h-5 mx-1 ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`} />
                    </>
                  )}
                </>
              )}

              {/* Close */}
              <button
                onClick={onClose}
                className={`p-2 rounded-lg transition ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Image area */}
          <div
            ref={imageAreaRef}
            className={`flex-1 min-h-0 p-4 ${isFits || fit ? 'relative overflow-hidden' : 'overflow-auto flex items-center justify-center'}`}
          >
            {isFits ? (
              <div className="w-full h-full flex flex-col">
                <FitsViewer
                  url={item.file.downloadUrl}
                  isDark={isDark}
                  filePath={item.file.path}
                  fileType={item.file.fileType}
                  hideControls
                  externalZoom={fitsZoom}
                  externalStretch={fitsStretch}
                  onFitZoomComputed={setFitsFitZoom}
                />
              </div>
            ) : fit ? (
              <div className="relative w-full h-full">
                <img
                  ref={fitImgRef}
                  src={src}
                  alt={itemTitle}
                  className="absolute inset-0 w-full h-full object-contain rounded-xl"
                />
              </div>
            ) : (
              <div
                className="relative"
                style={{ width: `${zoom * 100}%`, flexShrink: 0 }}
              >
                <img
                  src={src}
                  alt={itemTitle}
                  className="rounded-xl w-full h-auto block"
                />
              </div>
            )}
          </div>

          {/* Thumbnail strip — windowed to ±10 around current index */}
          {localItems.length > 1 && (() => {
            const THUMB_WINDOW = 10;
            const start = Math.max(0, index - THUMB_WINDOW);
            const end = Math.min(localItems.length, index + THUMB_WINDOW + 1);
            const windowed = localItems.slice(start, end);
            return (
              <div className={`flex-shrink-0 border-t p-3 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
                <div ref={thumbStripRef} className="flex gap-2 overflow-x-auto pb-1 items-center">
                  {start > 0 && (
                    <span className={`flex-shrink-0 text-[10px] px-1.5 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                      +{start}
                    </span>
                  )}
                  {windowed.map((wItem, i) => {
                    const idx = start + i;
                    const isFitsThumb = wItem.kind === 'file' && wItem.file.type === 'fits';
                    const thumbSrc = wItem.kind === 'file' ? wItem.file.downloadUrl : wItem.img.url;
                    const thumbKey = wItem.kind === 'file' ? wItem.file.path : wItem.img.id;
                    return (
                      <button
                        key={thumbKey}
                        ref={idx === index ? activeThumbRef : null}
                        onClick={() => { setIndex(idx); setZoom(1); setFit(true); }}
                        className={`flex-shrink-0 w-14 h-14 rounded-lg overflow-hidden border-2 ${
                          idx === index
                            ? 'border-accent-500'
                            : isDark ? 'border-slate-800 hover:border-slate-600' : 'border-slate-200 hover:border-slate-300'
                        }`}
                      >
                        {isFitsThumb ? (
                          <FitsThumbnail
                            url={thumbSrc}
                            thumbUrl={wItem.kind === 'file' ? wItem.file.thumbUrl : undefined}
                            stretch={1.0}
                            isDark={isDark}
                          />
                        ) : (
                          <img src={thumbSrc} alt="" className="w-full h-full object-cover" loading="lazy" />
                        )}
                      </button>
                    );
                  })}
                  {end < localItems.length && (
                    <span className={`flex-shrink-0 text-[10px] px-1.5 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                      +{localItems.length - end}
                    </span>
                  )}
                </div>
              </div>
            );
          })()}

          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/40 text-xs">
            Use arrow keys to navigate
          </div>
        </div>
      </div>

      {/* Confirm delete processed image */}
      {confirmDeleteProcessedId && (
        <ConfirmModal
          title="Delete image?"
          message="This will permanently delete the processed image. This cannot be undone."
          confirmLabel="Delete"
          onCancel={() => setConfirmDeleteProcessedId(null)}
          onConfirm={() => {
            onDeleteProcessed(confirmDeleteProcessedId);
            setConfirmDeleteProcessedId(null);
          }}
        />
      )}
    </>
  );
}
