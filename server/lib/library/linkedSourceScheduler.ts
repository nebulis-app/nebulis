/**
 * Automatic refresh for linked folders.
 *
 * A source linked as "ongoing" carries `refreshIntervalMin`. Every tick this looks for sources whose
 * interval has elapsed and rescans them with the same `rescanSource` the Rescan button uses, so a
 * scheduled refresh and a manual one can never disagree about what a rescan does. A one-time source
 * (interval NULL) is never touched here.
 *
 * Sources run one after another, and the walk of each gives the event loop back as it goes, so the
 * API keeps answering during a long rescan. Nothing runs while any other library work (a copy import,
 * an archive run, a repair) holds the shared library lock.
 */
import { listDueSources, rescanSource } from './librarySources.js';
import { acquireLibraryLock, currentLibraryWork } from '../libraryBusy.js';
import { getSettingsData } from '../telescopes.js';
import { log } from '../logger.js';

const TICK_MS = 5 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export interface RefreshTickResult {
  ran: string[];
  skippedBecause: 'already-running' | 'import-running' | 'library-busy' | null;
}

export async function tickLinkedSourceRefresh(now: number = Date.now()): Promise<RefreshTickResult> {
  if (running) return { ran: [], skippedBecause: 'already-running' };
  const holder = currentLibraryWork();
  if (holder !== null) return { ran: [], skippedBecause: holder === 'import' ? 'import-running' : 'library-busy' };
  running = true;
  const ran: string[] = [];
  let skippedBecause: RefreshTickResult['skippedBecause'] = null;
  try {
    for (const source of listDueSources(now)) {
      // Taken per source rather than per tick, so an import or archive run that wants the library
      // between two sources is not kept waiting behind the whole batch. The lock is held across the
      // awaits of the rescan, which is what keeps a delete or an archive run out while it works.
      const release = acquireLibraryLock('linked-scan');
      if (release === null) {
        skippedBecause = currentLibraryWork() === 'import' ? 'import-running' : 'library-busy';
        break;
      }
      try {
        const result = await rescanSource(source.id, getSettingsData());
        ran.push(source.id);
        log.info(
          { sourceId: source.id, offline: result.offline, added: result.added, updated: result.updated, removed: result.removed },
          '[library-sources] scheduled refresh',
        );
      } catch (err) {
        // One failing source must not starve the rest. If the failure left lastScanAt alone it is
        // simply tried again next tick.
        log.warn({ sourceId: source.id, err: err instanceof Error ? err.message : String(err) }, '[library-sources] scheduled refresh failed');
      } finally {
        release();
      }
      // Let requests through between two sources.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  } finally {
    running = false;
  }
  return { ran, skippedBecause };
}

export function startLinkedSourceScheduler(): void {
  stopLinkedSourceScheduler();
  timer = setInterval(() => {
    tickLinkedSourceRefresh().catch(err =>
      console.error('[library-sources] scheduled tick failed:', err instanceof Error ? err.message : err),
    );
  }, TICK_MS);
  timer.unref();
  // A server that was off across an interval catches up shortly after boot instead of a full tick later.
  setTimeout(() => {
    tickLinkedSourceRefresh().catch(err =>
      console.error('[library-sources] boot refresh failed:', err instanceof Error ? err.message : err),
    );
  }, 60_000).unref();
  console.log('[library-sources] Refresh scheduler started');
}

export function stopLinkedSourceScheduler(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
