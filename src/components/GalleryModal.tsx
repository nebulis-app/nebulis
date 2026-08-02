import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Loader2, Download, Trash2, FileImage, Image, Pencil, Contrast, Star, Share2,
} from 'lucide-react';
import { deleteLibraryFile } from '../lib/api/library';
import { useTheme } from '../hooks/useTheme';
import { FitsViewer } from './FitsViewer';
import { FitsThumbnail } from './FitsThumbnail';
import { ConfirmModal } from './ConfirmModal';
import type { SessionFile, ProcessedImage } from '../types';
import { previewSrcFor, thumbSrcFor, canPreviewImage } from '../lib/sessionImageSrc';
import { LightboxFrame, LightboxPane } from './lightbox/LightboxFrame';
import { LightboxImage } from './lightbox/LightboxImage';
import { useZoomPan } from './lightbox/useZoomPan';
import { zoomControlsFromPan, useFitsZoomControls } from './lightbox/zoomControls';
import { useLightboxKeys } from './lightbox/useLightboxKeys';
import { useAdjacentPreload } from './lightbox/useAdjacentPreload';
import { shareImage, shareOutcomeMessage } from './lightbox/shareImage';
import { sessionFileMeta, processedImageMeta } from './lightbox/itemMeta';
import type { ThumbEntry } from './lightbox/LightboxThumbStrip';

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
  /** Object display name, used to give the header a real title. */
  objectName?: string;
}

