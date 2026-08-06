/**
 * Client-side hostname/address check, so a bad value is caught as it's typed
 * instead of after a save round-trip.
 *
 * The server is still authoritative: validateHostAddress in
 * server/lib/smb.shared.ts runs on every write and rejects the same inputs.
 * This is the same hand-synced arrangement as shareName.ts, TELESCOPE_KINDS and
 * ConnectionType, which also cannot share a source without a monorepo. Keep the
 * rules and wording here in step with that function.
 *
 * Returns null when the value is acceptable, or the reason it is not.
 */
export function hostAddressError(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null; // Emptiness is handled by the caller's own required check.

  const splitAdvice = (rest: string): string => {
    const [host, ...segments] = rest.replace(/\\/g, '/').split('/').filter(Boolean);
    const share = segments.join('/');
    return host && share
      ? ` Put "${host}" here and "${share}" in the SMB Share Name field.`
      : '';
  };

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  if (scheme) {
    return `Enter the address only, not a full ${scheme[1]}:// URL.`
      + splitAdvice(trimmed.slice(scheme[0].length));
  }
  if (/^[\\/]{2}/.test(trimmed)) {
    return 'Enter the address only, not a full \\\\server\\share path.'
      + splitAdvice(trimmed.replace(/^[\\/]+/, ''));
  }
  if (/[\\/]/.test(trimmed)) {
    return 'The address cannot contain a slash.' + splitAdvice(trimmed);
  }
  if (trimmed.includes('@')) {
    const [user, host] = trimmed.split('@');
    return 'The address cannot contain a username.'
      + (user && host ? ` Put "${host}" here and "${user}" in the Username field.` : '');
  }
  if (/\s/.test(trimmed)) return 'The address cannot contain spaces.';

  // Optional :port, with bracketed and bare IPv6 both left intact.
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
      return `"${portText}" is not a valid port number. Use a number from 1 to 65535.`;
    }
  }
  if (!host) return 'Hostname or IP address is required.';

  if (host.includes(':')) {
    return /^[0-9a-f:.]+$/i.test(host)
      ? null
      : `"${host}" is not a valid IP address or hostname.`;
  }

  // `_` is allowed because mDNS names contain it; a trailing root dot is a
  // legal FQDN. This check is about separators and pasted URLs, not syntax.
  const labels = host.replace(/\.$/, '').split('.');
  const labelOk = (label: string) =>
    label.length > 0 && label.length <= 63
    && /^[a-z0-9_-]+$/i.test(label)
    && !label.startsWith('-') && !label.endsWith('-');
  return labels.every(labelOk) ? null : `"${host}" is not a valid IP address or hostname.`;
}
