import type { Settings } from '../../types';
import { fetchJSON, BASE, authHeaders } from './client';

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
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    const msg = (body?.error as { message?: string } | string | undefined);
    throw new Error(typeof msg === 'object' ? msg?.message : msg ?? res.statusText);
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
