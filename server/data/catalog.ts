import type { CatalogEntry } from '../lib/types/catalog.js';
export type { CatalogEntry };
import { SOLAR_SYSTEM_MAP } from './solar-system-catalog.js';
import { isRecord } from '../lib/typeGuards.js';

// ─── Curated catalog (with descriptions) ────────────────────────────
// Hand-maintained. Add an object by appending an entry to catalog-curated.json:
// { id, name, type, constellation, description, ra, dec, distanceLy?,
//   magnitude?, majorAxisArcmin?, wikiUrl? }. Coordinates are sexagesimal
// strings ("02h 26m 32s" / "+62° 02′ 30″") or decimal (RA in hours).
import curatedJson from './catalog-curated.json';

/** Runtime validator matching CatalogEntry's required (non-optional) fields. */
function isCatalogEntry(value: unknown): value is CatalogEntry {
  if (!isRecord(value)) return false;
  const v = value;
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.type === 'string' &&
    typeof v.constellation === 'string' &&
    typeof v.description === 'string'
  );
}

function parseCuratedJson(data: unknown): CatalogEntry[] {
  if (!Array.isArray(data)) {
    throw new Error('[catalog] catalog-curated.json: expected top-level array');
  }
  const entries = data.filter(isCatalogEntry);
  if (entries.length < data.length) {
    console.warn(`[catalog] catalog-curated.json: dropped ${data.length - entries.length} entr(ies) missing required fields`);
  }
  return entries;
}

const catalog: CatalogEntry[] = parseCuratedJson(curatedJson);
const curatedMap = new Map(catalog.map(e => [e.id.toUpperCase(), e]));

// ─── OpenNGC: comprehensive catalog of 12,000+ NGC/IC/Messier objects ──
// Source: https://github.com/mattiaverga/OpenNGC (CC BY-SA 4.0)
// Imported once as static JSON — no API calls needed.

// Inlined at bundle time by tsup/esbuild — no runtime file access needed.
import openNgcJson from './openngc.json';
import { caldwellToNgcId } from '../lib/caldwellCatalog.js';
import { mergeOverride, entryFromOverride } from '../lib/catalogOverrides.js';
import { getAliasesFor, expandSearchAliases, normalizeDesignation, resolveCanonicalId } from '../lib/catalogAliases.js';
import { getCuratedRecord } from '../lib/catalogStore.js';
import { getSharplessEntry, sharplessToCatalogEntry } from '../lib/sharplessCatalog.js';

interface OpenNGCEntry {
  id: string;
  type: string;
  // Not required at the type level: isOpenNGCEntry only checks id/type, and
  // every read site already falls back defensively (`?? ''` / truthiness),
  // so the type shouldn't claim a guarantee the validator doesn't enforce.
  constellation?: string | null;
  messier?: number | string | null;
  magnitude?: number | null;
  name?: string;
  ra?: number | string | null;
  dec?: number | string | null;
  ngcName?: string;
  typeCode?: string;
  majorAxisArcmin?: number | null;
  commonNames?: string[];
}

/**
 * Runtime validator for OpenNGC entries — matches the minimum shape this
 * module reads out of the bundled JSON. Loose on optional fields (the
 * catalog file has many nullable/missing fields), strict on the required
 * `id` and `type` that every lookup depends on.
 */
function isOpenNGCEntry(value: unknown): value is OpenNGCEntry {
  return isRecord(value) && typeof value.id === 'string' && typeof value.type === 'string';
}

function parseOpenNgcJson(data: unknown): OpenNGCEntry[] {
  if (!Array.isArray(data)) {
    throw new Error('[catalog] openngc.json: expected top-level array');
  }
  // Filter (not spot-check) so a malformed bundle surfaces at boot, not on
  // the first lookup, and any individual bad rows don't ride along mistyped.
  const entries = data.filter(isOpenNGCEntry);
  if (data.length > 0 && entries.length === 0) {
    throw new Error('[catalog] openngc.json: no entries matched the expected shape');
  }
  if (entries.length < data.length) {
    console.warn(`[catalog] openngc.json: dropped ${data.length - entries.length} entr(ies) missing required id/type strings`);
  }
  return entries;
}

const openNgcData: OpenNGCEntry[] = parseOpenNgcJson(openNgcJson);

