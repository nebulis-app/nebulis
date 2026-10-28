/**
 * Graceful shutdown: stop taking work, give running work a short chance to reach
 * a safe point, flush SQLite, then exit.
 *
 * The hard limit is launchd's 5 second exit timeout (macOS) and the similar
 * wait NSSM gives the Windows service: past it the process is SIGKILLed while
 * the OS still holds the service label, which once left the service stopped
 * after an update. So the wait is bounded (DEFAULT_GRACE_MS plus the flush
 * delay stays under 5s), and a server with nothing running still exits in about
 * the flush delay, as it did before this existed.
 *
 * Kept free of imports from the rest of the server so it can be tested with
 * stub servers and a fake exit, without signals or a database.
 */
import type { Server } from 'http';
import type { Request, Response, NextFunction } from 'express';

export const DEFAULT_GRACE_MS = 3_000;
const DEFAULT_POLL_MS = 50;
/** Lets the final log line and close callbacks flush before process.exit. */
const DEFAULT_FLUSH_MS = 300;

export interface ShutdownOptions {
  servers: Server[];
  /** True while something that should not be cut off is running: an open request, an import, an archive run. */
  isBusy: () => boolean;
  /** Ask long-running work to stop at its next safe point (best effort, called once). */
  requestStop?: () => void;
  /** Runs right after the listeners stop accepting, before waiting (for example: tell keep-alive clients to disconnect). */
  onStart?: () => void;
  /** Flush the write-ahead log and release the database file. */
  closeDatabase: () => void;
  exit: (code: number) => void;
  log?: (message: string) => void;
  graceMs?: number;
  pollMs?: number;
  flushMs?: number;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Returns the function to call from a signal handler. Calling it again while a
 * shutdown is running is a no-op that returns the same promise.
 */
export function createShutdown(opts: ShutdownOptions): (signal: string) => Promise<void> {
  const log = opts.log ?? (() => {});
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS;
  let running: Promise<void> | null = null;

  async function run(signal: string): Promise<void> {
    log(`Received ${signal}, shutting down`);

    // Stop accepting connections. Requests already being served keep going.
    for (const srv of opts.servers) {
      srv.close();
      srv.closeIdleConnections();
    }
    opts.onStart?.();

    if (opts.isBusy()) {
      log(`Waiting up to ${Math.round(graceMs / 1000)}s for running work to finish`);
      try { opts.requestStop?.(); } catch (err) {
        log(`Could not ask running work to stop: ${err instanceof Error ? err.message : String(err)}`);
      }
      const deadline = Date.now() + graceMs;
      while (opts.isBusy() && Date.now() < deadline) {
        await sleep(pollMs);
        // Connections that went idle while we waited are safe to drop now.
        for (const srv of opts.servers) srv.closeIdleConnections();
      }
      if (opts.isBusy()) log('Work is still running after the grace period; stopping it now');
    }

    for (const srv of opts.servers) srv.closeAllConnections();

    await sleep(flushMs);

    // Checkpointing the WAL before exit keeps the main database file complete,
    // so a copy of nebulis.db taken after a clean stop needs no -wal file. This
    // is deliberately the last step, with nothing awaited between it and exit:
    // a scheduler tick that fired after the close would hit a closed database.
    try {
      opts.closeDatabase();
    } catch (err) {
      log(`Database close failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    opts.exit(0);
  }

  return (signal: string) => (running ??= run(signal));
}

/**
 * Counts requests that have started and not yet finished, so shutdown can wait
 * for them. Once `markClosing` is called, responses carry `Connection: close`
 * so a keep-alive client does not send its next request into a stopping server.
 */
export function createRequestTracker(): {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  active: () => number;
  markClosing: () => void;
} {
  let active = 0;
  let closing = false;
  return {
    middleware(_req, res, next) {
      active++;
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        active--;
      };
      res.on('finish', end);
      res.on('close', end);
      if (closing) res.setHeader('Connection', 'close');
      next();
    },
    active: () => active,
    markClosing: () => { closing = true; },
  };
}
