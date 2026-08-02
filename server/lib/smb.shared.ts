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

/** A share field split into the share to connect to and an optional folder
 *  inside it. The three backends need this split at different points —
 *  `mount_smbfs` and `smbclient` take a bare share, UNC takes the whole path —
 *  so it happens once here instead of three times, differently. */
export interface ParsedShare {
  /** Share to mount/connect. Never contains a separator. */
  share: string;
  /** Folder inside the share, '' for the share root. Forward-slash separated,
   *  no leading or trailing slash. */
  subpath: string;
}

/**
 * Split the share field into `share` + `subpath`.
 *
 * Accepts `EMMC Images` (share root) or `UNAS/MyWorks` (folder inside a
 * share). Backslashes are normalised, since that is the separator users copy
 * out of Windows Explorer.
 *
 * A full `smb://host/share` URL is rejected rather than parsed. Its embedded
 * host may contradict the Hostname field, and silently preferring one would
 * connect somewhere the user did not ask for. The thrown message tells them
 * how to split their input across the two fields.
 *
 * Note this is a widening, not a breaking change: before it existed, any share
 * value containing a separator failed on every platform (percent-encoded into
 * a bogus share on macOS, rejected by smbclient on Linux, and tripping the UNC
 * prefix guard on Windows), so no working configuration can regress.
 */
export function parseShareName(raw: string | null | undefined): ParsedShare {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new Error('Share name is required.');

  const splitForAdvice = (rest: string): string => {
    const [host, ...segments] = rest.replace(/\\/g, '/').split('/').filter(Boolean);
    const share = segments.join('/');
    return host && share
      ? ` Put "${host}" in the Hostname field and "${share}" here.`
      : '';
  };

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  if (scheme) {
    throw new Error(
      `Enter the share name only, not a full ${scheme[1]}:// URL.`
      + splitForAdvice(trimmed.slice(scheme[0].length)),
    );
  }
  // \\server\share or //server/share, pasted straight out of Explorer/Finder.
  if (/^[\\/]{2}/.test(trimmed)) {
    throw new Error(
      'Enter the share name only, not a full \\\\server\\share path.'
      + splitForAdvice(trimmed.replace(/^[\\/]+/, '')),
    );
  }

  const segments = trimmed.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.length === 0) throw new Error('Share name is required.');

  const share = segments[0];
  const subpath = segments.slice(1).join('/');
  // Only the subpath is sanitized. It is interpolated into smbclient's `-c`
  // mini-script, where a quote or semicolon would start a new command. The
  // share is passed as a single argv element (never through a shell) and is
  // percent-encoded on macOS, so char-restricting it would only break existing
  // profiles whose share legitimately contains something like `$`.
  if (subpath) {
    sanitizePath(subpath);
    validatePathNoTraversal(subpath);
  }
  return { share, subpath };
}

export function loadSettings(profile: Partial<Pick<TelescopeProfile, 'hostname' | 'shareName' | 'username' | 'password'>> | null | undefined): SmbProfile {
  return {
    hostname: profile?.hostname || '',
    shareName: profile?.shareName || 'EMMC Images',
    username: profile?.username || 'guest',
    password: profile?.password || '',
  };
}
