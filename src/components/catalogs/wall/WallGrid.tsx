/**
 * The mosaic itself: measures its container, picks a column count, and lays
 * every tile on an explicit grid via the shared `layoutWall` (the same function
 * the poster renderer uses, so the two never disagree).
 */
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { WallTile as WallTileData } from '../../../lib/api/catalogs';
import { columnsForWidth, layoutWall, type Placement } from '../../../lib/catalogWallLayout';
import { WallTile } from './WallTile';
import type { WallOverrides } from '../../../lib/catalogWallOverrides';

export const WALL_GAP = 1;
const STATS_KEY = '__stats';

interface Props {
  tiles: WallTileData[];
  overrides: WallOverrides;
  imagedCount: number;
  total: number;
  accent: string;
  editing?: boolean;
  onEmptyClick?: (tile: WallTileData, anchor: HTMLElement) => void;
  /** Extra content drawn over each placed tile (edit-mode controls). */
  renderOverlay?: (tile: WallTileData, placement: Placement) => ReactNode;
  /** Reports the measured geometry so edit controls can do pixel math. */
  onGeometry?: (g: { columns: number; cell: number }) => void;
  /** Uniform mode: every tile 1x1. */
  uniform?: boolean;
}

export function WallGrid({
  tiles, overrides, imagedCount, total, accent, editing, onEmptyClick, renderOverlay, onGeometry, uniform,
}: Props) {
  const { t } = useTranslation('catalogs');
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const columns = columnsForWidth(width || 1200);
  const cell = width > 0 ? (width - (columns - 1) * WALL_GAP) / columns : 0;

  const byKey = useMemo(() => new Map(tiles.map(tile => [tile.id, tile])), [tiles]);
  const layout = useMemo(() => {
    const items = tiles.map(tile => ({
      key: tile.id,
      span: uniform || !tile.imaged ? { cols: 1, rows: 1 } : overrides[tile.id]?.span ?? tile.span,
    }));
    items.push({ key: STATS_KEY, span: { cols: columns >= 6 ? 2 : 1, rows: 1 } });
    return layoutWall(items, columns);
  }, [tiles, overrides, columns, uniform]);

  // Cells the packing leaves empty (the tail of the last row) are drawn as dark
  // cells, so the wall ends as a clean rectangle instead of a ragged edge.
  const fillers = useMemo(() => {
    const taken = new Set<string>();
    for (const p of layout.placements) {
      for (let y = p.row; y < p.row + p.placed.rows; y++) {
        for (let x = p.col; x < p.col + p.placed.cols; x++) taken.add(`${x},${y}`);
      }
    }
    const out: Array<{ col: number; row: number }> = [];
    for (let y = 0; y < layout.rows; y++) {
      for (let x = 0; x < columns; x++) if (!taken.has(`${x},${y}`)) out.push({ col: x, row: y });
    }
    return out;
  }, [layout, columns]);

  useLayoutEffect(() => {
    if (cell > 0) onGeometry?.({ columns, cell });
  }, [columns, cell, onGeometry]);

  return (
    <div
      ref={ref}
      className="relative w-full overflow-hidden rounded-2xl bg-white/[0.06] ring-1 ring-white/10"
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gridAutoRows: cell > 0 ? `${cell}px` : '96px',
        gap: WALL_GAP,
      }}
    >
      {fillers.map(f => (
        <div
          key={`f${f.col},${f.row}`}
          aria-hidden="true"
          className="bg-[#07080d]"
          style={{ gridColumn: f.col + 1, gridRow: f.row + 1 }}
        />
      ))}
      {layout.placements.map(p => {
        const style = {
          gridColumn: `${p.col + 1} / span ${p.placed.cols}`,
          gridRow: `${p.row + 1} / span ${p.placed.rows}`,
        };
        if (p.key === STATS_KEY) {
          return (
            <div key={p.key} style={style} className="flex items-center justify-center bg-[#07080d] px-2">
              <span className="font-display text-sm font-semibold tabular-nums text-white/70 sm:text-base">
                {t('wall.statsTile', { imaged: imagedCount, total })}
              </span>
            </div>
          );
        }
        const tile = byKey.get(p.key);
        if (!tile) return null;
        const o = overrides[tile.id];
        const effective = o?.imagePath && tile.image ? { ...tile, image: { ...tile.image, path: o.imagePath } } : tile;
        return (
          <div key={p.key} style={style} className="relative min-h-0 min-w-0">
            <WallTile
              tile={effective}
              cols={p.placed.cols}
              rows={p.placed.rows}
              accent={accent}
              focus={o?.focus ?? null}
              zoom={o?.zoom ?? null}
              editing={editing}
              onEmptyClick={onEmptyClick}
            />
            {renderOverlay?.(tile, p)}
          </div>
        );
      })}
    </div>
  );
}
