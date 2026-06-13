/**
 * Correlation ID middleware.
 *
 * Generates a UUID per incoming request, exposes it via:
 *  - req.id          (typed on Express.Request in server/types/express.d.ts)
 *  - X-Request-Id    response header (already in CORS exposedHeaders)
 *  - AsyncLocalStorage stored in lib/requestContext, picked up by the pino
 *    mixin in lib/logger so every log line emitted during the request
 *    automatically carries requestId without callers threading it through.
 */
import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { requestContext } from '../lib/requestContext.js';

export { requestContext };
export type { RequestContext } from '../lib/requestContext.js';

export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);
  requestContext.run({ requestId }, next);
}
