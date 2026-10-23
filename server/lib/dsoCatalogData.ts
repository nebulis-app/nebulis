/**
 * The deep-sky catalog: one record per physical object, read from the single
 * static file server/data/dso-catalog.json.
 *
 * That file replaced five overlapping lists (openngc.json, catalog-curated.json,
 * sharpless.json, the Caldwell table and two hand-written name lists) that were
 * edited separately and drifted apart. Every name, alias and catalog number for
 * an object now lives on its one record, so an edit lands once. It is edited by
 * hand; there is no generator to re-run. tests/backend/dsoCatalogIntegrity.test.ts
 * guards the rules an edit has to keep (each designation on one record, the
 * Messier and Caldwell crosswalks, sources on hand-added names).
 *
 * The record fields:
 *   id            canonical id: the storage key for library objects, images and
 *                 caches. Priority M > NGC/IC > Sh2 > C, so it never moves.
 *   name / names  display name, then the other common names
 *   designations  every catalog number, normalised ("NGC224", "SH2-190",
 *                 "MEL22"); the id first. Each belongs to exactly one record.
 *   listed        the id the object appears under in browse, search and the
 *                 Planner (the OpenNGC row id, e.g. "C9" for the Cave Nebula).
 *                 Absent on lookup-only records: faint objects kept so any NGC
 *                 or IC number resolves to a real object, but not browsed.
 *   curated       has the hand-written layer (description, Wikipedia link)
 *   sharpless     the Sharpless catalog's own footprint, when it is a member
 *   sources       where a hand-added name or cross-reference came from
 *
 * This module is a leaf (no imports from the catalog modules), and it also
 * presents the record set in the three row shapes the older modules were
 * written against, so their logic did not have to change.
 *
 * Imported (not readFileSync'd) so esbuild/tsup inlines the JSON into the
 * server bundle; the native builds ship no data/ folder on disk.
 */
import catalogJson from '../data/dso-catalog.json';
import { isRecord } from './typeGuards.js';

export interface SharplessFootprint {
  /** Degrees, as the Sharpless catalog gives them. */
  ra: number;
  dec: number;
  sizeArcmin: number;
}

export interface DsoRecord {
  id: string;
  name: string;
  /** Common names other than `name`. */
  names: string[];
  designations: string[];
  type: string;
  typeCode: string | null;
  constellation: string | null;
  /** Decimal hours. */
  ra: number | null;
  /** Decimal degrees. */
  dec: number | null;
  magnitude: number | null;
  sizeArcmin: number | null;
  distanceLy: number | null;
  listed: string | null;
  curated: boolean;
  sharpless: SharplessFootprint | null;
  description: string;
  wikiUrl: string | null;
  reviewedAt: string | null;
  sources: Readonly<Record<string, string>>;
}

// ─── Designation spelling ───────────────────────────────────────────────────

const DESIGNATION_RE =
  /^(?:SH2-\d+|(?:NGC|IC|CED|VDB|LBN|LDN|UGC|PGC|ARP|MEL|CR|STOCK|HCG|M|C|B)\d+[A-Z]?)$/;

/**
 * One spelling per catalog number: uppercase, no spaces, the Sharpless form
 * "SH2-N", catalog words folded ("Messier 31" → "M31", "Melotte 22" → "MEL22")
 * and no zero padding after any prefix ("NGC0224" → "NGC224", "Mel022" →
 * "MEL22"). Returns null for anything that is not a bare catalog number.
 */
export function normalizeCatalogNumber(raw: string): string | null {
  let s = raw.trim().toUpperCase().replace(/\s+/g, '')
    .replace(/^SHARPLESS-?/, 'SH2-')
    .replace(/^SH2-?(\d)/, 'SH2-$1')
    .replace(/^CALDWELL-?(\d)/, 'C$1')
    .replace(/^MESSIER-?(\d)/, 'M$1')
    .replace(/^BARNARD-?(\d)/, 'B$1')
    .replace(/^MELOTTE-?(\d)/, 'MEL$1')
    .replace(/^COLLINDER-?(\d)/, 'CR$1');
  s = s.replace(/^(SH2-)0+(\d)/, '$1$2').replace(/^([A-Z]+)0+(\d)/, '$1$2');
  return DESIGNATION_RE.test(s) ? s : null;
}

const DISPLAY_PREFIX: ReadonlyArray<readonly [RegExp, string]> = [
  [/^SH2-/, 'Sh2-'], [/^MEL(?=\d)/, 'Mel'], [/^CR(?=\d)/, 'Cr'], [/^STOCK(?=\d)/, 'Stock'],
  [/^VDB(?=\d)/, 'vdB'], [/^CED(?=\d)/, 'Ced'], [/^ARP(?=\d)/, 'Arp'],
];

/** The way a catalog number is written for people: "Sh2-190", "Mel22", "vdB141". */
export function displayDesignation(designation: string): string {
  for (const [re, prefix] of DISPLAY_PREFIX) if (re.test(designation)) return designation.replace(re, prefix);
  return designation;
}

