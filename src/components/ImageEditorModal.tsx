import { useRef, useState, useEffect, useCallback } from 'react';
import {
  X, Type, Crop, SlidersHorizontal, MousePointer,
  AlignLeft, AlignCenter, AlignRight,
  Check, RotateCcw, Save, Trash2, Loader2, Pencil,
  FlipHorizontal2, FlipVertical2, BookmarkCheck, Plus,
} from 'lucide-react';
import { uploadProcessedImage, uploadLibraryFile } from '../lib/api/library';
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

type Tool = 'select' | 'text' | 'crop' | 'adjust';

interface Props {
  imageUrl: string;
  imageName: string;
  objectId: string;
  date: string;
  isDark: boolean;
  /** Where the saved result lands: 'telescope' → library folder, 'processed' → processed images. */
  sourceKind: 'telescope' | 'processed';
  onClose: () => void;
  onSaved: () => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const FONTS = [
  { label: 'Sans-serif', value: 'Arial, sans-serif' },
  { label: 'Serif',      value: 'Georgia, serif' },
  { label: 'Monospace',  value: "'Courier New', monospace" },
  { label: 'Impact',     value: 'Impact, fantasy' },
];

const LINE_HEIGHT_RATIO = 1.35;
const HANDLE_SIZE = 8; // px for crop handle squares

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function clamp(v: number, lo = 0, hi = 1) { return Math.max(lo, Math.min(hi, v)); }

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
function eventToCanvasPx(e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } {
  const r = e.currentTarget.getBoundingClientRect();
  const scaleX = e.currentTarget.width  / r.width;
  const scaleY = e.currentTarget.height / r.height;
  return { x: (e.clientX - r.left) * scaleX, y: (e.clientY - r.top) * scaleY };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ImageEditorModal({ imageUrl, imageName, objectId, date, isDark, sourceKind, onClose, onSaved }: Props) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef       = useRef<HTMLImageElement | null>(null);

  // Image loading
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError,  setImgError]  = useState(false);

