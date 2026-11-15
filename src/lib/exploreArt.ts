/**
 * Pictures for Explore's browse tiles, all bundled with the app.
 *
 * Tiles used to show a representative object's picture through the normal
 * catalog image route, which meant a server with no internet and a cold cache
 * rendered plain coloured boxes. These are fixed, fingerprinted assets that
 * ship in the build, so the front page of Explore looks the same offline and
 * after a cache wipe.
 *
 * Six reuse the NASA banners already bundled in heroImagery.ts. The two
 * galaxy tiles are from the NASA Image and Video Library (images.nasa.gov),
 * 960x600 WebP, attention-cropped. Keep the credit line and `nasaId` with any
 * picture added here; take new ones from images.nasa.gov, as heroImagery.ts
 * explains.
 */
import { HERO_IMAGES } from './heroImagery';
import type { ExploreCatalogId, ExploreCategoryId } from './api/explore';
import sombreroGalaxy from '../assets/explore/sombrero-galaxy.webp';
import antennaeGalaxies from '../assets/explore/antennae-galaxies.webp';
import lagoonNebula from '../assets/explore/lagoon-nebula.webp';
import ngc1300 from '../assets/explore/ngc-1300.webp';
import heartAndSoul from '../assets/explore/heart-and-soul.webp';
import helixNebula from '../assets/explore/helix-nebula.webp';
import sharpless140 from '../assets/explore/sharpless-140.webp';

export interface ExploreArt {
  src: string;
  /** What the picture shows, for the tooltip. */
  label: string;
  credit: string;
  /** Item id at images.nasa.gov, so the source record stays findable. */
  nasaId: string;
}

export const EXPLORE_ART: Record<ExploreCategoryId, ExploreArt> = {
  // The Webb "Cosmic Cliffs" is the most striking frame in the set, so it leads.
  showpieces: HERO_IMAGES['cosmic-cliffs'],
  galaxies: {
    src: sombreroGalaxy,
    label: 'The Sombrero Galaxy (M104)',
    credit: 'NASA/ESA and The Hubble Heritage Team (STScI/AURA)',
    nasaId: 'PIA15226',
  },
  'galaxy-groups': {
    src: antennaeGalaxies,
    label: 'The Antennae Galaxies, two galaxies in collision',
    credit: 'NASA, ESA, and the Hubble Heritage Team (STScI/AURA)',
    nasaId: 'GSFC_20171208_Archive_e001327',
  },
  // The Eagle Nebula's Pillars are an emission nebula, so the match is exact.
  'emission-nebulae': HERO_IMAGES['pillars-of-creation'],
  'planetary-nebulae': HERO_IMAGES['southern-ring'],
  'supernova-remnants': HERO_IMAGES['crab-nebula'],
  'dark-reflection': HERO_IMAGES.horsehead,
  clusters: HERO_IMAGES.westerlund,
};

/**
 * Pictures for the catalog tiles. Each shows an object that is really in that catalog, so the picture is a fair
 * example and not decoration: Messier 8, NGC 1300 (an NGC-only object), IC 1805 and IC 1848, Caldwell 63, and the
 * Sharpless 140 cloud. Same source and rules as the kind tiles above: images.nasa.gov, 960x600 WebP, credit and
 * `nasaId` kept here. The Helix is cropped inside GALEX's circular field so a wide tile shows no black corners.
 */
export const CATALOG_ART: Record<ExploreCatalogId, ExploreArt> = {
  messier: {
    src: lagoonNebula,
    label: 'The heart of the Lagoon Nebula (Messier 8)',
    credit: 'NASA, ESA',
    nasaId: 'GSFC_20171208_Archive_e001955',
  },
  ngc: {
    src: ngc1300,
    label: 'The barred spiral galaxy NGC 1300',
    credit: 'NASA, ESA, and The Hubble Heritage Team (STScI/AURA); acknowledgment P. Knezek (WIYN)',
    nasaId: 'GSFC_20171208_Archive_e002154',
  },
  ic: {
    src: heartAndSoul,
    label: 'The Heart and Soul nebulae (IC 1805 and IC 1848), in infrared',
    credit: 'NASA/JPL-Caltech/UCLA',
    nasaId: 'PIA13112',
  },
  caldwell: {
    src: helixNebula,
    label: 'The Helix Nebula (Caldwell 63, NGC 7293), in ultraviolet',
    credit: 'NASA/JPL-Caltech',
    nasaId: 'PIA15658',
  },
  sharpless: {
    src: sharpless140,
    label: 'The Sharpless 140 cloud, in infrared',
    credit: 'NASA/JPL-Caltech',
    nasaId: 'PIA05878',
  },
};
