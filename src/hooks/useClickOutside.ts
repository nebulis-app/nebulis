import { useEffect, type RefObject } from 'react';

/**
 * Fires `handler` when the user clicks outside `ref` (or presses Escape when
 * `closeOnEscape` is true). Attach/detach is gated on `enabled` so callers
 * can tie it to their open/closed state without an extra conditional effect.
 *
 * `ref` may be an array when the "inside" area spans two disconnected DOM
 * subtrees, e.g. a trigger button plus a menu portaled to `document.body` to
 * escape an `overflow-hidden` ancestor.
 *
 * Refs are typed at `HTMLElement` rather than through a generic: the element
 * type is never used beyond `contains()`, and a generic forced every ref in an
 * array to be the *same* tag (SitePicker passes a div wrapper plus a ul menu,
 * which failed to infer a single T).
 */
export function useClickOutside(
  ref: RefObject<HTMLElement | null> | RefObject<HTMLElement | null>[],
  handler: () => void,
  { enabled = true, closeOnEscape = false }: { enabled?: boolean; closeOnEscape?: boolean } = {},
) {
  useEffect(() => {
    if (!enabled) return;

    const refs = Array.isArray(ref) ? ref : [ref];

    function onMouseDown(e: MouseEvent) {
      // Bound to a const so the `instanceof` narrowing survives into the
      // `some` callback — TS re-widens a property access inside a closure.
      const target = e.target;
      if (!(target instanceof Node)) return;
      const insideAny = refs.some(r => r.current !== null && r.current.contains(target));
      if (!insideAny) handler();
    }

    function onKeyDown(e: KeyboardEvent) {
      if (closeOnEscape && e.key === 'Escape') handler();
    }

    document.addEventListener('mousedown', onMouseDown);
    if (closeOnEscape) document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      if (closeOnEscape) document.removeEventListener('keydown', onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handler, enabled, closeOnEscape, ...(Array.isArray(ref) ? ref : [ref])]);
}
