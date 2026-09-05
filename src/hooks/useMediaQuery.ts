import { useSyncExternalStore } from 'react';

/**
 * Subscribes to a CSS media query.
 *
 * For picking *which component to render*, not for styling. Styling belongs in
 * Tailwind's responsive variants, which cost nothing. This is for the cases
 * where the two layouts are different enough that rendering both and hiding one
 * is wrong: a hidden copy is still in the accessibility tree, still fetches its
 * images, and still matches a test's `.first()` selector.
 *
 * `useSyncExternalStore` rather than an effect, so the first render already has
 * the right answer and nothing flashes the wrong layout.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      // Guarded for older Safari, where MediaQueryList predates EventTarget.
      const list = window.matchMedia(query);
      if (list.addEventListener) {
        list.addEventListener('change', onChange);
        return () => list.removeEventListener('change', onChange);
      }
      list.addListener(onChange);
      return () => list.removeListener(onChange);
    },
    () => window.matchMedia(query).matches,
    // Server/prerender has no viewport. False keeps the desktop grid as the
    // default, matching the mobile-last order of the Tailwind breakpoints.
    () => false,
  );
}