  // Active tool
  const [activeTool, setActiveTool] = useState<Tool>('select');

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
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);

  // Text drag
  const isDragging   = useRef(false);
  const dragId       = useRef<string | null>(null);
  const dragOffset   = useRef({ dx: 0, dy: 0 });

  // Save
  const [saving,    setSaving]    = useState(false);
  const [saveTitle, setSaveTitle] = useState('');
  const [saveError, setSaveError] = useState('');

  // Watermark presets
  const [presets,        setPresets]        = useState<WatermarkPreset[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(false);
  const [savePresetName, setSavePresetName] = useState('');
  const [showSavePreset, setShowSavePreset] = useState(false);

  // ── Init ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    setSaveTitle(`${imageName.replace(/\.[^.]+$/, '')} (edited)`);
  }, [imageName]);

  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload  = () => { if (!cancelled) { imgRef.current = img; setImgLoaded(true); } };
    img.onerror = () => { if (!cancelled) setImgError(true); };
    img.src = imageUrl;
    return () => { cancelled = true; img.onload = null; img.onerror = null; };
  }, [imageUrl]);

  useEffect(() => {
    let cancelled = false;
    setPresetsLoading(true);
    getWatermarkPresets()
      .then(p => { if (!cancelled) setPresets(p); })
      .catch(() => {/* ignore if endpoint not available */})
      .finally(() => { if (!cancelled) setPresetsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // ── Canvas sizing ─────────────────────────────────────────────────────────

  const sizeCanvas = useCallback(() => {
    const canvas    = canvasRef.current;
    const img       = imgRef.current;
    const container = containerRef.current;
    if (!canvas || !img || !container) return;

    const { clientWidth: cw, clientHeight: ch } = container;
    const aspect = img.naturalWidth / img.naturalHeight;
    let w = cw, h = cw / aspect;
    if (h > ch) { h = ch; w = ch * aspect; }
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width  = Math.floor(w) + 'px';
    canvas.style.height = Math.floor(h) + 'px';
  }, []);

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
    if (flipH || flipV) {
      ctx.translate(flipH ? cw : 0, flipV ? ch : 0);
      ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
    }
    if (appliedCrop) {
      const { x1, y1, x2, y2 } = appliedCrop;
      ctx.drawImage(img,
        x1 * img.naturalWidth,  y1 * img.naturalHeight,
        (x2 - x1) * img.naturalWidth, (y2 - y1) * img.naturalHeight,
        0, 0, cw, ch);
    } else {
      ctx.drawImage(img, 0, 0, cw, ch);
    }
    ctx.restore();

    // pixel-based adjustments (works in all browsers)
    if (adj.brightness !== 0 || adj.contrast !== 0 || adj.saturation !== 0) {
      const id = ctx.getImageData(0, 0, cw, ch);
      applyPixelAdjustments(id.data, adj.brightness, adj.contrast, adj.saturation);
      ctx.putImageData(id, 0, 0);
    }

    // ── text layers ──
    textLayers.forEach(l => drawTextLayer(ctx, l, cw, ch, l.id === selectedId));

    // ── crop overlay ──
    if (cropDraft && activeTool === 'crop') {
      drawCropOverlay(ctx, cropDraft, cw, ch);
    }
  }, [imgLoaded, flipH, flipV, appliedCrop, adj, textLayers, selectedId, cropDraft, activeTool, drawTextLayer, drawCropOverlay]);

  // Size canvas then draw when image first loads
  useEffect(() => {
    if (!imgLoaded) return;
    sizeCanvas();
    draw();
  }, [imgLoaded, sizeCanvas, draw]);

  // Redraw on every state change
  useEffect(() => { draw(); }, [draw]);

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

  const [canvasCursor, setCanvasCursor] = useState<string>('default');

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { x: px, y: py } = eventToCanvasPx(e);
    const { width: cw, height: ch } = canvas;

    // ── crop mode ──
    if (activeTool === 'crop') {
      if (cropDraft) {
        const handle = getCropHandle(px, py, cropDraft, cw, ch);
        cropHandleRef.current     = handle;
        cropDragStartRef.current  = { mouseX: px, mouseY: py, crop: { ...cropDraft } };
      } else {
        cropHandleRef.current     = 'new';
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

    // ── text tool: place new text ──
    if (activeTool === 'text') {
      const layer: TextLayer = {
        id: crypto.randomUUID(),
        text: tText || 'Text',
        x: px / cw, y: py / ch,
        fontSize: tSize, fontFamily: tFont, color: tColor,
        bold: tBold, italic: tItalic, opacity: tOpacity, align: tAlign, angle: tAngle,
      };
      setTextLayers(prev => [...prev, layer]);
      setSelectedId(layer.id);
    } else {
      setSelectedId(null);
    }
  };

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { x: px, y: py } = eventToCanvasPx(e);
    const { width: cw, height: ch } = canvas;

    // Update cursor during crop hover
    if (activeTool === 'crop') {
      if (cropDraft && !cropDragStartRef.current) {
        const h = getCropHandle(px, py, cropDraft, cw, ch);
        setCanvasCursor(getCropCursor(h));
      }
    }

    // ── crop drag ──
    if (activeTool === 'crop' && cropDragStartRef.current) {
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
    setActiveTool('select');
  }, [cropDraft]);

  const resetCrop = () => { setCropDraft(null); setAppliedCrop(null); };

  // ── Watermark helpers ─────────────────────────────────────────────────────

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
    setPresets(updated);
    setSavePresetName('');
    setShowSavePreset(false);
    await saveWatermarkPresets(updated).catch(() => {/* best-effort */});
  };

  const deletePreset = async (id: string) => {
    const updated = presets.filter(p => p.id !== id);
    setPresets(updated);
    await saveWatermarkPresets(updated).catch(() => {});
  };

  // ── Save ──────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    const img     = imgRef.current;
    const display = canvasRef.current;
    if (!img || !display) return;

    setSaving(true);
    setSaveError('');
    try {
      const offscreen = document.createElement('canvas');
      let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
      if (appliedCrop) {
        sx = appliedCrop.x1 * img.naturalWidth;
        sy = appliedCrop.y1 * img.naturalHeight;
        sw = (appliedCrop.x2 - appliedCrop.x1) * img.naturalWidth;
        sh = (appliedCrop.y2 - appliedCrop.y1) * img.naturalHeight;
      }
      offscreen.width  = Math.round(sw);
      offscreen.height = Math.round(sh);
      const ctx = offscreen.getContext('2d')!;

      // Image
      ctx.save();
      if (flipH || flipV) {
        ctx.translate(flipH ? offscreen.width : 0, flipV ? offscreen.height : 0);
        ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
      }
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, offscreen.width, offscreen.height);
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
        offscreen.toBlob(b => b ? resolve(b) : reject(new Error('Export failed')), 'image/jpeg', 0.93),
      );

      const title = saveTitle.trim() || `${imageName.replace(/\.[^.]+$/, '')} (edited)`;
      const file  = new File([blob], `${title}.jpg`, { type: 'image/jpeg' });
      if (sourceKind === 'telescope') {
        await uploadLibraryFile(objectId, date, file);
      } else {
        await uploadProcessedImage(objectId, date, file, title, 'Created with image editor');
      }

      onSaved();
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
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
      if (e.key === 'Enter' && activeTool === 'crop' && cropDraft) {
        confirmCrop();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, selectedId, activeTool, confirmCrop]);

  // ── Dynamic cursor for crop mode ──────────────────────────────────────────

  const canvasCursorStyle = activeTool === 'crop'
    ? (cropDragStartRef.current ? canvasCursor : canvasCursor)
    : activeTool === 'text' ? 'cell' : 'default';

  // ── Shared Tailwind helpers ───────────────────────────────────────────────

  const toolBtn = (active: boolean) =>
    `flex flex-col items-center gap-0.5 p-2 rounded-lg text-[10px] font-medium transition ${
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

  const label = `block text-xs font-medium mb-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`;

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
    <div className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center">
      <div className={`relative w-full max-w-[1400px] h-[96vh] mx-4 flex flex-col rounded-2xl overflow-hidden shadow-2xl ${isDark ? 'bg-slate-900' : 'bg-white'}`}>

        {/* Header */}
        <div className={`flex-shrink-0 flex items-center justify-between px-4 py-3 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          <div className="flex items-center gap-2 min-w-0">
            <Pencil className="w-4 h-4 text-accent-500 flex-shrink-0" />
            <span className={`font-semibold text-sm ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Edit Image</span>
            <span className={`text-xs truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>- {imageName}</span>
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
                <p className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Failed to load image.</p>
                <p className={`text-xs ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>Close and reopen to try again.</p>
              </div>
            ) : !imgLoaded ? (
              <Loader2 className="w-8 h-8 animate-spin text-slate-500" />
            ) : (
              <canvas
                ref={canvasRef}
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={onMouseUp}
                onMouseLeave={onMouseUp}
                className="rounded-xl shadow-2xl select-none"
                style={{ maxWidth: '100%', maxHeight: '100%', cursor: canvasCursorStyle }}
              />
            )}
          </div>

          {/* Side panel */}
          <div className={`w-60 flex-shrink-0 flex flex-col border-l ${isDark ? 'border-slate-800 bg-slate-900' : 'border-slate-200 bg-white'}`}>

            {/* Tool selector */}
            <div className={`flex-shrink-0 p-3 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
              <div className="grid grid-cols-4 gap-1">
                <button onClick={() => setActiveTool('select')} className={toolBtn(activeTool === 'select')} title="Select">
                  <MousePointer className="w-4 h-4" />Select
                </button>
                <button onClick={() => setActiveTool('text')} className={toolBtn(activeTool === 'text')} title="Text">
                  <Type className="w-4 h-4" />Text
                </button>
                <button onClick={() => setActiveTool('crop')} className={toolBtn(activeTool === 'crop')} title="Crop">
                  <Crop className="w-4 h-4" />Crop
                </button>
                <button onClick={() => setActiveTool('adjust')} className={toolBtn(activeTool === 'adjust')} title="Adjust">
                  <SlidersHorizontal className="w-4 h-4" />Adjust
                </button>
              </div>
            </div>

            {/* Tool options */}
            <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">

              {/* ── SELECT ── */}
              {activeTool === 'select' && (
                <>
                  <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    Click a text label to select and drag it. Press Delete to remove.
                  </p>
                  <button onClick={addWatermark} className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition ${isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'}`}>
                    <Type className="w-3.5 h-3.5 opacity-60" />Add watermark
                  </button>
                  {textLayers.length > 0 && (
                    <div className="space-y-1">
                      <p className={`text-[10px] font-semibold uppercase tracking-wider ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>Text layers</p>
                      {textLayers.map(l => (
                        <button key={l.id} onClick={() => { setSelectedId(l.id); loadLayerIntoSidebar(l); setActiveTool('text'); }}
                          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition ${
                            l.id === selectedId
                              ? isDark ? 'bg-accent-500/15 text-accent-400' : 'bg-accent-300 text-accent-700'
                              : isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'
                          }`}
                        >
                          <span className="w-3 h-3 rounded-full flex-shrink-0 border border-slate-600" style={{ backgroundColor: l.color }} />
                          <span className="truncate flex-1 text-left">{(l.text || '(empty)').replace(/\n/g, ' ')}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}

              {/* ── TEXT ── */}
              {activeTool === 'text' && (
                <>
                  <button onClick={addWatermark} className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition ${isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'}`}>
                    <Type className="w-3.5 h-3.5 opacity-60" />Add watermark
                  </button>

                  <div>
                    <label className={label}>Content</label>
                    <textarea value={tText} onChange={e => setTText(e.target.value)}
                      placeholder="Your text…" rows={3}
                      className={`${inputCls} resize-none`}
                    />
                    {!selectedId && <p className={`text-[10px] mt-0.5 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>Click canvas to place text</p>}
                  </div>

                  <div>
                    <label className={label}>Font</label>
                    <select value={tFont} onChange={e => setTFont(e.target.value)} className={inputCls}>
                      {FONTS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                    </select>
                  </div>

                  <div>
                    <label className={label}>Size</label>
                    <div className="flex items-center gap-2">
                      <button onClick={() => setTSize(s => Math.max(8, s - 4))} className={`w-8 h-8 rounded-lg text-lg font-bold flex items-center justify-center transition ${isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'}`}>−</button>
                      <span className={`flex-1 text-center text-sm tabular-nums font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{tSize}px</span>
                      <button onClick={() => setTSize(s => Math.min(250, s + 4))} className={`w-8 h-8 rounded-lg text-lg font-bold flex items-center justify-center transition ${isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'}`}>+</button>
                    </div>
                  </div>

                  <div>
                    <label className={`flex justify-between text-xs font-medium mb-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                      <span>Angle</span>
                      <span className="tabular-nums">{tAngle > 0 ? `+${tAngle}` : tAngle}°</span>
                    </label>
                    <input type="range" min={-90} max={90} value={tAngle} onChange={e => setTAngle(+e.target.value)} className="w-full accent-accent-500" />
                  </div>

                  <div>
                    <label className={label}>Color</label>
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
                    <label className={label}>Style & align</label>
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
                      <span>Opacity</span><span className="tabular-nums">{tOpacity}%</span>
                    </label>
                    <input type="range" min={10} max={100} value={tOpacity} onChange={e => setTOpacity(+e.target.value)} className="w-full accent-accent-500" />
                  </div>

                  {selectedId && (
                    <button onClick={() => { setTextLayers(prev => prev.filter(l => l.id !== selectedId)); setSelectedId(null); }}
                      className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-red-400 bg-red-500/10 hover:bg-red-500/20 transition"
                    >
                      <Trash2 className="w-3.5 h-3.5" />Delete selected text
                    </button>
                  )}

                  {/* Watermark presets */}
                  <div className={`border-t pt-3 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className={`text-[10px] font-semibold uppercase tracking-wider ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Saved Presets</span>
                      <button onClick={() => setShowSavePreset(s => !s)} title="Save as preset"
                        className={`p-1 rounded transition ${isDark ? 'hover:bg-slate-800 text-slate-500' : 'hover:bg-slate-100 text-slate-400'}`}>
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {showSavePreset && (
                      <div className="flex gap-1 mb-2">
                        <input value={savePresetName} onChange={e => setSavePresetName(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') saveAsPreset(); if (e.key === 'Escape') setShowSavePreset(false); }}
                          placeholder="Preset name…"
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
                    ) : presets.length === 0 ? (
                      <p className={`text-[10px] ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                        No saved presets. Click + to save current settings.
                      </p>
                    ) : (
                      <div className="space-y-1">
                        {presets.map(p => (
                          <div key={p.id} className={`flex items-center gap-1 px-2 py-1.5 rounded-lg ${isDark ? 'bg-slate-800/60' : 'bg-slate-50'}`}>
                            <span className={`flex-1 text-xs truncate ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{p.name}</span>
                            <button onClick={() => applyPreset(p)} title="Apply"
                              className={`p-1 rounded transition ${isDark ? 'hover:bg-slate-700 text-accent-400' : 'hover:bg-accent-50 text-accent-600'}`}>
                              <BookmarkCheck className="w-3 h-3" />
                            </button>
                            <button onClick={() => deletePreset(p.id)} title="Delete"
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
              {activeTool === 'crop' && (
                <>
                  <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    Drag to draw a crop box. Drag edges or corners to resize. Drag inside to move. Press Enter or click Apply to confirm.
                  </p>
                  {cropDraft && (
                    <button onClick={confirmCrop}
                      className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium bg-accent-500 text-white hover:bg-accent-600 transition">
                      <Check className="w-3.5 h-3.5" />Apply crop
                    </button>
                  )}
                  {appliedCrop && (
                    <>
                      <div className={`text-xs rounded-lg px-3 py-2 ${isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>Crop applied</div>
                      <button onClick={resetCrop}
                        className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition ${isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'}`}>
                        <RotateCcw className="w-3.5 h-3.5" />Reset crop
                      </button>
                    </>
                  )}
                </>
              )}

              {/* ── ADJUST ── */}
              {activeTool === 'adjust' && (
                <>
                  {adjRow('brightness', 'Brightness')}
                  {adjRow('contrast',   'Contrast')}
                  {adjRow('saturation', 'Saturation')}

                  <div>
                    <p className={`text-xs font-medium mb-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Flip</p>
                    <div className="flex gap-1">
                      <button onClick={() => setFlipH(f => !f)}
                        className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-xs font-medium transition ${
                          flipH
                            ? isDark ? 'bg-accent-500/20 text-accent-400' : 'bg-accent-300 text-accent-700'
                            : isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'
                        }`}
                      >
                        <FlipHorizontal2 className="w-3.5 h-3.5" />Horizontal
                      </button>
                      <button onClick={() => setFlipV(f => !f)}
                        className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-xs font-medium transition ${
                          flipV
                            ? isDark ? 'bg-accent-500/20 text-accent-400' : 'bg-accent-300 text-accent-700'
                            : isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'
                        }`}
                      >
                        <FlipVertical2 className="w-3.5 h-3.5" />Vertical
                      </button>
                    </div>
                  </div>

                  {(adj.brightness !== 0 || adj.contrast !== 0 || adj.saturation !== 0 || flipH || flipV) && (
                    <button onClick={() => { setAdj({ brightness: 0, contrast: 0, saturation: 0 }); setFlipH(false); setFlipV(false); }}
                      className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition ${isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'}`}>
                      <RotateCcw className="w-3.5 h-3.5" />Reset all
                    </button>
                  )}
                </>
              )}
            </div>

            {/* Save */}
            <div className={`flex-shrink-0 p-3 border-t space-y-2 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
              <div>
                <label className={label}>Title</label>
                <input type="text" value={saveTitle} onChange={e => setSaveTitle(e.target.value)} className={inputCls} />
              </div>
              {saveError && <p className="text-xs text-red-400">{saveError}</p>}
              <button onClick={handleSave} disabled={saving || !imgLoaded}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 disabled:opacity-50 disabled:cursor-not-allowed transition"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {saving ? 'Saving…' : 'Save as new version'}
              </button>
              <p className={`text-[10px] text-center ${isDark ? 'text-slate-700' : 'text-slate-400'}`}>
                {sourceKind === 'telescope' ? 'Saves alongside the original telescope images' : 'Saves to Processed Images'}
              </p>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
