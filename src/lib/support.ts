/**
 * The "Enjoying Nebulis?" support ask: where the coffee link lives and whether to show the modal.
 *
 * The ask is shown once. Every way of closing it (the button, the X, Escape, a click on the
 * backdrop) records that it was seen, because a dismissal that only lasts a session turns a thank-you
 * into a nag: that is exactly why the mobile promo was switched off (see lib/mobilePromo.ts).
 * Storage can be unavailable (private windows, blocked site data); then the ask is simply not shown,
 * since there would be no way to remember that it had been.
 */
export const COFFEE_URL = 'https://buymeacoffee.com/brent873';

export const SUPPORT_ASK_SEEN_KEY = 'nebulis_support_ask_seen';

export function shouldShowSupportAsk(): boolean {
  try {
    return localStorage.getItem(SUPPORT_ASK_SEEN_KEY) === null;
  } catch {
    return false;
  }
}

export function markSupportAskSeen(): void {
  try {
    localStorage.setItem(SUPPORT_ASK_SEEN_KEY, new Date().toISOString());
  } catch { /* nothing to remember it with */ }
}
