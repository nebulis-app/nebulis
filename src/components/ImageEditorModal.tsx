import { useRef, useState, useEffect, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  X, Type, Crop, SlidersHorizontal,
  AlignLeft, AlignCenter, AlignRight,
  Check, RotateCcw, RotateCw, Save, Trash2, Loader2, Pencil,
  FlipHorizontal2, FlipVertical2, BookmarkCheck, Plus, Wand2, Eye,
} from 'lucide-react';
import { computeAutoAdjust } from '../lib/autoAdjust';
import { uploadProcessedImage, uploadObjectProcessedImage, uploadLibraryFile, overwriteProcessedImage } from '../lib/api/library';
import { getWatermarkPresets, saveWatermarkPresets, type WatermarkPreset } from '../lib/api/auth';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TextLayer {
  id: string;
  text: string;      // may contain '\n' for multiple lines
  x: number;        // 0–1 fraction of canvas width  (anchor = left-edge or center or right-edge of first line baseline)
  y: number;        // 0–1 fraction of canvas height (baseline of first line)
  fontSize: number; // px at display canvas size
  fontFamily: string;
  color: string;
  bold: boolean;
  italic: boolean;
  opacity: number;
  align: 'left' | 'center' | 'right';
  angle: number;    // degrees (–90…+90)
}

interface CropRect {
  x1: number; y1: number; // 0–1 fractions
  x2: number; y2: number;
}

type CropHandle = 'new' | 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

interface Adjustments {
  brightness: number; // –100…+100
  contrast: number;
  saturation: number;
}

/** Clockwise rotation applied to the image, in degrees. */
const ROTATIONS = [0, 90, 180, 270] as const;
type Rotation = typeof ROTATIONS[number];

/** Next quarter-turn in the cycle; indexing the canonical tuple keeps the
 *  result a `Rotation` without asserting modular arithmetic into the union. */
function nextRotation(prev: Rotation, deltaDeg: 90 | -90): Rotation {
  const step = deltaDeg === 90 ? 1 : ROTATIONS.length - 1;
  return ROTATIONS[(ROTATIONS.indexOf(prev) + step) % ROTATIONS.length];
}

type Tool = 'text' | 'adjust';

/**
 * Identifies the exact file being edited so "Save" can overwrite it in place.
 * When absent, only "Save as new version" is offered.
 */
export type OverwriteTarget =
  | { kind: 'processed'; id: string }
  | { kind: 'telescope'; path: string };

interface Props {
  imageUrl: string;
  imageName: string;
  objectId: string;
  /** The night the picture belongs to. Null for one that belongs to no single night (opened from an object page):
   *  "Save as new" then adds a processed image to the object itself. */
  date: string | null;
  isDark: boolean;
  /** Where the saved result lands: 'telescope' → library folder, 'processed' → processed images. */
  sourceKind: 'telescope' | 'processed';
  /** When set, enables a "Save" button that overwrites this file in place. */
  overwriteTarget?: OverwriteTarget;
  onClose: () => void;
  onSaved: () => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const FONTS = [
  { labelKey: 'imageEditorModal.fonts.sansSerif', value: 'Arial, sans-serif' },
  { labelKey: 'imageEditorModal.fonts.serif',      value: 'Georgia, serif' },
  { labelKey: 'imageEditorModal.fonts.monospace',  value: "'Courier New', monospace" },
  { labelKey: 'imageEditorModal.fonts.impact',     value: 'Impact, fantasy' },
];

const LINE_HEIGHT_RATIO = 1.35;
const HANDLE_SIZE = 8; // px for crop handle squares

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function clamp(v: number, lo = 0, hi = 1) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Map a normalized crop rect expressed in the ROTATED (on-screen) image space
 * back to the original image's normalized space, so it can be used as a
 * `drawImage` source rectangle. The crop tool always works in the space the
 * user sees, which is the rotated one.
 */
function cropToSourceRect(crop: CropRect, rotation: Rotation): CropRect {
  const { x1, y1, x2, y2 } = crop;
  switch (rotation) {
    case 90:  return { x1: y1,     y1: 1 - x2, x2: y2,     y2: 1 - x1 };
    case 180: return { x1: 1 - x2, y1: 1 - y2, x2: 1 - x1, y2: 1 - y1 };
    case 270: return { x1: 1 - y2, y1: x1,     x2: 1 - y1, y2: x2 };
    default:  return { x1, y1, x2, y2 };
  }
}

/**
 * Set up `ctx` so a subsequent `drawImage` into a `destW`×`destH` rect lands
 * on `canvasW`×`canvasH` rotated clockwise by `rotation` and optionally
 * flipped. Returns the dest rect to draw into (swapped for 90°/270°). The
 * caller is responsible for `ctx.save()` / `ctx.restore()`.
 */
function applyImageTransform(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  canvasH: number,
  rotation: Rotation,
  flipH: boolean,
  flipV: boolean,
): { destW: number; destH: number } {
  if (rotation === 90)  { ctx.translate(canvasW, 0);       ctx.rotate(Math.PI / 2); }
  else if (rotation === 180) { ctx.translate(canvasW, canvasH); ctx.rotate(Math.PI); }
  else if (rotation === 270) { ctx.translate(0, canvasH);       ctx.rotate(-Math.PI / 2); }

  const rot90 = rotation === 90 || rotation === 270;
  const destW = rot90 ? canvasH : canvasW;
  const destH = rot90 ? canvasW : canvasH;

  if (flipH || flipV) {
    ctx.translate(flipH ? destW : 0, flipV ? destH : 0);
    ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  }
  return { destW, destH };
}

function applyPixelAdjustments(
  data: Uint8ClampedArray,
  brightness: number,
  contrast: number,
  saturation: number,
) {
  if (brightness === 0 && contrast === 0 && saturation === 0) return;
  const br  = brightness / 100;
  const con = (contrast + 100) / 100;   // 0–2
  const sat = (saturation + 100) / 100; // 0–2

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i]     / 255;
    let g = data[i + 1] / 255;
    let b = data[i + 2] / 255;

    // brightness
    r += br; g += br; b += br;
    // saturation
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    r = gray + sat * (r - gray);
    g = gray + sat * (g - gray);
    b = gray + sat * (b - gray);
    // contrast (pivot at 0.5)
    r = (r - 0.5) * con + 0.5;
    g = (g - 0.5) * con + 0.5;
    b = (b - 0.5) * con + 0.5;

    data[i]     = Math.max(0, Math.min(255, r * 255));
    data[i + 1] = Math.max(0, Math.min(255, g * 255));
    data[i + 2] = Math.max(0, Math.min(255, b * 255));
  }
}

