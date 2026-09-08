import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Loader2, Download, Trash2, FileImage, Image, Pencil, Contrast, Star, Share2,
} from 'lucide-react';
import { deleteLibraryFile } from '../lib/api/library';
import { FitsViewer } from './FitsViewer';
import { FitsThumbnail } from './FitsThumbnail';
import { ConfirmModal } from './ConfirmModal';
import type { SessionFile, ProcessedImage } from '../types';
import { previewSrcFor, thumbSrcFor, canPreviewImage } from '../lib/sessionImageSrc';
import { isRenderableProcessed, isFitsProcessed } from '../lib/processedFormats';
import type { OverwriteTarget } from './ImageEditorModal';
import { LightboxFrame, LightboxPane } from './lightbox/LightboxFrame';
import { LightboxImage } from './lightbox/LightboxImage';
import { useZoomPan } from './lightbox/useZoomPan';
import { zoomControlsFromPan, useFitsZoomControls } from './lightbox/zoomControls';
import { useLightboxKeys } from './lightbox/useLightboxKeys';
import { useAdjacentPreload } from './lightbox/useAdjacentPreload';
import { shareImage, shareOutcomeMessage } from './lightbox/shareImage';
import { sessionFileMeta, processedImageMeta } from './lightbox/itemMeta';
import { LB_ICON_BTN, LB_TEXT_BTN, LB_DANGER_BTN } from './lightbox/chrome';
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
  onEditImage: (url: string, name: string, kind: 'telescope' | 'processed', overwriteTarget?: OverwriteTarget) => void;
  onHeaderFileClick: (file: SessionFile) => void;
  onSetAsGallery: (img: ProcessedImage) => void;
  onDeleteProcessed: (id: string) => void;
  settingGalleryId: string | null;
  deletingProcessedId: string | null;
  /** Object display name, used to give the header a real title. */
  objectName?: string;
  /** Hides the Edit action. For a caller with no working onEditImage handler
   *  (e.g. an object-level aggregate view spanning many/no sessions, where
   *  "edit and save back into session X" doesn't have a single X to target)
   *  rather than wiring a handler that would silently do nothing. */
  hideEditButton?: boolean;
}

/** `<img>` src for an item, or null when the format cannot be rendered.
 *  A processed image can be a FITS restack or a stored-only deliverable
 *  (XISF, PSD, RAW) same as a raw session file can — those get routed to
 *  the FITS viewer or the "no preview" card below instead of an `<img>`. */
