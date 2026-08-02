import { useEffect, useRef } from 'react';

interface LightboxKeyActions {
  onPrev: () => void;
  onNext: () => void;
  onFirst: () => void;
  onLast: () => void;
  onClose: () => void;
  onFit: () => void;
  onActualSize: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onDownload?: () => void;
  onDelete?: () => void;
  onToggleFavorite?: () => void;
  /**
   * Suspends every shortcut. Set while a nested dialog is open (a delete
   * confirmation, the FITS header modal) so Escape dismisses that dialog
   * instead of tearing down the whole viewer underneath it.
   */
  suspended?: boolean;
}

/**
 * True when the event should be left to the focused control.
 *
 * The FITS stretch slider is a `<input type="range">`: arrow keys are its only
 * keyboard interface. A viewer-level handler that calls `preventDefault` on
 * every arrow key makes the slider impossible to operate with the keyboard,
 * which is what the previous implementation did.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function useLightboxKeys(actions: LightboxKeyActions, enabled = true) {
  // Held in a ref so the listener is bound once and never restarts as the
  // parent re-renders with fresh callbacks. Written in an effect rather than
  // during render: a keydown can only arrive after commit, so the ref is
  // always current by the time the listener reads it.
  const ref = useRef(actions);
  useEffect(() => { ref.current = actions; });

  useEffect(() => {
    if (!enabled) return;
    const handle = (e: KeyboardEvent) => {
      const a = ref.current;
      if (a.suspended) return;
      if (isTypingTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case 'ArrowLeft': e.preventDefault(); a.onPrev(); break;
        case 'ArrowRight': e.preventDefault(); a.onNext(); break;
        case 'Home': e.preventDefault(); a.onFirst(); break;
        case 'End': e.preventDefault(); a.onLast(); break;
        case 'Escape': e.preventDefault(); a.onClose(); break;
        case 'f': case 'F': e.preventDefault(); a.onFit(); break;
        case '1': e.preventDefault(); a.onActualSize(); break;
        case '+': case '=': e.preventDefault(); a.onZoomIn(); break;
        case '-': case '_': e.preventDefault(); a.onZoomOut(); break;
        case 'd': case 'D':
          if (a.onDownload) { e.preventDefault(); a.onDownload(); }
          break;
        case 'Delete': case 'Backspace':
          if (a.onDelete) { e.preventDefault(); a.onDelete(); }
          break;
        case 'l': case 'L':
          if (a.onToggleFavorite) { e.preventDefault(); a.onToggleFavorite(); }
          break;
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [enabled]);
}

/** Shortcut list for the viewer's help affordance. */
export const LIGHTBOX_SHORTCUTS: { keys: string; label: string }[] = [
  { keys: '← →', label: 'Previous / next' },
  { keys: 'Home End', label: 'First / last' },
  { keys: 'F', label: 'Fit to window' },
  { keys: '1', label: 'Actual size' },
  { keys: '+ −', label: 'Zoom in / out' },
  { keys: 'D', label: 'Download' },
  { keys: 'Esc', label: 'Close' },
];
