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
    const body = await res.json().catch(() => ({ error: res.statusText }));
    // Handle envelope error format
    const message = body?.error?.message || body?.error || res.statusText;
    throw new Error(message);
  }
  const body = await res.json();
  // Unwrap API envelope if present: { ok, data, meta }
  if (body && typeof body === 'object' && 'ok' in body && 'data' in body) {
    return body.data as T;
  }
  return body as T;
}

export async function fetchBinary(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(url, { headers: authHeaders(), signal });
  if (!res.ok) throw new Error(`Request failed: ${res.status} ${res.statusText}`);
  return res.arrayBuffer();
}
