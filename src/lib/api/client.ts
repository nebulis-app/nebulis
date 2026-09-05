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

export function errorMessage(v: unknown, fallback: string): string {
  if (typeof v !== 'object' || v === null || !('error' in v)) return fallback;
  const { error } = v;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { message } = error;
    if (typeof message === 'string') return message;
  }
  return fallback;
}

export async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
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
  return payload as T;
}

export async function fetchBinary(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(url, { headers: authHeaders(), signal });
  if (!res.ok) throw new Error(`Request failed: ${res.status} ${res.statusText}`);
  return res.arrayBuffer();
}