// Build lookup maps: by ID, by Messier designation, by NGC cross-reference
// name, and by "duplicate observation" common name (the historical NGC
// catalog recorded the same physical object twice under two numbers for
// some entries — e.g. NGC2527 is Herschel-400's id for what OpenNGC treats
// as a duplicate of NGC2520 — and OpenNGC records the second number in
// commonNames rather than giving it its own row).
const openNgcMap = new Map<string, OpenNGCEntry>();
const messierToNgc = new Map<string, OpenNGCEntry>();
const ngcNameToEntry = new Map<string, OpenNGCEntry>();
const commonNameToEntry = new Map<string, OpenNGCEntry>();

for (const entry of openNgcData) {
  openNgcMap.set(entry.id.toUpperCase(), entry);
  if (entry.messier != null) {
    messierToNgc.set(`M${entry.messier}`.toUpperCase(), entry);
  }
  if (entry.ngcName) {
    ngcNameToEntry.set(entry.ngcName.toUpperCase(), entry);
  }
  for (const alias of entry.commonNames ?? []) {
    if (/^(NGC|IC)\d+$/i.test(alias)) commonNameToEntry.set(alias.toUpperCase(), entry);
  }
}

console.log(`[catalog] Loaded ${openNgcData.length} OpenNGC entries, ${messierToNgc.size} Messier cross-references`);

/**
 * Static-data lookup chain for a catalog entry. Internal helper — public
 * callers should use getCatalogEntry, which wraps this with user overrides.
 *
 * Recursing into this function (not into getCatalogEntry) for the Caldwell
 * alias step keeps override application a single, top-level concern: the
 * override for the requested id is the only one that ever applies, even if
 * an override also happens to exist for the underlying NGC backing the alias.
 */
function lookupCatalogEntry(id: string): CatalogEntry | undefined {
  const key = id.toUpperCase().replace(/\s+/g, '');

  // 0. Solar system objects (Moon, planets, named moons, etc.)
  const solarEntry = SOLAR_SYSTEM_MAP.get(key);
  if (solarEntry) return solarEntry;

  // 1. Curated entry (has description, hand-picked data). curatedMap is keyed
  //    by the canonical id, so a designation that resolves elsewhere (M102 is
  //    keyed under NGC5866) is tried through resolveCanonicalId too. The
  //    requested id is handed back so a caller asking "M102" gets "M102".
  const curated = curatedMap.get(key);
  if (curated) return curated;
  const canonicalKey = resolveCanonicalId(key).toUpperCase().replace(/\s+/g, '');
  if (canonicalKey !== key) {
    const viaCanonical = curatedMap.get(canonicalKey);
    if (viaCanonical) return { ...viaCanonical, id };
  }

  // 1b. Caldwell C-number (e.g. "C21") → resolve to NGC/IC id first
  const ngcAlias = caldwellToNgcId(key);
  if (ngcAlias) {
    const aliasKey = ngcAlias.toUpperCase().replace(/\s+/g, '');
    const aliasEntry = lookupCatalogEntry(aliasKey);
    if (aliasEntry) {
      // Return the entry with the Caldwell id so callers get back "C21" not "NGC4449"
      return { ...aliasEntry, id };
    }
    return undefined;
  }

  // 2. OpenNGC lookup by direct ID (NGC1234, IC567)
  let ngc = openNgcMap.get(key);

  // Zero-padded form (NGC925 -> NGC0925): OpenNGC's own `ngcName`/`commonNames`
  // fields are stored zero-padded to 4 digits, so every fallback below needs
  // both the raw and padded key, not just the direct openNgcMap.get(key) above.
  const padMatch = key.match(/^(NGC|IC)(\d{1,3})$/);
  const paddedKey = padMatch ? `${padMatch[1]}${padMatch[2].padStart(4, '0')}` : null;

  // 2b. Zero-pad NGC/IC numbers to 4 digits (NGC925 -> NGC0925)
  if (!ngc && paddedKey) {
    ngc = openNgcMap.get(paddedKey);
  }

  // 2c. NGC/IC cross-reference (e.g. "NGC2548"): for Messier objects, the
  // OpenNGC row is keyed by id "M48" in openNgcMap, not "NGC2548" — only
  // ngcNameToEntry indexes the NGC/IC designation itself. Without this, any
  // Herschel-400-style list that enumerates objects by their NGC number
  // (rather than M-number) fails to resolve for every NGC id that has a
  // Messier alias, falling back to "Unknown" type and no description.
  if (!ngc) {
    ngc = ngcNameToEntry.get(key) ?? (paddedKey ? ngcNameToEntry.get(paddedKey) : undefined);
  }

  // 2d. Duplicate-observation NGC/IC number (e.g. "NGC2527" -> the NGC2520
  // row that OpenNGC treats as the same object). See comment on
  // commonNameToEntry above.
  if (!ngc) {
    ngc = commonNameToEntry.get(key) ?? (paddedKey ? commonNameToEntry.get(paddedKey) : undefined);
  }

  // 3. Messier lookup (M31 -> NGC224)
  if (!ngc && key.startsWith('M')) {
    ngc = messierToNgc.get(key);
  }

  if (ngc) {
    return {
      id: ngc.messier != null ? `M ${ngc.messier}` : ngc.id,
      name: ngc.name ?? (ngc.messier != null ? `M ${ngc.messier}` : ngc.id),
      type: ngc.type,
      constellation: ngc.constellation ?? '',
      magnitude: ngc.magnitude ?? undefined,
      description: '',
      ra: ngc.ra != null ? String(ngc.ra) : undefined,
      dec: ngc.dec != null ? String(ngc.dec) : undefined,
    };
  }

  // 4. Sharpless catalog (Sh2-N emission nebulae)
  const sharpless = getSharplessEntry(key);
  if (sharpless) return sharplessToCatalogEntry(sharpless, id);

  return undefined;
}

