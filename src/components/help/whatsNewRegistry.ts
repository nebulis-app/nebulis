import type { ComponentType } from 'react';
import { WhatsNewV20Modal } from './WhatsNewV20Modal';

/** Props every hand-built "What's New" reel accepts.
 *
 *  `onAcknowledge` / `acknowledging` are supplied only by the first-login flow
 *  (WhatsNewAutoPopup), which persists the dismissal server-side. Omitting them
 *  gives a plain "Done" footer, which is what the "see it again from Settings"
 *  entry point (WhatsNewForVersion) wants. `onViewAll` hands off to the full
 *  ChangelogModal; omit it to hide that link. */
export interface EnhancedWhatsNewProps {
  isOpen: boolean;
  onClose: () => void;
  onAcknowledge?: () => void;
  acknowledging?: boolean;
  onViewAll?: () => void;
}

/** Release series (`major.minor`) that have a screenshot-driven reel instead of
 *  the plain changelog. Keyed by series, not exact version, so a user on 2.0.3
 *  still gets the 2.0 reel. Add an entry here alongside the modal component;
 *  any version whose series isn't listed falls back to ChangelogModal.
 *
 *  Index this directly (`ENHANCED_WHATS_NEW[versionSeries(v)]`) to get the
 *  component to render — a helper that *returns* a component trips
 *  react-hooks/static-components. */
export const ENHANCED_WHATS_NEW: Record<string, ComponentType<EnhancedWhatsNewProps>> = {
  '2.0': WhatsNewV20Modal,
};

/** "1.5.1" to "1.5". Anything unparseable is returned whole, which simply
 *  fails to match a series. */
export function versionSeries(version: string): string {
  const match = /^(\d+)\.(\d+)/.exec(version);
  return match ? `${match[1]}.${match[2]}` : version;
}

/** Whether a version's release series has a screenshot reel (vs. only a plain
 *  changelog entry). */
export function hasEnhancedWhatsNew(version: string | null | undefined): boolean {
  return version != null && versionSeries(version) in ENHANCED_WHATS_NEW;
}
