import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChangelogModal } from '../ChangelogModal';
import { MobileAppsPromoModal } from './MobileAppsPromoModal';
import { shouldShowMobilePromo } from '../../lib/mobilePromo';
import { getLastSeenVersion, setLastSeenVersion } from '../../lib/api/auth';
import { fetchJSON } from '../../lib/api/client';

interface VersionInfo {
  version: string;
  shortVersion: string;
  build: number;
}

/**
 * First-login What's New popup.
 *
 * Compares the user's last-acknowledged app version (server-side, per user)
 * to the running version. When they differ — including a patch bump like
 * 1.0.0 → 1.0.1 — the ChangelogModal opens automatically with a footer
 * carrying "Got it" (persists the dismissal) and "Remind me later" (closes
 * without persisting so the popup returns on next login).
 *
 * After the changelog is dismissed (or if the user has already seen the
 * current version), the MobileAppsPromoModal appears once per session until
 * the user permanently dismisses it.
 *
 * Designed to be mounted once at the app shell level (Layout). Renders
 * nothing visually until the comparison succeeds — fail-silent on either
 * fetch is fine, the popup is a soft notification.
 */
export function WhatsNewAutoPopup() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [viewAll, setViewAll] = useState(false);
  const [showPromo, setShowPromo] = useState(false);
  // Snapshot the version we're trying to acknowledge so a mid-popup version
  // bump (unlikely, but possible during long-lived sessions) doesn't write
  // a stale value into lastSeenVersion.
  const [ackTarget, setAckTarget] = useState<string | null>(null);

  const versionQuery = useQuery({
    queryKey: ['app-version'],
    queryFn: () => fetchJSON<VersionInfo>('/meta/version'),
    staleTime: 60 * 60 * 1000,
  });

  const lastSeenQuery = useQuery({
    queryKey: ['last-seen-version'],
    queryFn: getLastSeenVersion,
    staleTime: Infinity,
  });

  const acknowledge = useMutation({
    mutationFn: (version: string) => setLastSeenVersion(version),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['last-seen-version'] });
      setOpen(false);
    },
  });

  // Open changelog when the running version differs from what the user last
  // acknowledged (including the NULL case: never seen before).
  useEffect(() => {
    const current = versionQuery.data?.version;
    if (!current) return;
    if (lastSeenQuery.isLoading) return;
    const seen = lastSeenQuery.data?.lastSeenVersion ?? null;
    if (seen !== current) {
      setAckTarget(current);
      setOpen(true);
    }
  }, [versionQuery.data?.version, lastSeenQuery.data?.lastSeenVersion, lastSeenQuery.isLoading]);

  // Watch for the changelog closing so we can chain the promo.
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (prevOpenRef.current && !open) {
      if (shouldShowMobilePromo()) setShowPromo(true);
    }
    prevOpenRef.current = open;
  }, [open]);

  // When the changelog won't show (user already acknowledged this version),
  // still show the promo after a brief delay if it hasn't been dismissed.
  useEffect(() => {
    if (lastSeenQuery.isLoading) return;
    const current = versionQuery.data?.version;
    const seen = lastSeenQuery.data?.lastSeenVersion ?? null;
    if (!current || seen !== current) return; // changelog will/may show; handled above
    if (!shouldShowMobilePromo()) return;
    const timer = setTimeout(() => setShowPromo(true), 1200);
    return () => clearTimeout(timer);
  // Run once when both queries settle. Intentionally not re-running on
  // shouldShowMobilePromo since it reads storage synchronously on each render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSeenQuery.isLoading, versionQuery.data?.version, lastSeenQuery.data?.lastSeenVersion]);

  return (
    <>
      {open && ackTarget && (
        <ChangelogModal
          isOpen={open}
          onClose={() => { setOpen(false); setViewAll(false); }}
          onAcknowledge={() => acknowledge.mutate(ackTarget)}
          acknowledging={acknowledge.isPending}
          onlyVersion={viewAll ? undefined : ackTarget}
          onViewAll={viewAll ? undefined : () => setViewAll(true)}
        />
      )}
      <MobileAppsPromoModal
        isOpen={showPromo}
        onClose={() => setShowPromo(false)}
      />
    </>
  );
}
