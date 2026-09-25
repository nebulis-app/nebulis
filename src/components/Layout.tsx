import { Link, useLocation } from 'react-router-dom';
import { Sun, Moon, Settings, Library, Sparkles, EyeOff, CloudMoon, Calendar, Crosshair, RefreshCw, HelpCircle, LogOut, ShieldCheck, Eye, Images, BookOpen, Aperture, Telescope, ChevronDown, Star, Menu, X } from 'lucide-react';
import { useState, useRef, useLayoutEffect, cloneElement, isValidElement, type ReactElement } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { useTheme, type Theme } from '../hooks/useTheme';
import { useNavVisibility, type NavItemId } from '../hooks/useNavVisibility';
import { getAllTelescopeStatus } from '../lib/api/telescopes';
import { getImportStatus, formatTransportSuffix, triggerImport } from '../lib/api/library';
import { getCurrentUser } from '../lib/api/auth';
import { getUpdateStatus } from '../lib/api/update';
import { clearAuthToken, getAuthToken } from '../lib/api/client';
import { useClickOutside } from '../hooks/useClickOutside';
import { useAuth } from '../contexts/AuthContext';
import { WhatsNewAutoPopup } from './help/WhatsNewAutoPopup';
import { MobileMenu } from './MobileMenu';
import { LibraryUnavailableBanner } from './LibraryUnavailableBanner';
import { UpdateBanner } from './UpdateBanner';
import { TourAnchor } from './tour/TourAnchor';
import { useTour } from './tour/TourProvider';

interface LayoutProps {
  children: ReactNode;
}

const themeOptions: { id: Theme; labelKey: string; icon: ReactNode }[] = [
  { id: 'light', labelKey: 'appearance.light.label', icon: <Sun className="w-4 h-4" /> },
  { id: 'dark', labelKey: 'appearance.dark.label', icon: <Moon className="w-4 h-4" /> },
  { id: 'space', labelKey: 'appearance.space.label', icon: <Sparkles className="w-4 h-4" /> },
  { id: 'night', labelKey: 'appearance.night.label', icon: <EyeOff className="w-4 h-4" /> },
];

/** Total horizontal breathing room kept between the nav strip and the logo or
 *  the right-hand cluster, before the strip is allowed to stay at full size.
 *  Half of it lands on each side. */
const NAV_STRIP_CLEARANCE = 24;

/** Route/icon/active-match/tour-anchor per top-nav item, keyed by the same
 *  `NavItemId` the Settings → General "Navigation bar" list uses to control
 *  visibility and order. `settings`'s update badge is handled separately in
 *  the render loop since it depends on query state, not anything static here.
 *
 *  Exported so tests/frontend/tourAnchors.test.ts can add these `tourAnchorId`
 *  values to its known-anchor set: its static scan looks for a literal
 *  `<TourAnchor id="...">` in JSX, which this file no longer has now that the
 *  nav strip renders from `orderedItems` instead of one hardcoded link per
 *  item — same "third kind of dynamic id" case that file's own doc comment
 *  anticipates (it already does this for SETTINGS_NAV). */
// eslint-disable-next-line react-refresh/only-export-components
export const NAV_LINK_CONFIG: Record<NavItemId, {
  to: string;
  icon: ReactNode;
  isActive: (pathname: string) => boolean;
  tourAnchorId?: string;
}> = {
  library: {
    to: '/', icon: <Library className="w-4 h-4" />, isActive: (p) => p === '/', tourAnchorId: 'nav-library',
  },
  gallery: {
    to: '/image-gallery', icon: <Images className="w-4 h-4" />, isActive: (p) => p === '/image-gallery', tourAnchorId: 'nav-gallery',
  },
  observations: {
    to: '/observations', icon: <Calendar className="w-4 h-4" />, isActive: (p) => p.startsWith('/observations'), tourAnchorId: 'nav-observations',
  },
  forecast: {
    to: '/forecast', icon: <CloudMoon className="w-4 h-4" />, isActive: (p) => p === '/forecast',
  },
  planner: {
    to: '/planner', icon: <Crosshair className="w-4 h-4" />, isActive: (p) => p === '/planner',
  },
  wishlist: {
    to: '/wishlist', icon: <Star className="w-4 h-4" />, isActive: (p) => p.startsWith('/wishlist'),
  },
  catalogs: {
    to: '/catalogs', icon: <BookOpen className="w-4 h-4" />, isActive: (p) => p.startsWith('/catalogs'),
  },
  calibrations: {
    to: '/calibrations', icon: <Aperture className="w-4 h-4" />, isActive: (p) => p.startsWith('/calibrations'),
  },
  settings: {
    to: '/settings', icon: <Settings className="w-4 h-4" />, isActive: (p) => p === '/settings', tourAnchorId: 'nav-settings',
  },
  help: {
    to: '/help', icon: <HelpCircle className="w-4 h-4" />, isActive: (p) => p === '/help', tourAnchorId: 'nav-help',
  },
};

