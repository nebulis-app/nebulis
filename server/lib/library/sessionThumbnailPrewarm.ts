// Pre-render the per-session thumbnails the calendar / Nights list shows.
//
// `pregenerateObjectThumbnails` (import.ts) only warms ONE thumbnail per object
// (its best image). The Nights view asks for a thumbnail per *session*, via
// `getLocalObservations().thumbnailUrl` → `/library/file/thumbnail?path=<that
// night's stacked file>`. Those were never pre-warmed, so the first visit to
// any calendar month cold-rendered every card — 5-10s of blank tiles on a
// busy disk. This pass renders them ahead of time (idempotent, mtime-keyed),
// so the list paints from cache.
//
// Runs deferred on boot and after an import. Renders go through `runRender` so
// the pass shares the same concurrency budget as live requests.

import fs from 'fs';
import path from 'path';
import sharp from '../sharp-optional.js';
import { getLibraryDir } from '../libraryPath.js';
import { LINKED_SOURCE_DIR_NAME } from './archiveFolders.js';
import { THUMBNAILS_DIR } from '../paths.js';
import { runRender } from '../renderQueue.js';
import { getLocalObservations } from './observations.js';
import {
  fileThumbnailDiskCacheKey,
  objectThumbnailDiskCacheKey,
  resolveObjectImagePath,
  FILE_THUMBNAIL_DEFAULT_SIZE,
} from './gallery.js';

const SIZE = FILE_THUMBNAIL_DEFAULT_SIZE;

let running = false;

interface PrewarmResult {
  warmed: number;
  cached: number;
  skipped: number;
  errors: number;
}

/** `/api/v1/library/file/thumbnail?path=<X>` → the decoded, library-relative X. */
function fileThumbRelPath(thumbnailUrl: string): string | null {
  const m = /\/library\/file\/thumbnail\?path=([^&]+)/.exec(thumbnailUrl);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/** `/api/v1/library/objects/<id>/thumbnail` → the decoded object id. */
function objectThumbId(thumbnailUrl: string): string | null {
  const m = /\/library\/objects\/([^/]+)\/thumbnail(?:$|\?)/.exec(thumbnailUrl);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

async function renderIfMissing(cachePath: string, srcAbsPath: string): Promise<'warmed' | 'cached'> {
  if (fs.existsSync(cachePath)) return 'cached';
  await runRender(async () => {
    fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
    const tmpPath = `${cachePath}.${process.pid}.prewarm.tmp`;
    try {
      await sharp(srcAbsPath)
        .resize(SIZE, SIZE, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80, progressive: true })
        .toFile(tmpPath);
      await fs.promises.rename(tmpPath, cachePath);
    } catch (err) {
      try { await fs.promises.rm(tmpPath, { force: true }); } catch { /* best effort */ }
      throw err;
    }
  });
  return 'warmed';
}

/**
 * Warm the thumbnail cache for every session the calendar can show. Idempotent:
 * an entry whose cache file already exists is left alone. Single-flight.
 */
export async function prewarmSessionThumbnails(reason = 'manual'): Promise<PrewarmResult> {
  const result: PrewarmResult = { warmed: 0, cached: 0, skipped: 0, errors: 0 };
  if (running) {
    console.log(`[session-thumb-prewarm] Skipped (${reason}) — a run is already in progress`);
    return result;
  }
  running = true;
  const startedAt = Date.now();

  try {
    const libraryDir = getLibraryDir();
    const libRoot = libraryDir.endsWith(path.sep) ? libraryDir : libraryDir + path.sep;

    let observations: ReturnType<typeof getLocalObservations>;
    try {
      observations = getLocalObservations();
    } catch (err) {
      console.warn('[session-thumb-prewarm] could not list observations:', err instanceof Error ? err.message : err);
      return result;
    }

    console.log(`[session-thumb-prewarm] Start (${reason}) — checking ${observations.length} session thumbnail(s)`);

    // This is pure background nicety, and a near-full or Time-Machine-busy disk
    // is exactly when a client is most likely to be waiting on a live
    // thumbnail. So pace it: yield often, and rest briefly after every actual
    // render to leave disk + CPU headroom for real requests.
    const REST_AFTER_RENDER_MS = 150;

    for (let i = 0; i < observations.length; i++) {
      if (i % 10 === 0) await new Promise<void>(r => setImmediate(r));

      const url = observations[i].thumbnailUrl;
      try {
        let outcome: 'warmed' | 'cached' | null = null;

        const relPath = fileThumbRelPath(url);
        const objectId = relPath ? null : objectThumbId(url);

        if (relPath) {
          // A linked source's relPath (the '@src/...' form — see fileResolver.ts)
          // never lives under libraryDir, so joining it here would always miss on
          // existsSync below anyway (safe, but a wasted resolve+stat on every
          // pass). Skip explicitly: linked-file session thumbnails render
          // on-demand instead of being pre-warmed, matching the contract's scope
          // (only hero thumbnails are generated eagerly for a linked object).
          if (relPath.startsWith(LINKED_SOURCE_DIR_NAME + '/')) { result.skipped++; continue; }
          const absPath = path.resolve(libraryDir, relPath);
          if (!absPath.startsWith(libRoot) || !fs.existsSync(absPath)) { result.skipped++; continue; }
          if (!/\.(jpe?g|png|tiff?)$/i.test(relPath)) { result.skipped++; continue; }
          const mtimeMs = fs.statSync(absPath).mtimeMs;
          const cachePath = path.join(THUMBNAILS_DIR, `${fileThumbnailDiskCacheKey(relPath, SIZE, SIZE, mtimeMs)}.jpg`);
          outcome = await renderIfMissing(cachePath, absPath);
        } else if (objectId) {
          const srcPath = await resolveObjectImagePath(objectId);
          if (!srcPath || !fs.existsSync(srcPath)) { result.skipped++; continue; }
          const mtimeMs = fs.statSync(srcPath).mtimeMs;
          const cachePath = path.join(THUMBNAILS_DIR, `${objectThumbnailDiskCacheKey(srcPath, SIZE, SIZE, mtimeMs)}.jpg`);
          outcome = await renderIfMissing(cachePath, srcPath);
        } else {
          result.skipped++;
          continue;
        }

        result[outcome]++;
        if (outcome === 'warmed') await new Promise<void>(r => setTimeout(r, REST_AFTER_RENDER_MS));
      } catch (err) {
        result.errors++;
        if (result.errors <= 5) {
          console.warn('[session-thumb-prewarm]', url, '-', err instanceof Error ? err.message : err);
        }
      }
    }

    console.log(
      `[session-thumb-prewarm] Done (${reason}) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ` +
      `${result.warmed} warmed, ${result.cached} already cached, ${result.skipped} skipped, ${result.errors} errors`,
    );
    return result;
  } finally {
    running = false;
  }
}
