import { useCallback, useEffect, useId, useRef } from 'react';

const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'button:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Accessible name for the dialog. Rendered as a visually-hidden heading
   *  unless the consumer overrides via the wrapper className/children. */
  title: string;
  children: React.ReactNode;
  /** Extra classes for the dialog panel (the centered card). The backdrop
   *  is always full-screen with a semi-transparent overlay. */
  className?: string;
}

/**
 * Accessible modal primitive: traps focus, restores focus on close, locks
 * body scroll, closes on Escape and backdrop click. Renders a backdrop and
 * a `role="dialog"` element labelled by a visually-hidden heading.
 *
 * The visual styling of the panel (rounded corners, background, padding) is
 * left to the consumer via `className` and `children`, so each modal keeps
 * its existing look. This primitive only owns accessibility plumbing.
 */
export function Modal({ isOpen, onClose, title, children, className }: ModalProps) {
  const labelId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Capture the trigger element on open so we can restore focus on close.
  // Done in a layout-stable effect that runs only when `isOpen` flips true.
  useEffect(() => {
    if (!isOpen) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    // Focus the first focusable child, or the dialog itself as a fallback.
    const dialog = dialogRef.current;
    if (dialog) {
      const focusable = dialog.querySelectorAll<HTMLElement>(FOCUSABLE);
      const target = focusable[0] ?? dialog;
      target.focus();
    }

    return () => {
      previousFocusRef.current?.focus?.();
    };
  }, [isOpen]);

  // Body scroll lock.
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isOpen]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;

    const dialog = dialogRef.current;
    if (!dialog) return;

    // If the focused element belongs to a nested dialog (e.g. ConfirmModal
    // opened from inside another modal), let that inner modal handle its own
    // Tab logic — don't yank focus back into this outer dialog.
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== dialog && !dialog.contains(active)) return;

    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter(el => !el.hasAttribute('disabled') && el.offsetParent !== null);
    if (focusable.length === 0) {
      e.preventDefault();
      dialog.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey && (active === first || active === dialog)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }, [onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center p-4"
      onKeyDown={handleKeyDown}
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        tabIndex={-1}
        className={`relative z-10 outline-none ${className ?? ''}`}
      >
        <h2 id={labelId} className="sr-only">{title}</h2>
        {children}
      </div>
    </div>
  );
}
