import { describe, it, expect } from 'vitest';
import { getById, getCatalog, getPlannerCatalog, filterCatalog, search, searchFiltered, plannerSearchFields } from '../../server/lib/dsoCatalog';
import { normalizeDesignation, resolveCanonicalId } from '../../server/lib/catalogAliases';
import { matchesSearch, isExactMatch, searchKey } from '../../src/lib/dsoSearch';
import { SHARPLESS_CATALOG } from '../../server/lib/sharplessCatalog';
import { rankTargets, resultsWithoutTarget, serverResultKeys, targetMatches } from '../../src/lib/plannerSearch';

/**
 * Every object must be findable by every name it has, in every spelling a
 * person types: catalog number (M31, NGC 224), long form (Messier 31, Caldwell
 * 39, Sharpless 155), Caldwell/Messier/Sharpless/Melotte aliases, and common
 * names (Andromeda Galaxy, Eskimo Nebula). A search that misses any of these
 * is a bug in the search, not in the query.
 *
 * Two searches are checked against the same cases, because the app has two:
 *   - the server catalog search (`search`), behind the Planner's backfill and
 *     the Wishlist, Reclassify, Move observation and New observation pickers;
 *   - the Planner list's in-browser matcher (`matchesSearch`), run on the exact
 *     fields the server sends for each target (`plannerSearchFields`).
 *
 * The objects are chosen to mix every shape: Messier objects with an NGC number
 * and a nickname, Caldwell objects, Sharpless-only objects, NGC/IC objects with
 * no nickname, a Messier object with no NGC number, and objects whose alias is
 * the only thing connecting two catalogs. Add an object here whenever a search
 * for it fails in the wild.
 */
const TEST_OBJECTS = [
  'M31', 'M42', 'M45', 'M81', 'M82', 'M101', 'M51', 'M13', 'M27', 'M57', 'M16', 'M8', 'M20', 'M33', 'M1', 'M104', 'M40', 'M24',
  'NGC7000', 'NGC2392', 'NGC7293', 'IC342', 'NGC6992', 'NGC7331', 'NGC869', 'NGC2237', 'IC434', 'SH2-155', 'NGC891',
  'C9', 'NGC1499', 'NGC6888', 'NGC3372', 'NGC5128', 'IC1396', 'NGC6543', 'NGC4565', 'SH2-240', 'NGC5866', 'NGC253', 'NGC6960', 'IC405', 'NGC2244',
];

/** The row the Planner's tonight list is built from: the Planner's own entry
 *  where there is one (it keeps OpenNGC's "C9" for the Cave Nebula), else the
 *  search entry. */
const entryFor = (id: string) => getPlannerCatalog().find((e) => e.id === id) ?? getById(id)!;
const canonical = (id: string) => resolveCanonicalId(id).toUpperCase().replace(/\s+/g, '');

/** Every spelling of one designation that a person might type. */
function designationSpellings(d: string): string[] {
  const m = d.match(/^([A-Za-z]+?)(?:2-)?(\d+)([A-Za-z]?)$/);
  if (!m) return [d, d.toLowerCase()];
  const prefix = d.toUpperCase().startsWith('SH2') ? 'SH2' : m[1]!.toUpperCase();
  const num = String(Number(m[2])) + m[3];
  const out = new Set<string>([d, d.toLowerCase(), d.toUpperCase(), `  ${d}  `]);
  const add = (...xs: string[]) => xs.forEach((x) => out.add(x));
  switch (prefix) {
    case 'M':
      add(`M${num}`, `m${num}`, `M ${num}`, `Messier ${num}`, `messier ${num}`, `MESSIER ${num}`, `Messier${num}`, `Messier-${num}`);
      break;
    case 'C':
      add(`C${num}`, `c${num}`, `C ${num}`, `Caldwell ${num}`, `caldwell ${num}`, `CALDWELL ${num}`, `Caldwell${num}`);
      break;
    case 'SH2':
      add(`Sh2-${num}`, `SH2-${num}`, `sh2-${num}`, `Sh2 ${num}`, `sh2${num}`, `Sh 2-${num}`, `Sh 2 ${num}`, `Sharpless ${num}`, `sharpless ${num}`, `Sharpless${num}`);
      break;
    case 'NGC':
    case 'IC':
      add(`${prefix}${num}`, `${prefix.toLowerCase()}${num}`, `${prefix} ${num}`, `${prefix}${num.padStart(4, '0')}`, `${prefix} ${num.padStart(4, '0')}`, `${prefix.toLowerCase()} ${num}`);
      break;
    case 'MEL':
      add(`Mel ${num}`, `Mel${num}`, `Mel ${num.padStart(3, '0')}`, `Melotte ${num}`, `melotte ${num}`);
      break;
    default:
      break;
  }
  return [...out];
}

