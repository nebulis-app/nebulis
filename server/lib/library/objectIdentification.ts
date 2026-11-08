/**
 * Identify the catalog object a folder name refers to.
 *
 * The folder-import wizard used to resolve a folder to an object with one
 * rule: `normalizeCatalogId(folderName)` had to be a catalog id on its own.
 * That works for a telescope's own folders ("M 42", "NGC 7000") but not for a
 * library the user has organised themselves, which is exactly what the "Files
 * already on the computer" option is for. Folder names like
 * "M42 - Orion Nebula", "M42_2024-01-15", "Seestar_M42", "Orion Nebula" or
 * "Bodes Galaxy" all fell through and became library objects named after the
 * folder, which is the complaint this module fixes.
 *
 * Deliberately conservative. Every rule below has to produce the *whole*
 * object on its own, and an ambiguous name (two different designations, e.g.
 * "M81_M82") resolves to nothing rather than guessing one of them. A miss is
 * cheap: the review screen lets the user search the catalog by hand. A wrong
 * match silently merges two of their objects, which is not recoverable by
 * clicking.
 *
 * Pure: catalog lookups only, no filesystem and no database, so the scan, the
 * commit fallback and a unit test all get the same answer.
 */
import { getCatalogEntry, findCatalogEntryByExactName, type CatalogEntry } from '../catalogLookup.js';
import { normalizeCatalogId, variantSuffix } from '../telescopeFiles.js';
import { normalizeDesignation, resolveCanonicalId } from '../catalogAliases.js';

export interface IdentifiedObject {
  /** Normalized/canonical catalog id, e.g. "M42". */
  objectId: string;
  name: string;
  type: string;
  constellation: string | null;
  magnitude: number | null;
  /**
   * The id to store this under. `objectId` is the catalog object ("M31"); this keeps an imaging variant
   * ("M31_mosaic", "M16_Ha") so it lands as its own object exactly as a telescope sync stores it, and the
   * Library groups it under the base object's card. Equal to `objectId` for a plain name.
   */
  targetObjectId: string;
}

/**
 * A catalog designation sitting inside a longer folder name.
 *
 * The leading group requires a non-alphanumeric boundary (or the start of the
 * string) so "Seestar_M42" and "2024-01-15_M42" match while a word that merely
 * ends in a number ("Dwarf3") does not. The trailing lookahead rejects a
 * prefix of a longer number so "M421" is not read as "M42".
 */
const DESIGNATION_TOKEN_RE =
  /(?:^|[^A-Za-z0-9])((?:SH2|SHARPLESS|ABELL|BERKELEY|BERK)[\s-]?\d+|(?:NGC|IC|M|C|B|UGC|PGC|ARP|MEL|STOCK|HCG|CED|VDB|LBN|LDN)[\s-]?\d+[A-Za-z]?)(?![0-9])/gi;

function fromEntry(objectId: string, entry: CatalogEntry): IdentifiedObject {
  return {
    objectId,
    targetObjectId: objectId,
    name: entry.name,
    type: entry.type,
    constellation: entry.constellation ?? null,
    magnitude: entry.magnitude ?? null,
  };
}

/** Every distinct designation-shaped token in the folder name. */
function designationTokens(folderName: string): string[] {
  const out: string[] = [];
  for (const match of folderName.matchAll(DESIGNATION_TOKEN_RE)) {
    const normalized = normalizeDesignation(match[1]);
    if (normalized) out.push(normalized);
  }
  return out;
}

/**
 * Resolve a folder name to a catalog object, or null when nothing (or more
 * than one thing) matches confidently.
 *
 * Order matters:
 *  1. The existing exact rule, so designation-shaped folders keep the exact
 *     behaviour (including the imaging-suffix stripping) they had before.
 *  2. One designation embedded in a longer name ("M42 - Orion Nebula").
 *  3. The folder name is an object's display or common name, ignoring case,
 *     spaces, and punctuation ("Bodes Galaxy" -> "Bode's Galaxy").
 */
export function identifyObjectFromFolderName(folderName: string): IdentifiedObject | null {
  const found = identifyBase(folderName);
  if (!found) return null;
  const suffix = variantSuffix(folderName.trim());
  return suffix ? { ...found, targetObjectId: `${found.objectId}${suffix}` } : found;
}

function identifyBase(folderName: string): IdentifiedObject | null {
  const trimmed = folderName.trim();
  if (!trimmed) return null;

  // 1. Exact designation/id, the rule matchCatalog used before. The id is
  //    canonicalized ("m42" -> "M42", "NGC224" -> "M31") so the review screen
  //    shows the same key commitFolderImport stores the object under; the
  //    entry itself was already found case-insensitively.
  const directKey = normalizeCatalogId(trimmed);
  const direct = getCatalogEntry(directKey) || (directKey !== trimmed ? getCatalogEntry(trimmed) : undefined);
  if (direct) return fromEntry(resolveCanonicalId(directKey), direct);

  // 2. A single designation inside a longer folder name. Two distinct ones
  //    ("M81_M82") stay unmatched so the user chooses.
  const found = new Map<string, CatalogEntry>();
  for (const token of designationTokens(trimmed)) {
    const canonicalId = resolveCanonicalId(token);
    if (!canonicalId || found.has(canonicalId)) continue;
    const entry = getCatalogEntry(canonicalId) || getCatalogEntry(token);
    if (entry) found.set(canonicalId, entry);
  }
  if (found.size === 1) {
    const [objectId, entry] = [...found.entries()][0];
    return fromEntry(objectId, entry);
  }
  if (found.size > 1) return null;

  // 3. Full-name match, punctuation-insensitive.
  const byName = findCatalogEntryByExactName(trimmed);
  if (byName) return fromEntry(resolveCanonicalId(byName.id), byName);

  return null;
}
