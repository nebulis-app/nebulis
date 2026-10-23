import type { MediaItem } from '../../lib/api/library';

/** Minimum tile width in px: the grid packs as many tiles as fit at this width. */
export type TileSize = number;

export const TILE_MIN = 110;
export const TILE_MAX = 320;
export const TILE_STEP = 10;
export const TILE_DEFAULT = 170;
/** The compact size the "All" tab uses for sub-frames. */
export const TILE_COMPACT = 120;
/** From this width a tile has room for its date in the corner beside the format tag. */
export const TILE_DATE_FROM = 150;
/** From this width tiles switch from square to 4:3 so a wide picture isn't cropped hard. */
export const TILE_WIDE_FROM = 220;

/** Sizes saved before the slider, when the choice was S / M / L. */
const LEGACY_SIZES: Record<string, number> = { small: 120, medium: 170, large: 260 };

/** Reads a stored tile size, accepting the old S/M/L names, or null when it isn't usable. */
export function parseTileSize(raw: string | null): TileSize | null {
  if (raw == null) return null;
  if (raw in LEGACY_SIZES) return LEGACY_SIZES[raw];
  const n = Number(raw);
  return Number.isFinite(n) && n >= TILE_MIN && n <= TILE_MAX ? n : null;
}

/** True when the item opens in the image viewer (rather than downloading or playing). */
export function opensInViewer(item: MediaItem): boolean {
  if (item.kind === 'project' || item.kind === 'video') return false;
  return item.previewable && (item.isImage || item.isFits);
}
