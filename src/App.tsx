import { Suspense, lazy, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ThemeProvider } from './hooks/useTheme';
import { NavVisibilityProvider } from './hooks/useNavVisibility';
import { Layout } from './components/Layout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { OnboardingModal } from './components/OnboardingModal';

// Route pages are code-split: each loads on first navigation rather than in the
// initial bundle. This keeps the first paint (the Library landing page) from
// having to download the FITS viewer, image editor, Leaflet map, and dnd-kit
// planner up front. Named exports are adapted to the default-export shape lazy()
// expects.
const Gallery = lazy(() => import('./pages/Gallery').then(m => ({ default: m.Gallery })));
const ObjectDetail = lazy(() => import('./pages/ObjectDetail').then(m => ({ default: m.ObjectDetail })));
const SettingsPage = lazy(() => import('./pages/Settings').then(m => ({ default: m.SettingsPage })));
const StorageDashboard = lazy(() => import('./components/StorageDashboard').then(m => ({ default: m.StorageDashboard })));
const CompareView = lazy(() => import('./pages/CompareView').then(m => ({ default: m.CompareView })));
const ForecastPage = lazy(() => import('./pages/ForecastPage').then(m => ({ default: m.ForecastPage })));
const ObservationsCalendar = lazy(() => import('./pages/ObservationsCalendar').then(m => ({ default: m.ObservationsCalendar })));
const ObservationDetail = lazy(() => import('./pages/ObservationDetail').then(m => ({ default: m.ObservationDetail })));
const PlannerPage = lazy(() => import('./pages/PlannerPage').then(m => ({ default: m.PlannerPage })));
const NewObservationPage = lazy(() => import('./pages/NewObservationPage').then(m => ({ default: m.NewObservationPage })));
const BackupStatus = lazy(() => import('./pages/BackupStatus').then(m => ({ default: m.BackupStatus })));
const ImageGalleryPage = lazy(() => import('./pages/ImageGalleryPage').then(m => ({ default: m.ImageGalleryPage })));
const HelpPage = lazy(() => import('./pages/HelpPage').then(m => ({ default: m.HelpPage })));
const LinkDevicePage = lazy(() => import('./pages/LinkDevicePage'));
const CatalogsHub = lazy(() => import('./pages/CatalogsHub').then(m => ({ default: m.CatalogsHub })));
const CatalogBoard = lazy(() => import('./pages/CatalogBoard').then(m => ({ default: m.CatalogBoard })));
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
    <Layout>
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
        <Route path="/catalogs" element={<CatalogsHub />} />
        <Route path="/catalogs/:catalog" element={<CatalogBoard />} />
        <Route path="/wishlist" element={<Navigate to="/planner?tab=wishlist" replace />} />
        <Route path="/backup" element={<BackupStatus />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/image-gallery" element={<ImageGalleryPage />} />
        <Route path="/help" element={<HelpPage />} />
        <Route path="/link" element={<LinkDevicePage />} />
      </Routes>
      </Suspense>
      </SyncSubframesProvider>
    </Layout>
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
