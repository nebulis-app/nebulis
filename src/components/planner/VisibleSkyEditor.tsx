/**
 * Polar editor for the observer's "visible sky" map.
 *
 * Renders 36 azimuth wedges (10° each, 0° at North) × 4 elevation bands
 * (centers 10°, 30°, 50°, 70°; bands cover 0-80° in 20° steps). Each cell
 * is independently toggleable. Above 80° is treated as zenith and always
 * visible (not editable here).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import {
  SKY_MAP_AZ_SLICES,
  SKY_MAP_BANDS,
  SKY_MAP_CELLS,
  cellIndex,
  makeAllBlockedMap,
  makeAllVisibleMap,
  type VisibleSkyMap,
} from '../../lib/visibilityCheck';

interface VisibleSkyEditorProps {
  open: boolean;
  initialMap: VisibleSkyMap | null | undefined;
  onSave: (map: VisibleSkyMap) => void;
  onClose: () => void;
}

const SVG_SIZE = 480;
const CENTER = SVG_SIZE / 2;
const RING_OUTER = 220;
const RING_INNER = 60; // zenith disc
// Extra viewBox padding so the N/E/S/W cardinal labels sit outside the outer
// ring without getting cropped at the edges of the SVG viewport.
const VIEW_PAD = 36;

// Polar -> cartesian. SVG y grows downward, so North (az=0) is at -y direction.
function polar(azDeg: number, radius: number): { x: number; y: number } {
  const rad = ((azDeg - 90) * Math.PI) / 180; // shift so 0° az points up
  return { x: CENTER + radius * Math.cos(rad), y: CENTER + radius * Math.sin(rad) };
}

function wedgePath(azStart: number, azEnd: number, rInner: number, rOuter: number): string {
  const p1 = polar(azStart, rOuter);
  const p2 = polar(azEnd, rOuter);
  const p3 = polar(azEnd, rInner);
  const p4 = polar(azStart, rInner);
  const sweep = azEnd - azStart > 180 ? 1 : 0;
  return [
    `M ${p1.x} ${p1.y}`,
    `A ${rOuter} ${rOuter} 0 ${sweep} 1 ${p2.x} ${p2.y}`,
    `L ${p3.x} ${p3.y}`,
    `A ${rInner} ${rInner} 0 ${sweep} 0 ${p4.x} ${p4.y}`,
    'Z',
  ].join(' ');
}

export function VisibleSkyEditor(props: VisibleSkyEditorProps) {
  // Wrap the implementation so we can use the `open` flag as a remount key.
  // That way the editor's local state always starts fresh from `initialMap`
  // when the user opens the modal again, without a setState-in-effect dance.
  if (!props.open) return null;
  return <VisibleSkyEditorBody key={String(props.open)} {...props} />;
}

function VisibleSkyEditorBody({ initialMap, onSave, onClose }: VisibleSkyEditorProps) {
  const { isDark } = useTheme();
  const [map, setMap] = useState<VisibleSkyMap>(() => normalizeMap(initialMap));

  // Paint mode: when the user presses on a cell, we capture the *target*
  // visibility (opposite of the pressed cell) and stamp every cell the
  // pointer enters with that value, exactly once per drag.
  const paintModeRef = useRef<boolean | null>(null);
  const paintedRef = useRef<Set<number>>(new Set());

  const paintCell = useCallback((azSlice: number, band: number) => {
    const idx = cellIndex(azSlice, band);
    if (paintedRef.current.has(idx)) return;
    paintedRef.current.add(idx);
    const target = paintModeRef.current;
    if (target === null) return;
    setMap(prev => {
      if (prev[idx] === target) return prev;
      const next = prev.slice();
      next[idx] = target;
      return next;
    });
  }, []);

  const beginPaint = useCallback((azSlice: number, band: number, e: React.PointerEvent) => {
    e.preventDefault();
    // Deliberately no setPointerCapture — capture would redirect every
    // subsequent pointer event to this one wedge, so pointerEnter on the
    // *next* wedge over would never fire. We get cross-wedge paint via the
    // window-level pointerup listener instead.
    paintedRef.current = new Set();
    const idx = cellIndex(azSlice, band);
    paintModeRef.current = !map[idx];
    paintCell(azSlice, band);
  }, [map, paintCell]);

  const continuePaint = useCallback((azSlice: number, band: number) => {
    if (paintModeRef.current === null) return;
    paintCell(azSlice, band);
  }, [paintCell]);

  // Global pointerup terminates paint, even if released outside a wedge.
  useEffect(() => {
    function end() {
      paintModeRef.current = null;
      paintedRef.current.clear();
    }
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, []);

  // Band 0 is the outermost ring (0-20° altitude), band 3 the innermost (60-80°).
  // Equal radial spacing across the four rings.
  const ringWidth = (RING_OUTER - RING_INNER) / SKY_MAP_BANDS;
  const radii = Array.from({ length: SKY_MAP_BANDS + 1 }, (_, i) => RING_OUTER - i * ringWidth);

  const azWidth = 360 / SKY_MAP_AZ_SLICES;

  const visibleFill = 'rgb(34 197 94 / 0.55)';      // emerald-500/55
  const blockedFill = isDark ? 'rgb(15 23 42 / 0.85)' : 'rgb(203 213 225 / 0.85)';
  const strokeColor = isDark ? 'rgb(71 85 105)' : 'rgb(148 163 184)';
  const labelColor = isDark ? 'rgb(226 232 240)' : 'rgb(15 23 42)';

  const visibleCount = map.filter(Boolean).length;

  const cardinalLabels: Array<{ az: number; text: string }> = [
    { az: 0, text: 'N' },
    { az: 90, text: 'E' },
    { az: 180, text: 'S' },
    { az: 270, text: 'W' },
  ];

  const elevationLabels = [10, 30, 50, 70].map((deg, band) => {
    const rMid = radii[band] - ringWidth / 2;
    const pos = polar(45, rMid); // place along NE diagonal so labels stay clear of N tick
    return { deg, x: pos.x, y: pos.y };
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className={`relative rounded-2xl shadow-2xl max-w-3xl w-full max-h-[92vh] overflow-auto ${
          isDark ? 'bg-slate-900 text-slate-100' : 'bg-white text-slate-900'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-slate-700/40">
          <div>
            <h2 className="text-lg font-semibold">Set Visible Sky</h2>
            <p className="text-xs opacity-70 mt-0.5">
              Click a cell to toggle whether you can see that patch of sky. {visibleCount} of {SKY_MAP_CELLS} cells visible.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-white/10 transition"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex flex-col items-center gap-4 p-5">
          <div className="flex gap-2 flex-wrap justify-center">
            <button
              onClick={() => setMap(makeAllVisibleMap())}
              className="px-3 py-1.5 text-xs rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white"
            >
              All visible
            </button>
            <button
              onClick={() => setMap(makeAllBlockedMap())}
              className="px-3 py-1.5 text-xs rounded-lg bg-slate-700 hover:bg-slate-600 text-white"
            >
              Clear all
            </button>
            <button
              onClick={() => setMap(prev => mirrorNS(prev))}
              className="px-3 py-1.5 text-xs rounded-lg bg-slate-700 hover:bg-slate-600 text-white"
            >
              Mirror N to S
            </button>
            <button
              onClick={() => setMap(prev => mirrorEW(prev))}
              className="px-3 py-1.5 text-xs rounded-lg bg-slate-700 hover:bg-slate-600 text-white"
            >
              Mirror E to W
            </button>
          </div>

          <svg
            viewBox={`${-VIEW_PAD} ${-VIEW_PAD} ${SVG_SIZE + VIEW_PAD * 2} ${SVG_SIZE + VIEW_PAD * 2}`}
            className="w-full max-w-[480px] h-auto select-none touch-none"
            role="img"
            aria-label="Visible sky map editor"
          >
            <circle cx={CENTER} cy={CENTER} r={RING_OUTER + 8} fill="none" stroke={strokeColor} strokeWidth={1} />
            <circle cx={CENTER} cy={CENTER} r={RING_INNER} fill={visibleFill} stroke={strokeColor} strokeWidth={1} />
            <text
              x={CENTER}
              y={CENTER + 4}
              textAnchor="middle"
              fontSize={11}
              fill={labelColor}
              opacity={0.85}
            >
              80°+ (zenith)
            </text>

            {Array.from({ length: SKY_MAP_AZ_SLICES }, (_, az) =>
              Array.from({ length: SKY_MAP_BANDS }, (_, band) => {
                const idx = cellIndex(az, band);
                const isVisible = map[idx];
                const azStart = az * azWidth;
                const azEnd = azStart + azWidth;
                const rOuter = radii[band];
                const rInner = radii[band + 1];
                return (
                  <path
                    key={`${az}-${band}`}
                    d={wedgePath(azStart, azEnd, rInner, rOuter)}
                    fill={isVisible ? visibleFill : blockedFill}
                    stroke={strokeColor}
                    strokeWidth={0.5}
                    className="cursor-pointer transition-opacity hover:opacity-80"
                    onPointerDown={(e) => beginPaint(az, band, e)}
                    onPointerEnter={() => continuePaint(az, band)}
                  />
                );
              }),
            )}

            {cardinalLabels.map(({ az, text }) => {
              const p = polar(az, RING_OUTER + 22);
              return (
                <text
                  key={text}
                  x={p.x}
                  y={p.y}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={16}
                  fontWeight={600}
                  fill={labelColor}
                >
                  {text}
                </text>
              );
            })}

            {elevationLabels.map(({ deg, x, y }) => (
              <text
                key={deg}
                x={x}
                y={y}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={9}
                fill={labelColor}
                opacity={0.7}
                style={{ pointerEvents: 'none' }}
              >
                {deg}°
              </text>
            ))}
          </svg>

          <p className="text-xs opacity-60 max-w-md text-center">
            Bands are centered at 10°, 30°, 50°, 70° altitude (outer ring is the horizon).
            Above 80° is treated as zenith and always visible.
          </p>
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-slate-700/40">
          <button
            onClick={onClose}
            className={`px-4 py-2 text-sm rounded-lg ${
              isDark ? 'bg-slate-700 hover:bg-slate-600 text-white' : 'bg-slate-200 hover:bg-slate-300 text-slate-900'
            }`}
          >
            Cancel
          </button>
          <button
            onClick={() => onSave(map)}
            className="px-4 py-2 text-sm rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white"
          >
            Save sky map
          </button>
        </div>
      </div>
    </div>
  );
}

function normalizeMap(input: VisibleSkyMap | null | undefined): VisibleSkyMap {
  if (Array.isArray(input) && input.length === SKY_MAP_CELLS) {
    return input.slice();
  }
  return makeAllVisibleMap();
}

/** Mirror the northern hemisphere onto the southern (or vice versa, taking the
 *  union). Useful when a user has trees only on one side and wants to start
 *  with a symmetric guess. */
