/**
 * Product-tour step definitions.
 *
 * A step anchors to a real DOM element via `anchorKey`, emitted by
 * `<TourAnchor id="...">` wrappers around the UI. When a step's `route` does
 * not match the current one, `next()` navigates there first and the overlay
 * waits for the anchor to mount before drawing its spotlight.
 *
 * Editing rules:
 *  1. Every `anchorKey` must match a `<TourAnchor id>` in the tree.
 *  2. A step with `route` must render its anchor on that route.
 *  3. Its words live in `src/locales/<lang>/tour.json` under `steps.<id>`: title, body and an optional hint.
 */

export type TourStepId =
  | 'welcome'
  | 'library'
  | 'telescopes'
  | 'sync'
  | 'planner'
  | 'processed'
  | 'explore'
  | 'catalogs'
  | 'gallery'
  | 'observations'
  | 'settings'
  | 'done';

export interface TourPlacement {
  side: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
}

export interface TourStep {
  id: TourStepId;
  /** DOM anchor emitted by `<TourAnchor id="...">`. */
  anchorKey: string;
  /** Route the step runs on; navigating between steps is handled for you. */
  route?: string;
  /** Route pathname only (ignore search params) when checking the match. */
  pathOnly?: boolean;
  placement: TourPlacement;
  /** Icon shown in the card header. */
  icon?: TourIconName;
  /**
   * `next()` must open a real object page for this step rather than using a
   * static route, because the anchor lives on `/object/:id`.
   */
  grabFirstObject?: boolean;
}

export type TourIconName =
  | 'sparkles'
  | 'library'
  | 'telescope'
  | 'crosshair'
  | 'catalogs'
  | 'gallery'
  | 'observations'
  | 'settings'
  | 'compass';

// The sequence for one complete walk-through. `welcome` is injected below in a
// provider-owned constant, so it is intentionally absent from this list.
const TOUR_STEPS: TourStep[] = [
  {
    id: 'library',
    anchorKey: 'library',
    route: '/',
    placement: { side: 'bottom', align: 'start' },
    icon: 'library',
  },
  {
    id: 'telescopes',
    anchorKey: 'settings-nav-hardware',
    route: '/settings',
    placement: { side: 'right', align: 'center' },
    icon: 'telescope',
  },
  {
    id: 'sync',
    anchorKey: 'top-nav-sync',
    placement: { side: 'bottom', align: 'end' },
    icon: 'sparkles',
  },
  {
    id: 'planner',
    anchorKey: 'planner',
    route: '/planner',
    placement: { side: 'bottom', align: 'start' },
    icon: 'crosshair',
  },
  {
    id: 'processed',
    anchorKey: 'object-processed',
    placement: { side: 'top', align: 'center' },
    icon: 'catalogs',
    grabFirstObject: true,
  },
  {
    id: 'explore',
    anchorKey: 'explore',
    route: '/explore',
    placement: { side: 'bottom', align: 'start' },
    icon: 'compass',
  },
  {
    id: 'catalogs',
    anchorKey: 'catalogs',
    route: '/catalogs',
    placement: { side: 'bottom', align: 'start' },
    icon: 'catalogs',
  },
  {
    id: 'gallery',
    anchorKey: 'gallery',
    route: '/image-gallery',
    placement: { side: 'bottom', align: 'start' },
    icon: 'gallery',
  },
  {
    id: 'observations',
    anchorKey: 'observations',
    route: '/observations',
    placement: { side: 'bottom', align: 'start' },
    icon: 'observations',
  },
  {
    id: 'settings',
    anchorKey: 'settings-nav-general',
    route: '/settings',
    placement: { side: 'right', align: 'center' },
    icon: 'settings',
  },
  {
    id: 'done',
    anchorKey: 'nav-help',
    placement: { side: 'bottom', align: 'end' },
    icon: 'sparkles',
  },
];

/** Welcome card: never anchored, so it needs no route or DOM element. */
export const WELCOME_STEP: TourStep = {
  id: 'welcome',
  anchorKey: 'welcome',
  placement: { side: 'bottom', align: 'start' },
  icon: 'sparkles',
};

/** The sequence for one complete walk-through, welcome card included. */
export const ALL_TOUR_STEPS: TourStep[] = [WELCOME_STEP, ...TOUR_STEPS];

/** Whether a step's route matches a pathname. "/" must match exactly. */
export function stepMatchesRoute(s: TourStep, pathname: string): boolean {
  if (!s.route) return false;
  if (s.route === '/') return pathname === '/';
  return s.pathOnly ? pathname === s.route : pathname.startsWith(s.route);
}
