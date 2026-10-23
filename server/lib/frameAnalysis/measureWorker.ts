/**
 * The worker thread that measures frames, so the server's main thread (HTTP, sync jobs, imports) never stalls on a
 * megapixel star search. It owns no state: a message names a file, the reply is that file's metrics or why it
 * could not be read. Spawned by `measureOffThread.ts`.
 */
import fs from 'fs';
import { parentPort } from 'worker_threads';
import { FrameDecodeError, measureFrame } from './measure.js';
import { isRecord } from '../typeGuards.js';

if (parentPort) {
  const port = parentPort;
  port.on('message', (message: unknown) => {
    if (!isRecord(message) || typeof message.id !== 'number' || typeof message.abs !== 'string') return;
    const { id, abs } = message;
    try {
      const metrics = measureFrame(fs.readFileSync(abs));
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
