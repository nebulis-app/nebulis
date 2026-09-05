/**
 * Catalog store — the single seam every catalog reader resolves through.
 *
 * Catalog identity and text used to live in five places (catalog-curated.json,
 * curated-descriptions.json, catalogAliases' ALIASES map, OpenNGC's own
 * cross-references, the Sharpless refs) read through two parallel lookup chains
 * (server/data/catalog.ts and server/lib/dsoCatalog.ts). A description added to
 * one file could not be relied on to show up, because the path that next read
 * it might consult a different file.
 *
 * curated-descriptions.json has been merged into catalog-curated.json (see
 * scripts/merge-curated-descriptions.ts), which now carries a `designations`
 * array on every entry. This module presents that file as a validated record
 * set and derives the alias index from it, so a fix lands once and the alias
 * map is not hand-maintained alongside the entries.
 *
 * Consumed by: curatedDescriptions.ts (getCuratedDescription), dsoCatalog.ts
 * (curated extras), catalog.ts (getAlsoKnownAs). The catalogAliases ALIASES
 * map is derived from the same sources, so resolveCanonicalId and
 * resolveToCanonical agree.
 *
 * Imported (not readFileSync'd) so esbuild/tsup inlines the JSON into the
 * server bundle — the native Windows/macOS builds ship a single bundle with no
 * data/ folder on disk, so a runtime read would throw ENOENT there.
 */
import curatedJson from '../data/catalog-curated.json';
import openNgcJson from '../data/openngc.json';
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

function isCuratedFileEntry(value: unknown): value is CuratedFileEntry {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.type === 'string' &&
    typeof value.constellation === 'string'
  );
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

const openNgcRows: OpenNgcRow[] = Array.isArray(openNgcJson)
  ? (openNgcJson as unknown[]).filter((r): r is OpenNgcRow => isRecord(r) && typeof r.id === 'string')
  : [];

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

/**
 * Designations that are genuinely ambiguous in the literature and cannot be
 * derived. Each entry earns its place with a one-line reason.
 */
const AMBIGUOUS_DESIGNATIONS: ReadonlyArray<readonly [string, string]> = [
  // M102 is a historical dispute, not a fact; NGC 5866 is the modern consensus.
  ['M102', 'NGC5866'],
  // IC 2118 and NGC 1909 are both in live use for the Witch Head Nebula.
  ['NGC1909', 'IC2118'],
];

// ─── Build the record set + alias index ─────────────────────────────────────

interface BuildResult {
  records: CuratedRecord[];
  byCanonical: Map<string, CuratedRecord>;
  aliasIndex: Map<string, string>;
  warnings: string[];
}

function buildStore(): BuildResult {
  const warnings: string[] = [];
  const fileEntries: CuratedFileEntry[] = Array.isArray(curatedJson)
    ? (curatedJson as unknown[]).filter(isCuratedFileEntry)
    : [];
  if (Array.isArray(curatedJson) && fileEntries.length < curatedJson.length) {
    warnings.push(`catalog-curated.json: dropped ${curatedJson.length - fileEntries.length} entr(ies) missing required fields`);
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
  // (authoritative), then OpenNGC / Sharpless cross-references for skeleton
  // objects with no curated record, then the hand-written exception list.
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
  for (const [designation, canonicalId] of AMBIGUOUS_DESIGNATIONS) {
    aliasIndex.set(norm(designation), canonicalId); // exception list always wins
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
