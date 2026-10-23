/**
 * Edit-mode controls drawn over one imaged tile: a size picker, an image
 * chooser button, a reset, and a corner handle that resizes by dragging.
 *
 * The handle snaps to whole cells and writes the new span straight into the
 * draft, so the grid reflows live under the pointer. Tapping the size button
 * is the touch-friendly path to the same change.
 */
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageIcon, RotateCcw, Scaling } from 'lucide-react';
import type { WallSpan, WallTile } from '../../../lib/api/catalogs';
import { WALL_GAP } from './WallGrid';
import { SPAN_CHOICES } from '../../../lib/catalogWallTile';

const MAX_SPAN = 4;

interface Props {
  tile: WallTile;
  placed: WallSpan;
  /** The span currently saved in the draft, or null while on Auto. */
  override: WallSpan | null;
  columns: number;
  cell: number;
  accent: string;
  hasEdits: boolean;
  onSpan: (span: WallSpan | null) => void;
  onPickImage: () => void;
  onReset: () => void;
}

export function WallEditControls({
  tile, placed, override, columns, cell, accent, hasEdits, onSpan, onPickImage, onReset,
}: Props) {
  const { t } = useTranslation('catalogs');
  const [menuOpen, setMenuOpen] = useState(false);
  const drag = useRef<{ x: number; y: number; cols: number; rows: number } | null>(null);
  const stride = cell + WALL_GAP;

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, cols: placed.cols, rows: placed.rows };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || stride <= 0) return;
    const cols = Math.min(Math.min(MAX_SPAN, columns), Math.max(1, d.cols + Math.round((e.clientX - d.x) / stride)));
    const rows = Math.min(MAX_SPAN, Math.max(1, d.rows + Math.round((e.clientY - d.y) / stride)));
    if (cols !== placed.cols || rows !== placed.rows) onSpan({ cols, rows });
  };
  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const btn = `flex h-6 w-6 items-center justify-center rounded-md bg-black/60 text-white ring-1 ring-inset ring-white/20 backdrop-blur-md
    transition-colors hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70`;

  return (
    <div className="pointer-events-none absolute inset-0 z-10" style={{ boxShadow: `inset 0 0 0 1.5px ${accent}b3` }}>
      <div className="pointer-events-auto absolute right-1 top-1 flex gap-1">
        {hasEdits && (
          <button type="button" className={btn} onClick={onReset} title={t('wall.edit.resetTile')} aria-label={t('wall.edit.resetTile')}>
            <RotateCcw className="h-3 w-3" />
          </button>
        )}
        <button type="button" className={btn} onClick={onPickImage} title={t('wall.edit.chooseImage')} aria-label={t('wall.edit.chooseImage')}>
          <ImageIcon className="h-3 w-3" />
        </button>
        <button
          type="button"
          className={btn}
          onClick={() => setMenuOpen(o => !o)}
          aria-expanded={menuOpen}
          title={t('wall.edit.size')}
          aria-label={t('wall.edit.sizeAria', { id: tile.id })}
        >
          <Scaling className="h-3 w-3" />
        </button>
      </div>

      {menuOpen && (
        <>
          <div className="pointer-events-auto fixed inset-0 z-20" onClick={() => setMenuOpen(false)} aria-hidden="true" />
          <div className="pointer-events-auto absolute right-1 top-8 z-30 w-40 rounded-xl bg-slate-900 p-2 shadow-2xl ring-1 ring-white/15">
            <div className="grid grid-cols-4 gap-1.5">
              {SPAN_CHOICES.map(s => {
                const active = override?.cols === s.cols && override?.rows === s.rows;
                return (
                  <button
                    key={`${s.cols}x${s.rows}`}
                    type="button"
                    onClick={() => { onSpan(s); setMenuOpen(false); }}
                    aria-pressed={active}
                    aria-label={`${s.cols} × ${s.rows}`}
                    title={`${s.cols} × ${s.rows}`}
                    className="flex h-8 items-center justify-center rounded-md bg-white/5 ring-1 ring-inset ring-white/10 hover:bg-white/10
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                    style={active ? { background: `${accent}33`, boxShadow: `inset 0 0 0 1.5px ${accent}` } : undefined}
                  >
                    {/* A little picture of the shape itself */}
                    <span
                      className="block rounded-[2px] bg-white/70"
                      style={{ width: s.cols * 5, height: s.rows * 5 }}
                    />
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => { onSpan(null); setMenuOpen(false); }}
              aria-pressed={override == null}
              className="mt-2 w-full rounded-md bg-white/5 py-1 text-[0.6875rem] font-medium text-white/80 ring-1 ring-inset ring-white/10 hover:bg-white/10"
              style={override == null ? { boxShadow: `inset 0 0 0 1.5px ${accent}` } : undefined}
            >
              {t('wall.edit.auto')}
            </button>
          </div>
        </>
      )}

      {/* Corner drag handle */}
      <button
        type="button"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        aria-label={t('wall.edit.dragAria', { id: tile.id })}
        className="pointer-events-auto absolute bottom-0 right-0 h-5 w-5 cursor-nwse-resize touch-none"
      >
        <span
          className="absolute bottom-1 right-1 h-2.5 w-2.5 rounded-[2px]"
          style={{ background: accent, boxShadow: `0 0 0 1.5px rgba(0,0,0,0.6)` }}
        />
      </button>
    </div>
  );
}
