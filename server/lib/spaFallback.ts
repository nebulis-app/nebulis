/**
 * Production SPA fallback.
 *
 * Registered last, after the API routers and `express.static`, so it only sees
 * a request nothing else claimed. It serves the built `index.html` for
 * client-side routes, and a plain 404 for anything that names a file: the shell
 * is HTML, so answering a missing module chunk with it makes the browser report
 * the opaque "Importing a module script failed" instead of a clean 404. That is
 * what a tab holding an `index.html` from a build the server has since replaced
 * hits when it lazily loads a route. `src/lib/chunkReload.ts` is the client half
 * of the recovery.
 *
 * Extracted from `index.ts` so the behaviour and its headers can be tested
 * without booting the whole server.
 */
import path from 'path';
import type { RequestHandler } from 'express';
import { looksLikeAssetRequest } from './staticAssets.js';

export function spaFallback(distPath: string): RequestHandler {
  const indexPath = path.join(distPath, 'index.html');
  return (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/plugins/pixinsight')) return next();
    if (looksLikeAssetRequest(req.path)) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    // index.html names the chunk hashes for the build it belongs to, so it must
    // revalidate rather than be reused from cache. This mirrors the static
    // handler in index.ts, which cannot cover this path because sendFile here
    // bypasses express.static's setHeaders.
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexPath);
  };
}
