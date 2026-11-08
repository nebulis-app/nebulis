/**
 * Bakes the server's catalog into the two files the iOS and Android apps use in standalone mode: `catalog-bundle.json.deflate` (name
 * resolution, search, observing programs) and `planner-targets.json.deflate` (the list /planner/tonight walks). Both are raw DEFLATE.
 *
 * The server resolves a name through a chain (solar system -> curated -> Caldwell -> OpenNGC -> Sharpless -> overrides) spread over
 * several modules. Porting that chain by hand would drift, so this runs the REAL functions over every key the chain could match and
 * stores the answers; the apps then only normalise a name and look it up.
 *
 * Two callers: `scripts/build-catalog-data.ts` (signs and publishes the files, run by GitHub Actions) and the spike generators under
 * `spikes/direct-mode`, which add the golden fixtures the native tests compare against. Import this lazily and set DATA_DIR first, as
 * the other build scripts do, so no server module opens the real database.
 */

import crypto from 'node:crypto';
import zlib from 'node:zlib';

const collapse = (s: string): string => s.toUpperCase().replace(/\s+/g, '');
const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T;

export async function buildCatalogData() {
  const cat = await import('../../data/catalog.js');
  const aliases = await import('../catalogAliases.js');
  const curatedDesc = await import('../curatedDescriptions.js');
  const cats = await import('../objectCategories.js');
  const astro = await import('../astroCalc.js');
  const herschel = await import('../herschel400Catalog.js');
  const sharpless = await import('../sharplessCatalog.js');
  const rasc = await import('../rascCatalog.js');
  const abell = await import('../abellCatalog.js');
  const berkeley = await import('../berkeleyCatalog.js');
  const solar = await import('../../data/solar-system-catalog.js');
  const dso = await import('../dsoCatalog.js');
  const dsoData = await import('../dsoCatalogData.js');
  // What openngc.json and catalog-curated.json used to be: the OpenNGC rows, and the hand-written layer.
  const openNgc = dso.getCatalog();
  const curated = [...dsoData.CURATED_ROWS];

  // ---- records -----------------------------------------------------------------------------------------------------------

  /** One baked row: a plain JSON object, stored once and referenced by index. */
  type PoolRecord = object;
  const pool: PoolRecord[] = [];
  const poolIndex = new Map<string, number>();
  function intern(rec: PoolRecord): number {
    const s = JSON.stringify(rec);
    let i = poolIndex.get(s);
    if (i === undefined) { i = pool.length; pool.push(rec); poolIndex.set(s, i); }
    return i;
  }

  /** What the server would say about `key`: the catalog entry plus the curated text and the "also known as" list. */
  function recordFor(key: string): PoolRecord | null {
    const entry = cat.getBaseCatalogEntry(key);
    if (!entry) return null;
    const curatedHit = curatedDesc.getCuratedDescription(key);
    return strip({
      id: entry.id, name: entry.name, type: entry.type, constellation: entry.constellation,
      magnitude: entry.magnitude, description: entry.description || undefined, ra: entry.ra, dec: entry.dec,
      distanceLy: entry.distanceLy, wikiUrl: entry.wikiUrl ?? undefined, majorAxisArcmin: entry.majorAxisArcmin ?? undefined,
      size: entry.size ?? undefined,
      alsoKnownAs: (cat.getAlsoKnownAs(key) as string[]).length ? cat.getAlsoKnownAs(key) : undefined,
      curatedExtract: curatedHit?.extract || undefined, curatedWikiUrl: curatedHit?.wikiUrl || undefined,
    });
  }

  // every key the lookup chain could match
  const candidate = new Set<string>();
  const add = (v: unknown) => { if (typeof v === 'string' && v.trim()) { const k = collapse(v); candidate.add(k); const m = k.match(/^(NGC|IC)(\d+)$/); if (m) candidate.add(`${m[1]}${m[2].padStart(4, '0')}`); } };

  for (const e of curated) { add(e.id); for (const d of e.designations ?? []) add(d); }
  // Every designation the consolidated catalog lists for an object (UGC, PGC, Arp, ...), so each one resolves in the apps as it does here.
  for (const r of dsoData.DSO_RECORDS) { add(r.id); for (const d of r.designations ?? []) add(d); }
  for (const r of openNgc) { add(r.id); add(r.ngcName); if (r.messier != null) add(`M${r.messier}`); for (const c of r.commonNames ?? []) add(c); }
  for (const e of sharpless.SHARPLESS_CATALOG) { add(e.id); add(e.ngcRef); add(e.messierRef); }
  for (let n = 1; n <= 110; n++) add(`M${n}`);
  for (let n = 1; n <= 109; n++) add(`C${n}`);
  for (const id of herschel.HERSCHEL400_IDS) add(id);
  for (const id of rasc.RASC_FINEST_IDS) add(id);
  for (const id of abell.ABELL_IDS) add(id);
  for (const id of berkeley.BERKELEY_IDS) add(id);
  for (const k of solar.SOLAR_SYSTEM_MAP.keys()) add(k);
  for (const k of solar.SOLAR_SYSTEM_LOOKUP_KEYS) add(k);
  for (const k of ['LUNAR', 'SOLAR', 'MOON', 'SUN', 'C9', 'M102', 'NGC1909', 'IC2118']) add(k);

  // Long spellings the server normalises on the way in ("Messier 31", "Caldwell 5", "Sharpless 155", "Barnard 33").
  for (const k of [...candidate]) {
    let m: RegExpMatchArray | null;
    if ((m = k.match(/^M(\d+)$/))) candidate.add(`MESSIER${m[1]}`);
    else if ((m = k.match(/^C(\d+)$/))) candidate.add(`CALDWELL${m[1]}`);
    else if ((m = k.match(/^SH2-(\d+)$/))) { candidate.add(`SHARPLESS${m[1]}`); candidate.add(`SHARPLESS-${m[1]}`); candidate.add(`SH2${m[1]}`); }
    else if ((m = k.match(/^B(\d+)$/))) candidate.add(`BARNARD${m[1]}`);
  }

  const keys: Record<string, number> = {};
  for (const k of [...candidate].sort()) {
    const rec = recordFor(k);
    if (rec) keys[k] = intern(rec);
  }

  // ---- alias map: collapse(alias) -> canonical (what resolveCanonicalId does beyond normalising) -------------------------------

  const aliasMap: Record<string, string> = {};
  for (const k of candidate) {
    const norm = aliases.normalizeDesignation(k).toUpperCase().replace(/\s+/g, '');
    const canon = aliases.resolveCanonicalId(k);
    if (canon !== norm && canon !== k) aliasMap[k] = canon;
  }
  const reverse: Record<string, string[]> = {};
  for (const c of new Set(Object.values(aliasMap))) {
    const a = aliases.getAliasesFor(c) as string[];
    if (a.length) reverse[collapse(c)] = a;
  }

  // ---- search rows (the server scores these; the app only needs ids/name/haystack and the entry to return) -------------------

  const searchNorm = (v: string): string => aliases.normalizeDesignation(v).toUpperCase().replace(/\s+/g, '');
  const searchRows: Array<{ e: number; ids: string[]; name: string; hay: string; src: 'curated' | 'ngc'; cid?: string; mid?: string }> = [];
  for (const e of cat.getAllCatalogEntries()) {
    const aka = cat.getAlsoKnownAs(e.id) as string[];
    searchRows.push({
      e: intern(strip({ id: e.id, name: e.name, type: e.type, constellation: e.constellation, magnitude: e.magnitude, description: e.description, ra: e.ra, dec: e.dec })),
      ids: [e.id, ...aka].filter(Boolean).map(String).map(searchNorm),
      name: e.name,
      hay: [e.id, e.name, e.constellation, e.type, ...aka].join(' ').toLowerCase(),
      src: 'curated', cid: String(e.id).toUpperCase(),
    });
  }
  for (const n of openNgc) {
    const messierStr = n.messier != null ? String(n.messier) : null;
    const matchId = (messierStr ?? n.id).toUpperCase();
    const ids = [n.id, n.ngcName, messierStr != null ? `M${messierStr}` : null, ...(n.commonNames ?? [])].filter((v: unknown) => v != null && String(v) !== '').map(String).map(searchNorm);
    const hay = [n.id, messierStr, n.name, n.constellation, n.type, ...(n.commonNames ?? [])].filter(Boolean).join(' ').toLowerCase();
    searchRows.push({
      e: intern(strip({ id: messierStr ?? n.id, name: n.name ?? messierStr ?? n.id, type: n.type, constellation: n.constellation ?? '', magnitude: n.magnitude ?? undefined, description: '', ra: n.ra != null ? String(n.ra) : undefined, dec: n.dec != null ? String(n.dec) : undefined })),
      ids, name: n.name ?? '', hay, src: 'ngc', mid: matchId,
    });
  }

  // ---- observing programs (the Catalogs tab) -----------------------------------------------------------------------------------

  type Program = { label: string; ids: string[] };
  const programs: Record<string, Program> = {
    messier: { label: 'Messier', ids: Array.from({ length: 110 }, (_, i) => `M${i + 1}`) },
    caldwell: { label: 'Caldwell', ids: Array.from({ length: 109 }, (_, i) => `C${i + 1}`) },
    herschel400: { label: 'Herschel 400', ids: [...herschel.HERSCHEL400_IDS] },
    sharpless: { label: 'Sharpless', ids: sharpless.SHARPLESS_CATALOG.map(e => e.id) },
    rasc: { label: 'RASC Finest NGC', ids: [...rasc.RASC_FINEST_IDS] },
    abell: { label: 'Abell Planetary Nebulae', ids: [...abell.ABELL_IDS] },
    berkeley: { label: 'Berkeley Open Clusters', ids: [...berkeley.BERKELEY_IDS] },
  };
  const classify = (t: string | undefined) => cats.classOfType(t) ?? 'other';
  const programRows: Record<string, { label: string; rows: PoolRecord[] }> = {};
  for (const [name, def] of Object.entries(programs)) {
    programRows[name] = {
      label: def.label,
      rows: def.ids.map(rawId => {
        const key = collapse(rawId);
        const canonKey = aliases.resolveCanonicalId(key);
        let entry = cat.getBaseCatalogEntry(key);
        if (name === 'sharpless' && canonKey !== key) entry = cat.getBaseCatalogEntry(canonKey) ?? entry;
        const m = rawId.match(/^(?:M|C|SH2-|ABELL|BERK)(\d+)$/i);
        const type = entry?.type ?? 'Unknown';
        return strip({
          number: m ? parseInt(m[1], 10) : undefined, id: rawId, ngcName: canonKey !== key ? canonKey : undefined,
          name: entry?.name ?? rawId, type, typeClass: classify(type),
          constellation: entry?.constellation ?? undefined, magnitude: entry?.magnitude ?? undefined,
          majorAxisArcmin: entry?.majorAxisArcmin ?? undefined,
          ra: entry?.ra != null ? astro.raToHours(entry.ra) : undefined, dec: entry?.dec != null ? astro.decToDegs(entry.dec) : undefined,
        });
      }),
    };
  }

  const bundle = {
    format: 1,
    generated: 'nebulis-web/server data via server/lib/catalogData/build.ts',
    records: pool, keys, aliases: aliasMap, reverseAliases: reverse, search: searchRows, programs: programRows,
  };
  const json = Buffer.from(JSON.stringify(bundle));
  const packed = zlib.deflateRawSync(json, { level: 9 });

  // ---- planner targets -------------------------------------------------------------------------------------------------------
  // The list /planner/tonight actually walks: OpenNGC plus the curated extras OpenNGC filtering dropped plus Sharpless (getPlannerCatalog).
  const plannerCatalog = dso.getPlannerCatalog();
  const plannerRows = plannerCatalog.map(e => [e.id, e.ngcName, e.name, e.type, e.typeCode, e.constellation, e.ra, e.dec, e.magnitude, e.majorAxisArcmin, e.commonNames]);
  const plannerJson = Buffer.from(JSON.stringify(plannerRows));
  const plannerPacked = zlib.deflateRawSync(plannerJson, { level: 9 });

  // The version is a hash of the uncompressed content, so it does not change with the zlib build that compressed it. The apps hash the
  // same bytes after inflating, which is how they know which version their bundled copy is.
  const version = crypto.createHash('sha256').update(json).update('\n').update(plannerJson).digest('hex').slice(0, 12);

  return {
    version, json, packed, plannerJson, plannerPacked, plannerCount: plannerRows.length,
    // What the golden generator needs beyond the files themselves.
    pool, keys, aliasMap, searchRows, programRows, candidate, recordFor, strip, collapse,
  };
}

export type CatalogData = Awaited<ReturnType<typeof buildCatalogData>>;
