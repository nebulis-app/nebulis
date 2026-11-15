import { useEffect } from 'react';

/**
 * Stops the page behind a dialog from scrolling. Lock both <body> and <html>: which element owns the viewport
 * scrollbar varies, and a dialog with its own scroll area otherwise chains wheel and touch scrolling through to
 * whichever one is left unlocked.
 *
 * Locks are counted. A dialog opened from another dialog (a picture viewer inside an object card, a confirmation inside
 * a form) takes a second lock, and the page only scrolls again when the last one is released. Without the count the
 * inner dialog's close would unlock the page under the outer one.
 */
let locks = 0;
let saved: { body: string; html: string } | null = null;

/** Take one lock. Returns the function that releases it; releasing twice is harmless. */
export function lockBodyScroll(): () => void {
  const { body, documentElement: html } = document;
  if (locks === 0) {
    saved = { body: body.style.overflow, html: html.style.overflow };
    body.style.overflow = 'hidden';
    html.style.overflow = 'hidden';
  }
  locks++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    locks--;
    if (locks === 0 && saved) {
      body.style.overflow = saved.body;
      html.style.overflow = saved.html;
      saved = null;
    }
  };
}

export function useBodyScrollLock(active = true): void {
  useEffect(() => {
    if (!active) return undefined;
    return lockBodyScroll();
  }, [active]);
}
