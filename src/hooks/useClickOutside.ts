import { useEffect, type RefObject } from 'react';

/**
 * Fires `handler` when the user clicks outside `ref` (or presses Escape when
 * `closeOnEscape` is true). Attach/detach is gated on `enabled` so callers
 * can tie it to their open/closed state without an extra conditional effect.
 */
export function useClickOutside<T extends HTMLElement>(
  ref: RefObject<T | null>,
  handler: () => void,
  { enabled = true, closeOnEscape = false }: { enabled?: boolean; closeOnEscape?: boolean } = {},
) {
  useEffect(() => {
    if (!enabled) return;

    function onMouseDown(e: MouseEvent) {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) {
        handler();
      }
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
  }, [ref, handler, enabled, closeOnEscape]);
}
