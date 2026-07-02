/**
 * Type-safe Express query parameter extractors.
 *
 * Express types req.query values as `string | string[] | ParsedQs | ParsedQs[] | undefined`.
 * These helpers extract a scalar value safely, taking the first element when an array is passed.
 */

export function queryString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

export function queryNumber(value: unknown): number | undefined {
  const s = queryString(value);
  if (s === undefined) return undefined;
  const n = Number(s);
  return isNaN(n) ? undefined : n;
}

/**
 * Builds a Content-Disposition header value with an ASCII fallback (RFC 6266)
 * and an RFC 5987 `filename*` parameter for correct Unicode file names.
 * Strips control characters, double-quotes, and backslashes from the ASCII
 * fallback to prevent header injection.
 */
export function contentDispositionHeader(disposition: 'attachment' | 'inline', name: string): string {
  const ascii = name.replace(/[\x00-\x1f\x7f"\\]/g, '_');
  const encoded = encodeURIComponent(name);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
