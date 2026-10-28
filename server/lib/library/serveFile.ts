/**
 * Library — stream one already-resolved file to an HTTP client.
 *
 * Several routes serve library bytes without a credential (an <img> or <video>
 * cannot send an Authorization header, see the bypass list in
 * middleware/auth.ts). They used to read the whole file into a Buffer first,
 * once synchronously, so a request for a large file cost its full size in
 * memory (or stalled the event loop) per concurrent caller. This streams from
 * disk with `res.sendFile` instead: constant memory, Range support, ETag and
 * Last-Modified for free.
 *
 * The caller is responsible for turning a client-supplied path into `abs` via
 * `resolveLibraryFile` (fileResolver.ts), which is the containment check.
 */
import path from 'path';
import type { Response } from 'express';
import { statLibraryFileForServe, TimeoutError } from '../libraryPath.js';

export interface ServeOptions {
  contentType: string;
  /** Full Content-Disposition header value, or omit to send none. */
  contentDisposition?: string;
  cacheControl?: string;
}

/**
 * Sends `abs`, or answers 404 (missing / not a regular file) or 503 with
 * Retry-After (a network library that is slow right now, which is transient).
 */
export async function sendLibraryFile(res: Response, abs: string, opts: ServeOptions): Promise<void> {
  try {
    const stat = await statLibraryFileForServe(abs);
    if (!stat.isFile()) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
  } catch (err) {
    if (err instanceof TimeoutError) {
      res.status(503).set('Retry-After', '2').type('text/plain').send('Library is busy, retry shortly');
    } else {
      res.status(404).type('text/plain').send('Not found');
    }
    return;
  }

  res.set('Content-Type', opts.contentType);
  res.set('Cache-Control', opts.cacheControl ?? 'public, max-age=3600');
  if (opts.contentDisposition) res.set('Content-Disposition', opts.contentDisposition);

  await new Promise<void>(resolve => {
    // dotfiles: 'allow' because `abs` is already contained and vetted by the
    // caller. With an absolute path and no `root`, 'deny' would reject any
    // library that merely lives under a dot-directory (~/.local/...), which the
    // old buffered reads served fine. Hidden files INSIDE the library are
    // filtered by isRealFile before a path gets here.
    res.sendFile(path.resolve(abs), { acceptRanges: true, dotfiles: 'allow' }, err => {
      // A dropped connection mid-stream is not worth a response or a log line.
      if (err && !res.headersSent) {
        const status = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500;
        res.status(status).type('text/plain').send(status === 404 ? 'Not found' : 'Could not read file');
      }
      resolve();
    });
  });
}
