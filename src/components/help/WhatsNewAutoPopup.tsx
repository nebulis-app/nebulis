import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChangelogModal } from '../ChangelogModal';
import { ENHANCED_WHATS_NEW, versionSeries } from './whatsNewRegistry';
import { MobileAppsPromoModal } from './MobileAppsPromoModal';
import { SupportNebulisModal } from './SupportNebulisModal';
import { supportAskSeenLocally } from '../../lib/support';
import { shouldShowMobilePromo } from '../../lib/mobilePromo';
import { getLastSeenVersion, setLastSeenVersion, getSupportAskSeen, setSupportAskSeen } from '../../lib/api/auth';
import { fetchJSON } from '../../lib/api/client';
import { useWhatsNewGate } from '../../contexts/WhatsNewGateContext';

interface VersionInfo {
  version: string;
  shortVersion: string;
  build: number;
}

/**
 * First-login What's New popup.
 *
 * The screenshot-driven reels (vs. the plain ChangelogModal) are registered in
 * whatsNewRegistry, matched on `major.minor`: a user upgrading straight from
 * 1.4 to 1.5.2 still sees the 1.5 reel once, the same as someone who landed on
 * 1.5.0 first. The reel shows exactly once per series (see useEnhancedModal
 * below) — later patches in the same series fall back to the plain
 * ChangelogModal so the screenshots don't reappear on every point release.
 *
 * Compares the user's last-acknowledged app version (server-side, per user)
 * to the running version. When they differ — including a patch bump like
 * 1.0.0 → 1.0.1 — the ChangelogModal opens automatically with a footer
 * carrying "Got it" (persists the dismissal) and "Remind me later" (closes
 * without persisting so the popup returns on next login).
 *
 * After the changelog is dismissed (or if the user has already seen the
 * current version), the MobileAppsPromoModal appears once per session until
 * the user permanently dismisses it. Currently disabled: `shouldShowMobilePromo`
 * returns false while MOBILE_PROMO_ENABLED is off, so the chain below stays
 * wired but never opens anything. See lib/mobilePromo.ts.
 *
 * The "Enjoying Nebulis?" support ask comes after that, once per user (the server keeps the record), and only for someone who
 * has used Nebulis before (a first-ever launch has had no chance to find it useful yet). It holds
 * the tour gate until it is closed, so the tour never opens on top of it. If there is no What's New
 * to show (the version was already acknowledged), it appears shortly after load instead.
 *
 * Designed to be mounted once at the app shell level (Layout). Renders
 * nothing visually until the comparison succeeds — fail-silent on either
 * fetch is fine, the popup is a soft notification.
 *
 * Also owns the WhatsNewGateContext "settled" flag: TourProvider.autoStart
 * waits on it so the guided tour never auto-launches on top of this popup
 * on a fresh install. See WhatsNewGateContext for why.
 */
