/**
 * Rate limiting for the API surface.
 *
 * This is a self-hosted, LAN-only app — normal usage is one household's
 * handful of devices, not a multi-tenant service — so these limits are sized
 * to never trip during real browsing (a gallery grid loading thumbnails, a
 * planner page polling status) while still capping a runaway client or a
 * scripted flood against endpoints that do real file/CPU/network work per
 * request (thumbnail generation, ZIP archiving, external sky-image fetches,
 * destructive admin actions).
 *
 * Mounted after `apiEnvelope` (so `res.apiError` exists) and before the route
 * handlers in both the `/api/v1` and legacy `/api` routers — see index.ts.
 */
import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';

function tooManyRequests(req: Request, res: Response): void {
  res.apiError(429, 'RATE_LIMITED', 'Too many requests. Slow down and try again shortly.');
}

/** General ceiling for the whole API. Generous enough that no legitimate
 *  browsing pattern (a big gallery grid, a planner page's parallel fetches)
 *  ever gets close, while still bounding a scripted flood. */
export const apiRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 1200,
  standardHeaders: true,
  legacyHeaders: false,
  handler: tooManyRequests,
});

/** Middle tier for routes that are individually cheap-ish but legitimately
 *  called in bursts of dozens within one page load (a gallery grid or file
 *  list requesting a thumbnail per item). Still well below the general
 *  ceiling so a scripted flood is capped, without throttling a real page
 *  load of images. */
export const burstyRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  handler: tooManyRequests,
});

/** Tightest tier: routes called at most a handful of times per minute under
 *  any legitimate use — a whole-object ZIP download, an external sky-image
 *  fetch triggered by opening one framing modal, or a destructive admin
 *  action like resetting the database. */
export const strictRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: tooManyRequests,
});
