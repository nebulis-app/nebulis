/** Per-tile edits a user made to the wall: size, picture and crop (centre + zoom). */

export interface WallSpan { cols: number; rows: number }

export interface WallOverride {
  span?: WallSpan;
  /** Library-relative path of a chosen picture (one of the object's own images). */
  imagePath?: string;
  /** Focal point (0–1 each axis) kept in view when the tile crops the picture. */
  focus?: { x: number; y: number };
  /** 1 = the whole cover window; higher zooms in on `focus`. */
  zoom?: number;
}

export type WallOverrides = Record<string, WallOverride>;

/** Every `WallOverride` field, for code that walks them generically (e.g.
 *  stripping fields explicitly set to `undefined`). */
export const WALL_OVERRIDE_KEYS = ['span', 'imagePath', 'focus', 'zoom'] as const satisfies readonly (keyof WallOverride)[];

// Compile-time exhaustiveness: adding a field to WallOverride without listing
// it above makes this line a type error instead of a silently skipped key.
const _allWallOverrideKeysListed: [Exclude<keyof WallOverride, (typeof WALL_OVERRIDE_KEYS)[number]>] extends [never] ? true : false = true;
void _allWallOverrideKeysListed;
