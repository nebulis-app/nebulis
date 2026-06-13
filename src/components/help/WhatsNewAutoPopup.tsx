import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChangelogModal } from './ChangelogModal';
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
 * Designed to be mounted once at the app shell level (Layout). Renders
 * nothing visually until the comparison succeeds — fail-silent on either
 * fetch is fine, the popup is a soft notification.
 */
export function WhatsNewAutoPopup() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [viewAll, setViewAll] = useState(false);
  // Snapshot the version we're trying to acknowledge so a mid-popup version
  // bump (unlikely, but possible during long-lived sessions) doesn't write
  // a stale value into lastSeenVersion.
  const [ackTarget, setAckTarget] = useState<string | null>(null);

  const versionQuery = useQuery({
    queryKey: ['app-version'],
    queryFn: () => fetchJSON<VersionInfo>('/meta/version'),
    staleTime: 60 * 60 * 1000, // an hour; version is essentially static at runtime
  });

  const lastSeenQuery = useQuery({
    queryKey: ['last-seen-version'],
    queryFn: getLastSeenVersion,
    // Refetch on focus would re-pop the modal each time the tab becomes
    // active after a deploy. Once per session is enough.
    staleTime: Infinity,
  });

  const acknowledge = useMutation({
    mutationFn: (version: string) => setLastSeenVersion(version),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['last-seen-version'] });
      setOpen(false);
    },
  });

  // Compare the two once both queries land. We open the popup when the
  // current app version is different from what the user last acknowledged,
  // including the NULL case (never seen before).
  useEffect(() => {
    const current = versionQuery.data?.version;
    if (!current) return;
    // Wait until the lastSeen query has resolved — opening on undefined
    // would flash the popup for users who have already dismissed.
    if (lastSeenQuery.isLoading) return;
    const seen = lastSeenQuery.data?.lastSeenVersion ?? null;
    if (seen !== current) {
      setAckTarget(current);
      setOpen(true);
    }
  }, [versionQuery.data?.version, lastSeenQuery.data?.lastSeenVersion, lastSeenQuery.isLoading]);

  if (!open || !ackTarget) return null;
  return (
    <ChangelogModal
      isOpen={open}
      onClose={() => { setOpen(false); setViewAll(false); }}
      onAcknowledge={() => acknowledge.mutate(ackTarget)}
      acknowledging={acknowledge.isPending}
      onlyVersion={viewAll ? undefined : ackTarget}
      onViewAll={viewAll ? undefined : () => setViewAll(true)}
    />
  );
}
