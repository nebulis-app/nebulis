import { Link, useLocation } from 'react-router-dom';
import { Sun, Moon, Settings, Library, Sparkles, EyeOff, CloudMoon, Calendar, Crosshair, RefreshCw, HelpCircle, LogOut, ShieldCheck, Eye, Images, BookOpen, Telescope, ChevronDown } from 'lucide-react';
import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useTheme, type Theme } from '../hooks/useTheme';
import { useNavVisibility } from '../hooks/useNavVisibility';
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

const themeOptions: { id: Theme; label: string; icon: ReactNode }[] = [
  { id: 'light', label: 'Light', icon: <Sun className="w-4 h-4" /> },
  { id: 'dark', label: 'Dark', icon: <Moon className="w-4 h-4" /> },
  { id: 'space', label: 'Space', icon: <Sparkles className="w-4 h-4" /> },
  { id: 'night', label: 'Night', icon: <EyeOff className="w-4 h-4" /> },
];

function avatarInitials(name: string): string {
  const letters = name.match(/\b[A-Za-z]/g) ?? [];
  if (letters.length >= 2) return (letters[0] + letters[letters.length - 1]).toUpperCase();
  if (letters.length === 1) return letters[0].toUpperCase();
  return '?';
}

export function Layout({ children }: LayoutProps) {
  const { theme, setTheme, isDark, isNight, isSpace, showNebulaBackdrop } = useTheme();
  const { isVisible } = useNavVisibility();
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
        Skip to main content
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
          <div className="relative flex items-center justify-between h-16">
            {/* Logo */}
            <Link to="/" className="flex items-center gap-3 group">
              <img src="/nebulis-64.png" alt="Nebulis" className="w-7 h-7" />
              <span className="font-display font-bold text-2xl tracking-tight">
                Neb<span className="text-amber-500">ulis</span>
              </span>
            </Link>

            {/* Nav links — absolutely centered so the strip stays in the middle
                of the bar regardless of how wide the logo or right-side group get. */}
            <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1">
              <TourAnchor id="nav-library">
                <NavLink to="/" active={location.pathname === '/'} activeClass={activeNavClass} isDark={isDark} isNight={isNight}>
                  <Library className="w-4 h-4" />
                  <span>Library</span>
                </NavLink>
              </TourAnchor>
              {isVisible('gallery') && (
                <TourAnchor id="nav-gallery">
                  <NavLink to="/image-gallery" active={location.pathname === '/image-gallery'} activeClass={activeNavClass} isDark={isDark} isNight={isNight}>
                    <Images className="w-4 h-4" />
                    <span>Gallery</span>
                  </NavLink>
                </TourAnchor>
              )}
              <TourAnchor id="nav-observations">
                <NavLink to="/observations" active={location.pathname.startsWith('/observations')} activeClass={activeNavClass} isDark={isDark} isNight={isNight}>
                  <Calendar className="w-4 h-4" />
                  <span>Observations</span>
                </NavLink>
              </TourAnchor>
              {isVisible('forecast') && (
                <NavLink to="/forecast" active={location.pathname === '/forecast'} activeClass={activeNavClass} isDark={isDark} isNight={isNight}>
                  <CloudMoon className="w-4 h-4" />
                  <span>Forecast</span>
                </NavLink>
              )}
              {isVisible('planner') && (
                <NavLink to="/planner" active={location.pathname === '/planner' || location.pathname === '/wishlist'} activeClass={activeNavClass} isDark={isDark} isNight={isNight}>
                  <Crosshair className="w-4 h-4" />
                  <span>Planner</span>
                </NavLink>
              )}
              {isVisible('catalogs') && (
                <NavLink to="/catalogs" active={location.pathname.startsWith('/catalogs')} activeClass={activeNavClass} isDark={isDark} isNight={isNight}>
                  <BookOpen className="w-4 h-4" />
                  <span>Catalogs</span>
                </NavLink>
              )}
              <TourAnchor id="nav-settings">
                <NavLink
                  to="/settings"
                  active={location.pathname === '/settings'}
                  activeClass={activeNavClass}
                  isDark={isDark}
                  isNight={isNight}
                  tether={location.pathname === '/settings'}
                >
                  <Settings className="w-4 h-4" />
                  <span>Settings</span>
                  {hasUpdateAvailable && <NavUpdateBadge />}
                </NavLink>
              </TourAnchor>
              {isVisible('help') && (
                <TourAnchor id="nav-help">
                  <NavLink to="/help" active={location.pathname === '/help'} activeClass={activeNavClass} isDark={isDark} isNight={isNight}>
                    <HelpCircle className="w-4 h-4" />
                    <span>Help</span>
                  </NavLink>
                </TourAnchor>
              )}
            </div>

            {/* Right-aligned cluster: telescope sync indicator + profile/theme avatar.
                Stays flush right via the parent's justify-between, while the nav strip
                above floats absolutely centered between this group and the logo. */}
            <div className="flex items-center">
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
                      ? 'Add a telescope in Settings, then sync from here'
                      : isSyncing
                        ? `Syncing ${importStatusData?.currentObject || 'starting'}${formatTransportSuffix(importStatusData?.telescopeName, importStatusData?.transportKind)}...`
                        : `${onlineCount} of ${allStatus.length} telescope${allStatus.length === 1 ? '' : 's'} online`}
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
                      {showSyncPlaceholder ? 'Sync' : isSyncing ? 'Syncing...' : `${onlineCount}/${allStatus.length} online`}
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
                          {showAllScopes ? 'Telescopes' : 'Telescope'}
                        </span>
                        {showAllScopes && (
                          <button
                            onClick={() => syncMutation.mutate({ all: true })}
                            disabled={isSyncing || syncMutation.isPending}
                            className={`inline-flex items-center gap-1 text-[11px] font-medium disabled:opacity-40 ${
                              isDark ? 'text-accent-400 hover:text-accent-300' : 'text-accent-600 hover:text-accent-500'
                            }`}
                          >
                            <RefreshCw className="w-3 h-3" />
                            Sync all
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
                                ? 'No host configured'
                                : s.online
                                  ? `${s.hostname} · ${s.latencyMs}ms`
                                  : `${s.hostname} · offline`}
                            </div>
                          </div>
                          <button
                            onClick={() => syncMutation.mutate({ telescopeId: s.id })}
                            disabled={!s.configured || isSyncing || syncMutation.isPending}
                            title={isThisSyncing ? `Syncing ${s.name}...` : `Sync ${s.name}`}
                            aria-label={isThisSyncing ? `Syncing ${s.name}...` : `Sync ${s.name}`}
                            className={`shrink-0 p-1.5 rounded-lg transition-colors disabled:opacity-30 ${
                              isDark ? 'text-slate-400 hover:bg-slate-800 hover:text-slate-200' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600'
                            }`}
                          >
                            <RefreshCw className={`w-3.5 h-3.5 ${isThisSyncing ? 'animate-spin' : ''}`} />
                          </button>
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
                        Open backup status →
                      </Link>
                    </div>
                  )}
                </div>
                );
              })()}

              {/* Mobile & TV apps */}
              <MobileMenu />

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
                  title="Profile & settings"
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
                            {currentUser?.displayName || currentUser?.username || 'Open Access'}
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
                              ? <><ShieldCheck className="w-2.5 h-2.5" />Admin</>
                              : <><Eye className="w-2.5 h-2.5" />Viewer</>
                            }
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Theme picker */}
                    <div className={`px-3 py-2.5`}>
                      <p className={`text-[10px] font-semibold uppercase tracking-wider mb-2 px-1 ${
                        isNight ? 'text-red-900' : isDark ? 'text-slate-600' : 'text-slate-400'
                      }`}>Theme</p>
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
                            <span className="text-xs font-medium">{opt.label}</span>
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
                          Sign out
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
  tether = false,
  children,
}: {
  to: string;
  active: boolean;
  activeClass: string;
  isDark: boolean;
  isNight: boolean;
  tether?: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      className={`relative flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-all ${
        active && tether
          ? `${activeClass} rounded-t-xl rounded-b-none`
          : active
            ? `${activeClass} rounded-xl`
            : isNight
              ? 'rounded-xl text-red-700 hover:text-red-500 hover:bg-red-950/20'
              : isDark
                ? 'rounded-xl text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                : 'rounded-xl text-slate-500 hover:text-slate-700 hover:bg-slate-100'
      }`}
    >
      {children}
      {active && tether && (
        <>
          {/* 1px gradient thread descending into the section nav strip */}
          <span
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-full -translate-x-1/2 w-px h-3"
            style={{
              background: `linear-gradient(to bottom, ${
                isNight ? '#cc3333' : '#f59e0b'
              }, transparent)`,
            }}
          />
          {/* Small terminating dot */}
          <span
            aria-hidden
            className="pointer-events-none absolute left-1/2 -translate-x-1/2 w-1 h-1 rounded-full"
            style={{
              top: 'calc(100% + 12px)',
              background: isNight ? '#cc3333' : '#f59e0b',
              boxShadow: `0 0 4px ${isNight ? '#cc3333' : '#f59e0b'}`,
            }}
          />
        </>
      )}
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