function displaySrc(item: GalleryItem): string | null {
  if (item.kind === 'processed') {
    if (!isRenderableProcessed(item.img.originalName)) return null;
    // Bounded preview tier for display; `img.url` (the raw original, often the
    // largest file in the library) stays the Download / Share target.
    return item.img.previewUrl ?? item.img.url;
  }
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
  hideEditButton,
}: Props) {
  const queryClient = useQueryClient();

  // Snapshot of `items` taken on open, so deletions can be reflected without
  // waiting for the parent's query to refetch.
  const [localItems, setLocalItems] = useState<GalleryItem[]>([]);
  const [index, setIndex] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<GalleryItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Synchronous re-entry guard for confirmDelete: two clicks in one tick land
  // before the `deleting` state commits, but a ref updates immediately.
  const deletingRef = useRef(false);
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
  const isFits = item
    ? item.kind === 'file' ? item.file.type === 'fits' : isFitsProcessed(item.img.originalName)
    : false;
  const noPreview = item
    ? item.kind === 'file'
      ? !isFits && !canPreviewImage(item.file)
      : !isFits && !isRenderableProcessed(item.img.originalName)
    : false;

  const zp = useZoomPan(index);
  const fits = useFitsZoomControls();
  const imageZoom = useMemo(() => zoomControlsFromPan(zp), [zp]);

  /**
   * Shape of the decoded FITS frame, so the panel can size itself to a raw
   * frame the same way it does to a JPG.
   *
   * Without this, stepping from a stack to the sub-frame it came from snapped
   * the whole viewer from portrait-width to full width, even though both
   * frames came off the same sensor and are the same shape. Not cleared on
   * navigation: `LightboxFrame` holds the last known shape until a new one
   * arrives, and clearing here would reintroduce the snap it prevents.
   */
  const [fitsAspect, setFitsAspect] = useState<number | null>(null);
  const noteFitsSize = useCallback((w: number, h: number) => {
    setFitsAspect(h > 0 ? w / h : null);
  }, []);

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
    // Re-entry guard: the confirm dialog stays mounted through the request, so a
    // double-click otherwise fires two DELETEs and runs removeCurrent() twice,
    // splicing by a stale index and evicting the neighbouring (still-present)
    // frame from the strip.
    if (deletingRef.current) return;
    const target = pendingDelete;
    if (!target) return;
    deletingRef.current = true;
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
      deletingRef.current = false;
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
      const img = entry.img;
      const renderable = isRenderableProcessed(img.originalName);
      const fits = !renderable && isFitsProcessed(img.originalName);
      return {
        key: img.id,
        label: img.title || img.originalName,
        content: renderable ? (
          <img src={img.thumbUrl ?? img.previewUrl ?? img.url} alt="" className="w-full h-full object-cover" loading="lazy" />
        ) : fits ? (
          <FitsThumbnail url={img.url} thumbUrl={img.thumbUrl ?? undefined} stretch={1.0} isDark />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-white/[0.06] text-white/40">
            <FileImage className="h-5 w-5" />
          </div>
        ),
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
        <FitsThumbnail url={thumbSrcFor(f)} thumbUrl={f.thumbUrl} stretch={1.0} isDark />
      ) : unrenderable ? (
        <div className="flex h-full w-full items-center justify-center bg-white/[0.06] text-white/40">
          <FileImage className="h-5 w-5" />
        </div>
      ) : (
        <img src={thumbSrcFor(f)} alt="" className="w-full h-full object-cover" loading="lazy" />
      ),
    };
  }), [localItems]);

  if (!isOpen || !item) return null;

  // Edit and Share both need a decodable image in hand: Edit feeds the file
  // into a canvas, Share fetches it as a blob. A TIFF or 16-bit PNG can be
  // neither, so those items get Download and Delete only.
  const shareable = !noPreview && !!src;

  const actions = (
    <>
      {/* No header source exists for a processed FITS restack (only raw
          session files have one), so this stays file-only. */}
      {isFits && item.kind === 'file' && (
        <button
          type="button"
          onClick={() => onHeaderFileClick(item.file)}
          className={`${LB_TEXT_BTN} text-teal-300 hover:text-teal-200`}
        >
          FITS Header
        </button>
      )}

      {isAdmin && shareable && !isFits && !hideEditButton && (
        <button
          type="button"
          onClick={() => onEditImage(
            item.kind === 'file' ? item.file.downloadUrl : item.img.url,
            fileName,
            item.kind === 'file' ? 'telescope' : 'processed',
            item.kind === 'file'
              ? (/\.jpe?g$/i.test(item.file.name) ? { kind: 'telescope', path: item.file.path } : undefined)
              : { kind: 'processed', id: item.img.id },
          )}
          title="Edit image"
          aria-label="Edit image"
          className={LB_ICON_BTN}
        >
          <Pencil className="h-4 w-4" />
        </button>
      )}

      {shareable && (
        <button type="button" onClick={handleShare} disabled={sharing} title="Share" aria-label="Share" className={LB_ICON_BTN}>
          {sharing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
        </button>
      )}

      <a href={downloadUrl} download={fileName} title="Download (D)" aria-label="Download" className={LB_ICON_BTN}>
        <Download className="h-4 w-4" />
      </a>

      {isAdmin && item.kind === 'processed' && (
        <button
          type="button"
          onClick={() => onSetAsGallery(item.img)}
          disabled={!!settingGalleryId}
          title="Set as gallery image"
          aria-label="Set as gallery image"
          className={LB_ICON_BTN}
        >
          {settingGalleryId === item.img.id
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <Star className="h-4 w-4" />}
        </button>
      )}

      {canDelete && (
        <button
          type="button"
          onClick={() => setPendingDelete(item)}
          disabled={busyDelete}
          title="Delete"
          aria-label="Delete"
          className={LB_DANGER_BTN}
        >
          {busyDelete ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        </button>
      )}
    </>
  );

  const stretchControl = isFits ? (
    // h-8 matches the buttons in the neighbouring groups, so a range input
    // (which has no intrinsic height to speak of) does not make its pill
    // shorter than every other pill in the row.
    <div className="flex h-8 items-center gap-2 px-2">
      <Contrast className="h-4 w-4 flex-shrink-0 text-white/50" />
      <input
        type="range" min="0" max="1" step="0.01" value={fits.stretch}
        onChange={e => fits.setStretch(parseFloat(e.target.value))}
        className="w-20 accent-accent-500"
        title="Stretch"
        aria-label="Stretch"
      />
    </div>
  ) : null;

  return (
    <>
      <LightboxFrame
        isOpen
        onClose={onClose}
        dialogTitle={`Image viewer: ${meta.title}`}
        titleIcon={isFits
          ? <FileImage className="h-4.5 w-4.5 flex-shrink-0 text-teal-300" />
          : <Image className="h-4.5 w-4.5 flex-shrink-0 text-accent-400" />}
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
        // The thumbnail, not `src`: blurring a 4000px stacked frame to nothing
        // is work the GPU does not need to do, and the tile is already cached.
        ambientSrc={noPreview || isFits
          ? null
          : item.kind === 'file' ? thumbSrcFor(item.file) : (item.img.previewUrl ?? item.img.url)}
        contentAspect={isFits ? fitsAspect : (zp.natural ? zp.natural.w / zp.natural.h : null)}
      >
        {noPreview ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
            <FileImage className="h-12 w-12 text-white/20" />
            <div className="space-y-1 text-center">
              <p className="text-sm font-medium text-white/80">No preview for this format</p>
              <p className="text-xs text-white/45">
                {fileName} is stored in full and can be downloaded.
              </p>
            </div>
            <a
              href={downloadUrl}
              download={fileName}
              className="inline-flex items-center gap-2 rounded-full bg-white/[0.07] px-4 py-2 text-sm
                font-medium text-white/85 ring-1 ring-inset ring-white/15 backdrop-blur-md transition
                hover:bg-white/15 hover:text-white"
            >
              <Download className="h-4 w-4" />
              Download
            </a>
          </div>
        ) : isFits ? (
          <div className="absolute inset-2 sm:inset-4 flex flex-col">
            <FitsViewer
              url={item.kind === 'file' ? item.file.downloadUrl : item.img.url}
              // The stage is night-side in every theme, so the FITS canvas and
              // its loading state are told the same, rather than following the
              // page's theme and flashing a light panel inside a black frame.
              isDark
              filePath={item.kind === 'file' ? item.file.path : item.img.path}
              fileType={item.kind === 'file' ? item.file.fileType : undefined}
              hideControls
              externalZoom={fits.zoom}
              externalStretch={fits.stretch}
              onFitZoomComputed={fits.setFitZoom}
              onNaturalSize={noteFitsSize}
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
          pending={deleting}
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
    </>
  );
}
