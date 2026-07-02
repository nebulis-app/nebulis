export const MOBILE_PROMO_DISMISSED_KEY = 'nebulis_mobile_promo_dismissed';
export const MOBILE_PROMO_SESSION_KEY = 'nebulis_mobile_promo_session';

export function shouldShowMobilePromo(): boolean {
  return (
    !localStorage.getItem(MOBILE_PROMO_DISMISSED_KEY) &&
    !sessionStorage.getItem(MOBILE_PROMO_SESSION_KEY)
  );
}
