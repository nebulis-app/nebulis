/**
 * Where an annotation ring is centred, for the few objects whose catalog position is not the middle of what a
 * person sees.
 *
 * OpenNGC numbers the patches of a big nebula separately, each at its own position and each carrying the whole
 * nebula's size. The Rosette is NGC 2237, 2238, 2239 and 2246: NGC 2238 sits on the north-west edge, so its 80'
 * ring floats beside the wreath. This table moves such an entry to the middle of the object. Only the ring's
 * position changes; the planner, search and every other reader of the catalog keep the catalog's own numbers.
 *
 * The same table is baked into the native clients' copy by `scripts/gen-annotate-catalog.ts`, so connected and
 * standalone modes draw the same ring.
 *
 * Add an entry only after checking it against a plate-solved frame: a catalog position that is merely rough
 * (the Pleiades, the Veils) already lands on the object and is better left alone.
 */
import { getById, getPlannerCatalog, type DsoEntry } from '../dsoCatalog.js';

export interface RingCentre {
  /** Hours, J2000. */
  ra: number;
  /** Degrees, J2000. */
  dec: number;
}

const norm = (id: string): string => id.toUpperCase().replace(/\s+/g, '');

/** Sharpless 2-275's centre, which falls in the Rosette's central hole, a few arcminutes from its visual middle. */
const ROSETTE: RingCentre = { ra: 6.528581, dec: 4.92959 };

/** The California Nebula runs about 2.5 degrees north-east to south-west. OpenNGC puts NGC 1499 on its bright western
 *  head, so the ring covered one end. This is the middle of the whole, read off a plate-solved mosaic that shows all of it. */
const CALIFORNIA: RingCentre = { ra: 4.018, dec: 36.4 };

const CENTRES = new Map<string, RingCentre>([
  ['NGC2237', ROSETTE],
  ['NGC2238', ROSETTE],
  ['NGC1499', CALIFORNIA],
]);

function withCentre(e: DsoEntry): DsoEntry {
  const c = CENTRES.get(norm(e.id));
  return c ? { ...e, ra: c.ra, dec: c.dec } : e;
}

let cached: DsoEntry[] | null = null;

/** The planner catalog with ring centres applied: what annotation reads. */
export function getAnnotationCatalog(): DsoEntry[] {
  if (!cached) cached = getPlannerCatalog().map(withCentre);
  return cached;
}

/** One catalog entry, with its ring centre applied. */
export function getAnnotationEntry(id: string): DsoEntry | undefined {
  const e = getById(id);
  return e ? withCentre(e) : undefined;
}
