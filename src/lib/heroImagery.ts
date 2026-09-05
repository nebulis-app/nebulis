/**
 * Deep-sky artwork bundled with the app, for the page banners.
 *
 * ── Why these are bundled rather than fetched ───────────────────────────────
 * A banner is the first thing on screen, and Nebulis runs on a LAN box that is
 * often offline. Anything fetched at paint time either arrives late or does not
 * arrive, and both look worse than no image. These are a fixed set, imported so
 * Vite fingerprints them and they cache forever.
 *
 * ── Provenance ─────────────────────────────────────────────────────────────
 * Every image here comes from the NASA Image and Video Library
 * (images.nasa.gov). NASA content is generally not copyrighted and may be used
 * without permission; NASA asks that the credit line be carried, which is what
 * `credit` is for and why `nasaId` is kept: it is the item id at
 * images.nasa.gov, so any of these can be traced back to its source record.
 *
 * If you add one, take it from images.nasa.gov (not a random Hubble/ESA
 * mirror). ESA-hosted releases are CC BY rather than public domain, which is a
 * different obligation than the one documented here.
 *
 * Each file is a 1400x820 WebP, cropped with sharp's attention strategy. They
 * render under a heavy scrim at partial opacity, so they do not need to be
 * larger or cleaner than that. Quality 72 is the default target; a source
 * that's dense with small bright detail (a starfield, not a smooth nebula
 * gradient) can need a lower quality setting to stay a reasonable size at the
 * same dimensions, since that kind of noise doesn't compress away.
 *
 * Check what you are cropping. NASA publishes several of these as two-panel
 * instrument comparisons: `southern-ring` was one, and the white divider down
 * the middle of the frame drew a hard vertical line across every banner that
 * used it. It is now the NIRCam panel alone.
 */
import carinaLandscape from '../assets/heroes/carina-landscape.webp';
import cosmicCliffs from '../assets/heroes/cosmic-cliffs.webp';
import horsehead from '../assets/heroes/horsehead.webp';
import mysticMountain from '../assets/heroes/mystic-mountain.webp';
import pillarsOfCreation from '../assets/heroes/pillars-of-creation.webp';
import southernRing from '../assets/heroes/southern-ring.webp';
import westerlund from '../assets/heroes/westerlund.webp';

export interface HeroImage {
  /** Stable key, also what a page names when it picks one. */
  id: HeroImageId;
  src: string;
  /** What the picture is, for the alt text and any credit surface. */
  label: string;
  credit: string;
  /** Item id at images.nasa.gov, so the source record stays findable. */
  nasaId: string;
}

export type HeroImageId =
  | 'pillars-of-creation'
  | 'cosmic-cliffs'
  | 'westerlund'
  | 'carina-landscape'
  | 'mystic-mountain'
  | 'southern-ring'
  | 'horsehead';

export const HERO_IMAGES: Record<HeroImageId, HeroImage> = {
  'pillars-of-creation': {
    id: 'pillars-of-creation',
    src: pillarsOfCreation,
    label: "The Pillars of Creation in the Eagle Nebula, near-infrared",
    credit: 'NASA, ESA, and the Hubble Heritage Team (STScI/AURA)',
    nasaId: 'GSFC_20171208_Archive_e000842',
  },
  'cosmic-cliffs': {
    id: 'cosmic-cliffs',
    src: cosmicCliffs,
    label: 'The Cosmic Cliffs in the Carina Nebula',
    credit: 'NASA, ESA, CSA, STScI',
    nasaId: 'carina_nebula',
  },
  westerlund: {
    id: 'westerlund',
    src: westerlund,
    label: 'The star cluster Westerlund 2',
    credit: 'NASA, ESA, STScI',
    nasaId: 'GSFC_20171208_Archive_e000742',
  },
  'mystic-mountain': {
    id: 'mystic-mountain',
    src: mysticMountain,
    label: 'Mystic Mountain, a pillar in the Carina Nebula',
    credit: 'NASA, ESA, STScI',
    nasaId: 'GSFC_20171208_Archive_e002064',
  },
  'carina-landscape': {
    id: 'carina-landscape',
    src: carinaLandscape,
    label: 'A star-forming pillar in the Carina Nebula',
    credit: 'NASA, ESA, and M. Livio and the Hubble 20th Anniversary Team (STScI)',
    nasaId: 'GSFC_20171208_Archive_e002076',
  },
  'southern-ring': {
    id: 'southern-ring',
    src: southernRing,
    label: 'The Southern Ring Nebula',
    credit: 'NASA, ESA, CSA, STScI',
    nasaId: 'southern_ring_nebula',
  },
  horsehead: {
    id: 'horsehead',
    src: horsehead,
    label: 'The Horsehead Nebula',
    credit: 'NASA, ESA, STScI',
    nasaId: 'GSFC_20171208_Archive_e001518',
  },
};

/**
 * Which banner gets which picture.
 *
 * Fixed per page rather than random, so the app looks the same every time you
 * open it. Two pages sharing one image would read as a mistake, so each of the
 * banners that carries one gets its own.
 */
export const PAGE_HERO: Record<
  'library' | 'gallery' | 'observations' | 'planner' | 'forecast' | 'backup' | 'settings' | 'help' | 'catalogs',
  HeroImage
> = {
  library: HERO_IMAGES['cosmic-cliffs'],
  gallery: HERO_IMAGES['pillars-of-creation'],
  observations: HERO_IMAGES['carina-landscape'],
  planner: HERO_IMAGES['mystic-mountain'],
  forecast: HERO_IMAGES.horsehead,
  backup: HERO_IMAGES['southern-ring'],
  // Westerlund 2 stopped being any page's primary picture once Observations
  // moved to carina-landscape (it was too soft/glowing to hold up at that
  // banner's dimmed 0.34 intensity, see git history). Settings runs at full
  // intensity with no chart overlay to protect, where the same softness is a
  // non-issue, so it gets a second life here rather than sitting unused in
  // PAGE_HERO (it's still referenced directly by ObjectHero's fallback).
  settings: HERO_IMAGES.westerlund,
  // Help reuses horsehead. Every frame already has a primary page and there is
  // no spare artwork to add, so Help borrows the calmest frame: its dark field
  // keeps the long text column under the banner easy to read, and Help sits at
  // the far end of the nav from Forecast so the two never read as a mix-up.
  help: HERO_IMAGES.horsehead,
  // Catalogs reuses southern-ring, same "no spare artwork" situation as Help.
  // Its only other page is Backup, which is not in the top nav (reached from
  // the telescope menu), so the two never sit a click apart. The round
  // planetary nebula also pairs with the progress ring in this banner.
  catalogs: HERO_IMAGES['southern-ring'],
};