// Pixel coords from a mouse event relative to the canvas element
function eventToCanvasPx(
  canvas: HTMLCanvasElement, e: { clientX: number; clientY: number },
): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  const scaleX = canvas.width  / r.width;
  const scaleY = canvas.height / r.height;
  return { x: (e.clientX - r.left) * scaleX, y: (e.clientY - r.top) * scaleY };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ImageEditorModal({ imageUrl, imageName, objectId, date, isDark, sourceKind, overwriteTarget, onClose, onSaved }: Props) {
  const { t } = useTranslation('library');
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef       = useRef<HTMLImageElement | null>(null);
  const rootRef      = useRef<HTMLDivElement | null>(null);

  // Image loading
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError,  setImgError]  = useState(false);

  // Active tool
  const [activeTool, setActiveTool] = useState<Tool>('adjust');
  // Crop is a mode of the Adjust tab: while on, the canvas draws and drags the crop box instead of selecting text.
  const [cropping, setCropping] = useState(false);
  const cropMode = activeTool === 'adjust' && cropping;

  // Text layers
  const [textLayers, setTextLayers] = useState<TextLayer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Ref used in the sidebar→layer sync effect so selectedId isn't a dep
  // (we push style changes into the selected layer, not the other way around).
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  // Sidebar text settings
  const [tText,    setTText]    = useState('');
  const [tSize,    setTSize]    = useState(36);
  const [tFont,    setTFont]    = useState(FONTS[0].value);
  const [tColor,   setTColor]   = useState('#ffffff');
  const [tBold,    setTBold]    = useState(false);
  const [tItalic,  setTItalic]  = useState(false);
  const [tOpacity, setTOpacity] = useState(100);
  const [tAlign,   setTAlign]   = useState<'left' | 'center' | 'right'>('left');
  const [tAngle,   setTAngle]   = useState(0);

  // Crop
  const [cropDraft,   setCropDraft]   = useState<CropRect | null>(null);
  const [appliedCrop, setAppliedCrop] = useState<CropRect | null>(null);
  const cropHandleRef = useRef<CropHandle>('new');
  const cropDragStartRef = useRef<{ mouseX: number; mouseY: number; crop: CropRect } | null>(null);

  // Adjustments
  const [adj, setAdj] = useState<Adjustments>({ brightness: 0, contrast: 0, saturation: 0 });
  // While held, the preview shows the picture without the Adjust sliders, to judge what they did.
  const [comparing, setComparing] = useState(false);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [rotation, setRotation] = useState<Rotation>(0);

  // Text drag
  const isDragging   = useRef(false);
  const dragId       = useRef<string | null>(null);
  const dragOffset   = useRef({ dx: 0, dy: 0 });

  // Save
  const [savingMode, setSavingMode] = useState<'new' | 'overwrite' | null>(null);
  const saving = savingMode !== null;
  const defaultSaveTitle = `${imageName.replace(/\.[^.]+$/, '')} ${t('imageEditorModal.save.editedSuffix')}`;
  const [saveTitle, setSaveTitle] = useState(defaultSaveTitle);
  const [saveError, setSaveError] = useState('');
  // Reset the (user-editable) save title if the image being edited changes.
  // Render-phase adjustment instead of an effect, so no extra render.
  const [titleSeed, setTitleSeed] = useState(imageName);
  if (imageName !== titleSeed) {
    setTitleSeed(imageName);
    setSaveTitle(defaultSaveTitle);
  }

  // Watermark presets. Local `presetsOverride` carries an optimistic edit
  // (add/delete) until it either fails (revert) or succeeds (cleared, so the
  // next render reads the freshly-invalidated query — no useEffect syncing
  // query data into local state, and no unconfirmed write can outlive its
  // mutation the way a cache-hack setQueryData could).
  const queryClient = useQueryClient();
  const {
    data: serverPresets = [],
    isLoading: presetsLoading,
    isError: presetsQueryError,
  } = useQuery({
    queryKey: ['watermark-presets'],
    queryFn: getWatermarkPresets,
    staleTime: 5 * 60_000,
  });
  const [presetsOverride, setPresetsOverride] = useState<WatermarkPreset[] | null>(null);
  const presets = presetsOverride ?? serverPresets;
  const [savePresetName, setSavePresetName] = useState('');
  const [showSavePreset, setShowSavePreset] = useState(false);

  // ── Init ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload  = () => { if (!cancelled) { imgRef.current = img; setImgLoaded(true); } };
    img.onerror = () => { if (!cancelled) setImgError(true); };
    img.src = imageUrl;
    return () => { cancelled = true; img.onload = null; img.onerror = null; };
  }, [imageUrl]);


  // ── Canvas sizing ─────────────────────────────────────────────────────────

  const sizeCanvas = useCallback(() => {
    const canvas    = canvasRef.current;
    const img       = imgRef.current;
    const container = containerRef.current;
    if (!canvas || !img || !container) return;

    const { clientWidth: cw, clientHeight: ch } = container;
    // The canvas matches what the user will actually get: the image rotated,
    // then cropped in that rotated view. Both steps feed the aspect ratio so
    // the preview never stretches.
    const rot90 = rotation === 90 || rotation === 270;
    const baseW = rot90 ? img.naturalHeight : img.naturalWidth;
    const baseH = rot90 ? img.naturalWidth : img.naturalHeight;
    const cropW = appliedCrop ? (appliedCrop.x2 - appliedCrop.x1) : 1;
    const cropH = appliedCrop ? (appliedCrop.y2 - appliedCrop.y1) : 1;
    const aspect = (baseW * cropW) / (baseH * cropH);
    let w = cw, h = cw / aspect;
    if (h > ch) { h = ch; w = ch * aspect; }
    // Cap DPR at 2: beyond that the per-pixel adjustment loop (getImageData →
    // applyPixelAdjustments → putImageData, run on every slider tick) grows
    // fast with no visible gain on the preview.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width  = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width  = Math.floor(w) + 'px';
    canvas.style.height = Math.floor(h) + 'px';
  }, [rotation, appliedCrop]);

  // ── Drawing helpers ───────────────────────────────────────────────────────

  const measureText = useCallback((
    ctx: CanvasRenderingContext2D,
    layer: TextLayer,
  ): { maxWidth: number; lineHeight: number; numLines: number } => {
    const lines = layer.text.split('\n');
    ctx.font = `${layer.italic ? 'italic ' : ''}${layer.bold ? 'bold ' : ''}${layer.fontSize}px ${layer.fontFamily}`;
    const maxWidth  = Math.max(...lines.map(l => ctx.measureText(l).width), 1);
    const lineHeight = layer.fontSize * LINE_HEIGHT_RATIO;
    return { maxWidth, lineHeight, numLines: lines.length };
  }, []);

  const drawTextLayer = useCallback((
    ctx: CanvasRenderingContext2D,
    layer: TextLayer,
    cw: number,
    ch: number,
    selected: boolean,
  ) => {
    const lines = layer.text.split('\n');
    const lineHeight = layer.fontSize * LINE_HEIGHT_RATIO;

    ctx.save();
    ctx.globalAlpha = layer.opacity / 100;
    ctx.font = `${layer.italic ? 'italic ' : ''}${layer.bold ? 'bold ' : ''}${layer.fontSize}px ${layer.fontFamily}`;
    ctx.fillStyle   = layer.color;
    ctx.textAlign   = layer.align;
    ctx.textBaseline = 'alphabetic';
    ctx.shadowColor  = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur   = 6;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;

    ctx.translate(layer.x * cw, layer.y * ch);
    ctx.rotate(layer.angle * Math.PI / 180);

    lines.forEach((line, i) => {
      ctx.fillText(line, 0, i * lineHeight);
    });

    if (selected) {
      const { maxWidth } = measureText(ctx, layer);
      const totalH = lines.length * lineHeight;
      let bx = 0;
      if (layer.align === 'center') bx = -maxWidth / 2;
      if (layer.align === 'right')  bx = -maxWidth;

      ctx.shadowColor = 'transparent';
      ctx.shadowBlur  = 0;
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#60a5fa';
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(bx - 5, -layer.fontSize - 4, maxWidth + 10, totalH + 8);
      ctx.setLineDash([]);
    }

    ctx.restore();
  }, [measureText]);

  const drawCropOverlay = useCallback((
    ctx: CanvasRenderingContext2D,
    crop: CropRect,
    cw: number,
    ch: number,
  ) => {
    const x1 = Math.min(crop.x1, crop.x2) * cw;
    const y1 = Math.min(crop.y1, crop.y2) * ch;
    const x2 = Math.max(crop.x1, crop.x2) * cw;
    const y2 = Math.max(crop.y1, crop.y2) * ch;
    const w  = x2 - x1, h = y2 - y1;

    // dim outside
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, cw, y1);
    ctx.fillRect(0, y2, cw, ch - y2);
    ctx.fillRect(0, y1, x1, h);
    ctx.fillRect(x2, y1, cw - x2, h);

    // border
    ctx.strokeStyle = '#60a5fa';
    ctx.lineWidth   = 2;
    ctx.strokeRect(x1, y1, w, h);

    // rule-of-thirds
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    for (let i = 1; i <= 2; i++) {
      ctx.moveTo(x1 + w * i / 3, y1); ctx.lineTo(x1 + w * i / 3, y2);
      ctx.moveTo(x1, y1 + h * i / 3); ctx.lineTo(x2, y1 + h * i / 3);
    }
    ctx.stroke();

    // corner + edge handles
    const hs = HANDLE_SIZE;
    const handles: [number, number][] = [
      [x1, y1], [x1 + w / 2, y1], [x2, y1],
      [x2, y1 + h / 2],
      [x2, y2], [x1 + w / 2, y2], [x1, y2],
      [x1, y1 + h / 2],
    ];
    handles.forEach(([hx, hy]) => {
      ctx.fillStyle   = '#fff';
      ctx.strokeStyle = '#60a5fa';
      ctx.lineWidth   = 1.5;
      ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
      ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
    });
  }, []);

  // ── Main draw ─────────────────────────────────────────────────────────────

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img    = imgRef.current;
    if (!canvas || !img || !imgLoaded) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width: cw, height: ch } = canvas;
    ctx.clearRect(0, 0, cw, ch);

    // ── image ──
    ctx.save();
    const { destW, destH } = applyImageTransform(ctx, cw, ch, rotation, flipH, flipV);
    const src = appliedCrop
      ? cropToSourceRect(appliedCrop, rotation)
      : { x1: 0, y1: 0, x2: 1, y2: 1 };
    ctx.drawImage(img,
      src.x1 * img.naturalWidth, src.y1 * img.naturalHeight,
      (src.x2 - src.x1) * img.naturalWidth, (src.y2 - src.y1) * img.naturalHeight,
      0, 0, destW, destH);
    ctx.restore();

    // pixel-based adjustments (works in all browsers)
    if (!comparing && (adj.brightness !== 0 || adj.contrast !== 0 || adj.saturation !== 0)) {
      const id = ctx.getImageData(0, 0, cw, ch);
      applyPixelAdjustments(id.data, adj.brightness, adj.contrast, adj.saturation);
      ctx.putImageData(id, 0, 0);
    }

    // ── text layers ──
    textLayers.forEach(l => drawTextLayer(ctx, l, cw, ch, l.id === selectedId));

    // ── crop overlay ──
    if (cropDraft && cropMode) {
      drawCropOverlay(ctx, cropDraft, cw, ch);
    }
  }, [imgLoaded, flipH, flipV, rotation, appliedCrop, adj, comparing, textLayers, selectedId, cropDraft, cropMode, drawTextLayer, drawCropOverlay]);

  // Coalesce redraws into one animation frame. Slider onChange fires at pointer
  // rate (60-120Hz) and each draw() runs a full-frame getImageData/pixel-loop/
  // putImageData pass, so without this a retina drag queues dozens of redundant
  // passes per visible frame.
  const drawRafRef = useRef<number | null>(null);
  // The frame runs the newest draw, not the one that scheduled it. A change that arrives while a frame is already
  // waiting (a slider also updates the selected text layer one render later) is not scheduled again, so a draw
  // captured at scheduling time would paint the previous values and the preview would trail the controls.
  const drawRef = useRef(draw);
  useEffect(() => { drawRef.current = draw; });
  const scheduleDraw = useCallback(() => {
    if (drawRafRef.current != null) return;
    drawRafRef.current = requestAnimationFrame(() => {
      drawRafRef.current = null;
      drawRef.current();
    });
  }, []);
  useEffect(() => () => {
    if (drawRafRef.current != null) cancelAnimationFrame(drawRafRef.current);
  }, []);

  // Size canvas then draw when image first loads
  useEffect(() => {
    if (!imgLoaded) return;
    sizeCanvas();
    draw();
  }, [imgLoaded, sizeCanvas, draw]);

  // Redraw on every state change (coalesced to one frame)
  useEffect(() => { scheduleDraw(); }, [scheduleDraw, draw]);

  // ── Crop hit-testing ──────────────────────────────────────────────────────

  const getCropHandle = useCallback((px: number, py: number, crop: CropRect, cw: number, ch: number): CropHandle => {
    const x1 = Math.min(crop.x1, crop.x2) * cw;
    const y1 = Math.min(crop.y1, crop.y2) * ch;
    const x2 = Math.max(crop.x1, crop.x2) * cw;
    const y2 = Math.max(crop.y1, crop.y2) * ch;
    const w  = x2 - x1, h = y2 - y1;
    const T  = HANDLE_SIZE + 4; // tolerance in px

    const near = (ax: number, ay: number) => Math.abs(px - ax) <= T && Math.abs(py - ay) <= T;

    if (near(x1,           y1))           return 'nw';
    if (near(x1 + w / 2,   y1))           return 'n';
    if (near(x2,           y1))           return 'ne';
    if (near(x2,           y1 + h / 2))   return 'e';
    if (near(x2,           y2))           return 'se';
    if (near(x1 + w / 2,   y2))           return 's';
    if (near(x1,           y2))           return 'sw';
    if (near(x1,           y1 + h / 2))   return 'w';
    if (px >= x1 && px <= x2 && py >= y1 && py <= y2) return 'move';
    return 'new';
  }, []);

  // ── Text hit-testing ──────────────────────────────────────────────────────

  const hitTestText = useCallback((px: number, py: number, canvas: HTMLCanvasElement): TextLayer | null => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const cw = canvas.width, ch = canvas.height;

    for (let i = textLayers.length - 1; i >= 0; i--) {
      const l     = textLayers[i];
      const cx    = l.x * cw, cy = l.y * ch;
      const angle = l.angle * Math.PI / 180;

      // Transform mouse into text-local space (un-rotate around anchor)
      const dx  =  (px - cx), dy = (py - cy);
      const cos = Math.cos(-angle), sin = Math.sin(-angle);
      const lx  = cos * dx - sin * dy;
      const ly  = sin * dx + cos * dy;

      const { maxWidth, lineHeight, numLines } = measureText(ctx, l);
      const totalH = numLines * lineHeight;
      let bx = 0;
      if (l.align === 'center') bx = -maxWidth / 2;
      if (l.align === 'right')  bx = -maxWidth;

      const boxX1 = bx - 8, boxX2 = bx + maxWidth + 8;
      const boxY1 = -l.fontSize - 8, boxY2 = totalH - l.fontSize + 8;

      if (lx >= boxX1 && lx <= boxX2 && ly >= boxY1 && ly <= boxY2) return l;
    }
    return null;
  }, [textLayers, measureText]);

  // ── Load a layer's settings into the sidebar ──────────────────────────────

  const loadLayerIntoSidebar = (l: TextLayer) => {
    setTText(l.text); setTSize(l.fontSize); setTFont(l.fontFamily);
    setTColor(l.color); setTBold(l.bold); setTItalic(l.italic);
    setTOpacity(l.opacity); setTAlign(l.align); setTAngle(l.angle);
  };

  // ── Mouse events ──────────────────────────────────────────────────────────

  const getCropCursor = (handle: CropHandle): string => {
    const map: Record<CropHandle, string> = {
      new: 'crosshair', move: 'move',
      nw: 'nw-resize', n: 'ns-resize', ne: 'ne-resize',
      e: 'ew-resize', se: 'se-resize', s: 'ns-resize',
      sw: 'sw-resize', w: 'ew-resize',
    };
    return map[handle];
  };

  const [canvasCursor, setCanvasCursor] = useState<string>('crosshair');

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { x: px, y: py } = eventToCanvasPx(canvas, e);
    const { width: cw, height: ch } = canvas;

    // ── crop mode ──
    if (cropMode) {
      if (cropDraft) {
        const handle = getCropHandle(px, py, cropDraft, cw, ch);
        cropHandleRef.current     = handle;
        cropDragStartRef.current  = { mouseX: px, mouseY: py, crop: { ...cropDraft } };
      } else {
        cropHandleRef.current     = 'new';
        setCanvasCursor('crosshair');
        cropDragStartRef.current  = { mouseX: px, mouseY: py, crop: { x1: px / cw, y1: py / ch, x2: px / cw, y2: py / ch } };
        setCropDraft({ x1: px / cw, y1: py / ch, x2: px / cw, y2: py / ch });
      }
      return;
    }

    // ── text hit test (works in any tool) ──
    const hit = hitTestText(px, py, canvas);
    if (hit) {
      setSelectedId(hit.id);
      isDragging.current = true;
      dragId.current     = hit.id;
      dragOffset.current = { dx: px / cw - hit.x, dy: py / ch - hit.y };
      loadLayerIntoSidebar(hit);
      return;
    }

    // Text is only added from the panel's Add buttons, so a click on empty picture just deselects.
    setSelectedId(null);
  };

  const onMouseMove = (e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { x: px, y: py } = eventToCanvasPx(canvas, e);
    const { width: cw, height: ch } = canvas;

    // Update cursor during crop hover
    if (cropMode) {
      if (cropDraft && !cropDragStartRef.current) {
        const h = getCropHandle(px, py, cropDraft, cw, ch);
        setCanvasCursor(getCropCursor(h));
      }
    }

    // ── crop drag ──
    if (cropMode && cropDragStartRef.current) {
      const { mouseX: mx0, mouseY: my0, crop: c0 } = cropDragStartRef.current;
      const handle = cropHandleRef.current;
      const dx = (px - mx0) / cw, dy = (py - my0) / ch;

      let { x1, y1, x2, y2 } = c0;

      switch (handle) {
        case 'new':  x2 = clamp(c0.x1 + (px - mx0) / cw); y2 = clamp(c0.y1 + (py - my0) / ch); break;
        case 'move':
          x1 = clamp(c0.x1 + dx); y1 = clamp(c0.y1 + dy);
          x2 = clamp(c0.x2 + dx); y2 = clamp(c0.y2 + dy);
          // keep within bounds when moving
          if (x1 < 0)  { x2 -= x1; x1 = 0; }
          if (x2 > 1)  { x1 -= x2 - 1; x2 = 1; }
          if (y1 < 0)  { y2 -= y1; y1 = 0; }
          if (y2 > 1)  { y1 -= y2 - 1; y2 = 1; }
          break;
        case 'nw': x1 = clamp(c0.x1 + dx); y1 = clamp(c0.y1 + dy); break;
        case 'n':  y1 = clamp(c0.y1 + dy); break;
        case 'ne': x2 = clamp(c0.x2 + dx); y1 = clamp(c0.y1 + dy); break;
        case 'e':  x2 = clamp(c0.x2 + dx); break;
        case 'se': x2 = clamp(c0.x2 + dx); y2 = clamp(c0.y2 + dy); break;
        case 's':  y2 = clamp(c0.y2 + dy); break;
        case 'sw': x1 = clamp(c0.x1 + dx); y2 = clamp(c0.y2 + dy); break;
        case 'w':  x1 = clamp(c0.x1 + dx); break;
        default: {
          // A new CropHandle must define how it moves the rect; without this
          // the drag would silently do nothing.
          const _exhaustive: never = handle;
          void _exhaustive;
        }
      }

      setCropDraft({ x1, y1, x2, y2 });
      return;
    }

    // ── text drag ──
    if (isDragging.current && dragId.current) {
      const nx = clamp(px / cw - dragOffset.current.dx);
      const ny = clamp(py / ch - dragOffset.current.dy);
      setTextLayers(prev => prev.map(l =>
        l.id === dragId.current ? { ...l, x: nx, y: ny } : l,
      ));
    }
  };

  const onMouseUp = () => {
    if (cropDragStartRef.current) {
      cropDragStartRef.current = null;
    }
    isDragging.current = false;
    dragId.current     = null;
  };

  // The editor opens over the viewer it was launched from. Take focus off that viewer's toolbar, and hand it
  // back on close so keyboard users land where they were.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    rootRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  // Move and release are tracked on the window, not the canvas: a fast drag leaves the canvas
  // before the next mousemove lands on it, and a mouseup outside it would never arrive, leaving
  // the crop box or text label stuck to the cursor's last position.
  useEffect(() => {
    const move = (e: MouseEvent) => onMouseMove(e);
    const up = () => onMouseUp();
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  });

  // ── Sidebar → selected layer sync ─────────────────────────────────────────

  useEffect(() => {
    const id = selectedIdRef.current;
    if (!id) return;
    setTextLayers(prev => prev.map(l =>
      l.id === id
        ? { ...l, text: tText, fontSize: tSize, fontFamily: tFont, color: tColor,
            bold: tBold, italic: tItalic, opacity: tOpacity, align: tAlign, angle: tAngle }
        : l,
    ));
  }, [tText, tSize, tFont, tColor, tBold, tItalic, tOpacity, tAlign, tAngle]);

  // ── Crop actions ──────────────────────────────────────────────────────────

  const confirmCrop = useCallback(() => {
    if (!cropDraft) return;
    const crop: CropRect = {
      x1: Math.min(cropDraft.x1, cropDraft.x2),
      y1: Math.min(cropDraft.y1, cropDraft.y2),
      x2: Math.max(cropDraft.x1, cropDraft.x2),
      y2: Math.max(cropDraft.y1, cropDraft.y2),
    };
    if (crop.x2 - crop.x1 < 0.01 || crop.y2 - crop.y1 < 0.01) return;
    setAppliedCrop(crop);
    setCropDraft(null);
    // Re-anchor text positions to cropped space
    setTextLayers(prev => prev.map(l => ({
      ...l,
      x: (l.x - crop.x1) / (crop.x2 - crop.x1),
      y: (l.y - crop.y1) / (crop.y2 - crop.y1),
    })));
    setCropping(false);
  }, [cropDraft]);

  const resetCrop = () => { setCropDraft(null); setAppliedCrop(null); };
  const cancelCrop = () => { setCropDraft(null); setCropping(false); };

  // ── Rotate ────────────────────────────────────────────────────────────────

  const rotateBy = (deltaDeg: 90 | -90) => {
    setRotation(prev => nextRotation(prev, deltaDeg));
    // A crop rect is stored in the pre-rotation on-screen space; rotating would
    // reinterpret it against the new axes. Drop it rather than smear the image.
    setCropDraft(null);
    setAppliedCrop(null);
  };

  // ── Watermark helpers ─────────────────────────────────────────────────────

  // New text in the middle of the picture, styled like the last text edited but always starting with the placeholder
  // (the sidebar's own text is whatever label was last selected, such as a © watermark). Selecting it opens its controls.
  const addText = () => {
    const layer: TextLayer = {
      id: crypto.randomUUID(),
      text: t('imageEditorModal.textPanel.defaultText'),
      x: 0.5, y: 0.5,
      fontSize: tSize, fontFamily: tFont, color: tColor,
      bold: tBold, italic: tItalic, opacity: tOpacity, align: 'center', angle: tAngle,
    };
    setTextLayers(prev => [...prev, layer]);
    setSelectedId(layer.id);
    loadLayerIntoSidebar(layer);
  };

  const addWatermark = () => {
    const layer: TextLayer = {
      id: crypto.randomUUID(),
      text: `© ${new Date().getFullYear()}`,
      x: 0.03, y: 0.93,
      fontSize: 20, fontFamily: FONTS[0].value, color: '#ffffff',
      bold: false, italic: false, opacity: 70, align: 'left', angle: 0,
    };
    setTextLayers(prev => [...prev, layer]);
    setSelectedId(layer.id);
    loadLayerIntoSidebar(layer);
    setActiveTool('text');
  };

  const applyPreset = (p: WatermarkPreset) => {
    // Place the preset text on the canvas at a default position so the user
    // can immediately drag it where they want.
    const layer: TextLayer = {
      id: crypto.randomUUID(),
      text: p.text,
      x: 0.5, y: 0.9,        // start centered near bottom
      fontSize: p.fontSize,
      fontFamily: p.fontFamily,
      color: p.color,
      bold: p.bold,
      italic: p.italic,
      opacity: p.opacity,
      align: p.align,
      angle: p.angle,
    };
    setTextLayers(prev => [...prev, layer]);
    setSelectedId(layer.id);
    loadLayerIntoSidebar(layer);
    setActiveTool('text');
  };

  const saveAsPreset = async () => {
    const name = savePresetName.trim();
    if (!name) return;
    const preset: WatermarkPreset = {
      id: crypto.randomUUID(),
      name, text: tText, fontSize: tSize, fontFamily: tFont,
      color: tColor, bold: tBold, italic: tItalic, opacity: tOpacity, align: tAlign, angle: tAngle,
    };
    const updated = [...presets, preset];
    setPresetsOverride(updated);
    setSavePresetName('');
    setShowSavePreset(false);
    try {
      await saveWatermarkPresets(updated);
      // Await the refetch before dropping the override, otherwise `presets`
      // falls back to the stale server list for the duration of the refetch
      // and the just-saved preset visibly disappears then reappears.
      await queryClient.invalidateQueries({ queryKey: ['watermark-presets'] });
      setPresetsOverride(null);
    } catch {
      // Roll back the optimistic update — otherwise the sidebar shows a
      // preset that was never actually persisted, and it silently vanishes
      // next time the list reloads from the server.
      setPresetsOverride(null);
      setSaveError(t('imageEditorModal.presets.saveFailed'));
    }
  };

  const deletePreset = async (id: string) => {
    const updated = presets.filter(p => p.id !== id);
    setPresetsOverride(updated);
    try {
      await saveWatermarkPresets(updated);
      await queryClient.invalidateQueries({ queryKey: ['watermark-presets'] });
      setPresetsOverride(null);
    } catch {
      setPresetsOverride(null);
      setSaveError(t('imageEditorModal.presets.deleteFailed'));
    }
  };

  // ── Save ──────────────────────────────────────────────────────────────────

  const handleSave = async (mode: 'new' | 'overwrite') => {
    const img     = imgRef.current;
    const display = canvasRef.current;
    if (!img || !display) return;
    if (mode === 'overwrite' && !overwriteTarget) return;

    setSavingMode(mode);
    setSaveError('');
    try {
      const offscreen = document.createElement('canvas');
      const src = appliedCrop
        ? cropToSourceRect(appliedCrop, rotation)
        : { x1: 0, y1: 0, x2: 1, y2: 1 };
      const sx = src.x1 * img.naturalWidth;
      const sy = src.y1 * img.naturalHeight;
      const sw = (src.x2 - src.x1) * img.naturalWidth;
      const sh = (src.y2 - src.y1) * img.naturalHeight;

      // Output dimensions follow the rotated source rect.
      const rot90 = rotation === 90 || rotation === 270;
      offscreen.width  = Math.round(rot90 ? sh : sw);
      offscreen.height = Math.round(rot90 ? sw : sh);
      const ctx = offscreen.getContext('2d');
      if (!ctx) throw new Error(t('imageEditorModal.save.exportFailed'));

      // Image
      ctx.save();
      const { destW, destH } = applyImageTransform(
        ctx, offscreen.width, offscreen.height, rotation, flipH, flipV,
      );
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, destW, destH);
      ctx.restore();

      // Pixel adjustments at full res
      if (adj.brightness !== 0 || adj.contrast !== 0 || adj.saturation !== 0) {
        const id = ctx.getImageData(0, 0, offscreen.width, offscreen.height);
        applyPixelAdjustments(id.data, adj.brightness, adj.contrast, adj.saturation);
        ctx.putImageData(id, 0, 0);
      }

      // Text layers at full resolution
      const scaleX = offscreen.width  / display.width;
      const scaleY = offscreen.height / display.height;
      const scale  = Math.min(scaleX, scaleY);

      textLayers.forEach(layer => {
        const lines      = layer.text.split('\n');
        const fs         = layer.fontSize * scale;
        const lineHeight = fs * LINE_HEIGHT_RATIO;

        ctx.save();
        ctx.globalAlpha  = layer.opacity / 100;
        ctx.font         = `${layer.italic ? 'italic ' : ''}${layer.bold ? 'bold ' : ''}${fs}px ${layer.fontFamily}`;
        ctx.fillStyle    = layer.color;
        ctx.textAlign    = layer.align;
        ctx.textBaseline = 'alphabetic';
        ctx.shadowColor  = 'rgba(0,0,0,0.85)';
        ctx.shadowBlur   = 6 * scale;
        ctx.shadowOffsetX = scale;
        ctx.shadowOffsetY = scale;

        ctx.translate(layer.x * offscreen.width, layer.y * offscreen.height);
        ctx.rotate(layer.angle * Math.PI / 180);
        lines.forEach((line, i) => ctx.fillText(line, 0, i * lineHeight));
        ctx.restore();
      });

      const blob = await new Promise<Blob>((resolve, reject) =>
        offscreen.toBlob(b => b ? resolve(b) : reject(new Error(t('imageEditorModal.save.exportFailed'))), 'image/jpeg', 0.93),
      );

      const title = saveTitle.trim() || `${imageName.replace(/\.[^.]+$/, '')} ${t('imageEditorModal.save.editedSuffix')}`;
      const file  = new File([blob], `${title}.jpg`, { type: 'image/jpeg' });

      if (mode === 'overwrite' && overwriteTarget) {
        if (overwriteTarget.kind === 'processed') {
          await overwriteProcessedImage(objectId, overwriteTarget.id, file);
        } else if (date) {
          await uploadLibraryFile(objectId, date, file, overwriteTarget.path, !!appliedCrop || rotation !== 0 || flipH || flipV);
        } else {
          // An original can only be replaced inside its own night; callers do not offer this without one.
          throw new Error(t('imageEditorModal.save.saveFailed'));
        }
      } else if (!date) {
        await uploadObjectProcessedImage(objectId, file);
      } else if (sourceKind === 'telescope') {
        await uploadLibraryFile(objectId, date, file);
      } else {
        await uploadProcessedImage(objectId, date, file, title, 'Created with image editor');
      }

      onSaved();
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('imageEditorModal.save.saveFailed'));
    } finally {
      setSavingMode(null);
    }
  };

  // ── Keyboard ──────────────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId &&
          !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        setTextLayers(prev => prev.filter(l => l.id !== selectedId));
        setSelectedId(null);
      }
      if (e.key === 'Enter' && cropMode && cropDraft) {
        confirmCrop();
      }
    };
    const isTyping = (e: KeyboardEvent) =>
      e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    const onCompareDown = (e: KeyboardEvent) => { if (e.key === '\\' && !isTyping(e)) setComparing(true); };
    const onCompareUp = (e: KeyboardEvent) => { if (e.key === '\\') setComparing(false); };
    const stopComparing = () => setComparing(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onCompareDown);
    window.addEventListener('keyup', onCompareUp);
    window.addEventListener('blur', stopComparing);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onCompareDown);
      window.removeEventListener('keyup', onCompareUp);
      window.removeEventListener('blur', stopComparing);
    };
  }, [onClose, selectedId, cropMode, cropDraft, confirmCrop]);

  // ── Dynamic cursor for crop mode ──────────────────────────────────────────

  const canvasCursorStyle = cropMode
    ? (cropDraft ? canvasCursor : 'crosshair')
    : 'default';

  // ── Shared Tailwind helpers ───────────────────────────────────────────────

  const toolBtn = (active: boolean) =>
    `flex flex-col items-center gap-0.5 p-2 rounded-lg text-[0.625rem] font-medium transition ${
      active
        ? isDark ? 'bg-accent-500/20 text-accent-400' : 'bg-accent-300 text-accent-700'
        : isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'
    }`;

  const toggleBtn = (active: boolean) =>
    `flex-1 flex items-center justify-center py-1.5 rounded-lg text-xs font-medium transition ${
      active
        ? isDark ? 'bg-accent-500/20 text-accent-400' : 'bg-accent-300 text-accent-700'
        : isDark ? 'bg-slate-800 text-slate-400 hover:bg-slate-700' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
    }`;

  const inputCls = `w-full px-2 py-1.5 rounded-lg text-sm border ${
    isDark
      ? 'bg-slate-800 border-slate-700 text-slate-200 placeholder-slate-600'
      : 'bg-white border-slate-300 text-slate-700 placeholder-slate-400'
  }`;

  // Mirrors handleSave: a new version becomes a titled processed picture unless it is a raw file with a night.
  const titleUsed = sourceKind === 'processed' || !date;

  const label = `block text-xs font-medium mb-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`;

  // Measures the picture as it will be saved (rotation and crop included, adjustments not) on a
  // small copy, so the analysis is instant even for a 50 MP stack.
  const autoAdjust = () => {
    const img = imgRef.current;
    if (!img) return;
    const src = appliedCrop ? cropToSourceRect(appliedCrop, rotation) : { x1: 0, y1: 0, x2: 1, y2: 1 };
    const sx = src.x1 * img.naturalWidth, sy = src.y1 * img.naturalHeight;
    const sw = (src.x2 - src.x1) * img.naturalWidth, sh = (src.y2 - src.y1) * img.naturalHeight;
    const scale = Math.min(1, 512 / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
    const probe = document.createElement('canvas');
    probe.width = w; probe.height = h;
    const pctx = probe.getContext('2d', { willReadFrequently: true });
    if (!pctx) return;
    pctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
    setAdj(computeAutoAdjust(pctx.getImageData(0, 0, w, h).data));
  };

  const adjRow = (key: keyof Adjustments, display: string) => (
    <div key={key}>
      <label className={`flex justify-between text-xs font-medium mb-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
        <span>{display}</span>
        <span className={`tabular-nums ${adj[key] !== 0 ? (isDark ? 'text-slate-200' : 'text-slate-700') : (isDark ? 'text-slate-600' : 'text-slate-400')}`}>
          {adj[key] > 0 ? `+${adj[key]}` : adj[key]}
        </span>
      </label>
      <input type="range" min={-100} max={100} value={adj[key]}
        onChange={e => setAdj(p => ({ ...p, [key]: +e.target.value }))}
        className="w-full accent-accent-500"
      />
    </div>
  );

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      ref={rootRef}
      data-image-editor=""
      role="dialog"
      aria-modal="true"
      aria-label={t('imageEditorModal.header.title')}
      tabIndex={-1}
      className="image-editor-fade-in fixed inset-0 z-[95] bg-black/90 flex items-center justify-center outline-none"
    >
      <div className={`relative w-full max-w-[1400px] h-[96vh] mx-4 flex flex-col rounded-2xl overflow-hidden shadow-2xl ${isDark ? 'bg-slate-900' : 'bg-white'}`}>

        {/* Header */}
        <div className={`flex-shrink-0 flex items-center justify-between px-4 py-3 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          <div className="flex items-center gap-2 min-w-0">
            <Pencil className="w-4 h-4 text-accent-500 flex-shrink-0" />
            <span className={`font-semibold text-sm ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{t('imageEditorModal.header.title')}</span>
            <span className={`text-xs truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{t('imageEditorModal.header.namePrefix', { name: imageName })}</span>
          </div>
          <button onClick={onClose} className={`p-1.5 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 flex">

          {/* Canvas area */}
          <div ref={containerRef} className={`flex-1 min-w-0 flex items-center justify-center p-6 ${isDark ? 'bg-[#0d0d14]' : 'bg-slate-100'}`}>
            {imgError ? (
              <div className="text-center space-y-1">
                <p className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{t('imageEditorModal.loadError.failed')}</p>
                <p className={`text-xs ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>{t('imageEditorModal.loadError.retryHint')}</p>
              </div>
            ) : !imgLoaded ? (
              <Loader2 className="w-8 h-8 animate-spin text-slate-500" />
            ) : (
              <canvas
                ref={canvasRef}
                onMouseDown={onMouseDown}
                className="rounded-xl shadow-2xl select-none"
                style={{ maxWidth: '100%', maxHeight: '100%', cursor: canvasCursorStyle }}
              />
            )}
          </div>

          {/* Side panel */}
          <div className={`w-60 flex-shrink-0 flex flex-col border-l ${isDark ? 'border-slate-800 bg-slate-900' : 'border-slate-200 bg-white'}`}>

            {/* Tool selector */}
            <div className={`flex-shrink-0 p-3 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
              <div className="grid grid-cols-2 gap-1">
                <button onClick={() => setActiveTool('adjust')} className={toolBtn(activeTool === 'adjust')} title={t('imageEditorModal.tools.adjust')}>
                  <SlidersHorizontal className="w-4 h-4" />{t('imageEditorModal.tools.adjust')}
                </button>
                <button onClick={() => { cancelCrop(); setActiveTool('text'); }} className={toolBtn(activeTool === 'text')} title={t('imageEditorModal.tools.text')}>
                  <Type className="w-4 h-4" />{t('imageEditorModal.tools.text')}
                </button>
              </div>
            </div>

            {/* Tool options */}
            <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">

              {/* ── TEXT ── */}
              {activeTool === 'text' && (
                <>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button onClick={addText} className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition ${isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'}`}>
                      <Plus className="w-3.5 h-3.5 opacity-60" />{t('imageEditorModal.textPanel.addText')}
                    </button>
                    <button onClick={addWatermark} className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition ${isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'}`}>
                      <Type className="w-3.5 h-3.5 opacity-60" />{t('imageEditorModal.selectPanel.addWatermark')}
                    </button>
                  </div>
                  {textLayers.length > 0 && (
                    <div className="space-y-1">
                      <p className={`text-[0.625rem] font-semibold uppercase tracking-wider ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>{t('imageEditorModal.selectPanel.textLayers')}</p>
                      {textLayers.map(l => (
                        <button key={l.id} onClick={() => { setSelectedId(l.id); loadLayerIntoSidebar(l); }}
                          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition ${
                            l.id === selectedId
                              ? isDark ? 'bg-accent-500/15 text-accent-400' : 'bg-accent-300 text-accent-700'
                              : isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'
                          }`}
                        >
                          <span className="w-3 h-3 rounded-full flex-shrink-0 border border-slate-600" style={{ backgroundColor: l.color }} />
                          <span className="truncate flex-1 text-left">{(l.text || t('imageEditorModal.selectPanel.emptyLayerLabel')).replace(/\n/g, ' ')}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {textLayers.length > 0 && (
                    <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                      {t('imageEditorModal.selectPanel.hint')}
                    </p>
                  )}

                  {selectedId ? (
                    <>
                  <div>
                    <label className={label}>{t('imageEditorModal.textPanel.content')}</label>
                    <textarea value={tText} onChange={e => setTText(e.target.value)}
                      placeholder={t('imageEditorModal.textPanel.contentPlaceholder')} rows={3}
                      className={`${inputCls} resize-none`}
                    />
                  </div>

                  <div>
                    <label className={label}>{t('imageEditorModal.textPanel.font')}</label>
                    <select value={tFont} onChange={e => setTFont(e.target.value)} className={inputCls}>
                      {FONTS.map(f => <option key={f.value} value={f.value}>{t(f.labelKey)}</option>)}
                    </select>
                  </div>

                  <div>
                    <label className={label}>{t('imageEditorModal.textPanel.size')}</label>
                    <div className="flex items-center gap-2">
                      <button onClick={() => setTSize(s => Math.max(8, s - 4))} className={`w-8 h-8 rounded-lg text-lg font-bold flex items-center justify-center transition ${isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'}`}>−</button>
                      <span className={`flex-1 text-center text-sm tabular-nums font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{t('imageEditorModal.textPanel.sizeValue', { size: tSize })}</span>
                      <button onClick={() => setTSize(s => Math.min(250, s + 4))} className={`w-8 h-8 rounded-lg text-lg font-bold flex items-center justify-center transition ${isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'}`}>+</button>
                    </div>
                  </div>

                  <div>
                    <label className={`flex justify-between text-xs font-medium mb-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                      <span>{t('imageEditorModal.textPanel.angle')}</span>
                      <span className="tabular-nums">{tAngle > 0 ? `+${tAngle}` : tAngle}°</span>
                    </label>
                    <input type="range" min={-90} max={90} value={tAngle} onChange={e => setTAngle(+e.target.value)} className="w-full accent-accent-500" />
                  </div>

                  <div>
                    <label className={label}>{t('imageEditorModal.textPanel.color')}</label>
                    <div className="flex items-center gap-2">
                      <input type="color" value={tColor} onChange={e => setTColor(e.target.value)} className="w-8 h-8 rounded cursor-pointer border-0 bg-transparent" />
                      <span className={`text-xs font-mono ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{tColor}</span>
                      <div className="flex gap-1 ml-auto">
                        {['#ffffff', '#000000', '#facc15', '#f87171'].map(c => (
                          <button key={c} onClick={() => setTColor(c)} title={c}
                            className={`w-5 h-5 rounded-full border-2 transition ${tColor === c ? 'border-accent-500' : 'border-slate-600'}`}
                            style={{ backgroundColor: c }}
                          />
                        ))}
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className={label}>{t('imageEditorModal.textPanel.styleAndAlign')}</label>
                    <div className="flex gap-1">
                      <button onClick={() => setTBold(b => !b)} className={`${toggleBtn(tBold)} font-bold`}>B</button>
                      <button onClick={() => setTItalic(i => !i)} className={`${toggleBtn(tItalic)} italic`}>I</button>
                      <button onClick={() => setTAlign('left')}   className={toggleBtn(tAlign === 'left')}><AlignLeft   className="w-3 h-3" /></button>
                      <button onClick={() => setTAlign('center')} className={toggleBtn(tAlign === 'center')}><AlignCenter className="w-3 h-3" /></button>
                      <button onClick={() => setTAlign('right')}  className={toggleBtn(tAlign === 'right')}><AlignRight  className="w-3 h-3" /></button>
                    </div>
                  </div>

                  <div>
                    <label className={`flex justify-between text-xs font-medium mb-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                      <span>{t('imageEditorModal.textPanel.opacity')}</span><span className="tabular-nums">{tOpacity}%</span>
                    </label>
                    <input type="range" min={10} max={100} value={tOpacity} onChange={e => setTOpacity(+e.target.value)} className="w-full accent-accent-500" />
                  </div>

                  {selectedId && (
                    <button onClick={() => { setTextLayers(prev => prev.filter(l => l.id !== selectedId)); setSelectedId(null); }}
                      className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-red-400 bg-red-500/10 hover:bg-red-500/20 transition"
                    >
                      <Trash2 className="w-3.5 h-3.5" />{t('imageEditorModal.textPanel.deleteSelectedText')}
                    </button>
                  )}
                    </>
                  ) : (
                    <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                      {t('imageEditorModal.textPanel.noSelection')}
                    </p>
                  )}

                  {/* Watermark presets */}
                  <div className={`border-t pt-3 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className={`text-[0.625rem] font-semibold uppercase tracking-wider ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{t('imageEditorModal.presets.savedPresets')}</span>
                      <button onClick={() => setShowSavePreset(s => !s)} title={t('imageEditorModal.presets.saveAsPresetTitle')}
                        className={`p-1 rounded transition ${isDark ? 'hover:bg-slate-800 text-slate-500' : 'hover:bg-slate-100 text-slate-400'}`}>
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {showSavePreset && (
                      <div className="flex gap-1 mb-2">
                        <input value={savePresetName} onChange={e => setSavePresetName(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') saveAsPreset(); if (e.key === 'Escape') setShowSavePreset(false); }}
                          placeholder={t('imageEditorModal.presets.namePlaceholder')}
                          className={`flex-1 px-2 py-1 rounded-lg text-xs border ${isDark ? 'bg-slate-800 border-slate-700 text-slate-200 placeholder-slate-600' : 'bg-white border-slate-300 text-slate-700 placeholder-slate-400'}`}
                          autoFocus
                        />
                        <button onClick={saveAsPreset} disabled={!savePresetName.trim()}
                          className="px-2 py-1 rounded-lg text-xs font-medium bg-accent-500 text-white hover:bg-accent-600 disabled:opacity-40 transition">
                          <Check className="w-3 h-3" />
                        </button>
                      </div>
                    )}

                    {presetsLoading ? (
                      <Loader2 className="w-4 h-4 animate-spin text-slate-500 mx-auto" />
                    ) : presetsQueryError ? (
                      <p className="text-[0.625rem] text-red-400">
                        {t('imageEditorModal.presets.loadFailed')}
                      </p>
                    ) : presets.length === 0 ? (
                      <p className={`text-[0.625rem] ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                        {t('imageEditorModal.presets.empty')}
                      </p>
                    ) : (
                      <div className="space-y-1">
                        {presets.map(p => (
                          <div key={p.id} className={`flex items-center gap-1 px-2 py-1.5 rounded-lg ${isDark ? 'bg-slate-800/60' : 'bg-slate-50'}`}>
                            <span className={`flex-1 text-xs truncate ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{p.name}</span>
                            <button onClick={() => applyPreset(p)} title={t('imageEditorModal.presets.applyTitle')}
                              className={`p-1 rounded transition ${isDark ? 'hover:bg-slate-700 text-accent-400' : 'hover:bg-accent-50 text-accent-600'}`}>
                              <BookmarkCheck className="w-3 h-3" />
                            </button>
                            <button onClick={() => deletePreset(p.id)} title={t('imageEditorModal.presets.deleteTitle')}
                              className={`p-1 rounded transition text-red-400 ${isDark ? 'hover:bg-slate-700' : 'hover:bg-red-50'}`}>
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* ── CROP ── */}
              {/* ── ADJUST ── */}
              {cropMode && (
                <>
                  <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    {t('imageEditorModal.cropPanel.hint')}
                  </p>
                  {cropDraft && (
                    <button onClick={confirmCrop}
                      className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium bg-accent-500 text-white hover:bg-accent-600 transition">
                      <Check className="w-3.5 h-3.5" />{t('imageEditorModal.cropPanel.applyCrop')}
                    </button>
                  )}
                  <button onClick={cancelCrop}
                    className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition ${isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'}`}>
                    <X className="w-3.5 h-3.5" />{t('imageEditorModal.cropPanel.cancel')}
                  </button>
                </>
              )}

              {activeTool === 'adjust' && !cropMode && (
                <>
                  <button onClick={autoAdjust} title={t('imageEditorModal.adjustPanel.autoHint')}
                    className={`w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium transition-colors ${
                      isDark ? 'bg-accent-500/15 text-accent-400 hover:bg-accent-500/25' : 'bg-accent-500/10 text-accent-600 hover:bg-accent-500/20'
                    }`}>
                    <Wand2 className="w-3.5 h-3.5" />{t('imageEditorModal.adjustPanel.auto')}
                  </button>
                  <button
                    onPointerDown={() => setComparing(true)}
                    onPointerUp={() => setComparing(false)}
                    onPointerLeave={() => setComparing(false)}
                    onPointerCancel={() => setComparing(false)}
                    onContextMenu={e => e.preventDefault()}
                    aria-pressed={comparing}
                    title={t('imageEditorModal.adjustPanel.compareHint')}
                    className={`w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium select-none touch-none transition-colors ${
                      comparing
                        ? 'bg-accent-500 text-white'
                        : isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}>
                    <Eye className="w-3.5 h-3.5" />{t('imageEditorModal.adjustPanel.compare')}
                  </button>
                  {adjRow('brightness', t('imageEditorModal.adjustPanel.brightness'))}
                  {adjRow('contrast',   t('imageEditorModal.adjustPanel.contrast'))}
                  {adjRow('saturation', t('imageEditorModal.adjustPanel.saturation'))}

                  <div>
                    <p className={`text-xs font-medium mb-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{t('imageEditorModal.tools.crop')}</p>
                    <div className="flex gap-1">
                      <button onClick={() => setCropping(true)}
                        className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-xs font-medium transition ${isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'}`}>
                        <Crop className="w-3.5 h-3.5" />{appliedCrop ? t('imageEditorModal.cropPanel.cropApplied') : t('imageEditorModal.tools.crop')}
                      </button>
                      {appliedCrop && (
                        <button onClick={resetCrop} title={t('imageEditorModal.cropPanel.resetCrop')} aria-label={t('imageEditorModal.cropPanel.resetCrop')}
                          className={`flex items-center justify-center px-2.5 py-2 rounded-lg text-xs transition ${isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'}`}>
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  <div>
                    <p className={`flex justify-between text-xs font-medium mb-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                      <span>{t('imageEditorModal.adjustPanel.rotate')}</span>
                      {rotation !== 0 && <span className="tabular-nums">{rotation}°</span>}
                    </p>
                    <div className="flex gap-1">
                      <button onClick={() => rotateBy(-90)}
                        className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-xs font-medium transition ${isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'}`}
                      >
                        <RotateCcw className="w-3.5 h-3.5" />{t('imageEditorModal.adjustPanel.left')}
                      </button>
                      <button onClick={() => rotateBy(90)}
                        className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-xs font-medium transition ${isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'}`}
                      >
                        <RotateCw className="w-3.5 h-3.5" />{t('imageEditorModal.adjustPanel.right')}
                      </button>
                    </div>
                  </div>

                  <div>
                    <p className={`text-xs font-medium mb-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{t('imageEditorModal.adjustPanel.flip')}</p>
                    <div className="flex gap-1">
                      <button onClick={() => setFlipH(f => !f)}
                        className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-xs font-medium transition ${
                          flipH
                            ? isDark ? 'bg-accent-500/20 text-accent-400' : 'bg-accent-300 text-accent-700'
                            : isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'
                        }`}
                      >
                        <FlipHorizontal2 className="w-3.5 h-3.5" />{t('imageEditorModal.adjustPanel.horizontal')}
                      </button>
                      <button onClick={() => setFlipV(f => !f)}
                        className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-xs font-medium transition ${
                          flipV
                            ? isDark ? 'bg-accent-500/20 text-accent-400' : 'bg-accent-300 text-accent-700'
                            : isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'
                        }`}
                      >
                        <FlipVertical2 className="w-3.5 h-3.5" />{t('imageEditorModal.adjustPanel.vertical')}
                      </button>
                    </div>
                  </div>

                  {(adj.brightness !== 0 || adj.contrast !== 0 || adj.saturation !== 0 || flipH || flipV || rotation !== 0) && (
                    <button onClick={() => { setAdj({ brightness: 0, contrast: 0, saturation: 0 }); setFlipH(false); setFlipV(false); setRotation(0); }}
                      className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition ${isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'}`}>
                      <RotateCcw className="w-3.5 h-3.5" />{t('imageEditorModal.adjustPanel.resetAll')}
                    </button>
                  )}
                </>
              )}
            </div>

            {/* Save */}
            <div className={`flex-shrink-0 p-3 border-t space-y-2 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
              {/* Only a new processed picture is stored with a title. A new copy of a raw file is named by the
                  server (<object>_<date>-<time>E.jpg, a free-form name would stop it being recognised), and a
                  Save keeps the existing name. */}
              {titleUsed && (
                <div>
                  <label className={label}>{t('imageEditorModal.save.title')}</label>
                  <input type="text" value={saveTitle} onChange={e => setSaveTitle(e.target.value)} className={inputCls} />
                  {overwriteTarget && (
                    <p className={`text-[0.625rem] mt-0.5 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>{t('imageEditorModal.save.titleHint')}</p>
                  )}
                </div>
              )}
              {saveError && <p className="text-xs text-red-400">{saveError}</p>}

              {overwriteTarget && (
                <button onClick={() => handleSave('overwrite')} disabled={saving || !imgLoaded}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 disabled:opacity-50 disabled:cursor-not-allowed transition"
                >
                  {savingMode === 'overwrite' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  {savingMode === 'overwrite' ? t('imageEditorModal.save.saving') : t('imageEditorModal.save.save')}
                </button>
              )}

              <button onClick={() => handleSave('new')} disabled={saving || !imgLoaded}
                className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed ${
                  overwriteTarget
                    ? isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-200' : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                    : 'bg-accent-500 text-white hover:bg-accent-600'
                }`}
              >
                {savingMode === 'new' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {savingMode === 'new' ? t('imageEditorModal.save.saving') : t('imageEditorModal.save.saveAsNewVersion')}
              </button>

              <p className={`text-[0.625rem] text-center ${isDark ? 'text-slate-700' : 'text-slate-400'}`}>
                {overwriteTarget
                  ? sourceKind === 'telescope'
                    ? t('imageEditorModal.save.footerOverwriteTelescope')
                    : t('imageEditorModal.save.footerOverwriteProcessed')
                  : sourceKind === 'telescope' ? t('imageEditorModal.save.footerNewTelescope') : t('imageEditorModal.save.footerNewProcessed')}
              </p>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