/** `<img>` src for an item, or null when the format cannot be rendered. */
function displaySrc(item: GalleryItem): string | null {
  if (item.kind === 'processed') return item.img.url;
  if (item.file.type === 'fits') return null;
  if (!canPreviewImage(item.file)) return null;
  return previewSrcFor(item.file);
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
  objectName,
}: Props) {
  const { isDark } = useTheme();
  const queryClient = useQueryClient();

  // Snapshot of `items` taken on open, so deletions can be reflected without
  // waiting for the parent's query to refetch.
  const [localItems, setLocalItems] = useState<GalleryItem[]>([]);
  const [index, setIndex] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<GalleryItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((msg: string | null) => {
    if (statusTimer.current) clearTimeout(statusTimer.current);
    setStatus(msg);
    if (msg) statusTimer.current = setTimeout(() => setStatus(null), 3000);
  }, []);
  useEffect(() => () => { if (statusTimer.current) clearTimeout(statusTimer.current); }, []);

  // Snapshot on the open transition only. Re-snapshotting whenever `items`
  // changes identity would discard local deletions mid-session.
  const [wasOpen, setWasOpen] = useState(false);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setLocalItems(items);
      setIndex(defaultIndex);
      setPendingDelete(null);
      setStatus(null);
    }
  }

  const item = localItems[index];
  const isFile = item?.kind === 'file';
  const isFits = isFile && item.file.type === 'fits';
  const noPreview = isFile && !isFits && !canPreviewImage(item.file);

  const zp = useZoomPan(index);
  const fits = useFitsZoomControls();
  const imageZoom = useMemo(() => zoomControlsFromPan(zp), [zp]);

  // Reset the FITS controls when moving between frames, the same way the image
  // engine resets itself. Done during render so a new frame is never drawn for
  // a frame at the previous one's zoom and stretch.
  const [seenIndex, setSeenIndex] = useState(index);
  if (seenIndex !== index) {
    setSeenIndex(index);
    fits.reset();
  }

  const srcs = useMemo(() => localItems.map(displaySrc), [localItems]);
  useAdjacentPreload(srcs, index);

  const navigate = useCallback((dir: -1 | 1) => {
    setIndex(prev => {
      const next = prev + dir;
      return next < 0 || next >= localItems.length ? prev : next;
    });
  }, [localItems.length]);

  const src = item ? displaySrc(item) : null;
  const fileName = item ? (item.kind === 'file' ? item.file.name : item.img.originalName) : '';
  const meta = item
    ? (item.kind === 'file' ? sessionFileMeta(item.file, objectName) : processedImageMeta(item.img))
    : { title: '', detail: '' };

  const downloadUrl = item
    ? (item.kind === 'file' ? item.file.downloadUrl : item.img.url)
    : '';

  const handleShare = useCallback(async () => {
    if (!src) return;
    setSharing(true);
    try {
      flash(shareOutcomeMessage(await shareImage(src, fileName, meta.title)));
    } finally {
      setSharing(false);
    }
  }, [src, fileName, meta.title, flash]);

  const handleDownload = useCallback(() => {
    if (!downloadUrl) return;
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = fileName;
    a.click();
  }, [downloadUrl, fileName]);

  /**
   * Removes the item at `index` from the local list and lands on a sensible
   * neighbour.
   *
   * There used to be two hand-rolled copies of this, one per file type, and
   * they disagreed: the FITS branch closed the viewer when a single item was
   * left rather than showing it. Processed images had no local removal at all,
   * so deleting one left it on screen with a dead thumbnail until close.
   */
  const removeCurrent = useCallback(() => {
    setLocalItems(prev => {
      const next = prev.filter((_, i) => i !== index);
      if (next.length === 0) onClose();
      return next;
    });
    setIndex(prev => Math.max(0, Math.min(prev, localItems.length - 2)));
  }, [index, localItems.length, onClose]);

  const confirmDelete = useCallback(async () => {
    const target = pendingDelete;
    if (!target) return;
    setDeleting(true);
    try {
      if (target.kind === 'file') {
        await deleteLibraryFile(target.file.path);
        queryClient.invalidateQueries({ queryKey: ['observation-files', objectId, date] });
        queryClient.invalidateQueries({ queryKey: ['observation', objectId, date] });
        // The object's file counts and hero thumbnail are derived from this
        // list, so they go stale too. The old code never invalidated it.
        queryClient.invalidateQueries({ queryKey: ['library-objects'] });
      } else {
        onDeleteProcessed(target.img.id);
      }
      setPendingDelete(null);
      removeCurrent();
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Delete failed');
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, queryClient, objectId, date, onDeleteProcessed, removeCurrent, flash]);

  const canDelete = isAdmin && !!item;
  const busyDelete = deleting || (item?.kind === 'processed' && deletingProcessedId === item.img.id);

  useLightboxKeys({
    onPrev: () => navigate(-1),
    onNext: () => navigate(1),
    onFirst: () => setIndex(0),
    onLast: () => setIndex(localItems.length - 1),
    onClose,
    onFit: isFits ? fits.controls.setFit : zp.setFit,
    onActualSize: isFits ? fits.controls.setActualSize : zp.setActualSize,
    onZoomIn: isFits ? fits.controls.zoomIn : imageZoom.zoomIn,
    onZoomOut: isFits ? fits.controls.zoomOut : imageZoom.zoomOut,
    onDownload: handleDownload,
    onDelete: canDelete ? () => setPendingDelete(item) : undefined,
    // Escape must reach the confirmation dialog, not tear down the viewer
    // underneath it.
    suspended: !!pendingDelete,
  }, isOpen);

  const thumbs = useMemo<ThumbEntry[]>(() => localItems.map(entry => {
    if (entry.kind === 'processed') {
      return {
        key: entry.img.id,
        label: entry.img.title || entry.img.originalName,
        content: <img src={entry.img.url} alt="" className="w-full h-full object-cover" loading="lazy" />,
      };
    }
    const f = entry.file;
    const thumbIsFits = f.type === 'fits';
    // `thumbSrcFor` falls back to the raw file when the server produced no
    // thumbnail. For a 100 MB float TIFF that fallback is the full original,
    // which is exactly the decode the preview gate exists to avoid, so the
    // check applies to strip tiles as well as the viewed item.
    const unrenderable = !thumbIsFits && !canPreviewImage(f);
    return {
      key: f.path,
      label: f.name,
      content: thumbIsFits ? (
        <FitsThumbnail url={thumbSrcFor(f)} thumbUrl={f.thumbUrl} stretch={1.0} isDark={isDark} />
      ) : unrenderable ? (
        <div className={`w-full h-full flex items-center justify-center ${isDark ? 'bg-slate-800/60 text-slate-500' : 'bg-slate-100 text-slate-400'}`}>
          <FileImage className="w-5 h-5" />
        </div>
      ) : (
        <img src={thumbSrcFor(f)} alt="" className="w-full h-full object-cover" loading="lazy" />
      ),
    };
  }), [localItems, isDark]);

  if (!isOpen || !item) return null;

  const iconBtn = `p-2 rounded-lg transition disabled:opacity-40 ${
    isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'
  }`;

  // Edit and Share both need a decodable image in hand: Edit feeds the file
  // into a canvas, Share fetches it as a blob. A TIFF or 16-bit PNG can be
  // neither, so those items get Download and Delete only.
  const shareable = !noPreview && !!src;

  const actions = (
    <>
      {isFits && (
        <button
          type="button"
          onClick={() => onHeaderFileClick(item.file)}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition ${
            isDark ? 'hover:bg-slate-800 text-teal-400' : 'hover:bg-slate-100 text-teal-600'
          }`}
        >
          FITS Header
        </button>
      )}

      {isAdmin && shareable && !isFits && (
        <button
          type="button"
          onClick={() => onEditImage(
            item.kind === 'file' ? item.file.downloadUrl : item.img.url,
            fileName,
            item.kind === 'file' ? 'telescope' : 'processed',
          )}
          title="Edit image"
          aria-label="Edit image"
          className={iconBtn}
        >
          <Pencil className="w-4 h-4" />
        </button>
      )}

      {shareable && (
        <button type="button" onClick={handleShare} disabled={sharing} title="Share" aria-label="Share" className={iconBtn}>
          {sharing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Share2 className="w-4 h-4" />}
        </button>
      )}

      <a href={downloadUrl} download={fileName} title="Download (D)" aria-label="Download" className={iconBtn}>
        <Download className="w-4 h-4" />
      </a>

      {isAdmin && item.kind === 'processed' && (
        <button
          type="button"
          onClick={() => onSetAsGallery(item.img)}
          disabled={!!settingGalleryId}
          title="Set as gallery image"
          aria-label="Set as gallery image"
          className={iconBtn}
        >
          {settingGalleryId === item.img.id
            ? <Loader2 className="w-4 h-4 animate-spin" />
            : <Star className="w-4 h-4" />}
        </button>
      )}

      {canDelete && (
        <button
          type="button"
          onClick={() => setPendingDelete(item)}
          disabled={busyDelete}
          title="Delete"
          aria-label="Delete"
          className={`p-2 rounded-lg transition disabled:opacity-40 text-red-400 hover:text-red-500 ${
            isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'
          }`}
        >
          {busyDelete ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
        </button>
      )}

      <div className={`w-px h-5 mx-1 flex-shrink-0 ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`} />
    </>
  );

  const stretchControl = isFits ? (
    <>
      <Contrast className={`w-4 h-4 flex-shrink-0 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
      <input
        type="range" min="0" max="1" step="0.01" value={fits.stretch}
        onChange={e => fits.setStretch(parseFloat(e.target.value))}
        className="w-20 accent-accent-500"
        title="Stretch"
        aria-label="Stretch"
      />
      <div className={`w-px h-5 mx-1 flex-shrink-0 ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`} />
    </>
  ) : null;

  return (
    <>
      <LightboxFrame
        isOpen
        onClose={onClose}
        isDark={isDark}
        dialogTitle={`Image viewer: ${meta.title}`}
        titleIcon={isFits
          ? <FileImage className="w-5 h-5 text-teal-500 flex-shrink-0" />
          : <Image className="w-5 h-5 text-accent-500 flex-shrink-0" />}
        title={meta.title}
        subtitle={meta.detail}
        index={index}
        count={localItems.length}
        onPrev={() => navigate(-1)}
        onNext={() => navigate(1)}
        onSelectIndex={setIndex}
        zoom={noPreview ? undefined : (isFits ? fits.controls : imageZoom)}
        extraControls={stretchControl}
        actions={actions}
        thumbs={thumbs}
        swipeDisabled={isFits ? !fits.controls.isFit : !zp.isFit}
        status={status}
      >
        {noPreview ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <FileImage className={`w-12 h-12 ${isDark ? 'text-slate-600' : 'text-slate-400'}`} />
            <div className="text-center">
              <p className={`text-sm font-medium ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                No preview for this format
              </p>
              <p className={`text-xs mt-1 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                {fileName} is stored in full and can be downloaded.
              </p>
            </div>
            <a
              href={downloadUrl}
              download={fileName}
              className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium ${
                isDark ? 'bg-slate-800 text-slate-200 hover:bg-slate-700' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              <Download className="w-4 h-4" />
              Download
            </a>
          </div>
        ) : isFits ? (
          <div className="absolute inset-2 sm:inset-4 flex flex-col">
            <FitsViewer
              url={item.file.downloadUrl}
              isDark={isDark}
              filePath={item.file.path}
              fileType={item.file.fileType}
              hideControls
              externalZoom={fits.zoom}
              externalStretch={fits.stretch}
              onFitZoomComputed={fits.setFitZoom}
            />
          </div>
        ) : (
          <LightboxPane
            zpRef={zp.containerRef}
            isPanning={zp.isPanning}
            canPan={zp.overflows}
            handlers={zp.paneHandlers}
          >
            {src && (
              <LightboxImage
                src={src}
                thumbSrc={item.kind === 'file' ? thumbSrcFor(item.file) : undefined}
                alt={meta.title}
                zp={zp}
                isDark={isDark}
              />
            )}
          </LightboxPane>
        )}
      </LightboxFrame>

      {pendingDelete && (
        <ConfirmModal
          title={pendingDelete.kind === 'file' ? 'Delete file?' : 'Delete image?'}
          message={
            pendingDelete.kind === 'file'
              ? `${pendingDelete.file.name} will be permanently deleted from your library. This cannot be undone.`
              : 'This will permanently delete the processed image. This cannot be undone.'
          }
          confirmLabel={deleting ? 'Deleting...' : 'Delete'}
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
    </>
  );
}