function mirrorNS(map: VisibleSkyMap): VisibleSkyMap {
  const next = map.slice();
  for (let az = 0; az < SKY_MAP_AZ_SLICES; az++) {
    const mirrorAz = (SKY_MAP_AZ_SLICES / 2 - az + SKY_MAP_AZ_SLICES) % SKY_MAP_AZ_SLICES;
    for (let band = 0; band < SKY_MAP_BANDS; band++) {
      const a = cellIndex(az, band);
      const b = cellIndex(mirrorAz, band);
      const v = map[a] && map[b];
      next[a] = v;
      next[b] = v;
    }
  }
  return next;
}

function mirrorEW(map: VisibleSkyMap): VisibleSkyMap {
  const next = map.slice();
  for (let az = 0; az < SKY_MAP_AZ_SLICES; az++) {
    // East (az=90) mirrors to West (az=270). Symmetry axis = N-S line.
    const mirrorAz = (SKY_MAP_AZ_SLICES * 2 - az) % SKY_MAP_AZ_SLICES;
    for (let band = 0; band < SKY_MAP_BANDS; band++) {
      const a = cellIndex(az, band);
      const b = cellIndex(mirrorAz, band);
      const v = map[a] && map[b];
      next[a] = v;
      next[b] = v;
    }
  }
  return next;
}
