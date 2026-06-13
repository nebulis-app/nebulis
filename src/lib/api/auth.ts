import { fetchJSON } from './client';

// Onboarding / auth status
export interface AuthStatus {
  hasUsers: boolean;
  userCount: number;
  requiresSetup: boolean;
}
export const getAuthStatus = () => fetchJSON<AuthStatus>('/auth/status');
export const registerUser = (data: { username: string; password: string; displayName: string; email: string }) =>
  fetchJSON<{ token: string }>('/auth/register', { method: 'POST', body: JSON.stringify(data) });
export const loginUser = (data: { username: string; password: string }) =>
  fetchJSON<{ token: string }>('/auth/login', { method: 'POST', body: JSON.stringify(data) });

// User management
export type UserRole = 'admin' | 'viewer';
/** Coerce a DOM select string to UserRole. Unknown values fall back to 'viewer'. */
export function toUserRole(v: string): UserRole {
  return v === 'admin' ? 'admin' : 'viewer';
}

export interface AppUser {
  id: string;
  username: string;
  email: string;
  displayName: string;
  createdAt: string;
  role: UserRole;
}

export interface CurrentUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  createdAt: string;
  role: UserRole;
}

export const getCurrentUser = () => fetchJSON<CurrentUser>('/auth/me');
export const getUsers = () => fetchJSON<AppUser[]>('/auth/users');
export const createUser = (data: { username: string; email: string; password: string; displayName: string; role?: UserRole }) =>
  fetchJSON<AppUser[]>('/auth/users', { method: 'POST', body: JSON.stringify(data) });
export const deleteAppUser = (id: string) =>
  fetchJSON<AppUser[]>(`/auth/users/${id}`, { method: 'DELETE' });
export const resetUserPassword = (id: string, password: string) =>
  fetchJSON<{ updated: boolean }>(`/auth/users/${id}/password`, { method: 'PUT', body: JSON.stringify({ password }) });
export const updateUserRole = (id: string, role: UserRole) =>
  fetchJSON<AppUser[]>(`/auth/users/${id}/role`, { method: 'PUT', body: JSON.stringify({ role }) });

// Watermark presets (per-user, stored server-side)
export interface WatermarkPreset {
  id: string;
  name: string;
  text: string;
  fontSize: number;
  fontFamily: string;
  color: string;
  bold: boolean;
  italic: boolean;
  opacity: number;
  align: 'left' | 'center' | 'right';
  angle: number;
}

export const getWatermarkPresets = () =>
  fetchJSON<WatermarkPreset[]>('/preferences/watermarks');

export const saveWatermarkPresets = (presets: WatermarkPreset[]) =>
  fetchJSON<WatermarkPreset[]>('/preferences/watermarks', {
    method: 'PUT',
    body: JSON.stringify(presets),
  });

/** Last app version this user acknowledged in the What's New popup. Null
 *  when they've never seen it, which is true on first login. */
export const getLastSeenVersion = () =>
  fetchJSON<{ lastSeenVersion: string | null }>('/preferences/last-seen-version');

/** Mark `version` as acknowledged for this user. Called when they click
 *  "Got it" on the What's New popup. */
export const setLastSeenVersion = (version: string) =>
  fetchJSON<{ lastSeenVersion: string }>('/preferences/last-seen-version', {
    method: 'PUT',
    body: JSON.stringify({ version }),
  });
