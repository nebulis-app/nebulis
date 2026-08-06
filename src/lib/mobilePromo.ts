/**
 * "Nebulis on Mobile" promo popup.
 *
 * Disabled as of 1.5.1. Flip MOBILE_PROMO_ENABLED back to `true` to restore it;
 * nothing else needs changing, and the modal itself
 * (components/help/MobileAppsPromoModal.tsx) is left intact.
 *
 * Why it was turned off: the only permanent dismissal was the "Got it" button.
 * The X, Escape, and a backdrop click all wrote the *session* key instead, so a
 * user who closed it the reflexive way saw it again in every new tab, window,
 * and browser restart, indefinitely. If it comes back, make those three paths
 * dismiss permanently (or add a shows-counter) before re-enabling.
 */
export const MOBILE_PROMO_ENABLED = false;

export const MOBILE_PROMO_DISMISSED_KEY = 'nebulis_mobile_promo_dismissed';
export const MOBILE_PROMO_SESSION_KEY = 'nebulis_mobile_promo_session';

export function shouldShowMobilePromo(): boolean {
  if (!MOBILE_PROMO_ENABLED) return false;
  return (
    !localStorage.getItem(MOBILE_PROMO_DISMISSED_KEY) &&
    !sessionStorage.getItem(MOBILE_PROMO_SESSION_KEY)
  );
}
