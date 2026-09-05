/**
 * Editorial metadata for the observing programs Nebulis tracks.
 *
 * Shared by the Catalogs hub (poster panels) and the per-catalog board
 * (hero banner) so a catalog reads the same way wherever it appears.
 */

export interface CatalogMeta {
  id: string;
  label: string;
  /** Year and author line shown above the title. */
  credit: string;
  total: number;
  /** One short sentence. Used on the board hero, where space is tight. */
  tagline: string;
  /** Two or three sentences explaining what the program is and who it suits. */
  blurb: string;
  /**
   * Hero object candidates, tried in order. Later entries cover the case
   * where the first object has no cached master and the live DSS2 fetch
   * fails (offline, or a cold cache with no network).
   */
  heroIds: string[];
}

export const CATALOG_LIST: CatalogMeta[] = [
  {
    id: 'messier',
    label: 'Messier',
    credit: '1774 · Charles Messier',
    total: 110,
    tagline: '110 bright showpieces logged by a comet hunter who kept mistaking them for comets.',
    blurb: 'Messier logged these 110 fuzzy patches while hunting comets, so he would stop mistaking them for new ones. Every entry is bright enough for a small telescope, which makes this the list most imagers finish first.',
    heroIds: ['M42', 'M31', 'M8', 'M51'],
  },
  {
    id: 'caldwell',
    label: 'Caldwell',
    credit: '1995 · Patrick Moore',
    total: 109,
    tagline: '109 showpieces Messier left out, ordered by declination and reaching deep south.',
    blurb: 'Patrick Moore picked 109 bright showpieces that Messier left out, ordered by declination and reaching deep into the southern sky. Expect targets the Messier list misses, including the Veil, the Helix, and the Double Cluster.',
    heroIds: ['C33', 'C63', 'C14', 'C49'],
  },
  {
    id: 'herschel400',
    label: 'Herschel 400',
    credit: '1980 · Astronomical League',
    total: 400,
    tagline: '400 fainter objects from William Herschel\'s own sweeps. The natural step after Messier.',
    blurb: '400 objects drawn from William Herschel\'s own sweeps of the sky, chosen as the natural challenge after Messier. Fainter, smaller, and mostly galaxies, so it rewards long integration and dark skies.',
    heroIds: ['NGC891', 'NGC7331', 'NGC2903', 'NGC253'],
  },
  {
    id: 'sharpless',
    label: 'Sharpless',
    credit: '1959 · Stewart Sharpless',
    total: 313,
    tagline: '313 clouds of glowing hydrogen, the emission nebulae behind many of the sky\'s familiar names.',
    blurb: 'Stewart Sharpless catalogued 313 HII regions from the National Geographic sky survey plates. These are the hydrogen-alpha clouds narrowband imagers chase: large, faint, and full of structure. Some carry familiar names like the Cave, the Wizard, and the Pacman, but plenty are unnamed fields waiting for a long exposure.',
    heroIds: ['Sh2-171', 'Sh2-220', 'Sh2-142', 'Sh2-184'],
  },
];

const BY_ID = new Map(CATALOG_LIST.map(c => [c.id, c]));

/** Metadata for a catalog slug, or undefined for a catalog we have no story for. */
export function getCatalogMeta(id: string): CatalogMeta | undefined {
  return BY_ID.get(id);
}
