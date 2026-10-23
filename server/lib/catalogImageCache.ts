/**
 * Cache-Control for a catalog picture. A galaxy does not change, so once the
 * browser has the final picture it never needs to ask again: Hubble and
 * Wikipedia masters are kept for a year and marked immutable. A DSS2 plate is
 * the fallback, and a better master (Hubble from a catalog pack) can replace it
 * under the same URL, so it is held for 30 days rather than a year. The server
 * itself never evicts masters or canonical thumbnails (see the pruning note
 * above), so what the browser lets go of is still on disk.
 */
export function catalogImageCacheControl(source: 'hubble' | 'wiki' | 'dss2'): string {
  return source === 'dss2'
    ? 'public, max-age=2592000'
    : 'public, max-age=31536000, immutable';
}
