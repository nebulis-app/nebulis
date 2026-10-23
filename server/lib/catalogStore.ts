/**
 * Catalog store — the curated layer (description, Wikipedia link, reviewed
 * flag) of server/data/dso-catalog.json, as a validated record set with the
 * alias index derived from it.
 *
 * The catalog used to live in five places read through two parallel lookup
 * chains (server/data/catalog.ts and server/lib/dsoCatalog.ts), so a fix added
 * to one file could not be relied on to show up. All five are now one file,
 * read through dsoCatalogData.ts; this module keeps the curated view and the
 * derived alias index it always exposed.
 *
 * Consumed by: curatedDescriptions.ts (getCuratedDescription), dsoCatalog.ts
 * (curated extras), catalog.ts. The catalogAliases map is read off the same
 * records, so resolveCanonicalId and resolveToCanonical agree.
 */
import { CURATED_ROWS, LISTED_ROWS } from './dsoCatalogData.js';
import { isRecord } from './typeGuards.js';
import { normalizeDesignation, resolveCanonicalId, getAliasesFor } from './catalogAliases.js';
import { SHARPLESS_CATALOG } from './sharplessCatalog.js';
import { HERSCHEL400_IDS } from './herschel400Catalog.js';
import { CALDWELL_TO_NGC, ngcToCaldwell } from './caldwellCatalog.js';

// ─── The record ─────────────────────────────────────────────────────────────

/** An observing program an object belongs to. Membership only — the ordered
 *  program sequences (Herschel 400's order, the Sharpless numbering) stay in
 *  their own modules, since order is data, not membership. */
export type CatalogProgram = 'messier' | 'caldwell' | 'herschel400' | 'sharpless';

/** One curated object, carrying its own designations so the alias index is
 *  derived from the record set instead of hand-maintained alongside it. */
export interface CuratedRecord {
  /** The single ID images, sky-cache and catalogCache rows are keyed under. */
  canonicalId: string;
  /** Every spelling a user or a telescope folder might produce, normalised.
   *  Includes canonicalId. Authoritative source of the alias index. */
  designations: string[];
  /** Display name. Falls back to canonicalId when the object has no name. */
  name: string;
  /** Observing programs this object belongs to. */
  programs: CatalogProgram[];

  type: string;
  constellation: string;
  ra: string | null;
  dec: string | null;
  magnitude: number | null;
  sizeArcmin: number | null;
  distanceLy: number | null;

  /** Written description. Empty string when the curated layer has no prose for
   *  the object yet (it still displays from the structured fields). */
  description: string;
  /** Attribution for the description, usually the object's Wikipedia page, and
   *  how a rebuild knows whether it may overwrite the text. */
  descriptionSource: string | null;
  /** Set when a human has reviewed the record. Null on a scraped-but-unreviewed
   *  record. What a future audit script sorts by. */
  reviewedAt: string | null;
}

// ─── The file as it sits on disk ────────────────────────────────────────────

interface CuratedFileEntry {
  id: string;
  name: string;
  type: string;
  constellation: string;
  magnitude?: number;
  description?: string;
  ra?: string;
  dec?: string;
  distanceLy?: number;
  majorAxisArcmin?: number | null;
  wikiUrl?: string | null;
  designations?: string[];
  reviewedAt?: string | null;
}

/** Every string in an unknown array, in order; non-strings are dropped. */
function stringsIn(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const items: readonly unknown[] = value;
  return items.filter((v): v is string => typeof v === 'string');
}

const optString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const optNumber = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
/** `null` is a meaningful stored value ("explicitly none") distinct from absent. */
const optStringOrNull = (v: unknown): string | null | undefined => (v === null ? null : optString(v));
const optNumberOrNull = (v: unknown): number | null | undefined => (v === null ? null : optNumber(v));

/**
 * One curated entry, field by field, or null when a required field is missing.
 *
 * Replaces a type guard that checked the four required fields and then vouched
 * for the optional ones too: a wrongly-typed `magnitude` or `designations` would
 * have flowed through typed as valid. Here an optional field of the wrong type
 * reads as absent, which is how every consumer already treats a missing one.
 */
