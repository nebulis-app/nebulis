/**
 * The background queue that measures a night's frames after someone opens it, so a list fills in without a
 * button and without a request per frame. It lives in memory and is cheap to refill: asking again for a night
 * skips what is stored or already waiting, so a restart loses nothing but a few seconds.
 *
 * Frames are taken one at a time, which is also what the worker does, so a large library never starves the rest
 * of the server and a second admin opening the same night adds nothing.
 */
import { FrameFileError, measureLibraryFile } from './service.js';
import { log } from '../logger.js';

const waiting: string[] = [];
const queued = new Set<string>();
/** Why a frame could not be measured, until it is asked for again. In memory only. */
const failures = new Map<string, string>();
/** Frames asked for again on purpose: measured even when a stored measurement exists. */
const forced = new Set<string>();
let running = false;
let inflight: string | null = null;

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (waiting.length > 0) {
      const path = waiting.shift() as string;
      queued.delete(path);
      inflight = path;
      try {
        await measureLibraryFile(path, forced.delete(path));
        failures.delete(path);
      } catch (err) {
        failures.set(path, err instanceof FrameFileError || err instanceof Error ? err.message : String(err));
      }
      inflight = null;
    }
  } catch (err) {
    log.warn({ err }, '[frame-analysis] queue stopped');
  } finally {
    inflight = null;
    running = false;
  }
}


/** Add frames to the queue; those already waiting or running are left where they are. Returns how many were added. */
export function enqueueFrames(paths: string[], force = false): number {
  let added = 0;
  for (const p of paths) {
    if (queued.has(p) || p === inflight) continue;
    failures.delete(p);
    queued.add(p);
    waiting.push(p);
    if (force) forced.add(p);
    added++;
  }
  if (added > 0) void drain();
  return added;
}

export interface QueueState {
  /** Frames of the given set that are waiting or being measured right now. */
  pending: number;
  /** Frames of the given set that could not be read, with the reason. */
  failures: Record<string, string>;
}

export function queueStateFor(paths: string[]): QueueState {
  let pending = 0;
  const failed: Record<string, string> = {};
  for (const p of paths) {
    if (queued.has(p) || p === inflight) pending++;
    const why = failures.get(p);
    if (why) failed[p] = why;
  }
  return { pending, failures: failed };
}
