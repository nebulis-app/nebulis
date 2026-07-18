/**
 * Shared SMB types, constants, and utilities used by both posix and Windows implementations.
 */
import path from 'path';
import type { TelescopeProfile } from './telescopes.js';

export const BASE_PATH = 'MyWorks';

export interface SmbEntry {
  name: string;
  type: 'dir' | 'file';
  size?: number;
  mtime?: string; // ISO date string
}

/** Connection settings derived from a single telescope profile. SMB I/O calls
 *  accept this so the multi-telescope import pipeline can target each scope
 *  individually instead of always using the active one. */
export interface SmbProfile {
  hostname: string;
  shareName: string;
  username: string;
  password: string;
}

export function profileToSmb(profile: Pick<TelescopeProfile, 'hostname' | 'shareName' | 'username' | 'password'>): SmbProfile {
  return {
    hostname: profile.hostname || '',
    shareName: profile.shareName || 'EMMC Images',
    username: profile.username || 'guest',
    password: profile.password || '',
  };
}

/**
 * Sanitize a string for safe use in SMB path arguments.
 * Rejects characters that could break out of command context — including
 * quote and semicolon, which can terminate smbclient `-c` mini-script statements
 * and inject additional commands.
 */
export function sanitizePath(input: string): string {
  // Reject null bytes, shell/quote metachars, control chars, newlines, and
  // smbclient script separators (semicolon).
  if (/[\x00-\x1f\x7f`$\\";|&\r\n]/.test(input)) {
    throw new Error(`Invalid characters in path: ${input}`);
  }
  return input;
}

export function validatePathNoTraversal(filePath: string): void {
  const normalized = path.normalize(filePath);
  // Reject the bypass where ".." segments cancel out leading segments and the
  // normalized path becomes absolute or escapes upward.
  if (
    normalized.includes('..') ||
    normalized.startsWith('/') ||
    normalized.startsWith('\\') ||
    path.isAbsolute(normalized)
  ) {
    throw new Error('Path traversal detected');
  }
  // The original input had traversal tokens but normalize collapsed them to
  // something that no longer starts with the original first segment. Reject.
  const firstSegment = filePath.split(/[\\/]/).filter(Boolean)[0];
  const normalizedFirst = normalized.split(/[\\/]/).filter(Boolean)[0];
  if (firstSegment && normalizedFirst && firstSegment !== normalizedFirst) {
    throw new Error('Path traversal detected');
  }
}

export function loadSettings(profile: Partial<Pick<TelescopeProfile, 'hostname' | 'shareName' | 'username' | 'password'>> | null | undefined): SmbProfile {
  return {
    hostname: profile?.hostname || '',
    shareName: profile?.shareName || 'EMMC Images',
    username: profile?.username || 'guest',
    password: profile?.password || '',
  };
}
