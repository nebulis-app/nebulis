/**
 * DSO catalog — loads the OpenNGC-derived catalog from server/data/openngc.json.
 * Provides search, filtering, and lookup for the ~3,200 Seestar-appropriate objects.
 *
 * Search and getById also consult the curated catalog (catalog-curated.json) for
 * entries the OpenNGC filter drops: OpenNGC classifies some famous objects in a
 * way the Seestar whitelist excludes (IC1318 "Sadr Region" is the star Gamma
 * Cygni there, B33 is a dark nebula), so without this fallback searching those
 * ids returns nothing even though the rest of the app knows them.
 */
// Inlined at bundle time by tsup/esbuild — no runtime file access needed.
import openNgcJson from '../data/openngc.json';
import { expandSearchAliases, resolveCanonicalId, normalizeDesignation } from './catalogAliases.js';
import { getAllCuratedRecords } from './catalogStore.js';
import { isRecord } from './typeGuards.js';
import { raToHours, decToDegs } from './astroCalc.js';

export interface DsoEntry {
  id: string;           // e.g. "M31", "NGC7000", "IC434"
  ngcName: string;      // raw name from OpenNGC, e.g. "NGC0224"
  name: string;         // display name, e.g. "Andromeda Galaxy"
  type: string;         // human label, e.g. "Spiral Galaxy"
  typeCode: string;     // OpenNGC type code, e.g. "G"
  constellation: string | null;
  ra: number;           // decimal hours
  dec: number;          // decimal degrees
  magnitude: number | null;
  majorAxisArcmin: number | null;
  commonNames: string[];
  messier: number | null;
}

let _catalog: DsoEntry[] | null = null;

/**
 * Runtime validator for an OpenNGC catalog entry. Keeps us honest about what
 * the bundled JSON actually contains — so a stale/corrupt catalog file throws
 * at module load instead of producing mysterious undefined-access crashes later.
 */
function isDsoEntry(value: unknown): value is DsoEntry {
  if (!isRecord(value)) return false;
  const v = value;
  return (
    typeof v.id === 'string' &&
    typeof v.ngcName === 'string' &&
    typeof v.name === 'string' &&
    typeof v.type === 'string' &&
    typeof v.typeCode === 'string' &&
    (v.constellation === null || typeof v.constellation === 'string') &&
    typeof v.ra === 'number' &&
    typeof v.dec === 'number' &&
    (v.magnitude === null || typeof v.magnitude === 'number') &&
    (v.majorAxisArcmin === null || typeof v.majorAxisArcmin === 'number') &&
    Array.isArray(v.commonNames) && v.commonNames.every(n => typeof n === 'string') &&
    (v.messier === null || typeof v.messier === 'number')
  );
}

function parseDsoCatalog(data: unknown): DsoEntry[] {
  if (!Array.isArray(data)) {
    throw new Error('[dsoCatalog] openngc.json: expected top-level array');
  }
  // Every entry is validated, not just the first. This used to spot-check
  // data[0] and then assert the whole array as DsoEntry[]: a bundle whose
  // first row was fine and whose thousandth row was missing `ra` would have
  // been typed as valid and produced a NaN altitude at lookup time. ~4,400
  // entries, checked once per process, so the filter costs a few milliseconds.
  const entries = data.filter(isDsoEntry);
  if (data.length > 0 && entries.length === 0) {
    throw new Error('[dsoCatalog] openngc.json: entry shape does not match DsoEntry');
  }
  if (entries.length < data.length) {
    console.warn(`[dsoCatalog] dropped ${data.length - entries.length} openngc.json entr(ies) that did not match DsoEntry`);
  }
  return entries;
}

function loadCatalog(): DsoEntry[] {
  if (_catalog) return _catalog;
  _catalog = parseDsoCatalog(openNgcJson);
  return _catalog;
}

let _curatedExtras: DsoEntry[] | null = null;
let _searchable: DsoEntry[] | null = null;

/**
 * Reverse of the OpenNGC type-code → label mapping used by
 * scripts/download-catalog.mjs. Curated entries carry only the human label, so
 * map it back to keep DsoEntry.typeCode populated. Unknown labels fall back to
 * 'Other' (safe: typeCode is only used for filtering/display).
 */
