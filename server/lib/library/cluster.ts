/**
 * Data for the desktop app's Library "Cluster" view: for each object, how much has been done with it (processed
 * images, telescope stacks, sub-frames) and the user's own best picture of it.
 *
 * The counts are three batched queries, not one per object. The picture reuses the My Catalog wall's resolver, which
 * only ever returns the user's own images (never a sky-survey master) and caches each image's aspect ratio.
 */
import db from '../db.js';
import { resolveWallImage, type WallImage } from '../catalogWall.js';
import { getGalleryImageRow } from './gallery.js';
import { isDwarfThumbnailPreviewName } from './dwarfRestack.js';

export interface ClusterItem {
  objectId: string;
  processedCount: number;
  stackedCount: number;
  subCount: number;
  image: WallImage | null;
}

interface Counts { processed: number; stacked: number; subs: number; newestProcessed: string }

const roleCounts = db.prepare<[], { objectId: string; role: string; n: number }>(
  `SELECT objectId, role, COUNT(*) AS n FROM libraryFiles
   WHERE missingSince IS NULL AND role IN ('stacked', 'sub') GROUP BY objectId, role`,
);
const processedRows = db.prepare<[], { objectId: string; originalName: string; uploadedAt: string }>(
  'SELECT objectId, originalName, uploadedAt FROM sessionProcessedImages',
);

/** One entry per object that has any library data. Objects not listed have nothing to show. */
export function collectClusterCounts(): Map<string, Counts> {
  const out = new Map<string, Counts>();
  const entry = (id: string): Counts => {
    let c = out.get(id);
    if (!c) { c = { processed: 0, stacked: 0, subs: 0, newestProcessed: '' }; out.set(id, c); }
    return c;
  };
  for (const r of roleCounts.all()) {
    const c = entry(r.objectId);
    if (r.role === 'stacked') c.stacked = r.n; else c.subs = r.n;
  }
  for (const r of processedRows.all()) {
    // Same exclusion as getAllProcessedImagesForObject, so the count agrees with what the object page lists.
    if (isDwarfThumbnailPreviewName(r.originalName)) continue;
    const c = entry(r.objectId);
    c.processed++;
    if (r.uploadedAt > c.newestProcessed) c.newestProcessed = r.uploadedAt;
  }
  return out;
}

// Resolving a picture touches the database and the disk, so it is remembered until something that could change the
// answer does: a new/removed processed or stacked image, or a different featured picture.
const imageCache = new Map<string, { sig: string; image: WallImage | null }>();

export function clearClusterImageCache(): void { imageCache.clear(); }

async function imageFor(objectId: string, c: Counts): Promise<WallImage | null> {
  const g = getGalleryImageRow(objectId);
  const sig = [c.processed, c.stacked, c.newestProcessed, g.galleryImage ?? '', g.userSet ? 1 : 0].join('|');
  const hit = imageCache.get(objectId);
  if (hit && hit.sig === sig) return hit.image;
  const image = await resolveWallImage(objectId).catch(() => null);
  imageCache.set(objectId, { sig, image });
  return image;
}

const POOL = 8;

export async function getClusterItems(): Promise<ClusterItem[]> {
  const counts = [...collectClusterCounts().entries()];
  const items: ClusterItem[] = new Array(counts.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= counts.length) return;
      const [objectId, c] = counts[i];
      items[i] = {
        objectId,
        processedCount: c.processed,
        stackedCount: c.stacked,
        subCount: c.subs,
        image: await imageFor(objectId, c),
      };
    }
  }
  await Promise.all(Array.from({ length: Math.min(POOL, counts.length) }, worker));
  return items;
}
