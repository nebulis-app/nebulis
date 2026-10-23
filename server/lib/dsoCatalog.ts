/**
 * DSO catalog — the browse list (the listed records of server/data/dso-catalog.json,
 * originally OpenNGC filtered to what a smart telescope can image). Provides
 * search, filtering, and lookup for those ~4,400 objects.
 *
 * Search and getById also consult the curated layer for
 * entries the OpenNGC filter drops: OpenNGC classifies some famous objects in a
 * way the Seestar whitelist excludes (IC1318 "Sadr Region" is the star Gamma
 * Cygni there, B33 is a dark nebula), so without this fallback searching those
 * ids returns nothing even though the rest of the app knows them.
 */
import { LISTED_ROWS } from './dsoCatalogData.js';
import { expandSearchAliases, resolveCanonicalId, normalizeDesignation, getAliasesFor } from './catalogAliases.js';
import { getAllCuratedRecords } from './catalogStore.js';
import { SHARPLESS_CATALOG } from './sharplessCatalog.js';
import { isRecord } from './typeGuards.js';
import { raToHours, decToDegs, maxPossibleAltitude } from './astroCalc.js';

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
  /** Every other catalog designation for this object (M/NGC/IC/Caldwell/Sharpless),
   *  excluding `id`. Only populated on search results. */
  aliases?: string[];
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
    throw new Error('[dsoCatalog] listed rows: expected an array');
  }
  // Every entry is validated, not just the first. This used to spot-check
  // data[0] and then assert the whole array as DsoEntry[]: a bundle whose
  // first row was fine and whose thousandth row was missing `ra` would have
  // been typed as valid and produced a NaN altitude at lookup time. ~4,400
  // entries, checked once per process, so the filter costs a few milliseconds.
  const entries = data.filter(isDsoEntry);
  if (data.length > 0 && entries.length === 0) {
    throw new Error('[dsoCatalog] listed rows: entry shape does not match DsoEntry');
  }
  if (entries.length < data.length) {
    console.warn(`[dsoCatalog] dropped ${data.length - entries.length} listed row(s) that did not match DsoEntry`);
  }
  return entries;
}

