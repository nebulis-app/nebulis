import { fetchJSON } from './client';

// ─── Device pairing & connected devices ─────────────────────────────────────

export interface ConnectedDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
}

export const lookupPairingCode = (userCode: string) =>
  fetchJSON<{ tvName: string; expiresAt: number }>(
    `/pair/lookup?userCode=${encodeURIComponent(userCode)}`
  );

export const approvePairingCode = (userCode: string) =>
  fetchJSON<{ tvName: string }>('/pair/approve', {
    method: 'POST',
    body: JSON.stringify({ userCode }),
  });

export const getConnectedDevices = () => fetchJSON<ConnectedDevice[]>('/devices');

export const revokeConnectedDevice = (id: string) =>
  fetchJSON<{ revoked: boolean }>(`/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const renameConnectedDevice = (id: string, name: string) =>
  fetchJSON<{ renamed: boolean }>(`/devices/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });

// Admin-only: every device across every user, with owner info attached.
export interface ConnectedDeviceWithOwner extends ConnectedDevice {
  userId: string;
  ownerUsername: string | null;
  ownerDisplayName: string | null;
}

export const adminGetAllDevices = () =>
  fetchJSON<ConnectedDeviceWithOwner[]>('/devices/admin/all');

export const adminRevokeDevice = (id: string) =>
  fetchJSON<{ revoked: boolean }>(`/devices/admin/${encodeURIComponent(id)}`, { method: 'DELETE' });