/** Sort rank of a designation in an "also known as" list: the catalogs people
 *  name objects by first, survey numbers last. */
export function designationRank(designation: string): number {
  const order = ['M', 'NGC', 'IC', 'C', 'SH2-', 'MEL', 'CR', 'B', 'STOCK', 'CED', 'VDB', 'ARP', 'HCG', 'LDN', 'LBN', 'UGC', 'PGC'];
  const i = order.findIndex(p => new RegExp(`^${p.replace('-', '\\-')}\\d`).test(designation));
  return i < 0 ? order.length : i;
}

// ─── Load + validate ────────────────────────────────────────────────────────

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** One record, field by field; null without an id and name. A wrongly typed
 *  optional field reads as absent rather than being vouched for. */
export function parseDsoRecord(value: unknown): DsoRecord | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const name = str(value.name);
  if (!id || !name) return null;
  const designations = strings(value.designations);
  if (!designations.includes(id)) designations.unshift(id);
  let sharpless: SharplessFootprint | null = null;
  if (isRecord(value.sharpless)) {
    const ra = num(value.sharpless.ra);
    const dec = num(value.sharpless.dec);
    if (ra != null && dec != null) sharpless = { ra, dec, sizeArcmin: num(value.sharpless.sizeArcmin) ?? 0 };
  }
  const sources: Record<string, string> = {};
  if (isRecord(value.sources)) for (const [k, v] of Object.entries(value.sources)) if (typeof v === 'string') sources[k] = v;
  return {
    id,
    name,
    names: strings(value.names),
    designations,
    type: str(value.type) ?? 'Unknown',
    typeCode: str(value.typeCode),
    constellation: str(value.constellation),
    ra: num(value.ra),
    dec: num(value.dec),
    magnitude: num(value.magnitude),
    sizeArcmin: num(value.sizeArcmin),
    distanceLy: num(value.distanceLy),
    listed: str(value.listed),
    curated: value.curated === true,
    sharpless,
    description: str(value.description) ?? '',
    wikiUrl: str(value.wikiUrl),
    reviewedAt: str(value.reviewedAt),
    sources,
  };
}

function load(json: unknown): { records: DsoRecord[]; dropped: number } {
  const items: readonly unknown[] = Array.isArray(json) ? json : [];
  const records: DsoRecord[] = [];
  for (const item of items) {
    const r = parseDsoRecord(item);
    if (r) records.push(r);
  }
  return { records, dropped: items.length - records.length };
}

const loaded = load(catalogJson);
if (loaded.dropped > 0) console.warn(`[dsoCatalog] dso-catalog.json: dropped ${loaded.dropped} record(s) missing an id or name`);

/** Every record, in file order: listed objects first, lookup-only last. */
export const DSO_RECORDS: readonly DsoRecord[] = loaded.records;

const byDesignation = new Map<string, DsoRecord>();
for (const r of DSO_RECORDS) {
  for (const d of r.designations) {
    const key = normalizeCatalogNumber(d) ?? d.toUpperCase();
    if (!byDesignation.has(key)) byDesignation.set(key, r);
  }
  if (r.listed) {
    const key = normalizeCatalogNumber(r.listed) ?? r.listed.toUpperCase().replace(/\s+/g, '');
    if (!byDesignation.has(key)) byDesignation.set(key, r);
  }
}

/** The record any of an object's catalog numbers names ("NGC 224", "M31",
 *  "LBN654", "IC1577"), or undefined. */
export function recordFor(designation: string): DsoRecord | undefined {
  const key = normalizeCatalogNumber(designation) ?? designation.trim().toUpperCase().replace(/\s+/g, '');
  return byDesignation.get(key);
}

const isNgcIc = (d: string) => /^(NGC|IC)\d/.test(d);
const pad = (d: string) => d.replace(/^(NGC|IC)(\d+)/, (_, p: string, n: string) => `${p}${n.padStart(4, '0')}`);

// ─── The row shapes the older modules read ──────────────────────────────────

/** The browse catalog row (formerly openngc.json): one per listed record. */
export interface ListedRow {
  id: string;
  ngcName: string;
  name: string;
  type: string;
  typeCode: string;
  constellation: string | null;
  messier: number | null;
  ra: number;
  dec: number;
  magnitude: number | null;
  majorAxisArcmin: number | null;
  /** Common names, then the NGC/IC numbers besides `id` and `ngcName`. */
  commonNames: string[];
}

