/**
 * Can an object ever be imaged from a site?
 *
 * The highest altitude a declination reaches from a latitude is
 * `90 - |lat - dec|` at the meridian. A southern target from the northern
 * hemisphere therefore has a small or negative value: negative means it never
 * rises, and a value below the site's minimum altitude means it never clears
 * the observer's practical horizon. This is the cheap "is it in my sky at all"
 * test, not a tonight forecast — the Planner's best-window math handles that.
 */
export function maxAltitudeForDec(dec: number, lat: number): number {
  return 90 - Math.abs(lat - dec);
}

export function isObservableFromSite(dec: number | null, lat: number | null, minAlt: number): boolean {
  if (dec == null || lat == null) return true; // unknown position/location: do not hide it
  return maxAltitudeForDec(dec, lat) >= minAlt;
}

export interface WallTileLike {
  dec: number | null;
  imaged: boolean;
  mergedIds: readonly string[];
}

/**
 * The observable subset of a "My Catalog" wall, counted the way the server
 * counts the whole wall: one for the tile plus the objects folded into its
 * frame, so the filtered progress matches the unfiltered one.
 */
export function wallObservableCounts(
  tiles: readonly WallTileLike[],
  lat: number | null,
  minAlt: number,
): { total: number; imaged: number } {
  let total = 0;
  let imaged = 0;
  for (const tile of tiles) {
    if (!isObservableFromSite(tile.dec, lat, minAlt)) continue;
    const n = 1 + tile.mergedIds.length;
    total += n;
    if (tile.imaged) imaged += n;
  }
  return { total, imaged };
}
