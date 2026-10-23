import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import type { AnnotationData } from '../../lib/api/annotate';
import { ringKind, type RingKind } from '../../lib/annotateBurn';
import type { ZoomPan } from './useZoomPan';
import { fadesEstimate, zoomRatio } from '../../lib/annotateFade';
import { placeLabels } from '../../lib/annotateLabels';

/** Stroke and label size on screen, in CSS pixels, whatever the zoom. */
const LABEL_PX = 12.5;
const STROKE_PX = 1.6;
/** Diameter of the (i) button on screen, in CSS pixels. */
const INFO_BTN_PX = 22;
/** Tailwind classes, so the rings follow the theme (the night theme remaps the
 *  palette) instead of carrying hex values of their own. */
const RING_CLASS: Record<RingKind, string> = {
  target: 'stroke-accent-400',
  galaxy: 'stroke-sky-300',
  cluster: 'stroke-emerald-300',
  nebula: 'stroke-rose-300',
};

/**
 * Rings and names over an image, in the same box as the image so they follow it
 * through zoom, pan and rotation. Positions are in the server's pixel grid
 * (`data.imageWidth` x `imageHeight`); line weight and text size are converted
 * to that grid from screen pixels, so they stay readable at any zoom.
 */
export function AnnotationOverlay({ data, zp, selectedId, onSelect }: {
  data: AnnotationData;
  zp: ZoomPan;
  /** The ring whose details card is open. */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { t } = useTranslation('library');
  const { imageWidth: W, imageHeight: H } = data;
  const naturalW = zp.natural?.w ?? W;
  // CSS pixels on screen per unit of the server grid.
  const unit = (naturalW * zp.zoom) / W;
  const fs = LABEL_PX / unit;

  // Past a couple of times fit an estimate shows its error, so it recedes instead of pointing at the wrong thing.
  const faded = fadesEstimate(data.quality, zoomRatio(zp.zoom, zp.fitZoom));

  const labels = useMemo(() => placeLabels(data.annotations, W, H, fs), [data.annotations, W, H, fs]);

  if (data.annotations.length === 0) return null;
  const stroke = { vectorEffect: 'non-scaling-stroke' as const };
  // Keep an (i) button fully on the picture even for a ring at the edge.
  const pad = (INFO_BTN_PX / 2 + 2) / unit;

  return (
    <>
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
      aria-hidden="true"
    >
      {data.annotations.map(a => (
        <g key={a.id}>
          <circle cx={a.x} cy={a.y} r={a.r} fill="none" stroke="black" strokeOpacity={faded ? 0.2 : 0.45} strokeWidth={STROKE_PX + 2} style={stroke} />
          <circle
            cx={a.x} cy={a.y} r={a.r} fill="none" strokeWidth={a.id === selectedId ? STROKE_PX + 1.4 : STROKE_PX}
            // Dotted and fainter when the object is bigger than the frame: the
            // ring then marks a region, not an outline. Dashed when positions
            // are only estimated.
            strokeDasharray={a.oversized ? '2 7' : data.quality === 'approximate' ? '6 4' : undefined}
            strokeLinecap={a.oversized ? 'round' : undefined}
            strokeOpacity={(a.oversized && !a.isTarget ? 0.75 : 1) * (faded ? 0.35 : 1)}
            className={RING_CLASS[ringKind(a)]} style={stroke}
          />
        </g>
      ))}
      {labels.map(({ a, x, y }) => (
        <text
          key={a.id}
          x={x}
          y={y}
          textAnchor="middle"
          fontSize={fs}
          fontWeight={a.isTarget ? 600 : 500}
          className="fill-white"
          stroke="black"
          strokeOpacity={faded ? 0.35 : 0.75}
          fillOpacity={faded ? 0.55 : 1}
          strokeWidth={fs * 0.28}
          paintOrder="stroke"
          strokeLinejoin="round"
          // Counter-rotated about its own middle, like the (i) buttons, so a
          // turned picture never shows its names sideways or upside down.
          transform={zp.rotation % 360 ? `rotate(${-zp.rotation} ${x} ${y - fs * 0.35})` : undefined}
        >
          {a.label}
          {a.designation && <tspan fillOpacity={0.7} dx={fs * 0.4}>{a.designation}</tspan>}
        </text>
      ))}
    </svg>

    {/* One (i) per ring, on the circle at upper right. HTML rather than SVG so
        it keeps a fixed, tappable size at every zoom; counter-rotated so the
        icon stays upright when the picture is turned. */}
    <div className="pointer-events-none absolute inset-0">
      {data.annotations.map(a => {
        const x = Math.min(Math.max(a.x + a.r * Math.SQRT1_2, pad), W - pad);
        const y = Math.min(Math.max(a.y - a.r * Math.SQRT1_2, pad), H - pad);
        const open = a.id === selectedId;
        return (
          <button
            key={a.id}
            type="button"
            // A press here must not start a pan or a double-click zoom.
            onPointerDown={e => e.stopPropagation()}
            onDoubleClick={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); onSelect(open ? null : a.id); }}
            title={t('annotate.info.open', { name: a.label })}
            aria-label={t('annotate.info.open', { name: a.label })}
            aria-pressed={open}
            style={{
              left: `${(x / W) * 100}%`,
              top: `${(y / H) * 100}%`,
              width: INFO_BTN_PX,
              height: INFO_BTN_PX,
              transform: `translate(-50%, -50%) rotate(${-zp.rotation}deg)`,
            }}
            className={`pointer-events-auto absolute inline-flex items-center justify-center rounded-full ring-1 ring-inset
              outline-none backdrop-blur-sm transition focus-visible:ring-2 focus-visible:ring-white/70 ${
              open
                ? 'bg-accent-500 text-black ring-accent-300'
                : 'bg-black/65 text-white/85 ring-white/35 hover:bg-white/25 hover:text-white'
            }`}
          >
            <Info className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        );
      })}
    </div>
    </>
  );
}
