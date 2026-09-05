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

/**
 * Resolve a share-relative path against an absolute filesystem `root` and
 * refuse anything that escapes it. This is the containment check `smb.local.ts`
 * has always used (`path.resolve` + boundary `startsWith`), which is the
 * strongest of the traversal guards — `path.resolve` collapses every `..`
 * before the comparison, so a sneaky input that slipped past the string-level
 * `validatePathNoTraversal` still can't land outside `root`.
 *
 * Returns the resolved absolute path.
 */
export function assertInsideRoot(root: string, relPath: string): string {
  const absRoot = path.resolve(root);
  const candidate = path.resolve(absRoot, relPath);
  // A drive root (`F:\`) already ends in a separator; others don't. Build the
  // boundary only when one isn't there, or the startsWith looks for a double
  // separator that never matches.
  const rootWithSep = absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep;
  if (candidate !== absRoot && !candidate.startsWith(rootWithSep)) {
    throw new Error(`Path traversal detected: ${relPath}`);
  }
  return candidate;
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

/**
 * Validate the hostname/address field: an IP address or a hostname, with an
 * optional `:port`, and nothing else.
 *
 * The counterpart to parseShareName, and it exists for the mirror-image
 * mistake. A user pasted `10.0.1.5/SeeStar/` into the address field, which is
 * their host and their share run together. Every backend then tried to reach a
 * machine literally named `10.0.1.5/SeeStar/` and failed with a network error
 * that said nothing about the real problem. Whichever half a user pastes into
 * the wrong field, they now get told which part belongs where.
 *
 * Deliberately permissive about what counts as a hostname: `_` is accepted
 * because mDNS names like `UNAS-Pro._smb._tcp.local` contain it, and a trailing
 * root dot is accepted because it is a legal FQDN. The check is aimed at
 * separators and pasted URLs, not at policing name syntax.
 *
 * Returns the trimmed address. Throws with user-facing guidance otherwise.
 */
export function validateHostAddress(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new Error('Hostname or IP address is required.');

  // "host/share/folder" → name the two halves so the user can act on it.
  const splitForAdvice = (rest: string): string => {
    const [host, ...segments] = rest.replace(/\\/g, '/').split('/').filter(Boolean);
    const share = segments.join('/');
    return host && share
      ? ` Put "${host}" here and "${share}" in the SMB Share Name field.`
      : '';
  };

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  if (scheme) {
    throw new Error(
      `Enter the address only, not a full ${scheme[1]}:// URL.`
      + splitForAdvice(trimmed.slice(scheme[0].length)),
    );
  }
  if (/^[\\/]{2}/.test(trimmed)) {
    throw new Error(
      'Enter the address only, not a full \\\\server\\share path.'
      + splitForAdvice(trimmed.replace(/^[\\/]+/, '')),
    );
  }
  if (/[\\/]/.test(trimmed)) {
    throw new Error(
      'The address cannot contain a slash.' + splitForAdvice(trimmed),
    );
  }
  // `user@host`, copied out of an SSH or mount command.
  if (trimmed.includes('@')) {
    const [user, host] = trimmed.split('@');
    throw new Error(
      'The address cannot contain a username.'
      + (user && host ? ` Put "${host}" here and "${user}" in the Username field.` : ''),
    );
  }
  if (/\s/.test(trimmed)) throw new Error('The address cannot contain spaces.');

  // Split off an optional port. A bracketed IPv6 literal keeps its brackets
  // out of the host, and a bare IPv6 address (many colons) is left whole.
  let host = trimmed;
  let portText: string | null = null;
  const bracketed = /^\[(.+)\](?::(.*))?$/.exec(trimmed);
  if (bracketed) {
    host = bracketed[1];
    portText = bracketed[2] ?? null;
  } else {
    const idx = trimmed.lastIndexOf(':');
    if (idx >= 0 && trimmed.indexOf(':') === idx) {
      host = trimmed.slice(0, idx);
      portText = trimmed.slice(idx + 1);
    }
  }

  if (portText !== null) {
    const port = Number(portText);
    if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`"${portText}" is not a valid port number. Use a number from 1 to 65535.`);
    }
  }
  if (!host) throw new Error('Hostname or IP address is required.');

  // Bare or bracketed IPv6: hex groups and colons, with the :: shorthand and
  // the IPv4-mapped tail (::ffff:10.0.1.5) both allowed.
  if (host.includes(':')) {
    if (!/^[0-9a-f:.]+$/i.test(host)) {
      throw new Error(`"${host}" is not a valid IP address or hostname.`);
    }
    return trimmed;
  }

  // Hostname, FQDN, or IPv4. A trailing root dot is legal and kept.
  const labels = host.replace(/\.$/, '').split('.');
  const labelOk = (label: string) =>
    label.length > 0 && label.length <= 63
    && /^[a-z0-9_-]+$/i.test(label)
    && !label.startsWith('-') && !label.endsWith('-');
  if (!labels.every(labelOk)) {
    throw new Error(`"${host}" is not a valid IP address or hostname.`);
  }
  return trimmed;
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

