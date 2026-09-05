import { useState } from 'react';
import { ChangelogModal } from '../ChangelogModal';
import { ENHANCED_WHATS_NEW, versionSeries } from './whatsNewRegistry';

interface Props {
  /** The running version, e.g. "2.0.0". Its release series decides which reel
   *  opens (2.0.x to the 2.0 reel). */
  version: string;
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Manual "What's New" entry point (Settings). Opens the screenshot reel for the
 * given version's release series when one exists, otherwise the full
 * ChangelogModal (newest entry first, which is what's new for this version).
 * "View full release notes" inside the reel switches to that same full
 * changelog.
 *
 * The first-login auto-popup is separate: WhatsNewAutoPopup, which also
 * persists the dismissal.
 */
export function WhatsNewForVersion({ version, isOpen, onClose }: Props) {
  const [showHistory, setShowHistory] = useState(false);
  const Reel = ENHANCED_WHATS_NEW[versionSeries(version)];

  const close = () => {
    setShowHistory(false);
    onClose();
  };

  if (Reel && !showHistory) {
    return <Reel isOpen={isOpen} onClose={close} onViewAll={() => setShowHistory(true)} />;
  }

  // No reel for this series, or the user asked for the full history: the plain
  // changelog with no `onlyVersion` shows every release, newest first.
  return <ChangelogModal isOpen={isOpen} onClose={close} />;
}
