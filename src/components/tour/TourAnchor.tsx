import type { ReactNode } from 'react';

interface TourAnchorProps {
  /** Stable key referenced by a tour step's `anchorKey`. */
  id: string;
  children: ReactNode;
  /** Extra classes merged onto the wrapping element. */
  className?: string;
}

/**
 * Wraps a UI element so the product tour can find and highlight it.
 *
 * It renders a plain span to avoid changing layout (block children stay on
 * their own line, inline children stay inline). The `data-tour-anchor`
 * attribute is what the overlay's spotlight measures against. Anchors are
 * decorative when the tour is closed and cost nothing to keep in place.
 */
export function TourAnchor({ id, children, className }: TourAnchorProps) {
  return (
    <span data-tour-anchor={id} className={className}>
      {children}
    </span>
  );
}