const TYPE_CODE_BY_LABEL: Record<string, string> = {
  'Galaxy': 'G',
  'Spiral Galaxy': 'G',
  'Barred Spiral Galaxy': 'G',
  'Lenticular Galaxy': 'G',
  'Irregular Galaxy': 'G',
  'Starburst Galaxy': 'G',
  'Galaxy Pair': 'GPair',
  'Galaxy Triplet': 'GTrpl',
  'Galaxy Group': 'GGroup',
  'Open Cluster': 'OCl',
  'Globular Cluster': 'GCl',
  'Cluster + Nebula': 'Cl+N',
  'Planetary Nebula': 'PN',
  'Emission Nebula': 'EmN',
  'Emission/Reflection Nebula': 'EmN',
  'Reflection Nebula': 'RfN',
  'Supernova Remnant': 'SNR',
  'Dark Nebula': 'DrkN',
  'Nebula': 'Neb',
  'Star Cloud': '*Ass',
  'Double Star': '**',
  'Other': 'Other',
};

function typeCodeForLabel(type: string): string {
  return TYPE_CODE_BY_LABEL[type] ?? 'Other';
}

/**
 * Curated store records the OpenNGC-derived catalog does not name, converted to
 * DsoEntry shape. This is the seam that used to be dsoCatalog's own reparse of
 * catalog-curated.json plus a hand-rolled shadow filter — it now reads the one
 * catalog store. An entry is included when OpenNGC has no real name for its id
 * (bare "NGC5866" vs the store's "Spindle Galaxy"), so curated names stay
 * searchable without shadowing real OpenNGC rows.
 */
function loadCuratedExtras(): DsoEntry[] {
  if (_curatedExtras) return _curatedExtras;
  const openNgcNamed = new Set(
    loadCatalog()
      .filter(e => e.name && e.name.toUpperCase().replace(/\s+/g, '') !== e.id.toUpperCase().replace(/\s+/g, ''))
      .map(e => e.id.toUpperCase()),
  );
  const extras: DsoEntry[] = [];
  for (const record of getAllCuratedRecords()) {
    const id = record.canonicalId.toUpperCase().replace(/\s+/g, '');
    if (openNgcNamed.has(id)) continue;
    if (record.ra == null || record.dec == null) continue;
    const ra = raToHours(record.ra);
    const dec = decToDegs(record.dec);
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) continue;
    const messierMatch = id.match(/^M(\d+)$/);
    extras.push({
      id,
      ngcName: id,
      name: record.name || id,
      type: record.type || 'Other',
      typeCode: typeCodeForLabel(record.type || 'Other'),
      constellation: record.constellation || null,
      ra,
      dec,
      magnitude: record.magnitude,
      majorAxisArcmin: record.sizeArcmin,
      commonNames: record.designations.filter(d => d !== id),
      messier: messierMatch ? parseInt(messierMatch[1], 10) : null,
    });
  }
  _curatedExtras = extras;
  return extras;
}

/** OpenNGC catalog + curated extras: the full set search/getById see. */
function loadSearchable(): DsoEntry[] {
  if (!_searchable) _searchable = loadCatalog().concat(loadCuratedExtras());
  return _searchable;
}

export function getCatalog(): DsoEntry[] {
  return loadCatalog();
}

export function getById(id: string): DsoEntry | undefined {
  const normalized = normalizeDesignation(id).toUpperCase().replace(/\s+/g, '');

  // Resolve cross-catalog aliases first so "C5" finds IC342 and "NGC6611"
  // finds M16. Guarded against recursion: the canonical id is a fixpoint.
  const canonical = resolveCanonicalId(id).toUpperCase().replace(/\s+/g, '');
  if (canonical !== normalized) {
    const viaAlias = getById(canonical);
    if (viaAlias) return viaAlias;
  }

  // OpenNGC's own ngcName/commonNames fields are zero-padded to 4 digits
  // (e.g. "NGC0598"), so an unpadded caller id ("NGC598") needs both forms
  // tried against them.
  const padMatch = normalized.match(/^(NGC|IC)(\d{1,3})$/);
  const padded = padMatch ? `${padMatch[1]}${padMatch[2].padStart(4, '0')}` : null;
  const matches = (value: string) => {
    const v = value.toUpperCase().replace(/\s+/g, '');
    return v === normalized || (padded != null && v === padded);
  };

  const direct = loadCatalog().find(e => matches(e.id) || matches(e.ngcName));
  if (direct) return direct;

  // Curated extras — objects OpenNGC filtering dropped (e.g. IC1318 "Sadr
  // Region", B33 "Horsehead Nebula"). Their ids are compact uppercase, so a
  // plain equality against the normalized id is enough (no zero-padding).
  const curated = loadCuratedExtras().find(e => e.id === normalized);
  if (curated) return curated;

  // Duplicate-observation NGC/IC number: the historical NGC catalog recorded
  // some physical objects twice under two numbers (e.g. NGC2527 is the same
  // object as NGC2520). OpenNGC keeps one row and lists the other number in
  // commonNames rather than giving it its own entry — restricted to
  // designation-shaped aliases so this doesn't also match free-text common
  // names like "Andromeda Galaxy" (that's what getByName is for).
  if (!/^(NGC|IC)\d+$/.test(normalized)) return undefined;
  return loadCatalog().find(e => e.commonNames.some(matches));
}

