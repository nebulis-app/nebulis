import i18n from '../../i18n';

export const BASE = '/api';

const TOKEN_KEY = 'nebulis_auth_token';

export function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setAuthToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAuthToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function authHeaders(): HeadersInit {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

interface ApiEnvelope<T> { ok: boolean; data: T; meta?: unknown }

function isEnvelope(v: unknown): v is ApiEnvelope<unknown> {
  return typeof v === 'object' && v !== null && 'ok' in v && 'data' in v;
}

/**
 * Resolves a server error to display text.
 *
 * The server's `{ error: { code, message } }` envelope (see
 * `server/middleware/apiEnvelope.ts`) always carries an English `message` —
 * the server has no notion of the client's language. `code` is a stable
 * identifier (e.g. `NOT_FOUND`, `LIBRARY_BUSY`) that's meant to survive
 * wording changes, so it doubles as a translation key: `errors.json`'s
 * `serverCodes.<code>` group carries a real translation for codes that are
 * unambiguous (one code, one message, everywhere it's used). A code with no
 * entry there — most of them, for now — falls straight through to the
 * server's English `message`, which is exactly the safe placeholder
 * behavior: nothing shows a raw key or breaks while codes are translated
 * incrementally over time.
 */
export function errorMessage(v: unknown, fallback: string): string {
  if (typeof v !== 'object' || v === null || !('error' in v)) return fallback;
  const { error } = v;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { message } = error;
    if (typeof message !== 'string') return fallback;
    if ('code' in error && typeof error.code === 'string') {
      const key = `serverCodes.${error.code}`;
      if (i18n.exists(key, { ns: 'errors' })) {
        return i18n.t(key, { ns: 'errors' });
      }
    }
    return message;
  }
  return fallback;
}

export async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  return (await fetchJSONWithMeta<T>(url, options)).data;
}

/**
 * Same as fetchJSON, but also returns the envelope's `meta` (undefined when the
 * response has none). For the few endpoints that put request-level details
 * there, e.g. POST /planner/plan's weather summary.
 */
export async function fetchJSONWithMeta<T>(url: string, options?: RequestInit): Promise<{ data: T; meta: unknown }> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    ...options,
  });
  if (!res.ok) {
    if (res.status === 401) {
      clearAuthToken();
      window.dispatchEvent(new CustomEvent('nebulis:auth-cleared'));
    }
    // A write the UI offered came back forbidden: our cached role is stale or
    // was never confirmed. Let AuthContext re-check so the offending controls
    // disappear instead of failing again on the next click.
    if (res.status === 403) {
      window.dispatchEvent(new CustomEvent('nebulis:forbidden'));
    }
    const body: unknown = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(errorMessage(body, res.statusText));
  }
  const body: unknown = await res.json();
  // Unwrap API envelope if present: { ok, data, meta }.
  //
  // Trust boundary — T is a caller-supplied description of a server response;
  // nothing at runtime knows what T is, so no guard can be written here. The
  // envelope itself IS proven (isEnvelope above); only the payload inside is
  // taken on trust, and it comes from our own API whose response shapes are
  // Zod-validated server-side. Callers that handle genuinely untrusted or
  // optional data should narrow again at the call site.
  const payload: unknown = isEnvelope(body) ? body.data : body;
  const meta: unknown = isEnvelope(body) ? body.meta : undefined;
  return { data: payload as T, meta };
}

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

export async function fetchBinary(url: string, signal?: AbortSignal, t?: TFunc): Promise<ArrayBuffer> {
  const res = await fetch(url, { headers: authHeaders(), signal });
  if (!res.ok) {
    throw new Error(
      t
        ? t('errors:requestFailed', { status: res.status, statusText: res.statusText })
        : `Request failed: ${res.status} ${res.statusText}`
    );
  }
  return res.arrayBuffer();
}
