import { isOneOf } from '../typeGuards';
import { fetchJSON } from './client';

export const SYSTEM_LOG_CATEGORIES = [
  'auth', 'user', 'device', 'telescope', 'sync', 'storage', 'settings', 'system',
] as const;
export type SystemLogCategory = (typeof SYSTEM_LOG_CATEGORIES)[number];

export const SYSTEM_LOG_LEVELS = ['info', 'warning', 'error'] as const;
export type SystemLogLevel = (typeof SYSTEM_LOG_LEVELS)[number];

/** Narrows the raw string a `<select>` hands back. The filter selects also
 *  carry an "All" option whose value is '', which is not a category — callers
 *  that model that as `SystemLogCategory | ''` should keep the empty case
 *  separate rather than folding it in here. Mirrors isSystemLogCategory in
 *  server/lib/systemLog.ts. */
export function isSystemLogCategory(v: string): v is SystemLogCategory {
  return isOneOf(SYSTEM_LOG_CATEGORIES, v);
}

/** See isSystemLogCategory. */
export function isSystemLogLevel(v: string): v is SystemLogLevel {
  return isOneOf(SYSTEM_LOG_LEVELS, v);
}

export interface SystemLogEntry {
  id: number;
  createdAt: number; // Unix ms
  category: SystemLogCategory;
  event: string;
  level: SystemLogLevel;
  message: string;
  userId: string | null;
  username: string | null;
  ip: string | null;
  metadata: Record<string, unknown> | null;
}

export interface SystemLogQuery {
  limit?: number;
  offset?: number;
  category?: SystemLogCategory;
  level?: SystemLogLevel;
  search?: string;
}

export const getSystemLog = (query: SystemLogQuery = {}) => {
  const params = new URLSearchParams();
  params.set('limit', String(query.limit ?? 25));
  params.set('offset', String(query.offset ?? 0));
  if (query.category) params.set('category', query.category);
  if (query.level) params.set('level', query.level);
  if (query.search) params.set('search', query.search);
  return fetchJSON<{ entries: SystemLogEntry[]; total: number }>(`/system-log?${params.toString()}`);
};

export const clearSystemLog = () =>
  fetchJSON<{ cleared: boolean }>('/system-log', { method: 'DELETE' });
