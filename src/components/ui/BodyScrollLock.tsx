import { useBodyScrollLock } from '../../hooks/useBodyScrollLock';

/**
 * Put this inside a full-screen overlay that is built by hand (not with `Modal`). It locks page scrolling for as long
 * as the overlay is on screen, so the overlay does not have to track its own open state to do it. Renders nothing.
 */
export function BodyScrollLock() {
  useBodyScrollLock();
  return null;
}
