/**
 * Short-lived signed tokens for browser-initiated file downloads.
 *
 * A plain `<a download>` click (or `<img src>`, `window.open`) cannot carry the
 * `Authorization: Bearer` header the rest of the API uses — the browser owns
 * that request and there is no API to add a header to it. Rather than leave the
 * whole-object ZIP route unauthenticated, the SPA calls an authenticated
 * endpoint to mint one of these tokens and puts it in the download URL as
 * `?t=<token>`. The token IS the credential: it is bound to one exact request
 * path and expires within minutes.
 *
 * HMAC-SHA256 keyed on the same at-rest data key used for sealed credentials
 * (`crypto/dataKey`). Stateless — no server-side map to grow or clean up.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { getDataKey } from './crypto/dataKey.js';

/** Default lifetime. Long enough for a slow "mint → click → connect" round
 *  trip, short enough that a leaked URL (proxy log, shoulder-surf) is stale
 *  almost immediately. */
export const DOWNLOAD_TOKEN_TTL_MS = 5 * 60 * 1000;

function sign(payload: string): string {
  return createHmac('sha256', getDataKey()).update(payload).digest('base64url');
}

/**
 * Mint a token that authorizes a GET of exactly `scope` (the prefix-stripped
 * request path, e.g. `/library/download/objects/M42`) until it expires.
 */
export function mintDownloadToken(scope: string, ttlMs: number = DOWNLOAD_TOKEN_TTL_MS): string {
  const exp = Date.now() + ttlMs;
  return `${exp}.${sign(`${exp}.${scope}`)}`;
}

/**
 * True when `token` was minted by this server for this exact `scope` and has
 * not expired. Constant-time signature comparison; every malformed shape
 * returns false rather than throwing.
 */
export function verifyDownloadToken(token: string, scope: string): boolean {
  if (typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;

  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || Date.now() > exp) return false;

  const provided = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(`${exp}.${scope}`));
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