function avatarInitials(name: string): string {
  const letters = name.match(/\b[A-Za-z]/g) ?? [];
  if (letters.length >= 2) return (letters[0] + letters[letters.length - 1]).toUpperCase();
  if (letters.length === 1) return letters[0].toUpperCase();
  return '?';
}

export function Layout({ children }: LayoutProps) {
  const { t, i18n } = useTranslation(['common', 'settings']);
  const { theme, setTheme, isDark, isNight, isSpace, showNebulaBackdrop } = useTheme();
  const { isVisible, orderedItems } = useNavVisibility();
  const visibleNavItems = orderedItems.filter(item => isVisible(item.id));
  // Nav strip sizing is a measured decision, not an item count. The strip
  // lives between the logo and the right-hand cluster, so how many labels fit
  // depends on the room those two leave, and that room changes with the
  // viewport far more than with the item count. A plain "more than 8 items
  // means compact" rule shrank the bar on a 2560px screen that had 85px to
  // spare, while doing nothing about the same 11 items overlapping both
  // neighbours on a 1280px one. The sizing effect below measures instead, and
  // only tightens the strip when the full-size one genuinely does not fit.
  const [isCompactNav, setIsCompactNav] = useState(false);
  // How far the strip slides from the bar's centre to keep its clearance. The
  // logo is much narrower than the status cluster, so centring the strip by
  // construction throws away the extra room on the logo's side; the shift
  // spends it instead of shrinking the labels to fit the smaller side.
  const [navShift, setNavShift] = useState(0);
  const navBarRef = useRef<HTMLDivElement | null>(null);
  const navLogoRef = useRef<HTMLAnchorElement | null>(null);
  const navStripRef = useRef<HTMLDivElement | null>(null);
  const navRightRef = useRef<HTMLDivElement | null>(null);
  // Width the strip needs at full size. Only measurable while it is rendered
  // at full size, so it is cached and reused to decide when it can grow back.
  const fullNavWidthRef = useRef<number | null>(null);
  const navMeasuredForRef = useRef<string | null>(null);
  const navSignature = `${i18n.language}|${visibleNavItems.map(item => item.id).join(',')}`;
  const { active: tourActive, step: tourStep } = useTour();
  const { isAdmin } = useAuth();
  const location = useLocation();
  const [profileOpen, setProfileOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const hasToken = Boolean(getAuthToken());

  const { data: currentUser } = useQuery({
    queryKey: ['current-user'],
    queryFn: getCurrentUser,
    enabled: hasToken,
    staleTime: 5 * 60_000,
  });

  // Drives the "new update" badge on the Settings nav item. Same query key as
  // SoftwareUpdateCard / UpdateBanner, so this doesn't add an extra request —
  // React Query dedupes concurrent callers. Only admins can act on an update
  // (the Settings > Updates page is admin-only), so non-admins never fetch it.
  const { data: updateStatusData } = useQuery({
    queryKey: ['update-status'],
    queryFn: getUpdateStatus,
    enabled: hasToken && isAdmin,
    refetchInterval: 60_000,
  });
  const hasUpdateAvailable = updateStatusData?.updateAvailable ?? false;

  // Per-telescope status — drives the sync popover, for one scope or several.
  // Cheap because the server caches each hostname's TCP probe for 30 s.
  const { data: allStatus = [] } = useQuery({
    queryKey: ['telescope-status-all'],
    queryFn: getAllTelescopeStatus,
    refetchInterval: 30_000,
    staleTime: 25_000,
  });
  const showAllScopes = allStatus.length >= 2;
  const onlineCount = allStatus.filter(s => s.online).length;
  const [scopesOpen, setScopesOpen] = useState(false);
  const scopesRef = useRef<HTMLDivElement>(null);
  useClickOutside(scopesRef, () => setScopesOpen(false), { enabled: scopesOpen, closeOnEscape: true });

  const { data: importStatusData } = useQuery({
    queryKey: ['import-status'],
    queryFn: getImportStatus,
    refetchInterval: (query) => query.state.data?.running ? 2000 : 15_000,
  });

  const isSyncing = importStatusData?.running ?? false;

  // Sync is triggered from this dropdown now rather than a "From Telescope"
  // button on the Library page, so there's exactly one place a user reaches
  // for it regardless of which page they're on.
  const queryClient = useQueryClient();
  const syncMutation = useMutation({
    mutationFn: (opts?: { telescopeId?: string; all?: boolean }) => triggerImport(opts),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['import-status'] }),
  });

  useClickOutside(dropdownRef, () => setProfileOpen(false));

  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const mobileNavRef = useRef<HTMLDivElement>(null);
  useClickOutside(mobileNavRef, () => setMobileNavOpen(false), { enabled: mobileNavOpen, closeOnEscape: true });

  // Sizing and placement pass for the nav strip. Runs in a layout effect so
  // the decision is applied before paint: on a narrow screen the strip renders
  // at full size for one commit, is measured, and tightens without the user
  // ever seeing the in-between frame.
  //
  // `fullNavWidthRef` is the whole reason the sizing is not a one-liner. The
  // width the strip needs at full size can only be read while it is rendered at
  // full size, so it is cached, and the cached number is what decides when there
  // is room to grow back. Changing the item set or the language changes those
  // widths, so the signature below throws the cache away and measures again.
  useLayoutEffect(() => {
    const strip = navStripRef.current;
    const bar = navBarRef.current;
    const logo = navLogoRef.current;
    const right = navRightRef.current;
    if (!strip || !bar || !logo || !right) return;

    const fit = () => {
      const barRect = bar.getBoundingClientRect();
      const centre = barRect.left + barRect.width / 2;
      const logoRight = logo.getBoundingClientRect().right;
      const rightLeft = right.getBoundingClientRect().left;
      const needed = Math.ceil(strip.getBoundingClientRect().width);
      if (needed === 0) return;
      // Every pixel between the logo and the status cluster is room the strip
      // can use. Judging it against the room mirrored about the bar's centre
      // instead spends only the smaller side: the logo is ~120px and the
      // status cluster ~250px, so at 1470px the full-size labels had ~80px to
      // spare in the gap and still rendered compact.
      const gap = rightLeft - logoRight;

      if (!isCompactNav) {
        // This measurement is the only chance to read the full-size width, so
        // cache it before deciding to shrink away from it.
        fullNavWidthRef.current = needed;
      }

      const fullWidth = fullNavWidthRef.current;
      if (fullWidth == null) {
        // No full-size measurement for this item set yet. Render one, then
        // let the next pass decide.
        setIsCompactNav(false);
      } else {
        setIsCompactNav(fullWidth + NAV_STRIP_CLEARANCE > gap);
      }

      // Stay centred on the bar while that keeps the clearance on both sides,
      // and slide toward the roomier neighbour when it does not. The strip is
      // centred by construction, so without the slide the extra room on the
      // logo's side stays unusable and the labels shrink to fit the cluster's
      // side alone. Clamping the centre to the two clearance edges moves the
      // strip the least it can: zero whenever the centred position is legal.
      const half = needed / 2 + NAV_STRIP_CLEARANCE / 2;
      const lowestCentre = logoRight + half;
      const highestCentre = rightLeft - half;
      const target = lowestCentre > highestCentre
        // Narrower than the strip needs even in compact form. Nothing left to
        // protect, so fall back to the centred position.
        ? centre
        : Math.min(Math.max(centre, lowestCentre), highestCentre);
      setNavShift(Math.round(target - centre));
    };

    if (navMeasuredForRef.current !== navSignature) {
      navMeasuredForRef.current = navSignature;
      fullNavWidthRef.current = null;
    }

    fit();

    // Inter and Space Grotesk are self-hosted and load with font-display:
    // swap, so a cold first paint measures the fallback face's metrics. Those
    // differ enough from Inter's to flip the decision when a width sits right
    // on the boundary, so measure again once the real faces are in.
    let cancelled = false;
    document.fonts?.ready.then(() => { if (!cancelled) fit(); });

    // The logo and the status cluster change width on their own (a longer
    // hostname, the sync pill appearing, the update badge), so watching only
    // the bar would miss room appearing or disappearing. The strip is watched
    // too: switching it between full size and compact changes the width its
    // own fit is judged against, and re-measuring on that change is what lets
    // the cached full-size number settle before it is next trusted.
    const observer = new ResizeObserver(fit);
    for (const el of [bar, logo, right, strip]) observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [isCompactNav, navSignature]);

  function handleLogout() {
    clearAuthToken();
    window.location.reload();
  }

  // Theme-aware accent for active nav
  const activeNavClass = isNight
    ? 'bg-red-950/50 text-red-400'
    : isSpace
      ? 'bg-violet-900/30 text-violet-400'
      : isDark
        ? 'bg-slate-800 text-accent-400'
        : 'bg-accent-300 text-accent-700';

  return (
    <div className={`min-h-screen ${
      isNight ? 'bg-black text-red-500'
        : isSpace ? 'bg-transparent text-[#c8c3e0]'
          : isDark ? `${showNebulaBackdrop ? 'bg-transparent' : 'bg-slate-950'} text-slate-200`
            : 'bg-slate-50 text-slate-800'
    }`}>
      {/* First-login What's New popup. Mounted at the shell level so every
          authenticated screen gets the check; the component itself renders
          null until it has both /meta/version and the user's lastSeenVersion
          and they differ. */}
      <WhatsNewAutoPopup />

      {/* Desktop auto-update banner. Renders null unless a signed update is
          available for this platform. */}
      <UpdateBanner />

      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[9999] focus:px-4 focus:py-2 focus:rounded focus:bg-accent-500 focus:text-white focus:text-sm focus:font-medium"
      >
        {t('layout.skipToMainContent')}
      </a>
      {/* Navigation */}
      {/* `app-nav` is the hook the theme overrides in index.css target. Without
          it those rules fall back to matching every `nav` on the page. */}
      <nav className={`app-nav sticky top-0 z-50 border-b backdrop-blur-xl ${
        isNight
          ? 'bg-black/95 border-[#2a0808]'
          : isSpace
            ? 'bg-[#0d0b1f]/85 border-[#1e1a40]'
            : isDark
              ? 'bg-slate-950/80 border-slate-800'
              : 'bg-white/80 border-slate-200'
      }`}>
        <div className="max-w-[1800px] mx-auto px-4 sm:px-6 lg:px-8">
          <div ref={navBarRef} className="relative flex items-center justify-between h-16">
            {/* Logo */}
            <Link to="/" ref={navLogoRef} className="flex items-center gap-3 group">
              <img src="/nebulis-64.png" alt="Nebulis" className="w-7 h-7" />
              <span className="font-display font-bold text-2xl tracking-tight">
                Neb<span className="text-amber-500">ulis</span>
              </span>
            </Link>

            {/* Nav links — centered on the bar's centre and slid off it only
                as far as the clearance needs (see `navShift`), so the strip
                does not move for the logos or status text changing width.
                Order and visibility both come from Settings → General →
                Navigation bar (useNavVisibility); `settings` is always visible
                there but still freely reorderable. Whether the items render at
                full size or compact is measured against the room between the
                logo and the right-side cluster, not counted — see the sizing
                effect above. The translate is inline rather than Tailwind's
                `-translate-x-1/2` so the shift composes with the centring. */}
            <div
              ref={navStripRef}
              className={`absolute left-1/2 hidden lg:flex items-center ${isCompactNav ? 'gap-0.5' : 'gap-1'}`}
              style={{ transform: `translateX(calc(-50% + ${navShift}px))` }}
            >
              {visibleNavItems.map(item => {
                const cfg = NAV_LINK_CONFIG[item.id];
                const icon = isCompactNav && isValidElement(cfg.icon)
                  ? cloneElement(cfg.icon as ReactElement<{ className?: string }>, { className: 'w-3.5 h-3.5' })
                  : cfg.icon;
                const link = (
                  <NavLink
                    to={cfg.to}
                    active={cfg.isActive(location.pathname)}
                    activeClass={activeNavClass}
                    isDark={isDark}
                    isNight={isNight}
                    compact={isCompactNav}
                  >
                    {icon}
                    <span>{t(item.labelKey)}</span>
                    {item.id === 'settings' && hasUpdateAvailable && <NavUpdateBadge />}
                  </NavLink>
                );
                return cfg.tourAnchorId ? (
                  <TourAnchor key={item.id} id={cfg.tourAnchorId}>{link}</TourAnchor>
                ) : (
                  <span key={item.id}>{link}</span>
                );
              })}
            </div>

            {/* Right-aligned cluster: telescope sync indicator + profile/theme avatar.
                Stays flush right via the parent's justify-between, while the nav strip
                above floats absolutely centered between this group and the logo. */}
            <div ref={navRightRef} className="flex items-center">
              {/* Telescope online / sync indicator. Same dropdown shape for
                  one scope or several: the aggregate pill ("N of M online")
                  opens a popover listing each scope with its own dot, status
                  and a sync button. This is the only place a sync is
                  triggered from now — Library's old standalone "From
                  Telescope" button was removed in favor of it.

                  This pill is normally hidden entirely with zero telescopes
                  configured — but that is exactly the state of every brand-new
                  install, which is also when the product tour's "sync" step
                  runs (it walks the user through adding a telescope, but
                  doesn't require them to finish before moving on). Without a
                  telescope the tour step had nothing to spotlight and fell
                  back to a floating, unhighlighted card. `showSyncPlaceholder`
                  renders an inert stand-in of this same pill for the tour to
                  point at; it opens nothing and shows no dropdown, since there
                  is nothing real to list yet. */}
              {(() => {
                const showSyncPlaceholder = allStatus.length === 0 && tourActive && tourStep.id === 'sync';
                if (allStatus.length === 0 && !showSyncPlaceholder) return null;
                return (
                <div ref={scopesRef} className="relative ml-1">
                  <TourAnchor id="top-nav-sync">
                  <button
                    onClick={() => !showSyncPlaceholder && setScopesOpen(s => !s)}
                    title={showSyncPlaceholder
                      ? t('layout.syncPlaceholderTitle')
                      : isSyncing
                        ? t('layout.syncingTitle', {
                            object: importStatusData?.currentObject || t('layout.startingFallback'),
                            suffix: formatTransportSuffix(importStatusData?.telescopeName, importStatusData?.transportKind),
                          })
                        : t('layout.onlineStatus', { online: onlineCount, count: allStatus.length })}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium select-none transition-all ${
                      showSyncPlaceholder
                        ? isDark ? 'bg-slate-800 text-slate-500' : 'bg-slate-100 text-slate-400'
                        : isSyncing
                          ? isNight ? 'bg-red-950/30 text-red-400' : isDark ? 'bg-accent-500/10 text-accent-400' : 'bg-accent-100 text-accent-700'
                          : onlineCount === allStatus.length
                            ? isNight ? 'bg-red-950/30 text-red-400' : isDark ? 'bg-emerald-500/10 text-emerald-400' : 'bg-emerald-50 text-emerald-700'
                            : onlineCount > 0
                              ? isDark ? 'bg-amber-500/10 text-amber-400' : 'bg-amber-50 text-amber-700'
                              : isDark ? 'bg-slate-800 text-slate-500' : 'bg-slate-100 text-slate-400'
                    }`}
                  >
                    {!showSyncPlaceholder && isSyncing ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" />
                    ) : (
                      // Tinted by the button's own text color (already status-driven
                      // above), so this reads as "telescopes" at a glance instead of
                      // a cluster of dots that could be almost anything. Per-scope
                      // color/online detail still lives in the dropdown rows below.
                      <Telescope className="w-3.5 h-3.5 shrink-0" />
                    )}
                    <span className="hidden sm:inline">
                      {showSyncPlaceholder ? t('layout.syncPill') : isSyncing ? t('layout.syncingPill') : t('layout.onlinePill', { online: onlineCount, count: allStatus.length })}
                    </span>
                    {/* Signals "this opens something" — the pill used to look like
                        a static status badge with no hint it was clickable. */}
                    {!showSyncPlaceholder && (
                      <ChevronDown
                        className={`hidden sm:block w-3 h-3 shrink-0 transition-transform duration-200 ${scopesOpen ? 'rotate-180' : ''}`}
                      />
                    )}
                  </button>
                  </TourAnchor>
                  {scopesOpen && (
                    <div className={`absolute right-0 top-full mt-2 z-50 w-72 rounded-xl border shadow-lg overflow-hidden ${
                      isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'
                    }`}>
                      <div className={`flex items-center justify-between gap-2 px-3 py-2 border-b ${
                        isDark ? 'border-slate-800' : 'border-slate-100'
                      }`}>
                        <span className={`text-[11px] font-semibold uppercase tracking-wider ${
                          isDark ? 'text-slate-500' : 'text-slate-400'
                        }`}>
                          {t('layout.telescopesHeading', { count: allStatus.length })}
                        </span>
                        {showAllScopes && isAdmin && (
                          <button
                            onClick={() => syncMutation.mutate({ all: true })}
                            disabled={isSyncing || syncMutation.isPending}
                            className={`inline-flex items-center gap-1 text-[11px] font-medium disabled:opacity-40 ${
                              isDark ? 'text-accent-400 hover:text-accent-300' : 'text-accent-600 hover:text-accent-500'
                            }`}
                          >
                            <RefreshCw className="w-3 h-3" />
                            {t('layout.syncAll')}
                          </button>
                        )}
                      </div>
                      {allStatus.map(s => {
                        // The toolbar spinner is driven by import status, which is
                        // shared across all telescopes, so a per-row spinner needs
                        // its own signal: the status telescopeId once the server
                        // reports it, and the mutation's own pending variables in
                        // the gap right after clicking (before that status lands).
                        const isThisSyncing =
                          (isSyncing && importStatusData?.telescopeId === s.id) ||
                          (syncMutation.isPending && syncMutation.variables?.telescopeId === s.id);
                        return (
                        <div
                          key={s.id}
                          className={`flex items-center gap-2.5 px-3 py-2 text-sm ${
                            isDark ? 'hover:bg-slate-800/50' : 'hover:bg-slate-50'
                          }`}
                        >
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{
                              backgroundColor: s.online ? s.color : 'transparent',
                              boxShadow: s.online ? `0 0 6px ${s.color}cc` : undefined,
                              border: s.online ? 'none' : `1px dashed ${isDark ? '#475569' : '#cbd5e1'}`,
                            }}
                          />
                          <div className="flex-1 min-w-0">
                            <div className={`font-medium truncate ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                              {s.name}
                            </div>
                            <div className={`text-[11px] truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                              {!s.configured
                                ? t('layout.noHostConfigured')
                                : s.online
                                  ? t('layout.hostnameLatency', { hostname: s.hostname, ms: s.latencyMs })
                                  : t('layout.hostnameOffline', { hostname: s.hostname })}
                            </div>
                          </div>
                          {/* Syncing writes to the library server-side, which is
                              admin-only (POST /api/library/import). Hide the
                              trigger for viewers so the offer matches what the
                              API will actually allow. */}
                          {isAdmin && (
                          <button
                            onClick={() => syncMutation.mutate({ telescopeId: s.id })}
                            disabled={!s.configured || isSyncing || syncMutation.isPending}
                            title={isThisSyncing ? t('layout.syncingRow', { name: s.name }) : t('layout.syncRow', { name: s.name })}
                            aria-label={isThisSyncing ? t('layout.syncingRow', { name: s.name }) : t('layout.syncRow', { name: s.name })}
                            className={`shrink-0 p-1.5 rounded-lg transition-colors disabled:opacity-30 ${
                              isDark ? 'text-slate-400 hover:bg-slate-800 hover:text-slate-200' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600'
                            }`}
                          >
                            <RefreshCw className={`w-3.5 h-3.5 ${isThisSyncing ? 'animate-spin' : ''}`} />
                          </button>
                          )}
                        </div>
                        );
                      })}
                      <Link
                        to="/backup"
                        onClick={() => setScopesOpen(false)}
                        className={`block px-3 py-2 text-xs font-medium border-t ${
                          isDark ? 'border-slate-800 text-accent-400 hover:bg-slate-800/50' : 'border-slate-100 text-accent-600 hover:bg-slate-50'
                        }`}
                      >
                        {t('layout.openBackupStatus')}
                      </Link>
                    </div>
                  )}
                </div>
                );
              })()}

              {/* Mobile & TV apps — desktop only; the hamburger drawer covers
                  navigation on phones and tablets, so this button would only
                  crowd the already-tight right cluster on small screens. */}
              <div className="hidden lg:block">
                <MobileMenu />
              </div>

              {/* Hamburger — phones and tablets only (hidden on desktop).
                  Opens the slide-down drawer below the nav bar. */}
              <button
                onClick={() => setMobileNavOpen(o => !o)}
                aria-label={mobileNavOpen ? t('layout.closeNavMenu') : t('layout.openNavMenu')}
                aria-expanded={mobileNavOpen}
                className={`lg:hidden flex items-center justify-center w-9 h-9 rounded-xl transition-colors ${
                  mobileNavOpen
                    ? isNight ? 'bg-red-950/50 text-red-400' : isSpace ? 'bg-violet-900/30 text-violet-300' : isDark ? 'bg-slate-800 text-slate-200' : 'bg-slate-200 text-slate-700'
                    : isNight ? 'text-red-600 hover:bg-red-950/30' : isSpace ? 'text-violet-400 hover:bg-violet-900/20' : isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'
                }`}
              >
                {mobileNavOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
              </button>

              {/* Profile / theme dropdown */}
              <div ref={dropdownRef} className="relative ml-2">
                <button
                  onClick={() => setProfileOpen(!profileOpen)}
                  className={`flex items-center justify-center w-8 h-8 rounded-full text-xs font-bold transition-all ring-2 ${
                    profileOpen
                      ? isNight
                        ? 'ring-red-500 bg-red-900/40 text-red-300'
                        : isSpace
                          ? 'ring-violet-500 bg-violet-900/40 text-violet-300'
                          : isDark
                            ? 'ring-accent-500 bg-accent-500/20 text-accent-300'
                            : 'ring-accent-500 bg-accent-300 text-accent-700'
                      : isNight
                        ? 'ring-red-900/60 bg-red-950/30 text-red-500 hover:ring-red-700'
                        : isSpace
                          ? 'ring-violet-900/40 bg-violet-900/20 text-violet-400 hover:ring-violet-600'
                          : isDark
                            ? 'ring-slate-700 bg-slate-800 text-slate-300 hover:ring-slate-500'
                            : 'ring-slate-200 bg-slate-100 text-slate-600 hover:ring-slate-300'
                  }`}
                  title={t('layout.profileSettingsTitle')}
                >
                  {currentUser ? avatarInitials(currentUser.displayName || currentUser.username) : '?'}
                </button>

                {profileOpen && (
                  <div className={`absolute right-0 top-full mt-2 w-64 rounded-2xl border shadow-2xl overflow-hidden z-50 ${
                    isNight
                      ? 'bg-[#0a0000] border-[#2a0808]'
                      : isSpace
                        ? 'bg-[#0d0b1f] border-[#1e1a40]'
                        : isDark
                          ? 'bg-slate-900 border-slate-800'
                          : 'bg-white border-slate-200'
                  }`}>

                    {/* User info header */}
                    <div className={`px-4 py-3.5 border-b ${
                      isNight ? 'border-[#2a0808]' : isSpace ? 'border-[#1e1a40]' : isDark ? 'border-slate-800' : 'border-slate-100'
                    }`}>
                      <div className="flex items-center gap-3">
                        <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${
                          isNight
                            ? 'bg-red-950/50 text-red-400'
                            : isSpace
                              ? 'bg-violet-900/40 text-violet-300'
                              : isDark
                                ? 'bg-accent-500/15 text-accent-400'
                                : 'bg-accent-100 text-accent-700'
                        }`}>
                          {currentUser ? avatarInitials(currentUser.displayName || currentUser.username) : '?'}
                        </div>
                        <div className="min-w-0">
                          <p className={`text-sm font-semibold truncate ${
                            isNight ? 'text-red-300' : isDark ? 'text-slate-200' : 'text-slate-800'
                          }`}>
                            {currentUser?.displayName || currentUser?.username || t('layout.openAccess')}
                          </p>
                          {currentUser?.email && (
                            <p className={`text-xs truncate ${
                              isNight ? 'text-red-800' : isDark ? 'text-slate-500' : 'text-slate-400'
                            }`}>
                              {currentUser.email}
                            </p>
                          )}
                        </div>
                        {/* Role badge */}
                        {currentUser && (
                          <span className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ml-auto ${
                            currentUser.role === 'admin'
                              ? isNight
                                ? 'bg-red-950/40 text-red-500'
                                : isDark
                                  ? 'bg-amber-500/10 text-amber-400'
                                  : 'bg-amber-50 text-amber-700'
                              : isNight
                                ? 'bg-red-950/20 text-red-700'
                                : isDark
                                  ? 'bg-slate-700 text-slate-400'
                                  : 'bg-slate-100 text-slate-500'
                          }`}>
                            {currentUser.role === 'admin'
                              ? <><ShieldCheck className="w-2.5 h-2.5" />{t('layout.roleAdmin')}</>
                              : <><Eye className="w-2.5 h-2.5" />{t('layout.roleViewer')}</>
                            }
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Theme picker */}
                    <div className={`px-3 py-2.5`}>
                      <p className={`text-[10px] font-semibold uppercase tracking-wider mb-2 px-1 ${
                        isNight ? 'text-red-900' : isDark ? 'text-slate-600' : 'text-slate-400'
                      }`}>{t('layout.themeHeading')}</p>
                      <div className="grid grid-cols-2 gap-1">
                        {themeOptions.map(opt => (
                          <button
                            key={opt.id}
                            onClick={() => { setTheme(opt.id); setProfileOpen(false); }}
                            className={`flex items-center gap-2 px-2.5 py-2 rounded-xl text-left transition ${
                              theme === opt.id
                                ? isNight
                                  ? 'bg-red-950/40 text-red-400'
                                  : isSpace
                                    ? 'bg-violet-900/30 text-violet-300'
                                    : isDark
                                      ? 'bg-accent-500/15 text-accent-400'
                                      : 'bg-accent-300 text-accent-700'
                                : isNight
                                  ? 'text-red-700 hover:bg-red-950/20'
                                  : isDark
                                    ? 'text-slate-400 hover:bg-slate-800'
                                    : 'text-slate-500 hover:bg-slate-50'
                            }`}
                          >
                            <span className={theme === opt.id
                              ? isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500'
                              : ''
                            }>
                              {opt.icon}
                            </span>
                            <span className="text-xs font-medium">{t(opt.labelKey, { ns: 'settings' })}</span>
                            {theme === opt.id && (
                              <div className={`ml-auto w-1.5 h-1.5 rounded-full ${
                                isNight ? 'bg-red-500' : isSpace ? 'bg-violet-400' : 'bg-accent-500'
                              }`} />
                            )}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Logout — only shown when a token is present */}
                    {hasToken && (
                      <div className={`px-3 pb-2.5 border-t pt-2 ${
                        isNight ? 'border-[#2a0808]' : isSpace ? 'border-[#1e1a40]' : isDark ? 'border-slate-800' : 'border-slate-100'
                      }`}>
                        <button
                          onClick={handleLogout}
                          className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-sm transition ${
                            isNight
                              ? 'text-red-600 hover:bg-red-950/30 hover:text-red-400'
                              : isDark
                                ? 'text-slate-400 hover:bg-red-500/10 hover:text-red-400'
                                : 'text-slate-500 hover:bg-red-50 hover:text-red-600'
                          }`}
                        >
                          <LogOut className="w-4 h-4" />
                          {t('layout.signOut')}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </nav>

      {/* Mobile / tablet nav drawer — slides down under the nav bar.
          Only rendered below lg, where the desktop strip is hidden.

          Layout strategy:
          - Portrait: CSS grid, columns scale with viewport width
            (2 cols on phones, 3 on sm tablets, 4 on md tablets).
          - Landscape: single horizontal scrollable row so items never
            overflow vertically in the constrained height; items are
            compact (icon + label, smaller padding) to stay readable. */}
      {mobileNavOpen && (
        <div
          ref={mobileNavRef}
          className={`lg:hidden sticky top-16 z-40 border-b shadow-lg ${
            isNight
              ? 'bg-black/98 border-[#2a0808]'
              : isSpace
                ? 'bg-[#0d0b1f]/98 border-[#1e1a40]'
                : isDark
                  ? 'bg-slate-950/98 border-slate-800'
                  : 'bg-white/98 border-slate-200'
          }`}
        >
          <div className="max-w-[1800px] mx-auto px-4 sm:px-6 py-2">
            <div className="portrait:grid portrait:grid-cols-2 portrait:sm:grid-cols-3 portrait:md:grid-cols-4 portrait:gap-1 landscape:flex landscape:flex-nowrap landscape:gap-1 landscape:overflow-x-auto landscape:pb-1 no-scrollbar">
              {visibleNavItems.map(item => {
                const cfg = NAV_LINK_CONFIG[item.id];
                const isActive = cfg.isActive(location.pathname);
                const linkEl = (
                  <Link
                    key={item.id}
                    to={cfg.to}
                    onClick={() => setMobileNavOpen(false)}
                    className={`relative flex items-center gap-2 rounded-xl font-medium transition-all
                      portrait:px-4 portrait:py-3 portrait:text-sm
                      landscape:shrink-0 landscape:px-3 landscape:py-1.5 landscape:text-xs
                      ${
                        isActive
                          ? activeNavClass
                          : isNight
                            ? 'text-red-700 hover:text-red-500 hover:bg-red-950/20'
                            : isDark
                              ? 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                              : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
                      }`}
                  >
                    {cfg.icon}
                    <span>{t(item.labelKey)}</span>
                    {item.id === 'settings' && hasUpdateAvailable && (
                      <span
                        aria-hidden
                        className="ml-auto flex items-center justify-center w-3.5 h-3.5 rounded-full bg-red-500 text-white text-[9px] font-bold leading-none"
                      >
                        1
                      </span>
                    )}
                  </Link>
                );
                return cfg.tourAnchorId ? (
                  <TourAnchor key={item.id} id={cfg.tourAnchorId}>{linkEl}</TourAnchor>
                ) : (
                  <span key={item.id}>{linkEl}</span>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Main content */}
      <main id="main-content" className="max-w-[1800px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <LibraryUnavailableBanner />
        {children}
      </main>
    </div>
  );
}

function NavLink({
  to,
  active,
  activeClass,
  isDark,
  isNight,
  compact,
  children,
}: {
  to: string;
  active: boolean;
  activeClass: string;
  isDark: boolean;
  isNight: boolean;
  compact: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      // `transition-colors`, not `transition-all`: the `compact` flag changes
      // this element's padding, gap and font size, and the nav strip is sized
      // by measuring itself. A transition on those properties meant the sizing
      // effect sometimes read a width part-way through the shrink and cached it
      // as the full-size cost. Colour transitions are all the nav item needs.
      className={`relative flex items-center rounded-xl font-medium transition-colors ${
        compact ? 'gap-1 px-2.5 py-1.5 text-xs' : 'gap-1.5 px-3 py-2 text-sm'
      } ${
        active
          ? activeClass
          : isNight
            ? 'text-red-700 hover:text-red-500 hover:bg-red-950/20'
            : isDark
              ? 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
      }`}
    >
      {children}
    </Link>
  );
}

/** Small "1" badge signaling an available update. Absolutely positioned
 *  against the nearest `relative` ancestor (NavLink already is one), so it
 *  floats over the top-right corner of whatever it's dropped into. */
function NavUpdateBadge() {
  return (
    <span
      aria-hidden
      className="absolute -top-1 -right-1 flex items-center justify-center w-3.5 h-3.5 rounded-full bg-red-500 text-white text-[9px] font-bold leading-none"
    >
      1
    </span>
  );
}
