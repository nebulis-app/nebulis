/**
 * Which pack tier carries which object, by canonical id.
 *
 * The published packs listed objects by the id their own scraper used, so one
 * object could sit in several tiers under different spellings (the Heart Nebula
 * as IC1805 in popular and Sh2-190 in sharpless) with different pictures, and
 * the installer, which folds every file onto the canonical id, wrote one over
 * the other. Here every id is folded first and each canonical id has exactly one
 * owning tier, the earliest in CATALOG_TIERS that lists it.
 */
import { CATALOG_TIERS, type CatalogTier } from './manifest.js';
import { resolveCanonicalId } from '../catalogAliases.js';
import { POPULAR_DSO_IDS } from '../popularDsoCatalog.js';
import { EXTENDED_DSO_IDS } from '../extendedDsoCatalog.js';
import { SOLAR_SYSTEM_CATALOG } from '../../data/solar-system-catalog.js';
import { DSO_RECORDS } from '../dsoCatalogData.js';

const MESSIER_TOTAL = 110;
const CALDWELL_TOTAL = 109;

/** Every object a tier is meant to carry, as canonical ids, in a stable order. */
export function listTierMembers(): Record<CatalogTier, string[]> {
  const canon = (ids: Iterable<string>): string[] => [...new Set([...ids].map(id => resolveCanonicalId(id)))];
  const solar = SOLAR_SYSTEM_CATALOG.map(e => e.id);
  return {
    messier: canon(Array.from({ length: MESSIER_TOTAL }, (_, i) => `M${i + 1}`)),
    caldwell: canon(Array.from({ length: CALDWELL_TOTAL }, (_, i) => `C${i + 1}`)),
    popular: canon([...POPULAR_DSO_IDS, ...solar]),
    extended: canon([...EXTENDED_DSO_IDS, ...solar]),
    sharpless: canon(DSO_RECORDS.flatMap(r => r.designations.filter(d => /^SH2-\d+$/.test(d)))),
  };
}

let members: Record<CatalogTier, string[]> | null = null;
let owners: Map<string, CatalogTier> | null = null;

/** The one tier that carries this canonical id, or null when no tier lists it. */
export function ownerTier(canonicalId: string): CatalogTier | null {
  if (!owners) {
    members = listTierMembers();
    owners = new Map();
    for (const tier of CATALOG_TIERS) for (const id of members[tier]) if (!owners.has(id)) owners.set(id, tier);
  }
  return owners.get(canonicalId) ?? null;
}

/** The objects a tier owns: its members minus anything an earlier tier carries. */
export function ownedMembers(tier: CatalogTier): string[] {
  const all = listTierMembers()[tier];
  return all.filter(id => ownerTier(id) === tier);
}
