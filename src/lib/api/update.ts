import { fetchJSON } from './client';

interface UpdateStatus {
  platform: 'win-x64' | 'mac-arm64' | 'mac-x64' | null;
  channel: 'stable' | 'beta';
  autoUpdateEnabled: boolean;
  currentVersion: string;
  currentBuild: number;
  latestVersion: string | null;
  latestBuild: number | null;
  updateAvailable: boolean;
  mandatory: boolean;
  notesUrl: string | null;
  staged: boolean;
  applyRequested: boolean;
  lastCheckedAt: number | null;
  lastError: string | null;
}

export const getUpdateStatus = () => fetchJSON<UpdateStatus>('/meta/update');

export const checkForUpdate = () =>
  fetchJSON<UpdateStatus>('/meta/update/check', { method: 'POST' });

export const applyUpdate = () =>
  fetchJSON<{ applyRequested: boolean; version: string | null }>('/meta/update/apply', {
    method: 'POST',
  });
