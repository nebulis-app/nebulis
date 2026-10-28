/**
 * Removes every trailing character found in `chars`. A loop rather than
 * `/[chars]+$/`, which backtracks quadratically on a long run of the character
 * followed by something else.
 */
export function trimTrailing(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1])) end--;
  return value.slice(0, end);
}