/**
 * Get a catalog entry by ID. Checks curated entries first (which have
 * descriptions), then falls back to the comprehensive OpenNGC database.
 *
 * User overrides (catalogOverrides table) are layered on top: any non-null
 * override field wins over the static source. If no static entry exists but
 * an override row does, a synthetic entry is returned — this is how users
 * add objects the bundled catalogs don't know about.
 */
export function getCatalogEntry(id: string): CatalogEntry | undefined {
  const base = lookupCatalogEntry(id);
  if (base) return mergeOverride(base, id);
  return entryFromOverride(id);
}

export function searchCatalog(query: string): CatalogEntry[] {
  // Word-tokenized AND match, not whole-phrase substring: a query like "Eta
  // Carina" must match "eta" and "carina" independently across the
  // searchable text, since real object data splits them across fields
  // (NGC 3372's name is "Carina Nebula", "Eta" only appears in its OpenNGC
  // commonNames as the abbreviated "eta Car Nebula") rather than ever
  // containing the literal typed phrase.
  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const matchesAllWords = (haystack: string): boolean => words.every(w => haystack.includes(w));

  // Designation-aware matching: "C5", "Caldwell 5" or "NGC 7331" resolve to the
  // canonical object even though those exact strings never appear in its text.
  const norm = (v: string): string => normalizeDesignation(v).toUpperCase().replace(/\s+/g, '');
  const rawKey = norm(query);
  const aliasIds = new Set(expandSearchAliases(query.trim()).map(norm).filter(t => t && t !== rawKey));

  /** 0 = no match; higher = more relevant. Designation hits outrank text hits
   *  so "C5" lists IC342 first, not every id that merely contains "c5". */
  const scoreOf = (
    ids: Array<string | number | null | undefined>,
    name: string,
    haystack: string,
  ): number => {
    const idSet = ids
      .filter((v): v is string | number => v != null && String(v) !== '')
      .map(v => norm(String(v)));
    if (idSet.includes(rawKey)) return 100;
    if (idSet.some(id => aliasIds.has(id))) return 90;
    const nameLower = name.toLowerCase();
    if (nameLower === q) return 85;
    if (words.length === 1 && (nameLower.startsWith(q) || idSet.some(id => id.toLowerCase().startsWith(q)))) return 70;
    if (matchesAllWords(haystack)) return 40;
    return 0;
  };

  const scored: Array<{ entry: CatalogEntry; score: number }> = [];
  const seen = new Set<string>();

  // Curated first so it wins score ties (stable sort).
  for (const e of catalog) {
    const aka = getAlsoKnownAs(e.id);
    const haystack = [e.id, e.name, e.constellation, e.type, ...aka].join(' ').toLowerCase();
    const score = scoreOf([e.id, ...aka], e.name, haystack);
    if (score > 0) {
      scored.push({ entry: e, score });
      seen.add(e.id.toUpperCase());
    }
  }

  for (const ngc of openNgcData) {
    const messierStr = ngc.messier != null ? String(ngc.messier) : null;
    const matchId = (messierStr ?? ngc.id).toUpperCase();
    if (seen.has(matchId)) continue;
    const haystack = [ngc.id, messierStr, ngc.name, ngc.constellation, ngc.type, ...(ngc.commonNames ?? [])]
      .filter((v): v is string => Boolean(v))
      .join(' ')
      .toLowerCase();
    const score = scoreOf(
      [ngc.id, ngc.ngcName, messierStr != null ? `M${messierStr}` : null, ...(ngc.commonNames ?? [])],
      ngc.name ?? '',
      haystack,
    );
    if (score > 0) {
      scored.push({
        entry: {
          id: messierStr ?? ngc.id,
          name: ngc.name ?? messierStr ?? ngc.id,
          type: ngc.type,
          constellation: ngc.constellation ?? '',
          magnitude: ngc.magnitude ?? undefined,
          description: '',
          ra: ngc.ra != null ? String(ngc.ra) : undefined,
          dec: ngc.dec != null ? String(ngc.dec) : undefined,
        },
        score,
      });
      seen.add(matchId);
    }
  }

  return scored.sort((a, b) => b.score - a.score).map(r => r.entry);
}

