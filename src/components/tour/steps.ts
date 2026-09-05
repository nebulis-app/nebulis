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
 */

export type TourStepId =
  | 'welcome'
  | 'library'
  | 'telescopes'
  | 'sync'
  | 'planner'
  | 'processed'
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
  title: string;
  body: string;
  /** Optional secondary hint line below the body. */
  hint?: string;
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
export const TOUR_STEPS: TourStep[] = [
  {
    id: 'library',
    anchorKey: 'library',
    route: '/',
    placement: { side: 'bottom', align: 'start' },
    icon: 'library',
    title: 'Your library, front and center',
    body: 'This is home base. Every object you have imaged lives here as a card with its best picture, the number of nights you captured it, and the telescope it came from.',
    hint: 'Use search, the favorites chip, and the type filters to find anything in seconds.',
  },
  {
    id: 'telescopes',
    anchorKey: 'settings-nav-hardware',
    route: '/settings',
    placement: { side: 'right', align: 'center' },
    icon: 'telescope',
    title: 'Point it at your telescope',
    body: "This is the Telescopes tab. Click 'Add smart telescope', pick your model, and enter its address. The share name and defaults fill in on their own.",
    hint: 'You do not need to import immediately - but this is the step that unlocks automatic nightly imports.',
  },
  {
    id: 'sync',
    anchorKey: 'top-nav-sync',
    placement: { side: 'bottom', align: 'end' },
    icon: 'sparkles',
    title: 'Sync your telescope',
    body: 'Once a telescope is set up, open this pill in the top bar and hit Sync. It copies new sessions over Wi-Fi (or USB) and files them into your library automatically.',
    hint: 'Auto-import is on by default for each telescope you add, so new sessions usually show up on their own.',
  },
  {
    id: 'planner',
    anchorKey: 'planner',
    route: '/planner',
    placement: { side: 'bottom', align: 'start' },
    icon: 'crosshair',
    title: 'Plan the night before it starts',
    body: "The Planner answers 'is tonight worth going out?' and then lets you schedule what to shoot when. Pick a night, drag targets into the timeline, and look for the blocks Nebulis marks green.",
    hint: 'Green means fully visible, amber partly visible, and red blocked by your own sky.',
  },
  {
    id: 'processed',
    anchorKey: 'object-processed',
    placement: { side: 'top', align: 'center' },
    icon: 'catalogs',
    title: 'Your finished images',
    body: "This is where your finished work lands. Open any object to see its 'Processed Images' rollup above the session list, or an individual observation to upload a new one with 'Add processed image'.",
    hint: 'Any processed image can be starred to become the object\'s cover picture in the library.',
    grabFirstObject: true,
  },
  {
    id: 'catalogs',
    anchorKey: 'catalogs',
    route: '/catalogs',
    placement: { side: 'bottom', align: 'start' },
    icon: 'compass',
    title: 'Discover what to shoot next',
    body: 'Catalogs is the observing atlas: Messier, NGC, IC, Sharpless and Caldwell, each with images, positions, sizes and descriptions. Search a target, open it, and tap Plan Tonight.',
  },
  {
    id: 'gallery',
    anchorKey: 'gallery',
    route: '/image-gallery',
    placement: { side: 'bottom', align: 'start' },
    icon: 'gallery',
    title: 'Show it off',
    body: 'The Gallery turns your processed images into a full-screen slideshow you can run on a TV. Open it and press play for a clean, automatic show of your best work.',
  },
  {
    id: 'observations',
    anchorKey: 'observations',
    route: '/observations',
    placement: { side: 'bottom', align: 'start' },
    icon: 'observations',
    title: 'Every night, on a calendar',
    body: 'Observations is your log. It shows each session by date with the object, telescope, and whether it has a finished image, plus a world map of where you have set up.',
  },
  {
    id: 'settings',
    anchorKey: 'settings-nav-general',
    route: '/settings',
    placement: { side: 'right', align: 'center' },
    icon: 'settings',
    title: 'Make it yours',
    body: 'Settings is deeper than the telescope page: observing site, storage location, processing library, catalogs, connected phones and TVs, and a full system log. Poke around when you are ready.',
  },
  {
    id: 'done',
    anchorKey: 'nav-help',
    placement: { side: 'bottom', align: 'end' },
    icon: 'sparkles',
    title: 'You are ready',
    body: 'That is the whole loop: connect one telescope, let the imports run, plan clear nights in the Planner, and enjoy the finished images in the Gallery.',
    hint: 'Lost later? The Help page has written guides with screenshots, and this tour is always one click away.',
  },
];

/** Welcome card: never anchored, so it needs no route or DOM element. */
export const WELCOME_STEP: TourStep = {
  id: 'welcome',
  anchorKey: 'welcome',
  placement: { side: 'bottom', align: 'start' },
  icon: 'sparkles',
  title: 'Meet Nebulis',
  body: 'A quick tour of your observatory: the library, your telescope, planning a night, and your finished images. A few minutes.',
  hint: 'Tap Next to start. You can leave and restart anytime from Help.',
};

/** The sequence for one complete walk-through, welcome card included. */
export const ALL_TOUR_STEPS: TourStep[] = [WELCOME_STEP, ...TOUR_STEPS];

/** A route may match several steps (e.g. /settings); prefer the first. */
export function findStep(route: string): TourStep | undefined {
  return TOUR_STEPS.find(s => stepMatchesRoute(s, route));
}

/** Whether a step's route matches a pathname. "/" must match exactly. */
export function stepMatchesRoute(s: TourStep, pathname: string): boolean {
  if (!s.route) return false;
  if (s.route === '/') return pathname === '/';
  return s.pathOnly ? pathname === s.route : pathname.startsWith(s.route);
}