export const LISTED_ROWS: readonly ListedRow[] = DSO_RECORDS.flatMap((r): ListedRow[] => {
  if (!r.listed || r.ra == null || r.dec == null) return [];
  const listed = r.listed;
  const messierMatch = r.designations.find(d => /^M\d+$/.test(d));
  const primaryNgc = isNgcIc(normalizeCatalogNumber(listed) ?? '') ? normalizeCatalogNumber(listed)! : r.designations.find(isNgcIc);
  const ngcName = primaryNgc ? pad(primaryNgc) : listed;
  const own = new Set([normalizeCatalogNumber(listed) ?? listed, primaryNgc ?? '']);
  const bare = r.name === listed || normalizeCatalogNumber(r.name) !== null;
  return [{
    id: listed,
    ngcName,
    name: r.name,
    type: r.type,
    typeCode: r.typeCode ?? 'Other',
    constellation: r.constellation,
    messier: messierMatch ? Number(messierMatch.slice(1)) : null,
    ra: r.ra,
    dec: r.dec,
    magnitude: r.magnitude,
    majorAxisArcmin: r.sizeArcmin,
    commonNames: [...(bare ? [] : [r.name]), ...r.names, ...r.designations.filter(d => isNgcIc(d) && !own.has(d))],
  }];
});

/** Right ascension in the notation the curated layer always wrote: "05h 35m 16.5s". */
export function formatRaText(hours: number): string {
  let tenths = Math.round((((hours % 24) + 24) % 24) * 36000) % 864000; // 24h rounds to 00h
  const h = Math.floor(tenths / 36000); tenths -= h * 36000;
  const m = Math.floor(tenths / 600); tenths -= m * 600;
  const sec = tenths / 10;
  return `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${Number.isInteger(sec) ? sec : sec.toFixed(1)}s`;
}

/** Declination in the same notation: "-05° 23′ 23″". */
export function formatDecText(degrees: number): string {
  let secs = Math.round(Math.abs(degrees) * 3600);
  const d = Math.floor(secs / 3600); secs -= d * 3600;
  const m = Math.floor(secs / 60); secs -= m * 60;
  return `${degrees < 0 ? '-' : '+'}${String(d).padStart(2, '0')}° ${String(m).padStart(2, '0')}′ ${String(secs).padStart(2, '0')}″`;
}

/** The hand-written layer (formerly catalog-curated.json): one per curated record. */
export interface CuratedRow {
  id: string;
  name: string;
  type: string;
  constellation: string;
  magnitude?: number;
  description: string;
  ra?: string;
  dec?: string;
  distanceLy?: number;
  majorAxisArcmin: number | null;
  wikiUrl: string | null;
  designations: string[];
  reviewedAt: string | null;
}

export const CURATED_ROWS: readonly CuratedRow[] = DSO_RECORDS.filter(r => r.curated).map(r => ({
  id: displayDesignation(r.id),
  name: r.name,
  type: r.type,
  constellation: r.constellation ?? '',
  ...(r.magnitude != null ? { magnitude: r.magnitude } : {}),
  description: r.description,
  ...(r.ra != null && r.dec != null ? { ra: formatRaText(r.ra), dec: formatDecText(r.dec) } : {}),
  ...(r.distanceLy != null ? { distanceLy: r.distanceLy } : {}),
  majorAxisArcmin: r.sizeArcmin,
  wikiUrl: r.wikiUrl,
  designations: r.designations,
  reviewedAt: r.reviewedAt,
}));

/** A Sharpless catalog entry (formerly sharpless.json), ordered by number. */
export interface SharplessRow {
  id: string;
  raDeg: number;
  decDeg: number;
  sizeArcmin: number;
  commonName: string | null;
  ngcRef: string | null;
  messierRef: string | null;
}

export const SHARPLESS_ROWS: readonly SharplessRow[] = DSO_RECORDS
  .flatMap((r): Array<SharplessRow & { n: number }> => {
    if (!r.sharpless) return [];
    const sh = r.designations.find(d => /^SH2-\d+$/.test(d));
    if (!sh) return [];
    return [{
      n: Number(sh.slice(4)),
      id: displayDesignation(sh),
      raDeg: r.sharpless.ra,
      decDeg: r.sharpless.dec,
      sizeArcmin: r.sharpless.sizeArcmin,
      commonName: normalizeCatalogNumber(r.name) || /^Sh2-\d+$/.test(r.name) ? null : r.name,
      ngcRef: isNgcIc(r.id) ? r.id : r.designations.find(isNgcIc) ?? null,
      messierRef: /^M\d+$/.test(r.id) ? r.id : null,
    }];
  })
  .sort((a, b) => a.n - b.n)
  .map(row => ({
    id: row.id, raDeg: row.raDeg, decDeg: row.decDeg, sizeArcmin: row.sizeArcmin,
    commonName: row.commonName, ngcRef: row.ngcRef, messierRef: row.messierRef,
  }));

/** Caldwell number → the NGC/IC id it is (C9, C41 and C99 have none). */
export const CALDWELL_NGC: Readonly<Record<number, string>> = (() => {
  const out: Record<number, string> = {};
  for (const r of DSO_RECORDS) {
    if (!isNgcIc(r.id)) continue;
    for (const d of r.designations) {
      const m = /^C(\d+)$/.exec(d);
      if (m) out[Number(m[1])] = r.id;
    }
  }
  return out;
})();
