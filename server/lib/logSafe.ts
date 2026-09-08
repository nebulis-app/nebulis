/**
 * Helpers for keeping secrets out of the log files.
 *
 * The Windows tray's "Archive & Download" button bundles server.log (and the
 * NSSM stdout/stderr redirects) into a zip that users are told to email to
 * support, so anything written to those files can leave the machine. The
 * request logger already logs only `req.path`, but a few error/diagnostic
 * sites log the full URL with its query string. Some of those query strings
 * carry a credential: the signed object-download token (`?t=`), the one-time
 * subframe token, an accidental `?apiKey=`. Run the URL through `redactUrl`
 * before logging it.
 */

// Query keys whose VALUE is a credential and must never reach the log file.
const SENSITIVE_QUERY_KEYS = new Set([
  't',
  'token',
  'key',
  'apikey',
  'api_key',
  'sig',
  'signature',
  'secret',
  'password',
  'access_token',
  'refresh_token',
]);

/**
 * Returns the path plus a query string whose sensitive values are replaced
 * with `<redacted>`. Never throws: a value that will not parse as a URL is
 * returned with everything after the first `?` stripped.
 */
export function redactUrl(rawUrl: string | undefined | null): string {
  if (!rawUrl) return '';
  const qIdx = rawUrl.indexOf('?');
  if (qIdx === -1) return rawUrl;

  const pathPart = rawUrl.slice(0, qIdx);
  const queryPart = rawUrl.slice(qIdx + 1);

  try {
    const params = new URLSearchParams(queryPart);
    let mutated = false;
    for (const key of [...params.keys()]) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        params.set(key, '<redacted>');
        mutated = true;
      }
    }
    const rebuilt = params.toString();
    if (!mutated) return rebuilt ? `${pathPart}?${rebuilt}` : pathPart;
    // URLSearchParams re-encodes `<redacted>` as %3Credacted%3E; put it back
    // so the log line is readable.
    return `${pathPart}?${rebuilt.replace(/%3C(?:redacted)%3E/gi, '<redacted>')}`;
  } catch {
    // Unparseable query: drop it entirely rather than risk logging a secret.
    return `${pathPart}?<unparsed-query-redacted>`;
  }
}
