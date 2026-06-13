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
