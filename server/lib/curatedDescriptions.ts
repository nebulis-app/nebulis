// curated-descriptions.json has been merged into catalog-curated.json and is
// now served through the catalog store (see server/lib/catalogStore.ts). This
// module keeps the getCuratedDescription name and { extract, wikiUrl } shape
// its three call sites expect, resolving through the one record set so a
// description added to the catalog file shows up on every path.
import { getCuratedRecord } from './catalogStore.js';

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
