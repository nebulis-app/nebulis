import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ALL_TOUR_STEPS, WELCOME_STEP, stepMatchesRoute, type TourStep } from './steps';
import {
  getLibraryObjects,
  plantTourSampleObject,
  purgeTourSampleObject,
} from '../../lib/api/library';

/** Every cached view the demo object appears in or disappears from. Planting
 *  and purging both change what the library holds, so both refresh these. */
function invalidateLibraryViews(queryClient: QueryClient): void {
  for (const key of [
    ['library-objects'],        // Library grid
    ['library-object-filters'], // its type/telescope filter chips
    ['all-library-images'],     // Gallery
    ['observations'],           // Observations calendar
    // The demo also fills in coordinates, which is what lets the real Planner
    // render instead of its "Location not set" prompt.
    ['sites'],
    ['active-site'],
    ['settings'],
    ['planner-targets'],
    ['forecast'],
  ]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

/**
 * State for the guided product tour.
 *
 * The tour is a single list made of one synthetic welcome card plus the steps
 * in `steps.ts`. Ownership lives here so the overlay and any launcher button
 * (the Help page today) talk to the same running instance.
 */
const STORAGE_KEY = 'nebulis-tour-seen-v1';

interface TourContextValue {
  active: boolean;
  stepIndex: number;
  step: TourStep;
  /** Total steps including the welcome card. */
  stepCount: number;
  /** True between route navigation and the next route actually settling. */
  transitioning: boolean;
  start: () => void;
  stop: () => void;
  next: () => void;
  back: () => void;
  readonly stepList: TourStep[];
}

const TourContext = createContext<TourContextValue | null>(null);

export function useTour(): TourContextValue {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error('useTour must be used within a TourProvider');
  return ctx;
}

export function TourProvider({ children, autoStart = false }: { children: ReactNode; autoStart?: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [active, setActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [pendingRoute, setPendingRoute] = useState<string | null>(null);

  const locationRef = useRef(location);

  // Keep ref current without touching it during render.
  useEffect(() => {
    locationRef.current = location;
  }, [location]);

  // A route transition is in flight until the URL actually reaches it. This
  // is derived, not tracked in an effect, so it never lags a render.
  const transitioningRef = useRef(false);
  const transitioning = pendingRoute !== null && location.pathname !== pendingRoute;
  useEffect(() => {
    transitioningRef.current = transitioning;
  }, [transitioning]);

  const step = ALL_TOUR_STEPS[stepIndex] ?? WELCOME_STEP;

  const start = useCallback(() => {
    setStepIndex(0);
    setPendingRoute(null);
    setActive(true);
    // Plant the demo object so the library-, object- and processed-image
    // steps have something real to land on. The server refuses when the
    // library already holds real objects, so a returning user re-running the
    // tour walks through their own data instead. Fire-and-forget: the welcome
    // card comes first, which is several steps of head start before anything
    // needs it, and a failure here only costs the spotlight on those steps.
    plantTourSampleObject()
      .then(({ object, location }) => {
        if (object || location) invalidateLibraryViews(queryClient);
      })
      .catch(() => { /* tour still runs, just without a demo object */ });
  }, [queryClient]);

  // Auto-launch once, right after a fresh install finishes (or skips)
  // onboarding — `autoStart` is true from this provider's very first render
  // in that case, since App.tsx only mounts it once onboarding is dismissed.
  // Guarded by the same "seen" flag `stop()` writes, so a returning user who
  // already closed the tour once never gets it forced on them again.
  useEffect(() => {
    if (!autoStart) return;
    if (typeof window === 'undefined') return;
    try {
      if (localStorage.getItem(STORAGE_KEY) === '1') return;
    } catch {
      // Storage unavailable — still fine to show the tour once.
    }
    start();
  }, [autoStart, start]);

  const stop = useCallback(() => {
    setActive(false);
    setPendingRoute(null);
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY, '1');
      } catch {
        /* storage may be unavailable; seeing the tour again is harmless */
      }
    }
    // Take the demo object back out. This covers Finish, Skip tour, the close
    // button and Esc, since every one of them lands here. A tour abandoned by
    // closing the browser never reaches this, so the server also purges at
    // boot — the object is never left in the user's library either way.
    purgeTourSampleObject()
      .then(({ object, location }) => {
        if (object || location) invalidateLibraryViews(queryClient);
      })
      .catch(() => { /* the next server boot purges it */ });

    // The tour may have been walking through the demo object when it ended.
    // Leaving the user on a page for an object that no longer exists shows
    // them a "not found" screen, so send them home first.
    if (locationRef.current.pathname.startsWith('/object/')) navigate('/');
  }, [queryClient, navigate]);

  /**
   * Get onto the route a step needs. Returns true when a navigation was
   * kicked off (and the caller should not also advance the index); false when
   * the step's route is already the current one.
   */
  const ensureRouteForStep = useCallback(
    (idx: number, currentPathname: string): boolean => {
      const s = ALL_TOUR_STEPS[idx];
      // A routeless step (sync, processed, done — anchored wherever the user
      // already is) has no page to navigate to. stepMatchesRoute() always
      // returns false for these, so without this check the code below would
      // call navigate(undefined) — a real, previously-unnoticed bug (surfaced
      // as a console "Cannot read properties of undefined (reading
      // 'pathname')" while writing the tour's e2e regression suite).
      if (!s || !s.route) return false;
      if (stepMatchesRoute(s, currentPathname)) return false;
      setPendingRoute(s.route);
      navigate(s.route);
      return true;
    },
    [navigate],
  );

  const next = useCallback(() => {
    if (stepIndex >= ALL_TOUR_STEPS.length - 1) {
      stop();
      return;
    }
    const idx = stepIndex + 1;
    const pathname = locationRef.current.pathname;

    // Advance immediately; the overlay waits for the anchor while the route
    // (if any) settles underneath.
    setStepIndex(idx);

    // Special case: the processed-images anchor lives on a real object page,
    // so we need to open an actual object rather than navigate to a route.
    if (ALL_TOUR_STEPS[idx].grabFirstObject) {
      const cards = Array.from(
        document.querySelectorAll<HTMLAnchorElement>('a[href^="/object/"]'),
      );
      const href = cards
        .map(a => a.getAttribute('href'))
        .find(h => !!h && !h.startsWith('/object/undefined'));
      if (href) {
        setPendingRoute(href);
        navigate(href);
        return;
      }
      // No object links on this page (the planner has none). Ask the library
      // for its first object so the step still lands on a real, populated
      // page instead of a placeholder.
      getLibraryObjects()
        .then(objects => {
          const first = objects.find(o => o.id)?.id;
          if (first) {
            const target = `/object/${encodeURIComponent(first)}`;
            setPendingRoute(target);
            navigate(target);
          } else {
            setPendingRoute('/');
            navigate('/');
          }
        })
        .catch(() => {
          // Library unreachable: park on the library and keep walking; the
          // step will show its no-anchor fallback card there.
          setPendingRoute('/');
          navigate('/');
        });
      return;
    }

    ensureRouteForStep(idx, pathname);
  }, [stepIndex, stop, ensureRouteForStep, navigate]);

  const back = useCallback(() => {
    if (stepIndex === 0) return;
    const idx = stepIndex - 1;
    const pathname = locationRef.current.pathname;
    setStepIndex(idx);
    ensureRouteForStep(idx, pathname);
  }, [stepIndex, ensureRouteForStep]);

  // If the user clicks around mid-tour, park them on the step that matches
  // the new route so the highlight always means something.
  useEffect(() => {
    if (!active || transitioningRef.current) return;
    const pathname = location.pathname;
    const current = ALL_TOUR_STEPS[stepIndex];
    // A routeless step (welcome, sync, processed, done — anchored to
    // whatever page is already open rather than a specific one) belongs to
    // no page, so it can never be "wrong" for the current route and must be
    // exempt from relocation. Without this, starting the tour while already
    // on Library (`/`) — exactly what happens right after onboarding on a
    // fresh install — immediately relocates away from the just-started
    // welcome card to whichever step's route happens to be `/` (Library),
    // since stepMatchesRoute() always returns false for a routeless step.
    if ((current && stepMatchesRoute(current, pathname)) || current?.grabFirstObject || !current?.route) return;

    const idx = ALL_TOUR_STEPS.findIndex(s => stepMatchesRoute(s, pathname));
    if (idx >= 0 && idx !== stepIndex) setStepIndex(idx);
  }, [active, location.pathname, stepIndex]);

  // Esc / arrow keys only while the tour is open.
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        stop();
      } else if (e.key === 'ArrowRight') {
        next();
      } else if (e.key === 'ArrowLeft') {
        back();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, next, back, stop]);

  const value = useMemo<TourContextValue>(
    () => ({
      active,
      stepIndex,
      step,
      stepCount: ALL_TOUR_STEPS.length,
      transitioning,
      start,
      stop,
      next,
      back,
      stepList: ALL_TOUR_STEPS,
    }),
    [active, stepIndex, step, transitioning, start, stop, next, back],
  );

  return (
    <TourContext.Provider value={value}>
      {children}
    </TourContext.Provider>
  );
}
