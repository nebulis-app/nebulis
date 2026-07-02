import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/**
 * Swipe-down-to-close gesture for full-screen modals (image viewers, etc).
 *
 * Activates on touch only (mouse drags are left alone for select/drag flows).
 * Drag the modal down past `threshold` pixels to close; release before that
 * and the modal snaps back. Horizontal-dominant swipes cancel the gesture so
 * thumbnail-strip scrolls and image-pan flows are not hijacked.
 *
 * Returns:
 *  - `handlers`: spread onto the element that should respond to the gesture
 *  - `dy`: current vertical drag in pixels (0 when idle); apply as a
 *    transform: translateY for the modal and an opacity ramp for the backdrop
 *  - `dragging`: true while the user is actively dragging
 */
interface UseSwipeDownToCloseOptions {
  /** Pixels of vertical travel that commits the close. Default: 120. */
  threshold?: number;
  /** Disable the gesture (e.g. when the image is zoomed and the user is panning). */
  disabled?: boolean;
}

export function useSwipeDownToClose(
  onClose: () => void,
  { threshold = 120, disabled = false }: UseSwipeDownToCloseOptions = {},
) {
  const [dy, setDy] = useState(0);
  const [dragging, setDragging] = useState(false);
  const stateRef = useRef({ startX: 0, startY: 0, tracking: false, lastDy: 0 });

  const onPointerDown = (e: ReactPointerEvent) => {
    if (disabled) return;
    // Touch only — keep mouse free for selection, panning, etc.
    if (e.pointerType !== 'touch') return;
    stateRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      tracking: true,
      lastDy: 0,
    };
    setDragging(true);
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const s = stateRef.current;
    if (!s.tracking) return;
    const dx = e.clientX - s.startX;
    const dyRaw = e.clientY - s.startY;
    // Cancel if motion is horizontal-dominant past a small deadzone.
    if (Math.abs(dx) > Math.abs(dyRaw) && Math.abs(dx) > 8) {
      s.tracking = false;
      s.lastDy = 0;
      setDy(0);
      setDragging(false);
      return;
    }
    // Only respond to downward drag; upward drag does nothing.
    const next = Math.max(0, dyRaw);
    s.lastDy = next;
    setDy(next);
  };

  const finish = () => {
    const s = stateRef.current;
    if (!s.tracking) return;
    s.tracking = false;
    setDragging(false);
    if (s.lastDy > threshold) {
      onClose();
      // Keep the offset visible during the unmount frame so it doesn't snap
      // back before the modal disappears. Parent will unmount the element.
      return;
    }
    setDy(0);
  };

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: finish,
    },
    dy,
    dragging,
  };
}