function parseCuratedFileEntry(value: unknown): CuratedFileEntry | null {
  if (!isRecord(value)) return null;
  const { id, name, type, constellation } = value;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof type !== 'string' || typeof constellation !== 'string') {
    return null;
  }
  return {
    id,
    name,
    type,
    constellation,
    magnitude: optNumber(value.magnitude),
    description: optString(value.description),
    ra: optString(value.ra),
    dec: optString(value.dec),
    distanceLy: optNumber(value.distanceLy),
    majorAxisArcmin: optNumberOrNull(value.majorAxisArcmin),
    wikiUrl: optStringOrNull(value.wikiUrl),
    designations: value.designations === undefined ? undefined : stringsIn(value.designations),
    reviewedAt: optStringOrNull(value.reviewedAt),
  };
}

const norm = (id: string): string => normalizeDesignation(id).toUpperCase().replace(/\s+/g, '');
const DESIGNATION_SHAPE = /^(SH2-|NGC|IC|CED|VDB|LBN|LDN|UGC|PGC|ARP|MEL|STOCK|HCG|M|C|B)\d/;

// ─── OpenNGC cross-references + skeleton fallback ────────────────────────────

interface OpenNgcRow {
  id: string;
  name?: string;
  type?: string;
  constellation?: string | null;
  messier?: number | string | null;
  ngcName?: string;
  ra?: number | null;
  dec?: number | null;
  magnitude?: number | null;
  majorAxisArcmin?: number | null;
  commonNames?: string[];
}

/** One OpenNGC row, field by field, or null without a string `id`. An optional
 *  field of the wrong type reads as absent rather than being vouched for. */
function parseOpenNgcRow(value: unknown): OpenNgcRow | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  const { messier } = value;
  return {
    id: value.id,
    name: optString(value.name),
    type: optString(value.type),
    constellation: optStringOrNull(value.constellation),
    messier: messier === null ? null : typeof messier === 'number' || typeof messier === 'string' ? messier : undefined,
    ngcName: optString(value.ngcName),
    ra: optNumberOrNull(value.ra),
    dec: optNumberOrNull(value.dec),
    magnitude: optNumberOrNull(value.magnitude),
    majorAxisArcmin: optNumberOrNull(value.majorAxisArcmin),
    commonNames: value.commonNames === undefined ? undefined : stringsIn(value.commonNames),
  };
}

/** Parse every element of a bundled JSON array, dropping the ones that fail.
 *  Assigning the import to `unknown` first (a widening, not a cast) is what makes
 *  the parser, rather than the inferred JSON type, the authority on its shape. */
function parseAll<T>(json: unknown, parse: (value: unknown) => T | null): { parsed: T[]; total: number } {
  if (!Array.isArray(json)) return { parsed: [], total: 0 };
  const items: readonly unknown[] = json;
  const parsed: T[] = [];
  for (const item of items) {
    const p = parse(item);
    if (p !== null) parsed.push(p);
  }
  return { parsed, total: items.length };
}

const openNgcRows: OpenNgcRow[] = parseAll(LISTED_ROWS, parseOpenNgcRow).parsed;

const primaryNgcIds = new Set(openNgcRows.map(r => norm(r.id)));
const openNgcByNorm = new Map<string, OpenNgcRow>();
for (const r of openNgcRows) {
  openNgcByNorm.set(norm(r.id), r);
  if (r.ngcName) openNgcByNorm.set(norm(r.ngcName), r);
  if (r.messier != null) openNgcByNorm.set(norm(`M${r.messier}`), r);
  for (const cn of r.commonNames ?? []) if (DESIGNATION_SHAPE.test(norm(cn))) openNgcByNorm.set(norm(cn), r);
}

// ─── Program membership ─────────────────────────────────────────────────────

const programsByCanonical = (() => {
  const map = new Map<string, Set<CatalogProgram>>();
  const add = (id: string, program: CatalogProgram) => {
    const key = norm(resolveCanonicalId(id));
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(program);
  };
  for (let n = 1; n <= 110; n++) add(`M${n}`, 'messier');
  for (const n of Object.keys(CALDWELL_TO_NGC)) add(`C${n}`, 'caldwell');
  for (const id of HERSCHEL400_IDS) add(id, 'herschel400');
  for (const e of SHARPLESS_CATALOG) add(e.id, 'sharpless');
  return map;
})();

