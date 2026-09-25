import { Suspense, useEffect, useState } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { lazyRoute } from './lib/chunkReload';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ThemeProvider } from './hooks/useTheme';
import { NavVisibilityProvider } from './hooks/useNavVisibility';
import { Layout } from './components/Layout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { OnboardingModal } from './components/OnboardingModal';
import { TourProvider } from './components/tour/TourProvider';
import { TourOverlay } from './components/tour/TourOverlay';
import { WhatsNewGateProvider, useWhatsNewGate } from './contexts/WhatsNewGateContext';

// Route pages are code-split: each loads on first navigation rather than in the
// initial bundle. This keeps the first paint (the Library landing page) from
// having to download the FITS viewer, image editor, Leaflet map, and dnd-kit
// planner up front. Named exports are adapted to the default-export shape lazy()
// expects, and lazyRoute() adds the stale-build reload described in
// lib/chunkReload.ts.
const Gallery = lazyRoute(() => import('./pages/Gallery').then(m => ({ default: m.Gallery })));
const ObjectDetail = lazyRoute(() => import('./pages/ObjectDetail').then(m => ({ default: m.ObjectDetail })));
const SettingsPage = lazyRoute(() => import('./pages/Settings').then(m => ({ default: m.SettingsPage })));
const StorageDashboard = lazyRoute(() => import('./components/StorageDashboard').then(m => ({ default: m.StorageDashboard })));
const CompareView = lazyRoute(() => import('./pages/CompareView').then(m => ({ default: m.CompareView })));
const ForecastPage = lazyRoute(() => import('./pages/ForecastPage').then(m => ({ default: m.ForecastPage })));
const ObservationsCalendar = lazyRoute(() => import('./pages/ObservationsCalendar').then(m => ({ default: m.ObservationsCalendar })));
const ObservationDetail = lazyRoute(() => import('./pages/ObservationDetail').then(m => ({ default: m.ObservationDetail })));
const PlannerPage = lazyRoute(() => import('./pages/PlannerPage').then(m => ({ default: m.PlannerPage })));
const NewObservationPage = lazyRoute(() => import('./pages/NewObservationPage').then(m => ({ default: m.NewObservationPage })));
const BackupStatus = lazyRoute(() => import('./pages/BackupStatus').then(m => ({ default: m.BackupStatus })));
const ImageGalleryPage = lazyRoute(() => import('./pages/ImageGalleryPage').then(m => ({ default: m.ImageGalleryPage })));
const HelpPage = lazyRoute(() => import('./pages/HelpPage').then(m => ({ default: m.HelpPage })));
const LinkDevicePage = lazyRoute(() => import('./pages/LinkDevicePage'));
const CatalogsHub = lazyRoute(() => import('./pages/CatalogsHub').then(m => ({ default: m.CatalogsHub })));
const CatalogBoard = lazyRoute(() => import('./pages/CatalogBoard').then(m => ({ default: m.CatalogBoard })));
const CalibrationLibrary = lazyRoute(() => import('./pages/CalibrationLibrary').then(m => ({ default: m.CalibrationLibrary })));
const WishlistPage = lazyRoute(() => import('./pages/WishlistPage').then(m => ({ default: m.WishlistPage })));
const HomePage = lazyRoute(() => import('./pages/HomePage').then(m => ({ default: m.HomePage })));
import { LoginModal } from './components/LoginModal';
import { ConnectionErrorScreen } from './components/ConnectionErrorScreen';
import { SyncSubframesProvider } from './contexts/SyncSubframesContext';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { getAuthStatus } from './lib/api/auth';
import { getSettings } from './lib/api/settings';

// Shown while a lazily-loaded route chunk is being fetched. Kept intentionally
// minimal so it doesn't flash heavy chrome for the usually-instant local load.
function RouteFallback() {
  return (
    <div className="flex items-center justify-center py-24" role="status" aria-label="Loading">
      <div className="w-6 h-6 rounded-full border-2 border-accent-500/30 border-t-accent-500 animate-spin" />
    </div>
  );
}

