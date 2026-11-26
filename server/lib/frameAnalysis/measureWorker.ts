/**
 * The worker thread that measures frames, so the server's main thread (HTTP, sync jobs, imports) never stalls on a
 * megapixel star search. It owns no state: a message names a file, the reply is that file's metrics or why it
 * could not be read. Spawned by `measureOffThread.ts`.
 */
import fs from 'fs';
import { parentPort } from 'worker_threads';
import { FrameDecodeError, measureFrame, type FileWcs, type TargetSpec } from './measure.js';
import { isRecord } from '../typeGuards.js';

if (parentPort) {
  const port = parentPort;
  port.on('message', (message: unknown) => {
    if (!isRecord(message) || typeof message.id !== 'number' || typeof message.abs !== 'string') return;
    const { id, abs } = message;
    const t = isRecord(message.target) ? message.target : null;
    const target: TargetSpec | null = t && typeof t.ra === 'number' && typeof t.dec === 'number' && typeof t.radiusArcmin === 'number'
      ? { ra: t.ra, dec: t.dec, radiusArcmin: t.radiusArcmin } : null;
    const w = isRecord(message.wcs) ? message.wcs : null;
    const cd = w && Array.isArray(w.cd) && w.cd.length === 4 && w.cd.every(c => typeof c === 'number') ? (w.cd as [number, number, number, number]) : null;
    const wcs: FileWcs | null = w && cd && typeof w.crval1 === 'number' && typeof w.crval2 === 'number'
      && typeof w.crpix1 === 'number' && typeof w.crpix2 === 'number'
      ? { crval1: w.crval1, crval2: w.crval2, crpix1: w.crpix1, crpix2: w.crpix2, cd } : null;
    try {
      const metrics = measureFrame(fs.readFileSync(abs), target, wcs);
      port.postMessage({ id, ok: true, metrics });
    } catch (err) {
      port.postMessage({
        id,
        ok: false,
        unreadable: err instanceof FrameDecodeError,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
