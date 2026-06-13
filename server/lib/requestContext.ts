/**
 * AsyncLocalStorage holding per-request correlation data.
 *
 * Lives in lib/ rather than middleware/ so logger.ts can import it without
 * pulling Express into the bootstrap path. The middleware that populates it
 * is at server/middleware/correlation.ts.
 */
import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  requestId: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();
