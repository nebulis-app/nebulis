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

// QR enrollment — the signed-in web user generates a QR that a phone scans to
// connect and sign in in one step. We pass the browser's current origin so the
// server can embed a URL the phone can actually reach (rewriting only when the
// browser is on the server box itself).
export interface DeviceQrEnrollment {
  qrDataUrl: string;
  url: string;
  deviceCode: string;
  expiresAt: number;
  pollIntervalSec: number;
}

export const createDeviceQr = (deviceName?: string) =>
  fetchJSON<DeviceQrEnrollment>('/pair/qr', {
    method: 'POST',
    body: JSON.stringify({ origin: window.location.origin, deviceName }),
  });

// Read-only status of a QR enrollment. The web UI polls this to know when the
// scanning phone has finished connecting; it never consumes the pairing, so it
// can't race the phone for the token.
interface DeviceQrStatus {
  status: 'waiting' | 'connected' | 'expired';
  deviceName?: string;
}

export const getDeviceQrStatus = (deviceCode: string) =>
  fetchJSON<DeviceQrStatus>(`/pair/qr/status?deviceCode=${encodeURIComponent(deviceCode)}`);

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
