/**
 * Small runtime guards shared by every module that has to read an unknown
 * value (a JSON.parse result, a DB TEXT column, a request body, an external
 * API response) field by field.
 *
 * These exist so that narrowing is done once, with a real runtime check, in
 * one place. The pattern they replace was `const v = value as Record<string,
 * unknown>` immediately after a `typeof value === 'object'` test: correct in
 * practice, but an assertion, so nothing stops it drifting to a concrete
 * entity type later where the check no longer covers the claim.
 *
 * Deliberately dependency-free so anything in server/ can import it without
 * creating a cycle.
 */

/**
 * True for a non-null, non-array object. Arrays are excluded on purpose: every
 * caller here is about to read named fields, and `[]` silently answering
 * "yes, I'm a Record" is how an array ends up parsed as an entity with every
 * field undefined.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse JSON text that is expected to describe an object. Returns null for
 * invalid JSON *and* for valid JSON that is a number/string/array/null, so a
 * caller gets one failure path instead of two.
 */
export function parseJsonRecord(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

/**
 * Exhaustiveness guard for the `default` branch of a switch over a union.
 *
 * The point is the *compile* error, not the throw: once every member of the
 * union is handled, `value` is `never` and this call type-checks. Add a new
 * member to the union and the call stops compiling until the new case is
 * handled, instead of the switch silently falling through to `default`.
 *
 * The runtime throw only fires when a value from outside the declared type
 * reaches us anyway (an unvalidated DB row, a JSON payload), which is exactly
 * the case worth failing loudly on.
 */
export function assertNever(value: never, message: string): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}
