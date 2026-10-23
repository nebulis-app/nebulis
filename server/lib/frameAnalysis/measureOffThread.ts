/**
 * Runs `measureFrame` on a worker thread and hands back the result.
 *
 * Measuring is a few hundred milliseconds of tight loops per frame. On the main thread that stalls every request
 * for the length of the loop, and a whole night is minutes of it. One lazily started worker takes the work, and
 * stops after a minute idle so its memory is returned.
 *
 * The worker file is found in three places. Next to this one as `measureWorker.ts` when the server runs from
 * source (tsx, Docker). Beside the bundle as `measureWorker.cjs` (a second tsup entry) when the bundle runs
 * from a real folder. And inside a `pkg` executable, where a worker cannot load a file from the snapshot: the
 * build stages it as the asset `assets/frame-worker/measureWorker.worker`, and it is written to the data folder
 * once and started from there. If a worker cannot be started at all, measuring falls back to the calling thread
 * so the feature still works, and the reason is logged once.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import { FrameDecodeError, measureFrame, type FrameMetrics } from './measure.js';
import { coerceMetrics } from './metricsRecord.js';
import { isRecord } from '../typeGuards.js';
import { log } from '../logger.js';
import { DATA_DIR } from '../paths.js';

const IDLE_STOP_MS = 60_000;

interface Pending {
  abs: string;
  resolve: (m: FrameMetrics) => void;
  reject: (e: Error) => void;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
let idleTimer: NodeJS.Timeout | null = null;
/** Set when a worker could not be started; from then on everything runs in this thread. */
let inProcessReason: string | null = null;
/** True once a worker has answered a message, i.e. it is known to run in this environment. */
let workerProven = false;

const SNAPSHOT_MARK = /[\\/]snapshot[\\/]/;
const STAGED_ASSET = path.join('assets', 'frame-worker', 'measureWorker.worker');

/** A packaged executable keeps its files in a read-only snapshot that a worker thread cannot load from. */
function extractFromSnapshot(here: string, dataDir: string): string | null {
  const staged = [path.join(here, STAGED_ASSET), path.join(here, '..', STAGED_ASSET)].find(p => fs.existsSync(p));
  if (!staged) return null;
  const code = fs.readFileSync(staged);
  const hash = crypto.createHash('sha1').update(code).digest('hex').slice(0, 12);
  const dir = path.join(dataDir, 'cache');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `frame-worker-${hash}.cjs`);
  if (!fs.existsSync(target)) fs.writeFileSync(target, code);
  return target;
}

/** Where the worker file is for code running from `here`. Exported so the three layouts can be tested. */
export function resolveWorkerFile(here: string, dataDir: string): string | null {
  if (SNAPSHOT_MARK.test(here)) return extractFromSnapshot(here, dataDir);
  for (const name of ['measureWorker.cjs', 'measureWorker.js', 'measureWorker.ts']) {
    const candidate = path.join(here, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function failAll(reason: string): void {
  for (const p of pending.values()) p.reject(new Error(reason));
  pending.clear();
}

/**
 * A worker that dies before it has ever answered cannot run here (the runtime cannot load the file, a packaged
 * layout is missing it). Stop using workers and measure what was waiting on this thread, so no frame is lost to
 * a missing worker. A worker that has run before and then crashes is a bad file, which is reported as one.
 */
function giveUpOnWorker(reason: string): void {
  inProcessReason = reason;
  log.warn('[frame-analysis] the measuring worker cannot run here (%s); measuring on the main thread', reason);
  const waiting = [...pending.values()];
  pending.clear();
  for (const p of waiting) {
    void fs.promises.readFile(p.abs).then(buf => p.resolve(measureFrame(buf))).catch(err => p.reject(err instanceof Error ? err : new Error(String(err))));
  }
}

function stopWorker(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const w = worker;
  worker = null;
  if (w) void w.terminate();
}

function scheduleIdleStop(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (pending.size === 0) stopWorker(); }, IDLE_STOP_MS);
  idleTimer.unref();
}

function startWorker(): Worker | null {
  if (worker) return worker;
  if (inProcessReason) return null;
  const file = resolveWorkerFile(path.dirname(fileURLToPath(import.meta.url)), DATA_DIR);
  if (!file) {
    inProcessReason = 'worker file not found';
    log.warn('[frame-analysis] %s next to the server; measuring on the main thread', inProcessReason);
    return null;
  }
  try {
    const w = new Worker(file);
    w.unref();
    w.on('message', (msg: unknown) => {
      if (!isRecord(msg) || typeof msg.id !== 'number') return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok === true) {
        const metrics = coerceMetrics(msg.metrics);
        if (metrics) p.resolve(metrics);
        else p.reject(new Error('The measurement came back malformed'));
      } else {
        const text = typeof msg.message === 'string' ? msg.message : 'Measuring failed';
        p.reject(msg.unreadable === true ? new FrameDecodeError(text) : new Error(text));
      }
      workerProven = true;
      if (pending.size === 0) scheduleIdleStop();
    });
    w.on('error', err => {
      if (worker === w) worker = null;
      const reason = err instanceof Error ? err.message : String(err);
      if (!workerProven) { giveUpOnWorker(reason); return; }
      log.warn({ err }, '[frame-analysis] measuring worker failed');
      failAll(reason);
    });
    w.on('exit', code => {
      if (worker === w) worker = null;
      if (code === 0) return;
      const reason = `The measuring worker stopped (exit code ${code})`;
      if (!workerProven) giveUpOnWorker(reason); else failAll(reason);
    });
    worker = w;
    return w;
  } catch (err) {
    inProcessReason = err instanceof Error ? err.message : String(err);
    log.warn('[frame-analysis] cannot start a worker (%s); measuring on the main thread', inProcessReason);
    return null;
  }
}

/** Measure the FITS file at an absolute path, off the main thread when a worker can run. */
export async function measureOffThread(abs: string): Promise<FrameMetrics> {
  const w = startWorker();
  if (!w) return measureFrame(await fs.promises.readFile(abs));
  return new Promise<FrameMetrics>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { abs, resolve, reject });
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    w.postMessage({ id, abs });
  });
}

/** For tests: stop the worker and forget why one could not start. */
export function resetMeasureWorker(): void {
  stopWorker();
  failAll('reset');
  inProcessReason = null;
  workerProven = false;
}
