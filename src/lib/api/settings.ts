import type { Settings } from '../../types';
import { fetchJSON, BASE, authHeaders, errorMessage } from './client';

export const getSettings = () => fetchJSON<Settings>('/settings');
export const updateSettings = (settings: Partial<Settings>) =>
  fetchJSON<Settings>('/settings', { method: 'PUT', body: JSON.stringify(settings) });
export const resetDatabase = () =>
  fetchJSON<{ reset: boolean }>('/settings/reset-database', {
    method: 'DELETE',
    body: JSON.stringify({ confirmation: 'delete' }),
  });

// Run the nightly maintenance batch now (the enabled tasks only).
export const runNightlyMaintenanceNow = () =>
  fetchJSON<{ started: boolean }>('/settings/nightly/run', { method: 'POST' });

// Debug logging
interface DebugLoggingStatus {
  enabled: boolean;
  enabledAt: string | null;
  expiresAt: string | null;
  logPath: string | null;
  minutesRemaining: number;
  hasLog: boolean;
}

export const getDebugLoggingStatus = () =>
  fetchJSON<DebugLoggingStatus>('/settings/debug-logging/status');

export const enableDebugLogging = () =>
  fetchJSON<DebugLoggingStatus>('/settings/debug-logging/enable', { method: 'POST' });

export const disableDebugLogging = () =>
  fetchJSON<DebugLoggingStatus>('/settings/debug-logging/disable', { method: 'POST' });

export async function downloadDebugLog(): Promise<void> {
  const res = await fetch(`${BASE}/settings/debug-logging/download`, { headers: authHeaders() });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    throw new Error(errorMessage(body, res.statusText));
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'nebulis-debug-import.log.gz';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

// ─── Personal API keys (PixInsight and other tools) ─────────────────────────

export interface UserApiKey {
  id: string;
  userId: string;
  /** First characters of the key, safe to show. The full key is only returned once, at creation. */
  keyPrefix: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  /** Present in the admin "all keys" listing; null when the owner no longer exists. */
  ownerUsername?: string | null;
  ownerDisplayName?: string | null;
}

export interface CreatedApiKey {
  id: string;
  /** The secret. Shown once; the server keeps only its hash. */
  apiKey: string;
  keyPrefix: string;
  name: string;
}

export const getApiKeys = (scope: 'mine' | 'all' = 'mine') =>
  fetchJSON<{ keys: UserApiKey[]; max: number }>(`/settings/api-keys${scope === 'all' ? '?scope=all' : ''}`);

export const createApiKey = (name: string) =>
  fetchJSON<CreatedApiKey>('/settings/api-keys', { method: 'POST', body: JSON.stringify({ name }) });

export const revokeApiKeyById = (id: string) =>
  fetchJSON<{ revoked: boolean; id: string }>(`/settings/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
