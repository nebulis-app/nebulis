/**
 * Small narrowing helpers for values that arrive as bare strings from outside
 * the type system: `<select>` change events, localStorage, and query strings.
 *
 * The domain unions in this app are `as const` arrays, so membership is always
 * an `includes()` away. Wrapping it in a type predicate is what turns that
 * check into real narrowing — `x as SomeUnion` after an `includes()` compiles
 * to the same thing today but keeps compiling after someone reorders, renames,
 * or removes a member.
 */

/**
 * True when `value` is one of `values`, narrowing it to that union.
 *
 * Prefer a named guard (`isSortKey`, `isTelescopeKind`, ...) next to the array
 * it checks; use this directly only for one-off, file-local unions.
 */
export function isOneOf<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

/**
 * Same idea for the `{ value, label }[]` option lists the sort menus are built
 * from: true when `value` is one of the options' `value`s, narrowing it to that
 * union. Keeps the stored-preference readers in Gallery / ImageGalleryPage
 * honest without either page having to hand-maintain a second list of keys.
 */
export function isOptionValue<T extends string>(
  options: readonly { value: T }[],
  value: string,
): value is T {
  return options.some(o => o.value === value);
}
