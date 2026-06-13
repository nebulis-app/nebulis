import { Link, useLocation } from 'react-router-dom';
import { Sun, Moon, Settings, Library, Sparkles, EyeOff, CloudMoon, Calendar, Crosshair, RefreshCw, HelpCircle, LogOut, ShieldCheck, Eye, Images } from 'lucide-react';
import { useState, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useTheme, type Theme } from '../hooks/useTheme';
import { getTelescopeStatus, getAllTelescopeStatus } from '../lib/api/telescopes';
import { getImportStatus, formatTransportSuffix } from '../lib/api/library';
import { getCurrentUser } from '../lib/api/auth';
import { clearAuthToken, getAuthToken } from '../lib/api/client';
import { useClickOutside } from '../hooks/useClickOutside';
import { WhatsNewAutoPopup } from './help/WhatsNewAutoPopup';
import { LibraryUnavailableBanner } from './LibraryUnavailableBanner';
import { UpdateBanner } from './UpdateBanner';

interface LayoutProps {
  children: ReactNode;
}

const themeOptions: { id: Theme; label: string; icon: ReactNode; description: string }[] = [
  { id: 'light', label: 'Light', icon: <Sun className="w-4 h-4" />, description: 'Clean and bright' },
  { id: 'dark', label: 'Dark', icon: <Moon className="w-4 h-4" />, description: 'Easy on the eyes' },
  { id: 'space', label: 'Space', icon: <Sparkles className="w-4 h-4" />, description: 'Cosmic nebula vibes' },
  { id: 'night', label: 'Night', icon: <EyeOff className="w-4 h-4" />, description: 'Red light · dark adaptation' },
];

function avatarInitials(name: string): string {
  const letters = name.match(/\b[A-Za-z]/g) ?? [];
  if (letters.length >= 2) return (letters[0] + letters[letters.length - 1]).toUpperCase();
  if (letters.length === 1) return letters[0].toUpperCase();
  return '?';
}

