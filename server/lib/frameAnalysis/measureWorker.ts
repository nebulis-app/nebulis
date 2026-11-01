/**
 * The worker thread that measures frames, so the server's main thread (HTTP, sync jobs, imports) never stalls on a
 * megapixel star search. It owns no state: a message names a file, the reply is that file's metrics or why it
 * could not be read. Spawned by `measureOffThread.ts`.
 */
import fs from 'fs';
import { parentPort } from 'worker_threads';
import { FrameDecodeError, measureFrame, type TargetSpec } from './measure.js';
import { isRecord } from '../typeGuards.js';

if (parentPort) {
  const port = parentPort;
  port.on('message', (message: unknown) => {
    if (!isRecord(message) || typeof message.id !== 'number' || typeof message.abs !== 'string') return;
    const { id, abs } = message;
    const t = isRecord(message.target) ? message.target : null;
    const target: TargetSpec | null = t && typeof t.ra === 'number' && typeof t.dec === 'number' && typeof t.radiusArcmin === 'number'
      ? { ra: t.ra, dec: t.dec, radiusArcmin: t.radiusArcmin } : null;
    try {
      const metrics = measureFrame(fs.readFileSync(abs), target);
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
