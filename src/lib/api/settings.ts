import type { Settings } from '../../types';
import { fetchJSON, BASE, authHeaders, errorMessage } from './client';

export interface UserApiKey {
  id: string;
  userId: string;
  keyPrefix: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export const getSettings = () => fetchJSON<Settings>('/settings');
export const updateSettings = (settings: Partial<Settings>) =>
  fetchJSON<Settings>('/settings', { method: 'PUT', body: JSON.stringify(settings) });

// User-linked API Keys (up to 5 keys per user)
export const getUserApiKeys = () =>
  fetchJSON<{ keys: UserApiKey[] }>('/settings/api-keys');

export const createUserApiKey = (name: string) =>
  fetchJSON<{ id: string; apiKey: string; keyPrefix: string; name: string; message: string }>('/settings/api-keys', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });

export const deleteUserApiKey = (id: string) =>
  fetchJSON<{ revoked: boolean; id: string }>(`/settings/api-keys/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });

// Legacy single-key compatibility endpoints
export const generateApiKey = () =>
  fetchJSON<{ apiKey: string; message: string }>('/settings/generate-api-key', { method: 'POST' });
export const revokeApiKey = () =>
  fetchJSON<{ revoked: boolean }>('/settings/api-key', { method: 'DELETE' });
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