function loadCatalog(): DsoEntry[] {
  if (_catalog) return _catalog;
  _catalog = parseDsoCatalog(LISTED_ROWS);
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
 * the curated JSON plus a hand-rolled shadow filter — it now reads the one
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

let _sharplessExtras: DsoEntry[] | null = null;

/**
 * The Sharpless HII regions that are not already an OpenNGC or curated object.
 * The Sharpless catalog holds 313; about 70 of them are objects the other two lists
 * carry under an NGC/Messier/curated id (Sh2-6 is NGC 6302), and the other ~250
 * were in neither search nor the Planner, so "Sh2-1" found nothing. They have
 * coordinates and sizes but no constellation or magnitude, which the app treats
 * as unknown.
 */
function loadSharplessExtras(): DsoEntry[] {
  if (_sharplessExtras) return _sharplessExtras;
  const out: DsoEntry[] = [];
  for (const e of SHARPLESS_CATALOG) {
    const id = e.id.toUpperCase().replace(/\s+/g, '');
    // An alias of another object (ngcRef / messierRef) is that object, not a new one.
    if (resolveCanonicalId(id).toUpperCase().replace(/\s+/g, '') !== id) continue;
    out.push({
      id,
      ngcName: id,
      name: e.commonName || `Sh2-${id.replace(/^SH2-/, '')}`,
      type: 'Emission Nebula',
      typeCode: typeCodeForLabel('Emission Nebula'),
      constellation: null,
      ra: e.raDeg / 15,
      dec: e.decDeg,
      magnitude: null,
      majorAxisArcmin: e.sizeArcmin > 0 ? e.sizeArcmin : null,
      commonNames: [],
      messier: null,
    });
  }
  _sharplessExtras = out;
  return out;
}

/** OpenNGC catalog + curated extras + the remaining Sharpless objects: the full set search/getById see. */
function loadSearchable(): DsoEntry[] {
  if (!_searchable) {
    // Curated extras can repeat an OpenNGC id (NGC4449 is in both). Keep one
    // row per id, folding the curated common names into the OpenNGC entry.
    const byId = new Map<string, DsoEntry>();
    for (const e of loadCatalog().concat(loadCuratedExtras(), loadSharplessExtras())) {
      const prev = byId.get(e.id);
      if (!prev) { byId.set(e.id, e); continue; }
      // A bare-id name ("NGC5866") yields to the curated display name.
      const merged = prev.name === prev.id && e.name !== e.id ? { ...prev, name: e.name } : prev;
      const names = new Set([merged.name, ...merged.commonNames].map(n => n.toLowerCase()));
      const extra = [e.name, ...e.commonNames].filter(n => !names.has(n.toLowerCase()) && n !== e.id);
      byId.set(e.id, extra.length ? { ...merged, commonNames: [...merged.commonNames, ...extra] } : merged);
    }
    _searchable = Array.from(byId.values());
  }
  return _searchable;
}

/** Every entry search sees: OpenNGC, curated extras and Sharpless, one row per id. A superset of the planner catalog, since search
 *  also finds a curated twin that the planner folds into its OpenNGC id. Exported for the native clients' baked copy. */
export function getSearchable(): DsoEntry[] {
  return loadSearchable();
}

export function getCatalog(): DsoEntry[] {
  return loadCatalog();
}

let _plannable: DsoEntry[] | null = null;

/**
 * Every object the Planner can schedule: the OpenNGC catalog plus the curated
 * objects OpenNGC does not carry (most of the Sharpless catalog, the Horsehead
 * as B33, Sadr, the Witch Head), each listed once.
 *
 * An object already present under an OpenNGC id keeps that id. The Cave Nebula
 * is OpenNGC's "C9" and the curated "SH2-155"; the Planner keeps "C9" so that
 * wishlist items, plans and thumbnails saved under it keep working, and the
 * curated twin is dropped. `getCatalog()` stays OpenNGC-only for the callers
 * that mean exactly that (the catalog download job).
 */
export function getPlannerCatalog(): DsoEntry[] {
  if (_plannable) return _plannable;
  const canon = (id: string) => resolveCanonicalId(id).toUpperCase().replace(/\s+/g, '');
  const base = loadCatalog();
  const have = new Set(base.map(e => canon(e.id)));
  const extras: DsoEntry[] = [];
  for (const e of loadSearchable()) {
    const key = canon(e.id);
    if (have.has(key)) continue;
    have.add(key);
    extras.push(e);
  }
  _plannable = base.concat(extras);
  return _plannable;
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

/** Every catalog designation for an entry besides its own id: the raw OpenNGC
 *  name, its Messier number and each Caldwell/Sharpless/NGC alias. */
export function designationsFor(entry: DsoEntry): string[] {
  const out = new Map<string, string>();
  const add = (d: string | null | undefined) => {
    if (!d) return;
    const norm = normalizeDesignation(d);
    if (norm.toUpperCase() === entry.id.toUpperCase()) return;
    if (!out.has(norm.toUpperCase())) out.set(norm.toUpperCase(), norm);
  };
  add(entry.ngcName);
  if (entry.messier != null) add(`M${entry.messier}`);
  for (const a of getAliasesFor(entry.id)) add(a);
  // An entry stored under a non-canonical id (OpenNGC's own "C9" row for the
  // Cave Nebula, whose canonical id is Sh2-155) is still the same object.
  add(resolveCanonicalId(entry.id));
  return Array.from(out.values());
}

/** The fields a client needs to match a search against an object by any of its
 *  names: its own id, the raw catalog name, every other designation (Messier,
 *  Caldwell, NGC/IC, Sharpless, Melotte) and every common name. The Planner's
 *  target list is built from this so its search box and the server's catalog
 *  search can never disagree about what an object is called. */
export function plannerSearchFields(entry: DsoEntry): {
  id: string; ngcName: string; name: string; constellation: string | null; commonNames: string[]; aliases: string[];
} {
  return {
    id: entry.id,
    ngcName: entry.ngcName,
    name: entry.name,
    constellation: entry.constellation,
    commonNames: entry.commonNames,
    aliases: designationsFor(entry),
  };
}

/** Query/designation comparison key: case, spaces and underscores ignored. */
const designationKey = (s: string) =>
  normalizeDesignation(s.replace(/_/g, ' ')).toUpperCase().replace(/[\s_]+/g, '')
    .replace(/^MELOTTE-?(\d)/, 'MEL$1')
    // "Mel022" and "Mel 22" are one cluster; normalizeDesignation only unpads NGC/IC.
    .replace(/^([A-Z]+)0+(\d)/, '$1$2');

/** "Caldwell" / "sharpless" / "cald" on their own: the short designation prefix of
 *  that catalog ("c", "sh2"), or null. Mirrors catalogPrefix in src/lib/dsoSearch.ts. */
function catalogWordPrefix(query: string): string | null {
  const word = query.toLowerCase().replace(/[^a-z]/g, '');
  if (word.length < 4 || !/^[a-z\s]+$/i.test(query.trim())) return null;
  const words: Array<[string, string]> = [['messier', 'm'], ['caldwell', 'c'], ['sharpless', 'sh2'], ['melotte', 'mel'], ['barnard', 'b']];
  return words.find(([name]) => name.startsWith(word))?.[1] ?? null;
}

/** The entry's number in the catalog with this short prefix, or null. */
function catalogNumberOf(entry: DsoEntry, prefix: string): number | null {
  const re = new RegExp(`^${prefix.toUpperCase()}(\\d+)[A-Z]?$`);
  let best: number | null = null;
  for (const d of [entry.id, entry.ngcName, ...designationsFor(entry), ...entry.commonNames, ...(entry.messier != null ? [`M${entry.messier}`] : [])]) {
    const m = re.exec(designationKey(d).replace(/-/g, ''));
    if (m) best = best === null ? Number(m[1]) : Math.min(best, Number(m[1]));
  }
  return best;
}

/** Name comparison key: case, spaces, hyphens and apostrophes ignored, so
 *  "Bodes Galaxy", "Bode's Galaxy" and "bodesgalaxy" are one name. */
const textKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const _nameKeys = new WeakMap<DsoEntry, { name: string; common: string[] }>();
function nameKeysFor(entry: DsoEntry): { name: string; common: string[] } {
  let k = _nameKeys.get(entry);
  if (!k) { k = { name: textKey(entry.name), common: entry.commonNames.map(textKey) }; _nameKeys.set(entry, k); }
  return k;
}

function typeMatches(entry: DsoEntry, type: string): boolean {
  return entry.type.toLowerCase().includes(type.toLowerCase()) || entry.typeCode === type;
}

/**
 * Whether `entry` can ever clear `minAlt` degrees of altitude for an
 * observer at `lat` — a pure geometry check (see `maxPossibleAltitude`), not
 * a "is it up right now" one. An object below this bar never rises high
 * enough at this latitude on ANY night of the year, e.g. a deep-southern-
 * declination target for a mid-northern site. `lat == null` means no
 * location is known, in which case nothing is excluded (the caller can't
 * ask "visible from where" with no "where").
 */
function everVisibleFrom(entry: DsoEntry, lat?: number, minAlt?: number): boolean {
  if (lat == null) return true;
  return maxPossibleAltitude(lat, entry.dec) >= (minAlt ?? 0);
}

/** Shared relevance scoring, factored out of `search()` so `searchFiltered`
 *  (which also needs type filtering, a location filter, a stable sort
 *  override, and offset pagination over the matched set) doesn't duplicate
 *  the scoring rules. Pure and side-effect free: callers decide how to
 *  slice/order the result. */
/** A pasted Dwarf session folder ("DWARF3_C_20_2026-05-20_03-44-24-334_C_20")
 *  reduces to the target part ("C_20"); anything else is left alone. */
function stripDwarfFolderName(query: string): string {
  const m = query.trim().match(/^dwarf\w*?_(.+?)_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/i);
  return m ? m[1] : query;
}

function scoreMatches(rawQuery: string, type?: string, lat?: number, minAlt?: number): Array<{ entry: DsoEntry; score: number }> {
  const query = stripDwarfFolderName(rawQuery);
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const catalog = loadSearchable();

  // Expand the query to include the canonical ID and all aliases so e.g. "C30"
  // finds NGC7331 and "NGC6611" finds M16.
  const qKey = designationKey(query);
  const qText = textKey(query);
  const catalogWord = catalogWordPrefix(query);
  // "c39", "m8", "ngc2392", "sh2-155": a catalog number rather than a word.
  const qIsNumber = /^[a-z]{1,4}\d+[a-z]?$/.test(designationKey(query).toLowerCase().replace(/-/g, ''));
  const expandedTerms = expandSearchAliases(query.trim()).map(t => t.toLowerCase());

  const results: Array<{ entry: DsoEntry; score: number }> = [];

  for (const entry of catalog) {
    if (type && !typeMatches(entry, type)) continue;
    if (!everVisibleFrom(entry, lat, minAlt)) continue;

    let score = 0;
    const idLower = entry.id.toLowerCase();
    const nameLower = entry.name.toLowerCase();
    const ngcLower = entry.ngcName.toLowerCase().replace(/^0+/, ''); // strip leading zeros

    // Score against the original query first. A catalog number ("C39") only
    // matches names that start with it: finding it inside "NGC 3913" or "IC 391"
    // is a coincidence of letters, not a result.
    if (idLower === q || nameLower === q) score = 100;
    else if (idLower.startsWith(q) || nameLower.startsWith(q)) score = 80;
    else if (ngcLower.startsWith(q.replace(/^ngc\s*/i, 'ngc'))) score = 75;
    else if (entry.commonNames.some(n => n.toLowerCase().startsWith(q))) score = 70;
    else if (!qIsNumber && nameLower.includes(q)) score = 50;
    else if (!qIsNumber && idLower.includes(q)) score = 40;
    else if (!qIsNumber && entry.commonNames.some(n => n.toLowerCase().includes(q))) score = 30;
    else if ((entry.constellation ?? '').toLowerCase().includes(q)) score = 20;

    // The same names compared with punctuation and spacing folded away, for
    // "Bodes Galaxy" / "AndromedaGalaxy". Only raises a score, never lowers it.
    if (score < 100 && qText.length >= 3 && !qIsNumber) {
      const nk = nameKeysFor(entry);
      let alt = 0;
      if (nk.name === qText) alt = 100;
      else if (nk.common.some(c => c === qText)) alt = 98;
      else if (nk.name.startsWith(qText)) alt = 80;
      else if (nk.common.some(c => c.startsWith(qText))) alt = 70;
      else if (nk.name.includes(qText)) alt = 50;
      else if (nk.common.some(c => c.includes(qText))) alt = 30;
      if (alt > score) score = alt;
    }

    // Any other designation (M/NGC/IC/Caldwell/Sharpless) — exact beats prefix.
    if (score < 99 && qKey.length >= 2) {
      for (const d of [entry.id, ...designationsFor(entry)]) {
        const dk = designationKey(d);
        if (dk === qKey) { score = Math.max(score, 99); break; }
        if (/\d/.test(qKey) && dk.startsWith(qKey)) score = Math.max(score, 60);
      }
    }

    // If no match yet, try alias-expanded terms (exact/prefix only to avoid noise)
    if (score === 0 && expandedTerms.length > 1) {
      for (const term of expandedTerms) {
        if (term === q) continue;
        if (idLower === term || nameLower === term) { score = 95; break; }
        if (idLower.startsWith(term) || nameLower.startsWith(term)) { score = 75; break; }
      }
    }

    // A catalog name on its own ("Caldwell", "sharpless") means every object in
    // that catalog, in catalog order: 60 for C1, a hair less for each later one.
    if (catalogWord && score < 60) {
      const n = catalogNumberOf(entry, catalogWord);
      if (n !== null) score = 60 - Math.min(n, 5000) / 100000;
    }

    if (score > 0) results.push({ entry, score });
  }

  return dedupeByCanonical(results.sort((a, b) => b.score - a.score));
}

/** One row per object: two entries that are the same object under different ids
 *  (OpenNGC's "C9" and the curated "SH2-155", both the Cave Nebula) collapse to
 *  the canonical one, in the position of whichever ranked higher. */
function dedupeByCanonical(rows: Array<{ entry: DsoEntry; score: number }>): Array<{ entry: DsoEntry; score: number }> {
  const seen = new Map<string, number>();
  const out: Array<{ entry: DsoEntry; score: number }> = [];
  for (const row of rows) {
    const canon = resolveCanonicalId(row.entry.id).toUpperCase().replace(/\s+/g, '');
    const at = seen.get(canon);
    if (at === undefined) { seen.set(canon, out.length); out.push(row); continue; }
    const kept = out[at];
    if (kept && row.entry.id.toUpperCase().replace(/\s+/g, '') === canon) out[at] = { entry: row.entry, score: kept.score };
  }
  return out;
}

export function search(query: string, limit = 30): DsoEntry[] {
  return scoreMatches(query).slice(0, limit).map(r => r.entry);
}

/** Every match for `query` with its relevance score, best first, and no paging.
 *  Explore uses the score to break ties with its own ranking instead of
 *  re-implementing designation matching. */
export function searchScored(query: string): Array<{ entry: DsoEntry; score: number }> {
  return scoreMatches(query);
}

export type DsoSort = 'name' | 'magnitude';

/** Sorts in place by the given key; `undefined` leaves the array's existing
 *  order untouched (catalog order for `filterCatalog`, relevance order for
 *  `searchFiltered`) rather than forcing every caller to pick a tiebreaker. */
function sortEntries(entries: DsoEntry[], sort?: DsoSort): DsoEntry[] {
  if (sort === 'name') {
    return [...entries].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  }
  if (sort === 'magnitude') {
    // Fainter/unknown magnitude sorts last: null read as +Infinity so a
    // missing measurement never outranks a real (bright, low-number) one.
    return [...entries].sort((a, b) => (a.magnitude ?? Infinity) - (b.magnitude ?? Infinity));
  }
  return entries;
}

/**
 * Like `search`, but supports the same `type` filter, `sort` override, and
 * real offset/limit pagination `filterCatalog` (browse mode) has — added so
 * the `/dso` route can serve a free-text query alongside those without a
 * second, disconnected code path. `search()` above is left untouched (exact
 * same signature/behavior) since it has its own direct callers/tests that
 * expect a plain `DsoEntry[]`.
 */
export function searchFiltered(query: string, opts: {
  type?: string;
  /** Observer latitude in decimal degrees, paired with `minAlt` to drop
   *  objects that can never clear that altitude from this location — see
   *  `everVisibleFrom`. */
  lat?: number;
  minAlt?: number;
  sort?: DsoSort;
  limit?: number;
  offset?: number;
} = {}): { entries: DsoEntry[]; total: number } {
  const matched = sortEntries(scoreMatches(query, opts.type, opts.lat, opts.minAlt).map(r => r.entry), opts.sort);
  const withAliases = (e: DsoEntry): DsoEntry => ({ ...e, aliases: designationsFor(e) });
  const total = matched.length;
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 30;
  return { entries: matched.slice(offset, offset + limit).map(withAliases), total };
}

export function filterCatalog(opts: {
  type?: string;
  constellation?: string;
  maxMag?: number;
  minSize?: number;
  /** See `searchFiltered`'s identical option. */
  lat?: number;
  minAlt?: number;
  sort?: DsoSort;
  limit?: number;
  offset?: number;
}): { entries: DsoEntry[]; total: number } {
  const catalog = getPlannerCatalog();
  const filtered = sortEntries(catalog.filter(e => {
    if (opts.type && !typeMatches(e, opts.type)) return false;
    if (opts.constellation && (e.constellation ?? '').toLowerCase() !== opts.constellation.toLowerCase()) return false;
    if (opts.maxMag != null && e.magnitude != null && e.magnitude > opts.maxMag) return false;
    if (opts.minSize != null && e.majorAxisArcmin != null && e.majorAxisArcmin < opts.minSize) return false;
    if (!everVisibleFrom(e, opts.lat, opts.minAlt)) return false;
    return true;
  }), opts.sort);

  const total = filtered.length;
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 100;
  return { entries: filtered.slice(offset, offset + limit), total };
}
