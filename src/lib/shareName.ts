/**
 * Client-side share-name check, so a bad value is caught as it's typed instead
 * of after a save round-trip.
 *
 * The server is still authoritative: parseShareName in
 * server/lib/smb.shared.ts runs on every write and rejects the same inputs.
 * This is the same hand-synced arrangement as TELESCOPE_KINDS and
 * ConnectionType, which also cannot share a source without a monorepo. Keep
 * the rules and wording here in step with that function.
 *
 * Returns null when the value is acceptable, or the reason it is not.
 */
export function shareNameError(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null; // Emptiness is handled by the caller's own required check.

  const splitAdvice = (rest: string): string => {
    const [host, ...segments] = rest.replace(/\\/g, '/').split('/').filter(Boolean);
    const share = segments.join('/');
    return host && share
      ? ` Put "${host}" in the Hostname field and "${share}" here.`
      : '';
  };

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  if (scheme) {
    return `Enter the share name only, not a full ${scheme[1]}:// URL.`
      + splitAdvice(trimmed.slice(scheme[0].length));
  }
  if (/^[\\/]{2}/.test(trimmed)) {
    return 'Enter the share name only, not a full \\\\server\\share path.'
      + splitAdvice(trimmed.replace(/^[\\/]+/, ''));
  }

  const segments = trimmed.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.length === 0) return 'Share name is required.';
  const subpath = segments.slice(1).join('/');
  if (subpath) {
    // Mirrors sanitizePath + validatePathNoTraversal on the server. The
    // control-character range is the point of the check, not an oversight: it
    // has to match the server's character class exactly.
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f`$\\";|&\r\n]/.test(subpath)) {
      return `Invalid characters in path: ${subpath}`;
    }
    if (subpath.split('/').includes('..')) return 'Path traversal detected';
  }
  return null;
}
