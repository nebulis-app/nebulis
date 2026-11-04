/**
 * Post-import pipeline. EVERY path that adds files to the library (telescope
 * import, folder import, sub-frame sync, manual observation, linked-folder
 * link and rescan) ends by calling `runPostImport`, so a file gets the same
 * follow-up work no matter how it arrived:
 *
 *   foreground (the import waits for these, each with a cap)
 *     1. catalog enrichment      Wikipedia / SIMBAD, per touched object
 *     2. session weather         queued, never awaited (FC-3)
 *     3. gallery thumbnails      capped at THUMB_PREWARM_MAX_WAIT_MS
 *   background (never awaited, serialized across runs)
 *     4. session thumbnails      the Nights calendar's per-night images
 *     5. sub-frame headers       FITS filter / exposure, persisted in
 *                                `subFrameHeaderCache` for the integration view
 *
 * Boot and the nightly housekeeping call it with no objects, which runs only
 * the background stages across the whole library.
 *
 * Adding a new follow-up job means adding a stage here, not a new hook in an
 * import path. tests/backend/postImportGuard.test.ts fails if a stage function
 * is called from anywhere else.
 */
import { log } from '../logger.js';
import { enrichObjectData } from './objects.js';
import { enqueueSessionWeatherBackfill } from './observations.js';
import { warmObjectThumbnails, type ThumbnailProgress } from './galleryThumbnailWarm.js';
import { prewarmSessionThumbnails } from './sessionThumbnailPrewarm.js';
import { warmSubFrameHeaders } from './integration.js';

export type PostImportReason =
  | 'telescope-import'
  | 'folder-import'
  | 'subframe-sync'
  | 'manual-observation'
  | 'linked-folder'
  | 'linked-rescan'
  | 'adopt-library'
  | 'archive-restore'
  | 'boot'
  | 'nightly';

export interface PostImportOptions {
  reason: PostImportReason;
  /** Objects whose rows or files changed: catalog enrichment and weather.
   *  Omit for a library-wide sweep (boot, nightly). */
  touched?: Iterable<string>;
  /** The subset that received new files: thumbnails and header analysis.
   *  Defaults to `touched`. */
  withNewFiles?: Iterable<string>;
  /** Progress of the gallery-thumbnail stage, for the import status panel. */
  onThumbnailProgress?: (progress: ThumbnailProgress) => void;
}

export interface PostImportHandle {
  /** Resolves once enrichment (capped at ENRICH_MAX_WAIT_MS), weather and (capped) gallery thumbnails are done. Never rejects. */
  foreground: Promise<void>;
  /** Resolves once the background stages are done too. Never rejects. */
  done: Promise<void>;
}

/** How long an import waits for thumbnail pre-warming before it reports done.
 *  A target with no local image falls back to a sky-survey fetch with a long
 *  timeout, so on a slow or offline network the wait used to hold the progress
 *  dialog at 100% for a minute or more. The workers keep running after this and
 *  anything unfinished is generated on first view. */
export const THUMB_PREWARM_MAX_WAIT_MS = 10_000;

/** How long an import waits for catalog enrichment before it reports done and releases the library lock. Enrichment
 *  calls Wikipedia and SIMBAD per object, and an offline or slow service used to keep every other library operation
 *  (archive, linked scan, repair, a second telescope) answering 409 until the last timeout expired. The rest carries on
 *  in the background, so the thumbnails still follow it and nothing is skipped. */
export const ENRICH_MAX_WAIT_MS = 30_000;

/** Resolve when `work` settles or `ms` passes, whichever is first. Never rejects:
 *  the work's own errors are handled inside it, and the caller only wants to stop
 *  waiting. */
export async function waitUpTo(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work.catch(() => undefined),
      new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Background stages of different runs queue here instead of competing for the disk. */
let backgroundTail: Promise<void> = Promise.resolve();

/** Run one stage, logging its outcome. A failing stage never stops the next one. */
async function stage(reason: PostImportReason, name: string, work: () => Promise<unknown>): Promise<void> {
  const startedAt = Date.now();
  try {
    await work();
    log.debug({ reason, stage: name, ms: Date.now() - startedAt }, '[post-import] %s done', name);
  } catch (err) {
    log.warn({ reason, stage: name, err: err instanceof Error ? err.message : String(err) }, '[post-import] %s failed', name);
  }
}

export function runPostImport(opts: PostImportOptions): PostImportHandle {
  const { reason } = opts;
  const sweep = opts.touched === undefined;
  const touched = [...(opts.touched ?? [])];
  const withNewFiles = sweep ? undefined : [...(opts.withNewFiles ?? touched)];

  const enrichment = (async () => {
    if (sweep) return;
    for (const objectId of touched) {
      await stage(reason, `enrich ${objectId}`, () => enrichObjectData(objectId));
      // Queued, not awaited: a slow archive API for a 25-night object used to
      // add minutes to import completion (FC-3).
      await stage(reason, `weather ${objectId}`, async () => enqueueSessionWeatherBackfill(objectId));
    }
  })();

  // Thumbnails follow enrichment because a target with no local image needs the coordinates it fetches.
  const thumbnails = enrichment.then(async () => {
    if (sweep || !withNewFiles || withNewFiles.length === 0) return;
    await stage(reason, 'gallery-thumbnails', () => warmObjectThumbnails(withNewFiles, opts.onThumbnailProgress));
  });

  const foreground = (async () => {
    await waitUpTo(enrichment, ENRICH_MAX_WAIT_MS);
    if (withNewFiles && withNewFiles.length > 0) await waitUpTo(thumbnails, THUMB_PREWARM_MAX_WAIT_MS);
  })();

  // A targeted run with nothing new has no background work; a sweep always does.
  const hasBackgroundWork = sweep || (withNewFiles?.length ?? 0) > 0;
  const done = hasBackgroundWork
    ? Promise.all([foreground, thumbnails]).then(() => {
      const run = backgroundTail.then(async () => {
        await stage(reason, 'session-thumbnails', () => prewarmSessionThumbnails(reason));
        await stage(reason, 'sub-frame-headers', async () => {
          const r = await warmSubFrameHeaders(withNewFiles);
          log.info({ reason, objects: r.objects, frames: r.frames }, '[post-import] sub-frame headers: %d object(s), %d frame(s)', r.objects, r.frames);
        });
      });
      backgroundTail = run;
      return run;
    })
    : foreground;

  return { foreground, done };
}
