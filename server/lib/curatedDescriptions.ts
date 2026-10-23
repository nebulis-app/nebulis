// Curated descriptions live on the records of server/data/dso-catalog.json and
// are served through the catalog store (see server/lib/catalogStore.ts). This
// module keeps the getCuratedDescription name and { extract, wikiUrl } shape
// its three call sites expect, resolving through the one record set so a
// description added to the catalog file shows up on every path.
import { getAllCuratedRecords, getCuratedRecord } from './catalogStore.js';
import { getById as getDsoById } from './dsoCatalog.js';

interface CuratedEntry {
  extract: string;
  /** Attribution URL for the text. Null for a hand-written entry with no
   *  source recorded — callers already fall back (`curated?.wikiUrl || …`). */
  wikiUrl: string | null;
}

/**
 * The curated description for an object id (any designation: "IC342", "C5",
 * "Caldwell 5" all resolve to the same record), or null when the curated layer
 * has no prose for it yet.
 */
export function getCuratedDescription(objectId: string): CuratedEntry | null {
  const record = getCuratedRecord(objectId);
  if (!record || !record.description) return null;
  return { extract: record.description, wikiUrl: record.descriptionSource };
}

/** Lower-case letters and digits only, minus a trailing "nebula", so "Eastern
 *  Veil" and "Eastern Veil Nebula" name the same thing. */
function nameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/nebula$/, '');
}

let siblingIndex: Map<string, { canonicalId: string; name: string; description: string; wikiUrl: string | null; constellation: string }> | null = null;

function getSiblingIndex() {
  if (siblingIndex) return siblingIndex;
  siblingIndex = new Map();
  for (const r of getAllCuratedRecords()) {
    if (!r.description || !r.name || DESIGNATION.test(r.name.trim())) continue;
    const key = nameKey(r.name);
    if (key && !siblingIndex.has(key)) {
      siblingIndex.set(key, {
        canonicalId: r.canonicalId,
        name: r.name,
        description: r.description,
        wikiUrl: r.descriptionSource,
        constellation: r.constellation,
      });
    }
  }
  return siblingIndex;
}

/** True for a catalog designation ("NGC2527", "M 31", "Sh2-155") rather than a
 *  common name. Two designations are two objects, so they never lend text. */
const DESIGNATION = /^(ngc|ic|m|c|sh2?|caldwell|messier|b|lbn|ldn|abell|arp|vdb|barnard)[\s-]*\d/i;

/** "NGC6995" -> "NGC 6995", for prose. */
function spacedId(id: string): string {
  return id.replace(/^(NGC|IC)(\d+)$/i, '$1 $2');
}

/**
 * A description borrowed from another object that carries the same common name,
 * for an object with no prose of its own. NGC6995 is a 12' knot of the Eastern
 * Veil and shares that name with NGC6992, which has a curated paragraph; the
 * pair were otherwise looked up by catalog id alone, so the knot showed none.
 *
 * Only used as the last resort, so it never replaces real data. The borrowed
 * text is introduced with a line saying how the two relate, because it speaks
 * of the sibling by number. Matches on the common name within one
 * constellation, so two unrelated objects that happen to share a name do not
 * inherit each other's text.
 */
export function getSiblingDescription(objectId: string): CuratedEntry | null {
  const dso = getDsoById(objectId);
  if (!dso) return null;
  const own = getCuratedRecord(objectId)?.canonicalId ?? dso.id;
  const index = getSiblingIndex();
  for (const name of [dso.name, ...dso.commonNames]) {
    if (!name || DESIGNATION.test(name.trim())) continue;
    const sibling = index.get(nameKey(name));
    if (!sibling || sibling.canonicalId === own) continue;
    if (sibling.constellation && dso.constellation && sibling.constellation !== dso.constellation) continue;
    return {
      extract: `${spacedId(dso.id)} is a section of the ${sibling.name}. ${sibling.description}`,
      wikiUrl: sibling.wikiUrl,
    };
  }
  return null;
}
