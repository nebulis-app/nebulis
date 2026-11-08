/**
 * Editorial metadata for the observing programs Nebulis tracks.
 *
 * Shared by the Catalogs hub (poster panels) and the per-catalog board
 * (hero banner) so a catalog reads the same way wherever it appears.
 */

export interface CatalogMeta {
  id: string;
  /** Resolved via t(labelKey, { ns: 'catalogs' }) at the consumer — this
   *  module has no useTranslation() of its own (plain data, not a component). */
  labelKey: string;
  /** Year and author line shown above the title. Left untranslated: it's a
   *  historical date + a person's name, not a sentence. */
  credit: string;
  total: number;
  /** One short sentence. Used on the board hero, where space is tight. */
  taglineKey: string;
  /** Two or three sentences explaining what the program is and who it suits. */
  blurbKey: string;
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
    labelKey: 'catalogMeta.messier.label',
    credit: '1774 · Charles Messier',
    total: 110,
    taglineKey: 'catalogMeta.messier.tagline',
    blurbKey: 'catalogMeta.messier.blurb',
    heroIds: ['M42', 'M31', 'M8', 'M51'],
  },
  {
    id: 'caldwell',
    labelKey: 'catalogMeta.caldwell.label',
    credit: '1995 · Patrick Moore',
    total: 109,
    taglineKey: 'catalogMeta.caldwell.tagline',
    blurbKey: 'catalogMeta.caldwell.blurb',
    heroIds: ['C33', 'C63', 'C14', 'C49'],
  },
  {
    id: 'herschel400',
    labelKey: 'catalogMeta.herschel400.label',
    credit: '1980 · Astronomical League',
    total: 400,
    taglineKey: 'catalogMeta.herschel400.tagline',
    blurbKey: 'catalogMeta.herschel400.blurb',
    heroIds: ['NGC891', 'NGC7331', 'NGC2903', 'NGC253'],
  },
  {
    id: 'sharpless',
    labelKey: 'catalogMeta.sharpless.label',
    credit: '1959 · Stewart Sharpless',
    total: 313,
    taglineKey: 'catalogMeta.sharpless.tagline',
    blurbKey: 'catalogMeta.sharpless.blurb',
    heroIds: ['Sh2-171', 'Sh2-220', 'Sh2-142', 'Sh2-184'],
  },
  {
    id: 'rasc',
    labelKey: 'catalogMeta.rasc.label',
    credit: '1995 · RASC',
    total: 111,
    taglineKey: 'catalogMeta.rasc.tagline',
    blurbKey: 'catalogMeta.rasc.blurb',
    heroIds: ['NGC7009', 'NGC7293', 'NGC7331', 'NGC253'],
  },
  {
    id: 'abell',
    labelKey: 'catalogMeta.abell.label',
    credit: '1966 · George Abell',
    total: 80,
    taglineKey: 'catalogMeta.abell.tagline',
    blurbKey: 'catalogMeta.abell.blurb',
    heroIds: ['Abell21', 'Abell31', 'Abell35', 'Abell39'],
  },
  {
    id: 'berkeley',
    labelKey: 'catalogMeta.berkeley.label',
    credit: '1958 · Lynga & Alter',
    total: 89,
    taglineKey: 'catalogMeta.berkeley.tagline',
    blurbKey: 'catalogMeta.berkeley.blurb',
    heroIds: ['Berkeley59', 'Berkeley17', 'Berkeley62', 'Berkeley1'],
  },
];

const BY_ID = new Map(CATALOG_LIST.map(c => [c.id, c]));

/** Metadata for a catalog slug, or undefined for a catalog we have no story for. */
export function getCatalogMeta(id: string): CatalogMeta | undefined {
  return BY_ID.get(id);
}

/** The catalog number as people write it, for display only. The stored id
 *  stays compact (`ABELL1`, `BERK16`) because it is a lookup key and a wall
 *  override key; the tile and modal show the readable form. */
export function catalogDisplayId(id: string): string {
  const abell = id.match(/^ABELL(\d+)$/i);
  if (abell) return `Abell ${abell[1]}`;
  const berk = id.match(/^BERK(\d+)$/i);
  if (berk) return `Berkeley ${berk[1]}`;
  return id;
}