export function getAllCatalogEntries(): CatalogEntry[] {
  return catalog;
}

/** Catalog-number pattern — strings matching these are alternate designations,
 *  not human-readable common names, so they go in the AKA list separately. */
const CATALOG_ID_RE = /^(NGC|IC|M|UGC|PGC|B|SH2-|LBN|LDN)\s*\d+$/i;

/** Common names for objects that have no OpenNGC entry (mostly Sharpless nebulae). */
const MANUAL_COMMON_NAMES: Record<string, string[]> = {
  'B33':     ['Horsehead Nebula'],
  'SH2-101': ['Tulip Nebula'],
  'SH2-129': ['Flying Bat Nebula'],
  'SH2-155': ['Cave Nebula'],
  'SH2-240': ['Spaghetti Nebula', 'Simeis 147'],
};

/**
 * Build the "Also known as" list for an object: NGC cross-references,
 * Messier numbers, Caldwell designations, Sharpless designations, and
 * any common names stored in OpenNGC.
 */
export function getAlsoKnownAs(id: string): string[] {
  const key = id.toUpperCase().replace(/\s+/g, '');
  const names: string[] = [];

  // Look up the OpenNGC entry — either directly (M# ids are stored under "M101" etc.)
  // or via the ngcName reverse map (NGC5457 → find M101's entry).
  const entry = openNgcMap.get(key) ?? ngcNameToEntry.get(key);

  if (entry) {
    // Always include NGC/IC cross-reference (ngcName) and Messier number when present,
    // regardless of which ID was used for the lookup. This ensures M51's AKA includes
    // "NGC5194" AND "M51" itself, matching the behaviour of NGC-primary objects whose
    // self-referential ngcName already causes them to appear in their own AKA list.
    if (entry.ngcName && !names.includes(entry.ngcName)) {
      names.push(entry.ngcName);
    }
    if (entry.messier != null) {
      const mStr = `M${entry.messier}`;
      if (!names.includes(mStr)) names.push(mStr);
    }
    // Common names from OpenNGC — skip strings that are really catalog IDs
    for (const cn of entry.commonNames ?? []) {
      if (cn && !CATALOG_ID_RE.test(cn) && !names.includes(cn)) names.push(cn);
    }
    // Catalog-ID-style alternate designations from commonNames (NGC651, etc.)
    for (const cn of entry.commonNames ?? []) {
      if (cn && CATALOG_ID_RE.test(cn) && !names.includes(cn)) names.push(cn);
    }
  }

  // Sharpless designation itself (so "Lion Nebula" lists "Sh2-132" the same way
  // an NGC-primary object lists its own NGC number above).
  const sharpless = getSharplessEntry(key);
  if (sharpless) {
    const shId = sharpless.id.replace(/^SH2-/i, 'Sh2-');
    if (!names.includes(shId)) names.push(shId);
  }

  // Manual common names for objects not in OpenNGC
  for (const cn of MANUAL_COMMON_NAMES[key] ?? []) {
    if (!names.includes(cn)) names.push(cn);
  }

  // Caldwell and Sharpless designations via reverse alias map
  for (const alias of getAliasesFor(id)) {
    if (!names.includes(alias)) names.push(alias);
  }

  // Curated record designations and common name, so the curated file is the
  // one place to add an "also known as" (replacing the old MANUAL_COMMON_NAMES
  // drift point). Normalised designations are formatted back to display form.
  const record = getCuratedRecord(id);
  if (record) {
    const selfNorm = key.replace(/^(NGC|IC)0*(\d)/, '$1$2');
    for (const d of record.designations) {
      if (d === selfNorm) continue;
      const display = d.startsWith('SH2-') ? `Sh2-${d.slice(4)}` : d;
      if (!names.includes(display)) names.push(display);
    }
    if (record.name && record.name !== record.canonicalId && !names.includes(record.name)) {
      names.push(record.name);
    }
  }

  return names;
}