export function WhatsNewAutoPopup() {
  const queryClient = useQueryClient();
  const { markSettled } = useWhatsNewGate();
  const [open, setOpen] = useState(false);
  const [viewAll, setViewAll] = useState(false);
  const [showPromo, setShowPromo] = useState(false);
  const [showSupport, setShowSupport] = useState(false);
  // Whether this browser has never acknowledged any version, decided once with the first answer.
  // A brand-new user is not asked for a coffee on day one; they are asked on a later load.
  const firstEverRef = useRef(false);
  const chainFinishedRef = useRef(false);
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

  // Whether the support ask is still due. An unanswered or failed request counts as not due: better to miss one
  // ask than to nag someone because the server was briefly unreachable.
  const supportAskQuery = useQuery({
    queryKey: ['support-ask-seen'],
    queryFn: getSupportAskSeen,
    staleTime: Infinity,
    retry: false,
  });
  const supportAskSettled = !supportAskQuery.isLoading;
  const supportAskDue = supportAskQuery.data?.seenAt === null && !supportAskSeenLocally();

  // A browser that dismissed the ask before the server kept the record syncs it up, so the user is not asked
  // again from their other browsers.
  useEffect(() => {
    if (supportAskQuery.data?.seenAt !== null || !supportAskSeenLocally()) return;
    setSupportAskSeen()
      .then(() => queryClient.invalidateQueries({ queryKey: ['support-ask-seen'] }))
      .catch(() => { /* tried again on the next load */ });
  }, [supportAskQuery.data?.seenAt, queryClient]);

  const acknowledge = useMutation({
    mutationFn: (version: string) => setLastSeenVersion(version),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['last-seen-version'] });
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

  // Settle the tour gate once we know whether a popup was ever going to show
  // for this version. This must decide exactly ONCE, not re-run on every
  // change to lastSeenQuery: acknowledging the reel (onAcknowledge below)
  // persists lastSeenVersion and invalidates that query mid-chain, so `seen`
  // catches up to `current` while the popup is still open (now showing the
  // full changelog instead of the reel). A dependency-driven re-check would
  // read that as "nothing to show" and release the gate under the still-open
  // modal — which is the exact bug this gate exists to prevent.
  const decidedNeedRef = useRef(false);
  useEffect(() => {
    if (decidedNeedRef.current) return;
    const current = versionQuery.data?.version;
    if (!current || lastSeenQuery.isLoading || !supportAskSettled) return;
    decidedNeedRef.current = true;
    const seen = lastSeenQuery.data?.lastSeenVersion ?? null;
    firstEverRef.current = seen === null;
    if (seen === current) {
      // Nothing to show. The support ask, if it is due, takes over the gate so the tour waits for it.
      if (supportAskDue) {
        chainFinishedRef.current = true;
        setTimeout(() => setShowSupport(true), 1200);
      } else {
        markSettled();
      }
    }
  }, [versionQuery.data?.version, lastSeenQuery.data?.lastSeenVersion, lastSeenQuery.isLoading, supportAskSettled, supportAskDue, markSettled]);

  // The What's New chain is over: ask for the coffee if it is due, otherwise release the tour gate.
  // Idempotent, because "Got it" and the close handlers can both fire for one dismissal.
  const finishChain = () => {
    if (chainFinishedRef.current) return;
    chainFinishedRef.current = true;
    if (!firstEverRef.current && supportAskDue) setShowSupport(true);
    else markSettled();
  };

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
    // shouldShowMobilePromo is a module function reading storage synchronously,
    // so the linter doesn't require it as a dep — the effect runs once the two
    // queries settle.
  }, [lastSeenQuery.isLoading, versionQuery.data?.version, lastSeenQuery.data?.lastSeenVersion]);

  // Series match alone isn't enough to decide "show the reel": the popup
  // trigger above compares exact versions, so a patch bump within the same
  // series (1.5.0 -> 1.5.1) also reopens this. Only show the full reel when
  // the user's last-acknowledged version was in a DIFFERENT series (a real
  // first-look at 1.5, whether they arrived via 1.5.0 or jumped straight from
  // 1.4 to 1.5.2). Once any 1.5.x has been acknowledged, later 1.5.x patches
  // fall through to the plain ChangelogModal below instead of repeating the
  // screenshot tour on every point release.
  const seenSeries = versionSeries(lastSeenQuery.data?.lastSeenVersion ?? '');
  const EnhancedModal = ackTarget ? ENHANCED_WHATS_NEW[versionSeries(ackTarget)] : undefined;
  const useEnhancedModal =
    ackTarget !== null &&
    EnhancedModal !== undefined &&
    seenSeries !== versionSeries(ackTarget) &&
    !viewAll;

  return (
    <>
      {open && ackTarget && (
        useEnhancedModal && EnhancedModal ? (
          <EnhancedModal
            isOpen={open}
            onClose={() => { setOpen(false); setViewAll(false); finishChain(); }}
            // "Got it" persists the dismissal and ends the chain. The full release
            // notes are not forced on anyone after the reel; "View full release
            // notes" below opens them for whoever wants them.
            onAcknowledge={() => { acknowledge.mutate(ackTarget); setOpen(false); setViewAll(false); finishChain(); }}
            acknowledging={acknowledge.isPending}
            onViewAll={() => setViewAll(true)}
          />
        ) : (
          <ChangelogModal
            isOpen={open}
            onClose={() => { setOpen(false); setViewAll(false); finishChain(); }}
            // The plain changelog: shown directly for versions with no reel, or
            // when the reel's "View full release notes" was chosen.
            onAcknowledge={() => { acknowledge.mutate(ackTarget); setOpen(false); setViewAll(false); finishChain(); }}
            acknowledging={acknowledge.isPending}
            onlyVersion={viewAll ? undefined : ackTarget}
            onViewAll={viewAll ? undefined : () => setViewAll(true)}
          />
        )
      )}
      <MobileAppsPromoModal
        isOpen={showPromo}
        onClose={() => setShowPromo(false)}
      />
      <SupportNebulisModal
        isOpen={showSupport}
        onClose={() => { setShowSupport(false); markSettled(); }}
      />
    </>
  );
}
