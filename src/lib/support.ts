/**
 * The "Enjoying Nebulis?" support ask: where the coffee link lives and what this browser remembers of it.
 *
 * The ask is shown once. Every way of closing it (the button, the X, Escape, a click on the
 * backdrop) records that it was seen, because a dismissal that only lasts a session turns a thank-you
 * into a nag: that is exactly why the mobile promo was switched off (see lib/mobilePromo.ts).
 *
 * The record of truth is the user's row on the server (`/preferences/support-ask`), so the ask does not
 * return in every other browser they sign in from. This key is the browser's own copy: it stops a
 * flaky connection from re-asking, and it is how a dismissal made before the server kept the record
 * gets synced up (see WhatsNewAutoPopup).
 */
export const COFFEE_URL = 'https://buymeacoffee.com/brent873';

export const SUPPORT_ASK_SEEN_KEY = 'nebulis_support_ask_seen';

/** True when this browser has a record of the ask being dismissed. Storage that cannot be read counts as no record. */
export function supportAskSeenLocally(): boolean {
  try {
    return localStorage.getItem(SUPPORT_ASK_SEEN_KEY) !== null;
  } catch {
    return false;
  }
}

export function markSupportAskSeen(): void {
  try {
    localStorage.setItem(SUPPORT_ASK_SEEN_KEY, new Date().toISOString());
  } catch { /* nothing to remember it with */ }
}
