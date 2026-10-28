/**
 * Gallery thumbnail pre-warm: one 400x400 thumbnail per object, rendered ahead
 * of the first library-grid view. Uses the same resolveObjectImagePath logic as
 * the thumbnail route so the generated cache key is always identical to what
 * the route will look up. Runs up to 4 objects concurrently to saturate the
 * sharp/libvips thread pool.
 *
 * A pipeline stage of postImport.ts; nothing else should call it.
 */
import fs from 'fs';
import path from 'path';
import { THUMBNAILS_DIR } from '../paths.js';
import sharp from '../sharp-optional.js';
import { log } from '../logger.js';
import { assertSafeRaster } from '../imageSniff.js';
import { resolveObjectImagePath, objectThumbnailDiskCacheKey } from './gallery.js';

export type ThumbnailProgress = { done: number; total: number } | null;

export async function warmObjectThumbnails(
  objectIds: Iterable<string>,
  onProgress?: (progress: ThumbnailProgress) => void,
): Promise<void> {
  const THUMB_W = 400;
  const THUMB_H = 400;
  const ids = Array.from(objectIds);
  log.info({ count: ids.length }, '[thumb] Pre-generating gallery thumbnails for %d object(s)', ids.length);

  onProgress?.({ done: 0, total: ids.length });

  const queue = ids.slice();
  const CONCURRENCY = 4;
  // Local counter, not a read-modify-write off the caller's status object: that
  // object can be reset by a subsequent import run while these workers are
  // still mid-await, which would null-deref on the next increment.
  let done = 0;

  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const objectId = queue.shift();
      if (!objectId) break;
      try {
        const srcPath = await resolveObjectImagePath(objectId);
        if (srcPath && fs.existsSync(srcPath)) {
          const mtimeMs = fs.statSync(srcPath).mtimeMs;
          const cacheKey = objectThumbnailDiskCacheKey(srcPath, THUMB_W, THUMB_H, mtimeMs);
          const cachePath = path.join(THUMBNAILS_DIR, `${cacheKey}.jpg`);
          if (!fs.existsSync(cachePath)) {
            fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
            await assertSafeRaster(srcPath);
            await sharp(srcPath)
              .resize(THUMB_W, THUMB_H, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 80, progressive: true })
              .toFile(cachePath);
          }
        }
      } catch (err) {
        // Never block import completion: the thumbnail regenerates on demand
        // elsewhere, but a repeated failure here is worth seeing.
        log.warn({ err: err instanceof Error ? err.message : String(err), objectId }, '[import] thumbnail pre-warm failed');
      }
      done++;
      onProgress?.({ done, total: ids.length });
    }
  }));

  onProgress?.(null);
}