export function Layout({ children }: LayoutProps) {
  const { theme, setTheme, isDark, isNight, isSpace } = useTheme();
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

  const { data: telescopeStatus } = useQuery({
    queryKey: ['telescope-status'],
    queryFn: getTelescopeStatus,
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  // Per-telescope status — drives the multi-scope popover. Cheap because the
  // server caches each hostname's TCP probe for 30 s.
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
          : isDark ? 'bg-slate-950 text-slate-200'
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
      <nav className={`sticky top-0 z-50 border-b backdrop-blur-xl ${
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
              <NavLink to="/" active={location.pathname === '/'} activeClass={activeNavClass} isDark={isDark} isNight={isNight}>
                <Library className="w-4 h-4" />
                <span>Library</span>
              </NavLink>
              <NavLink to="/image-gallery" active={location.pathname === '/image-gallery'} activeClass={activeNavClass} isDark={isDark} isNight={isNight}>
                <Images className="w-4 h-4" />
                <span>Gallery</span>
              </NavLink>
              <NavLink to="/observations" active={location.pathname.startsWith('/observations')} activeClass={activeNavClass} isDark={isDark} isNight={isNight}>
                <Calendar className="w-4 h-4" />
                <span>Observations</span>
              </NavLink>
              <NavLink to="/forecast" active={location.pathname === '/forecast'} activeClass={activeNavClass} isDark={isDark} isNight={isNight}>
                <CloudMoon className="w-4 h-4" />
                <span>Forecast</span>
              </NavLink>
              <NavLink to="/planner" active={location.pathname === '/planner' || location.pathname === '/wishlist'} activeClass={activeNavClass} isDark={isDark} isNight={isNight}>
                <Crosshair className="w-4 h-4" />
                <span>Planner</span>
              </NavLink>
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
              </NavLink>
              <NavLink to="/help" active={location.pathname === '/help'} activeClass={activeNavClass} isDark={isDark} isNight={isNight}>
                <HelpCircle className="w-4 h-4" />
                <span>Help</span>
              </NavLink>
            </div>

            {/* Right-aligned cluster: telescope sync indicator + profile/theme avatar.
                Stays flush right via the parent's justify-between, while the nav strip
                above floats absolutely centered between this group and the logo. */}
            <div className="flex items-center">
              {/* Telescope online / sync indicator.
                  - 1 scope: single pill, links to /backup (legacy behavior).
                  - 2+ scopes: aggregate pill ("N of M online") that opens a
                    popover listing each scope with its own dot + latency. */}
              {showAllScopes ? (
                <div ref={scopesRef} className="relative ml-1">
                  <button
                    onClick={() => setScopesOpen(s => !s)}
                    title={isSyncing
                      ? `Syncing ${importStatusData?.currentObject || 'starting'}${formatTransportSuffix(importStatusData?.telescopeName, importStatusData?.transportKind)}...`
                      : `${onlineCount} of ${allStatus.length} telescopes online`}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium select-none transition-all ${
                      isSyncing
                        ? isNight ? 'bg-red-950/30 text-red-400' : isDark ? 'bg-accent-500/10 text-accent-400' : 'bg-accent-100 text-accent-700'
                        : onlineCount === allStatus.length
                          ? isNight ? 'bg-red-950/30 text-red-400' : isDark ? 'bg-emerald-500/10 text-emerald-400' : 'bg-emerald-50 text-emerald-700'
                          : onlineCount > 0
                            ? isDark ? 'bg-amber-500/10 text-amber-400' : 'bg-amber-50 text-amber-700'
                            : isDark ? 'bg-slate-800 text-slate-500' : 'bg-slate-100 text-slate-400'
                    }`}
                  >
                    {isSyncing ? (
                      <RefreshCw className="w-3 h-3 animate-spin shrink-0" />
                    ) : (
                      <span className="flex items-center gap-0.5 shrink-0">
                        {allStatus.slice(0, 4).map(s => (
                          <span
                            key={s.id}
                            className={`w-2 h-2 rounded-full ${s.online ? 'animate-pulse' : ''}`}
                            style={{
                              backgroundColor: s.online ? s.color : undefined,
                              boxShadow: s.online ? `0 0 6px ${s.color}cc` : undefined,
                              opacity: s.online ? 1 : 0.35,
                              backgroundImage: s.online ? undefined : 'none',
                            }}
                          />
                        ))}
                      </span>
                    )}
                    <span className="hidden sm:inline">
                      {isSyncing ? 'Syncing...' : `${onlineCount}/${allStatus.length} online`}
                    </span>
                  </button>
                  {scopesOpen && (
                    <div className={`absolute right-0 top-full mt-2 z-50 w-64 rounded-xl border shadow-lg overflow-hidden ${
                      isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'
                    }`}>
                      <div className={`px-3 py-2 text-[11px] font-semibold uppercase tracking-wider border-b ${
                        isDark ? 'text-slate-500 border-slate-800' : 'text-slate-400 border-slate-100'
                      }`}>
                        Telescopes
                      </div>
                      {allStatus.map(s => (
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
                        </div>
                      ))}
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
              ) : telescopeStatus?.configured && (
                <Link
                  to="/backup"
                  title={
                    isSyncing
                      ? `Syncing ${importStatusData?.currentObject || 'starting'}${formatTransportSuffix(importStatusData?.telescopeName, importStatusData?.transportKind)}...`
                      : telescopeStatus.online
                        ? `${telescopeStatus.hostname} · ${telescopeStatus.latencyMs}ms`
                        : `${telescopeStatus.hostname} · offline`
                  }
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium ml-1 select-none transition-all ${
                    isSyncing
                      ? isNight
                        ? 'bg-red-950/30 text-red-400'
                        : isDark
                          ? 'bg-accent-500/10 text-accent-400'
                          : 'bg-accent-50 text-accent-700'
                      : telescopeStatus.online
                        ? isNight
                          ? 'bg-red-950/30 text-red-400'
                          : isDark
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : 'bg-emerald-50 text-emerald-700'
                        : isNight
                          ? 'bg-red-950/30 text-red-700'
                          : isDark
                            ? 'bg-slate-800 text-slate-500'
                            : 'bg-slate-100 text-slate-400'
                  }`}
                >
                  {isSyncing ? (
                    <RefreshCw className="w-3 h-3 animate-spin shrink-0" />
                  ) : (
                    <span className={`w-2 h-2 rounded-full shrink-0 ${
                      telescopeStatus.online
                        ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.8)] animate-pulse'
                        : isDark ? 'bg-slate-600' : 'bg-slate-300'
                    }`} />
                  )}
                  <span className="hidden sm:inline">
                    {isSyncing
                      ? 'Syncing...'
                      : telescopeStatus.online ? 'Telescope Online' : 'Telescope Offline'}
                  </span>
                </Link>
              )}

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
      className={`relative flex items-center gap-2 px-4 py-2 text-sm font-medium transition-all ${
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