function programsFor(canonicalId: string): CatalogProgram[] {
  const set = programsByCanonical.get(norm(canonicalId));
  if (!set) return [];
  return (['messier', 'caldwell', 'herschel400', 'sharpless'] as const).filter(p => set.has(p));
}

// ─── Designation derivation ─────────────────────────────────────────────────

/** Designations from the record's own identity: its canonical id, the reverse
 *  alias map, its Caldwell number, and any the file already lists. */
function baseDesignations(canonicalId: string, listed: string[] | undefined): string[] {
  const out = new Set<string>();
  const push = (raw: string | null | undefined) => {
    if (!raw) return;
    const n = norm(raw);
    if (n && DESIGNATION_SHAPE.test(n)) out.add(n);
  };
  push(canonicalId);
  for (const d of listed ?? []) push(d);
  for (const alias of getAliasesFor(canonicalId)) push(alias);
  const cNum = ngcToCaldwell(canonicalId);
  if (cNum != null) push(`C${cNum}`);
  return [...out];
}

/** OpenNGC cross-references for a canonical id, minus any that are another
 *  record's canonical id (IC 434's row lists "B33", a separate record). */
function crossRefDesignations(canonicalId: string, ownedElsewhere: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  const push = (raw: string | null | undefined) => {
    if (!raw) return;
    const n = norm(raw);
    if (n && DESIGNATION_SHAPE.test(n) && n !== norm(canonicalId) && !ownedElsewhere.has(n)) out.add(n);
  };
  // Only this object's own OpenNGC row — a commonName-match row belongs to a
  // different object (NGC 2244's row lists "NGC2239"; IC 434's lists "B33").
  const row = openNgcByNorm.get(norm(canonicalId));
  if (row && norm(row.id) === norm(canonicalId)) {
    push(row.ngcName);
    if (row.messier != null) push(`M${row.messier}`);
    for (const cn of row.commonNames ?? []) if (!primaryNgcIds.has(norm(cn))) push(cn);
  }
  return [...out];
}

// ─── Build the record set + alias index ─────────────────────────────────────

interface BuildResult {
  records: CuratedRecord[];
  byCanonical: Map<string, CuratedRecord>;
  aliasIndex: Map<string, string>;
  warnings: string[];
}