/**
 * Find a catalog entry by its common name (case-insensitive, space-insensitive).
 * Returns the first entry whose `name` or any `commonNames` value matches.
 * Useful for resolving free-text input like "California Nebula" → NGC1499.
 */
export function getByName(name: string): DsoEntry | undefined {
  const normalized = name.toLowerCase().replace(/\s+/g, '');
  return loadCatalog().find(e =>
    e.name.toLowerCase().replace(/\s+/g, '') === normalized ||
    e.commonNames.some(n => n.toLowerCase().replace(/\s+/g, '') === normalized),
  );
}

export function search(query: string, limit = 30): DsoEntry[] {
  if (!query.trim()) return [];
  const q = query.toLowerCase().trim();
  const catalog = loadSearchable();

  // Expand the query to include the canonical ID and all aliases so e.g. "C30"
  // finds NGC7331 and "NGC6611" finds M16.
  const expandedTerms = expandSearchAliases(query.trim()).map(t => t.toLowerCase());

  const results: Array<{ entry: DsoEntry; score: number }> = [];

  for (const entry of catalog) {
    let score = 0;
    const idLower = entry.id.toLowerCase();
    const nameLower = entry.name.toLowerCase();
    const ngcLower = entry.ngcName.toLowerCase().replace(/^0+/, ''); // strip leading zeros

    // Score against the original query first
    if (idLower === q || nameLower === q) score = 100;
    else if (idLower.startsWith(q) || nameLower.startsWith(q)) score = 80;
    else if (ngcLower.startsWith(q.replace(/^ngc\s*/i, 'ngc'))) score = 75;
    else if (entry.commonNames.some(n => n.toLowerCase().startsWith(q))) score = 70;
    else if (nameLower.includes(q)) score = 50;
    else if (idLower.includes(q)) score = 40;
    else if (entry.commonNames.some(n => n.toLowerCase().includes(q))) score = 30;
    else if ((entry.constellation ?? '').toLowerCase().includes(q)) score = 20;

    // If no match yet, try alias-expanded terms (exact/prefix only to avoid noise)
    if (score === 0 && expandedTerms.length > 1) {
      for (const term of expandedTerms) {
        if (term === q) continue;
        if (idLower === term || nameLower === term) { score = 95; break; }
        if (idLower.startsWith(term) || nameLower.startsWith(term)) { score = 75; break; }
      }
    }

    if (score > 0) results.push({ entry, score });
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(r => r.entry);
}

export function filterCatalog(opts: {
  type?: string;
  constellation?: string;
  maxMag?: number;
  minSize?: number;
  limit?: number;
  offset?: number;
}): { entries: DsoEntry[]; total: number } {
  const catalog = loadCatalog();
  const filtered = catalog.filter(e => {
    if (opts.type && !e.type.toLowerCase().includes(opts.type.toLowerCase()) && e.typeCode !== opts.type) return false;
    if (opts.constellation && (e.constellation ?? '').toLowerCase() !== opts.constellation.toLowerCase()) return false;
    if (opts.maxMag != null && e.magnitude != null && e.magnitude > opts.maxMag) return false;
    if (opts.minSize != null && e.majorAxisArcmin != null && e.majorAxisArcmin < opts.minSize) return false;
    return true;
  });

  const total = filtered.length;
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 100;
  return { entries: filtered.slice(offset, offset + limit), total };
}