/**
 * Strip every shape an SMB credential is carried in before text is logged or
 * surfaced: `smbclient -U user%password` (both the flag form and a bare
 * `user%pass`) and a `//user:password@host` mount URL. `execFile` puts the
 * whole command line, password included, in `err.message`, and `mount_smbfs`
 * echoes its URL.
 */
export function scrubSmbSecrets(text: string): string {
  return text
    .replace(/(-U\s+\S+?%)\S+/g, '$1***')
    .replace(/(-U\s+)\S+/g, '$1***')
    .replace(/(\/\/[^:/@\s]+):[^@\s]*@/g, '$1:***@');
}

/**
 * Turn a raw transport failure into one short, client-safe reason.
 *
 * `smbclient` writes most of its diagnostics (session-setup and tree-connect
 * failures, the NT_STATUS code) to stdout, not stderr, so both streams are
 * inspected. `err.message` is excluded for the smbclient backend because
 * `execFile` embeds the full command line there and it carries no signal the
 * streams don't; `mount_smbfs` puts its reason in the message, so that backend
 * includes it. Everything is scrubbed first so a password containing a keyword
 * like "auth" can't steer the result.
 */
export function classifySmbError(err: unknown, backend: 'smbclient' | 'mount'): string {
  if (!(err instanceof Error)) return 'Unknown error';
  // A plain Error this layer threw (the hostname guard) has no command line.
  if (/^No (?:SeeStar|hostname)/.test(err.message)) return err.message;

  const e = err as { stdout?: string; stderr?: string; code?: string };
  const raw = backend === 'mount'
    ? scrubSmbSecrets(`${err.message}\n${e.stderr ?? ''}`)
    : scrubSmbSecrets(`${e.stderr ?? ''}\n${e.stdout ?? ''}`);

  if (backend === 'smbclient' && (e.code === 'ENOENT' || /\bENOENT\b/.test(err.message))) {
    return 'smbclient is not installed on the server';
  }
  const ntStatus = raw.match(/NT_STATUS_[A-Z0-9_]+/);
  if (ntStatus) return ntStatus[0];
  if (/Connection refused/i.test(raw)) return 'Connection refused';
  if (/timed out|timeout|IO_TIMEOUT/i.test(raw)) return 'Connection timed out';
  if (/Unable to resolve|Name or service not known|No address associated/i.test(raw)) return 'Host not found';
  if (/protocol negotiation failed|Server (?:does ?n[o']?t|didn['’]?t) support|no protocol supported/i.test(raw)) {
    return 'SMB protocol negotiation failed';
  }
  if (/session setup failed|logon failure|bad password|wrong password/i.test(raw)) {
    return 'Authentication failed';
  }
  if (backend === 'mount') {
    // mount_smbfs refusing a share it thinks is already mounted. ensureMount
    // tries to reuse one first, so reaching here means that lookup missed.
    if (/File exists/i.test(raw)) {
      return 'That share is already mounted on this Mac and the existing mount could not be reused';
    }
    if (/auth|credentials|password/i.test(raw)) return 'Authentication failed';
    if (/no such file|does not exist/i.test(raw)) return 'Share or folder not found';
  }
  return 'Connection failed';
}

/** Profile shape the native backends accept — a partial connection profile. */
type SmbProfileArg = Partial<Pick<TelescopeProfile, 'hostname' | 'shareName' | 'username' | 'password'>> | null | undefined;

/**
 * The shared prologue every native SMB op ran by hand: resolve the profile,
 * require a hostname, and reject an unsafe path before it reaches the OS.
 * `requireInsideBasePath` adds the delete-only `MyWorks` boundary check.
 *
 * Deliberately does NOT wrap the operation's own errors — each backend has
 * post-failure cleanup (posix's deduped logging, mac's mount teardown) that
 * can't be unified here.
 */
export async function withSmbGuards<T>(
  smbPath: string,
  profile: SmbProfileArg,
  fn: (settings: SmbProfile) => Promise<T>,
  opts: { requireInsideBasePath?: boolean } = {},
): Promise<T> {
  const settings = loadSettings(profile);
  if (!settings.hostname) {
    throw new Error('No SeeStar hostname configured. Please configure it in Settings.');
  }
  sanitizePath(smbPath);
  validatePathNoTraversal(smbPath);
  if (opts.requireInsideBasePath && smbPath !== BASE_PATH && !smbPath.startsWith(BASE_PATH + '/')) {
    throw new Error('Can only delete files within MyWorks');
  }
  return fn(settings);
}