function buildStore(): BuildResult {
  const warnings: string[] = [];
  const { parsed: fileEntries, total: curatedTotal } = parseAll(CURATED_ROWS, parseCuratedFileEntry);
  if (fileEntries.length < curatedTotal) {
    warnings.push(`dso-catalog.json curated rows: dropped ${curatedTotal - fileEntries.length} entr(ies) missing required fields`);
  }

  const byCanonical = new Map<string, CuratedRecord>();

  for (const entry of fileEntries) {
    const canonicalId = resolveCanonicalId(entry.id);
    const key = norm(canonicalId);
    if (byCanonical.has(key)) {
      warnings.push(`duplicate canonical id ${canonicalId} (from "${entry.id}"); keeping first`);
      continue;
    }
    // Fill structured fields the entry lacks from its OpenNGC row, so the ~3
    // description-only additions with no coordinates still plate-solve and plan.
    const row = openNgcByNorm.get(key);
    byCanonical.set(key, {
      canonicalId,
      designations: baseDesignations(canonicalId, entry.designations),
      name: entry.name?.trim() || row?.name || canonicalId,
      programs: programsFor(canonicalId),
      type: entry.type && entry.type !== 'Unknown' ? entry.type : row?.type ?? entry.type ?? 'Unknown',
      constellation: entry.constellation || row?.constellation || '',
      ra: entry.ra ?? (row?.ra != null ? String(row.ra) : null),
      dec: entry.dec ?? (row?.dec != null ? String(row.dec) : null),
      magnitude: entry.magnitude ?? row?.magnitude ?? null,
      sizeArcmin: entry.majorAxisArcmin ?? row?.majorAxisArcmin ?? null,
      distanceLy: entry.distanceLy ?? null,
      description: entry.description?.trim() ?? '',
      descriptionSource: entry.wikiUrl ?? null,
      reviewedAt: entry.reviewedAt ?? null,
    });
  }

  // Augment designations with OpenNGC cross-refs, never claiming another
  // record's canonical id.
  const allCanonicals = new Set([...byCanonical.values()].map(r => norm(r.canonicalId)));
  for (const record of byCanonical.values()) {
    const ownedElsewhere = new Set(allCanonicals);
    ownedElsewhere.delete(norm(record.canonicalId));
    const extra = crossRefDesignations(record.canonicalId, ownedElsewhere);
    if (extra.length) record.designations = [...new Set([...record.designations, ...extra])];
  }

  // Derive the alias index. Precedence: curated record designations first
  // (authoritative), then the listed rows and Sharpless cross-references for
  // objects with no curated record. Ambiguous designations (M102, NGC1909) are
  // settled on their records in dso-catalog.json.
  const aliasIndex = new Map<string, string>();
  const claim = (designation: string, canonicalId: string, sourceLabel: string) => {
    const d = norm(designation);
    if (!d) return;
    const existing = aliasIndex.get(d);
    if (existing && norm(existing) !== norm(canonicalId)) {
      warnings.push(`designation ${d} resolves to both ${existing} and ${canonicalId} (${sourceLabel}); keeping ${existing}`);
      return;
    }
    if (!existing) aliasIndex.set(d, canonicalId);
  };

  for (const record of byCanonical.values()) {
    for (const d of record.designations) claim(d, record.canonicalId, 'curated record');
  }
  for (const row of openNgcRows) {
    const canonical = resolveCanonicalId(row.id);
    if (aliasIndex.has(norm(row.id)) && norm(canonical) !== norm(row.id)) continue;
    claim(row.id, canonical, 'openngc');
    if (row.ngcName) claim(row.ngcName, canonical, 'openngc ngcName');
    if (row.messier != null) claim(`M${row.messier}`, canonical, 'openngc messier');
  }
  for (const e of SHARPLESS_CATALOG) {
    const canonical = resolveCanonicalId(e.id);
    claim(e.id, canonical, 'sharpless');
    if (e.ngcRef) claim(e.ngcRef, canonical, 'sharpless ngcRef');
    if (e.messierRef) claim(e.messierRef, canonical, 'sharpless messierRef');
  }

  return { records: [...byCanonical.values()], byCanonical, aliasIndex, warnings };
}

const store = buildStore();

if (store.warnings.length > 0) {
  console.warn(
    `[catalogStore] ${store.warnings.length} warning(s) at load:\n  ` + store.warnings.slice(0, 20).join('\n  '),
  );
}
console.log(`[catalogStore] ${store.records.length} curated records, ${store.aliasIndex.size} derived aliases`);

// ─── Read API ───────────────────────────────────────────────────────────────

/** Resolve any designation to its canonical id via the derived index, falling
 *  back to catalogAliases for anything the index has not indexed. */
export function resolveToCanonical(id: string): string {
  const hit = store.aliasIndex.get(norm(id));
  if (hit) return hit;
  return resolveCanonicalId(id);
}

/** The curated record for an id (any designation), or null. */
export function getCuratedRecord(id: string): CuratedRecord | null {
  return store.byCanonical.get(norm(resolveToCanonical(id))) ?? null;
}

/** Every curated record, in file order. */
export function getAllCuratedRecords(): readonly CuratedRecord[] {
  return store.records;
}

/** The derived alias index (normalised designation → canonical id). */
export function getDerivedAliasIndex(): ReadonlyMap<string, string> {
  return store.aliasIndex;
}

/** Warnings found at load: dropped entries, duplicate canonical ids, and
 *  designations more than one source claimed for different canonical ids.
 *  Empty in a healthy build. Exposed for the consistency test and a CI check. */
export function getAliasConflicts(): readonly string[] {
  return store.warnings;
}
