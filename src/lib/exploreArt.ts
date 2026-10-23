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
import type { ExploreCategoryId } from './api/explore';
import sombreroGalaxy from '../assets/explore/sombrero-galaxy.webp';
import antennaeGalaxies from '../assets/explore/antennae-galaxies.webp';

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