/** Spellings of a common name: as written, case, punctuation, padding. */
function nameSpellings(n: string): string[] {
  const out = new Set<string>([n, n.toLowerCase(), n.toUpperCase(), `  ${n}  `, n.replace(/['’]/g, ''), n.replace(/-/g, ' '), n.replace(/\s+/g, '')]);
  return [...out].filter((x) => x.trim().length > 0);
}

const isDesignation = (s: string) => /^(M|NGC|IC|C|SH2-|MEL|ESO|PGC|UGC|Messier|Caldwell|Sharpless|Melotte|Barnard|B)\s*-?\d/i.test(s.trim());

interface Case { query: string; kind: 'designation' | 'name' | 'partial' }

function casesFor(id: string): Case[] {
  const e = entryFor(id);
  const f = plannerSearchFields(e);
  const designations = new Set<string>([f.id, f.ngcName, ...f.aliases]);
  if (e.messier != null) designations.add(`M${e.messier}`);
  const names = new Set<string>([f.name, ...f.commonNames]);
  const cases: Case[] = [];
  for (const d of designations) for (const q of designationSpellings(normalizeDesignation(d))) cases.push({ query: q, kind: 'designation' });
  for (const n of names) {
    if (isDesignation(n)) { for (const q of designationSpellings(normalizeDesignation(n))) cases.push({ query: q, kind: 'designation' }); continue; }
    for (const q of nameSpellings(n)) cases.push({ query: q, kind: 'name' });
    // The first word of a multi-word nickname ("Eskimo", "Andromeda").
    const first = n.split(/\s+/)[0]!;
    if (n.split(/\s+/).length > 1 && first.length >= 5) cases.push({ query: first, kind: 'partial' });
  }
  return cases;
}

/** Fails with every offending spelling in the message, so one run shows the lot. */
function expectNone(failures: string[], id: string): void {
  if (failures.length) throw new Error(`${id}: ${failures.length} spelling(s) not found\n  ${failures.join('\n  ')}`);
}

describe('test objects exist', () => {
  it('every object in the list is in the catalog', () => {
    expect(TEST_OBJECTS.filter((id) => !getPlannerCatalog().some((e) => e.id === id) && !getById(id))).toEqual([]);
  });
});

describe('server search finds every object by every name', () => {
  for (const id of TEST_OBJECTS) {
    it(id, () => {
      const failures: string[] = [];
      for (const { query, kind } of casesFor(id)) {
        const results = search(query, 30).map((r) => canonical(r.id));
        const rank = results.indexOf(canonical(id));
        // Anything typed in full must find the object. A full designation or
        // name must also put it first among the results, or within the first
        // three where two objects genuinely share a name.
        const limit = kind === 'name' ? 2 : 29;
        if (rank === -1) failures.push(`"${query}" (${kind}): not found`);
        else if (kind === 'designation') {
          // Only an entry that is itself that exact designation (Barnard 33 has
          // its own "B33" row beside IC434) may rank ahead of the object.
          const key = normalizeDesignation(query).toUpperCase().replace(/\s+/g, '');
          const ahead = results.slice(0, rank).filter((r) => normalizeDesignation(r).toUpperCase().replace(/\s+/g, '') !== key);
          if (ahead.length) failures.push(`"${query}" (${kind}): ${ahead.join(', ')} ranked ahead of it`);
        } else if (rank > limit) failures.push(`"${query}" (${kind}): found at #${rank + 1}, expected within #${limit + 1} [${results.slice(0, 4).join(', ')}]`);
      }
      expectNone(failures, id);
    });
  }
});

describe('planner list matcher finds every object by every name', () => {
  for (const id of TEST_OBJECTS) {
    it(id, () => {
      const fields = plannerSearchFields(entryFor(id));
      const failures: string[] = [];
      for (const { query, kind } of casesFor(id)) {
        if (!matchesSearch(fields, query)) failures.push(`"${query}" (${kind}): not matched`);
        else if (kind !== 'partial' && !isExactMatch(fields, query)) failures.push(`"${query}" (${kind}): matched but not ranked as an exact match`);
      }
      expectNone(failures, id);
    });
  }
});

describe('browser and server agree on how a designation is spelled', () => {
  const spellings = [
    'Messier 31', 'messier31', 'M 31', 'm31', 'Caldwell 39', 'caldwell39', 'C 39', 'Sharpless 155', 'sharpless155', 'Sh2-155',
    'sh 2 155', 'SH2-155', 'NGC 0224', 'ngc224', 'NGC00224', 'IC 0342', 'ic342', 'Mel 022', 'Melotte 22', 'Barnard 33', 'B 33',
  ];
  it('gives two spellings of one designation the same key exactly when the server does', () => {
    const server = (s: string) => normalizeDesignation(s).toUpperCase().replace(/\s+/g, '');
    for (const a of spellings) {
      for (const b of spellings) {
        const sameOnServer = server(a) === server(b);
        const sameInBrowser = searchKey(a) === searchKey(b);
        // The browser may be looser (it also folds Melotte zero-padding), never stricter.
        if (sameOnServer) expect(sameInBrowser, `"${a}" vs "${b}"`).toBe(true);
      }
    }
  });
});


/**
 * The whole left pane of the Planner, for every object and every spelling, in
 * the two situations a person can be in: the object is up tonight (it is in
 * the list the page was given) or it is not (only the server's catalog search
 * knows it). Either way it must be listed exactly once, and nothing that is
 * not the same name may sit above it.
 */
describe('planner pane finds every object, up tonight or not', () => {
  const FILLER = getPlannerCatalog().filter((_, i) => i % 14 === 0);
  const asTarget = (id: string) => plannerSearchFields(entryFor(id));

  function pane(query: string, targets: ReturnType<typeof asTarget>[]) {
    // What the page holds once the debounced server request has come back.
    const results = searchFiltered(query, { limit: 40 }).entries;
    const serverKeys = serverResultKeys(results);
    const shown = rankTargets(targets.filter((t) => targetMatches(t, query, serverKeys)), query);
    const notObservable = resultsWithoutTarget(results, targets);
    return { shown, notObservable };
  }

  // An object can be "up tonight" only under an id the Planner lists. Sh2-155
  // is listed as OpenNGC's "C9" (same Cave Nebula), so it is reached through
  // the server search alone and is covered by the "not up tonight" case.
  const inTonightList = new Set(getPlannerCatalog().map((e) => e.id));

  it('the objects that can only be reached through the server search are the known ones', () => {
    // Pinned so a catalog change that moves an object in or out is noticed here
    // instead of silently dropping it from the "up tonight" cases below.
    expect(TEST_OBJECTS.filter((id) => !inTonightList.has(id)).sort()).toEqual(['SH2-155']);
  });

  for (const id of TEST_OBJECTS) {
    // Objects outside the Planner list (pinned to exactly SH2-155 by the test
    // above) cannot be "up tonight" by construction, so no case is registered
    // for them rather than a permanently skipped one.
    if (inTonightList.has(id)) it(`${id} when it is up tonight`, () => {
      const byId = new Map([...FILLER.map((e) => plannerSearchFields(e)), ...TEST_OBJECTS.filter((x) => inTonightList.has(x)).map(asTarget)].map((t) => [t.id, t]));
      const targets = [...byId.values()];
      const failures: string[] = [];
      for (const { query, kind } of casesFor(id)) {
        const { shown, notObservable } = pane(query, targets);
        const at = shown.findIndex((t) => canonical(t.id) === canonical(id));
        if (at === -1) { failures.push(`"${query}" (${kind}): not listed`); continue; }
        if (shown.filter((t) => canonical(t.id) === canonical(id)).length > 1) failures.push(`"${query}" (${kind}): listed more than once`);
        if (notObservable.some((r) => canonical(r.id) === canonical(id))) failures.push(`"${query}" (${kind}): listed again under "not observable tonight"`);
        if (kind !== 'partial' && shown.slice(0, at).some((t) => !isExactMatch(t, query))) failures.push(`"${query}" (${kind}): ${shown.slice(0, at).filter((t) => !isExactMatch(t, query)).map((t) => t.id).join(', ')} ranked ahead of it`);
      }
      expectNone(failures, id);
    });

    it(`${id} when it is not up tonight`, () => {
      const targets = [...new Map([...FILLER, ...TEST_OBJECTS.filter((x) => inTonightList.has(x)).map((x) => entryFor(x))]
        .filter((e) => canonical(e.id) !== canonical(id))
        .map((e) => [e.id, plannerSearchFields(e)] as const)).values()];
      const failures: string[] = [];
      for (const { query, kind } of casesFor(id)) {
        const { notObservable } = pane(query, targets);
        const at = notObservable.findIndex((r) => canonical(r.id) === canonical(id));
        if (at === -1) { failures.push(`"${query}" (${kind}): not listed`); continue; }
        if (notObservable.filter((r) => canonical(r.id) === canonical(id)).length > 1) failures.push(`"${query}" (${kind}): listed more than once`);
        if (kind === 'designation') {
          // Within the "not observable" group nothing but the same designation
          // may sit above it. (The pane lists up-tonight matches above that
          // group, so "M1" is shown after M10x there; the group is labelled.)
          const key = normalizeDesignation(query).toUpperCase().replace(/\s+/g, '');
          const ahead = notObservable.slice(0, at).map((r) => r.id)
            .filter((x) => normalizeDesignation(x).toUpperCase().replace(/\s+/g, '') !== key);
          if (ahead.length) failures.push(`"${query}" (${kind}): ${ahead.join(', ')} ranked ahead of it in the not-observable group`);
        }
      }
      expectNone(failures, id);
    });
  }
});


/**
 * A catalog's name on its own lists that whole catalog, instantly, in catalog
 * order. "Caldwell" showed nothing until a number was typed after it.
 */
describe('a catalog name lists the catalog', () => {
  const CATALOGS: Array<{ words: string[]; prefix: RegExp; label: string; min: number }> = [
    { words: ['Messier', 'messier', 'Messier ', 'mess', 'MESS'], prefix: /^M\d+$/, label: 'Messier', min: 100 },
    { words: ['Caldwell', 'caldwell', 'Caldwell ', 'cald', 'CALD'], prefix: /^C\d+$/, label: 'Caldwell', min: 90 },
    { words: ['Sharpless', 'sharpless', 'sharp', 'SHAR'], prefix: /^SH2-\d+$/, label: 'Sharpless', min: 300 },
  ];
  const everyObject = [...new Map([...getPlannerCatalog().map((e) => [e.id, plannerSearchFields(e)] as const)]).values()];
  const designationsOf = (f: ReturnType<typeof plannerSearchFields>) => [f.id, ...f.aliases].map((d) => normalizeDesignation(d).toUpperCase());

  for (const { words, prefix, label, min } of CATALOGS) {
    for (const word of words) {
      it(`"${word}" matches every ${label} object, first in catalog order`, () => {
        const members = everyObject.filter((f) => designationsOf(f).some((d) => prefix.test(d)));
        expect(members.length, `${label} objects in the catalog`).toBeGreaterThanOrEqual(min);
        // Instant, in-browser: every member matches with no server round trip.
        const missed = members.filter((f) => !matchesSearch(f, word)).map((f) => f.id);
        expect(missed, `${label} objects the browser did not match for "${word}"`).toEqual([]);
        // And nothing outside the catalog is dragged in.
        const stray = everyObject.filter((f) => !designationsOf(f).some((d) => prefix.test(d)) && matchesSearch(f, word)).map((f) => f.id);
        expect(stray.slice(0, 8), `non-${label} objects matched for "${word}"`).toEqual([]);
        // In catalog order: the first rows are 1, 2, 3...
        const ordered = rankTargets(members, word);
        const numberOf = (f: typeof members[number]) => Math.min(...designationsOf(f).filter((d) => prefix.test(d)).map((d) => Number(d.replace(/\D+/, ''))));
        const nums = ordered.map(numberOf);
        expect(nums, `${label} order for "${word}"`).toEqual([...nums].sort((a, b) => a - b));
      });
    }

    it(`the server lists ${label} objects for "${words[0]}", lowest numbers first`, () => {
      const results = search(words[0]!, 500);
      const got = results.filter((e) => designationsOf(plannerSearchFields(e)).some((d) => prefix.test(d)));
      expect(got.length).toBeGreaterThanOrEqual(Math.min(min, 40));
      // The members come first, before anything else.
      expect(results.slice(0, Math.min(got.length, 30)).every((e) => designationsOf(plannerSearchFields(e)).some((d) => prefix.test(d)))).toBe(true);
    });
  }

  it('does not turn ordinary words into catalog requests', () => {
    // "mel" and "bar" are the start of plenty of names; only four letters or more trigger a catalog.
    const f = plannerSearchFields(getById('M31')!);
    expect(matchesSearch(f, 'cal')).toBe(false);
    expect(matchesSearch(f, 'sharp')).toBe(false);
  });
});


/**
 * What the Planner can schedule: OpenNGC plus the curated objects it lacks
 * (Sharpless, Barnard, Sadr, Witch Head), each exactly once, with no existing
 * id changed.
 */
describe('the Planner catalog', () => {
  const planner = getPlannerCatalog();
  const openNgc = getCatalog();
  const canon = (id: string) => resolveCanonicalId(id).toUpperCase().replace(/\s+/g, '');

  it('keeps every OpenNGC object under the id it already had', () => {
    const ids = new Set(planner.map((e) => e.id));
    expect(openNgc.filter((e) => !ids.has(e.id)).map((e) => e.id)).toEqual([]);
  });

  it('lists each object once, whatever it is called', () => {
    const seen = new Map<string, string>();
    const twice: string[] = [];
    for (const e of planner) {
      const key = canon(e.id);
      if (seen.has(key)) twice.push(`${seen.get(key)} and ${e.id}`);
      else seen.set(key, e.id);
    }
    expect(twice).toEqual([]);
    expect(new Set(planner.map((e) => e.id)).size).toBe(planner.length);
  });

  it('keeps the Cave Nebula as C9 and does not list its Sh2-155 twin', () => {
    const ids = planner.map((e) => e.id);
    expect(ids).toContain('C9');
    expect(ids).not.toContain('SH2-155');
  });

  it('adds the curated objects OpenNGC does not have', () => {
    const ids = new Set(planner.map((e) => e.id));
    // The Sharpless nebulae, the Horsehead's own B33 row and the Sadr region.
    for (const id of ['SH2-240', 'SH2-101', 'SH2-100', 'B33', 'IC1318']) expect(ids.has(id), id).toBe(true);
    expect(planner.length).toBeGreaterThan(openNgc.length + 200);
  });

  it('has all 313 Sharpless objects, each findable as Sh2-N, Sharpless N and Sh 2-N', () => {
    expect(SHARPLESS_CATALOG.length).toBe(313);
    const inPlanner = new Set(planner.map((e) => canon(e.id)));
    const problems: string[] = [];
    for (const sh of SHARPLESS_CATALOG) {
      const id = sh.id.toUpperCase();
      const n = id.replace(/^SH2-/, '');
      if (!inPlanner.has(canon(id))) problems.push(`${id}: not in the Planner catalog`);
      for (const q of [id, `Sh2-${n}`, `Sharpless ${n}`, `Sh 2-${n}`, `sh2 ${n}`]) {
        if (!search(q, 5).some((e) => canon(e.id) === canon(id))) problems.push(`${id}: "${q}" finds nothing`);
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
  }, 60_000);

  it('gives every entry what scheduling needs: finite coordinates, a type and a name', () => {
    const bad = planner.filter((e) => !Number.isFinite(e.ra) || !Number.isFinite(e.dec) || !e.type || !e.typeCode || !e.name).map((e) => e.id);
    expect(bad).toEqual([]);
  });

  it('is what the browse view lists, so it and the Planner never disagree', () => {
    const { total } = filterCatalog({ limit: 1 });
    expect(total).toBe(planner.length);
  });
});