/** React Router's client-side navigation never touches native scroll
 *  restoration, so the browser leaves scrollY wherever it was on the previous
 *  page. Clicking an observation from partway down an object page's
 *  observations list landed on the observation page at that same offset
 *  instead of its top. Keyed on pathname only, not search, so filter/tab
 *  changes that only touch query params don't reset scroll underneath the
 *  user. */
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [pathname]);
  return null;
}

function AppInner() {
  const queryClient = useQueryClient();
  const { refresh: refreshAuth, hasToken } = useAuth();
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);

  const { data: authStatus, isError: authStatusFailed, refetch: retryAuthStatus } = useQuery({
    queryKey: ['auth-status'],
    queryFn: getAuthStatus,
    staleTime: 5 * 60 * 1000,
  });

  useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
    enabled: hasToken || authStatus?.requiresSetup === true,
    staleTime: 5 * 60 * 1000,
  });

  // requiresSetup (no users) always wins — onboardingCompleted is irrelevant
  // if the user account it was tied to no longer exists.
  const showOnboarding =
    !onboardingDismissed &&
    authStatus?.requiresSetup === true;

  // Show login when users exist but we have no stored token
  const showLogin =
    !showOnboarding &&
    !hasToken &&
    authStatus?.hasUsers === true;

  // No token and the status check itself failed (server unreachable/starting
  // up): authStatus stays undefined forever, so showOnboarding/showLogin above
  // never become true and the full app would otherwise render behind a server
  // that isn't answering, with no way to sign in.
  const showConnectionError =
    !hasToken &&
    authStatusFailed &&
    authStatus === undefined;

  function handleLogin() {
    refreshAuth();
    queryClient.invalidateQueries();
  }

  if (showConnectionError) {
    return <ConnectionErrorScreen onRetry={() => retryAuthStatus()} />;
  }

  if (showOnboarding) {
    return <OnboardingModal onComplete={() => setOnboardingDismissed(true)} />;
  }

  if (showLogin) {
    return <LoginModal onLogin={handleLogin} />;
  }

  return (
    <WhatsNewGateProvider>
      <AppShell onboardingDismissed={onboardingDismissed} />
    </WhatsNewGateProvider>
  );
}

/** Split out of AppInner so it can read the What's New gate via context
 *  (the provider has to sit above it in the tree). See WhatsNewGateContext
 *  for why the tour must not auto-start before that gate settles. */
function AppShell({ onboardingDismissed }: { onboardingDismissed: boolean }) {
  const { settled: whatsNewSettled } = useWhatsNewGate();

  return (
    <TourProvider autoStart={onboardingDismissed && whatsNewSettled}>
      <Layout>
        <ScrollToTop />
        <SyncSubframesProvider>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/" element={<Gallery />} />
              <Route path="/observations" element={<ObservationsCalendar />} />
              <Route path="/observations/new" element={<NewObservationPage />} />
              <Route path="/observations/:objectId/:date" element={<ObservationDetail />} />
              <Route path="/object/:objectId" element={<ObjectDetail />} />
              <Route path="/object/:objectId/compare" element={<CompareView />} />
              <Route path="/storage" element={<StorageDashboard />} />
              <Route path="/forecast" element={<ForecastPage />} />
              <Route path="/planner" element={<PlannerPage />} />
              <Route path="/wishlist" element={<WishlistPage />} />
              <Route path="/catalogs" element={<CatalogsHub />} />
              <Route path="/catalogs/:catalog" element={<CatalogBoard />} />
              <Route path="/calibrations" element={<CalibrationLibrary />} />
              <Route path="/tonight" element={<HomePage />} />
              <Route path="/backup" element={<BackupStatus />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/image-gallery" element={<ImageGalleryPage />} />
              <Route path="/help" element={<HelpPage />} />
              <Route path="/link" element={<LinkDevicePage />} />
            </Routes>
          </Suspense>
        </SyncSubframesProvider>
      </Layout>
      <TourOverlay />
    </TourProvider>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <NavVisibilityProvider>
          <AuthProvider>
            <AppInner />
          </AuthProvider>
        </NavVisibilityProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
