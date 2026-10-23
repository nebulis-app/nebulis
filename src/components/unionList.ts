/**
 * A runtime list of a string union's members, checked at compile time to name
 * EVERY member — no more, no less. For unions whose canonical module (lib/api,
 * lib/*) exports only the type: a value added to the union fails the build at
 * each list instead of silently missing from a picker or URL parser.
 *
 *   const SORTS = everyMember<MediaSort>()(['newest', 'oldest', 'time']);
 *
 * Curried so T is given explicitly while the tuple is still inferred.
 */
export function everyMember<T extends string>() {
  return <const A extends readonly T[]>(
    values: A & ([Exclude<T, A[number]>] extends [never] ? unknown : never),
  ): readonly T[] => values;
}
