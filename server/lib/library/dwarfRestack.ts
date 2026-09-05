/**
 * Dwarf RESTACKED folder: pure helpers shared by the live-sync path
 * (import.ts) and the manual folder-import wizard (commitFolderImport in
 * import.ts).
 *
 * RESTACKED holds DWARFLAB's cloud-combined "MegaStack" of an existing
 * target (or a Siril/PixInsight restack synced back down), one subfolder per
 * stack. It is not itself an observation — it's a processed image of a
 * target the user has (or should have) already imported through an ordinary
 * session folder. Real internal layout is unverified (inferred from a
 * support-chat description, not a real device), so target-name extraction
 * here is deliberately generous and never throws: callers decide, against
 * their own object index, whether the resolved id is a *real*, already-
 * imported object — this module has no I/O and makes no existence claims.
 */
import { normalizeObjectId, mimeTypeForExtension } from '../telescopeFiles.js';
export { mimeTypeForExtension };
import { resolveCanonicalId } from '../catalogAliases.js';
import { getByName as getCatalogEntryByName } from '../dsoCatalog.js';
import { extractTimestampFromSessionFolder } from '../walkers/index.js';
import { isRecord } from '../typeGuards.js';

export const RESTACKED_FOLDER = 'RESTACKED';

/** Sidecar Dwarf writes into every RESTACKED subfolder (and every ordinary
 *  session folder) alongside the stacked image(s): RA/DEC and the `target`
 *  string as the device itself recorded it. Callers do their own I/O; see
 *  `targetFromShotsInfo` for the pure parse step. */
export const SHOTS_INFO_FILENAME = 'shotsInfo.json';

export function isRestackedFolder(name: string): boolean {
  return name.toLowerCase() === RESTACKED_FOLDER.toLowerCase();
}

/** Dwarf writes a redundant low-res preview of `stacked.jpg` under this exact
 *  name in every RESTACKED subfolder. It carries no information `stacked.jpg`
 *  itself doesn't (same shot, just smaller), so it's suppressed everywhere a
 *  processed image can end up: skipped when matching a new RESTACKED sync
 *  (falls through to the archive like an unmatched file, bytes preserved,
 *  just never modeled as a processed image), and filtered out of every list
 *  read in processed.ts so a row already imported before this existed also
 *  stops showing, with no data migration needed. */
const DWARF_THUMBNAIL_PREVIEW = /^stacked_thumbnail\.[a-z0-9]+$/i;

export function isDwarfThumbnailPreviewName(name: string): boolean {
  return DWARF_THUMBNAIL_PREVIEW.test(name);
}

/** Pull the `target` field out of a parsed shotsInfo.json body. Pure --
 *  callers read the file and JSON.parse it themselves and pass in whatever
 *  came out (or `null` on a missing/unreadable/invalid file), so a bad
 *  sidecar degrades to the folder-name fallback in resolveRestackTargetId
 *  rather than throwing. */
export function targetFromShotsInfo(parsed: unknown): string | null {
  if (!isRecord(parsed)) return null;
  const { target } = parsed;
  return typeof target === 'string' && target.trim() ? target : null;
}

/** Strip a trailing Dwarf-style timestamp token off a RESTACKED subfolder
 *  name, when one is present, so what's left is (best-effort) just the
 *  target. Falls back to the whole name when no timestamp token matches. */
function stripTrailingTimestamp(name: string): string {
  const ts = extractTimestampFromSessionFolder(name);
  if (!ts) return name;
  const idx = name.lastIndexOf(ts);
  if (idx <= 0) return name;
  return name.slice(0, idx).replace(/[_\s-]+$/, '');
}

/** Run one candidate target string through the same alias -> catalog-name
 *  fallback chain the folder-import wizard already uses for a manually-typed
 *  target (see commitFolderImport in import.ts). Never returns null for a
 *  non-empty input: an unresolvable-but-plausible string (e.g. an
 *  already-canonical id like "M42") is returned as-is, same as before -- the
 *  caller's existence check against the real object index is what decides
 *  whether it names something real. */
function resolveTargetString(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normalized = normalizeObjectId(trimmed);
  let id = resolveCanonicalId(normalized);
  if (id === normalized) {
    const byName = getCatalogEntryByName(trimmed);
    if (byName) id = resolveCanonicalId(byName.id);
  }
  return id || null;
}

/** Resolve a RESTACKED subfolder to a library objectId.
 *
 *  Prefers `shotsInfoTarget` -- the `target` field out of that subfolder's
 *  own `shotsInfo.json` -- when the caller has one. That's Dwarf's own
 *  record of what it stacked, and it sidesteps the subfolder *name*
 *  entirely, which matters because the name is not just `<TARGET>`: real
 *  Dwarf 3 units were found writing `RESTACKED_DWARF_RAW_TELE_<TARGET>_<mode>_<timestamp>`
 *  (e.g. `RESTACKED_DWARF_RAW_TELE_C 27_Astro_20250709-010411632`), where
 *  `<mode>` is an imaging-mode word like `Astro`/`Duo-Band` that no existing
 *  parser strips, and the trailing timestamp (`YYYYMMDD-HHMMSSmmm`, no
 *  internal dashes) doesn't match either pattern `stripTrailingTimestamp`
 *  recognizes -- so name-only parsing silently fails closed on this layout.
 *
 *  Falls back to parsing the subfolder name itself only when there is no
 *  shotsInfo.json, it's unreadable, or its target string doesn't resolve.
 *  Pure: no I/O, no existence check. */
export function resolveRestackTargetId(rawFolderName: string, shotsInfoTarget?: string | null): string | null {
  if (shotsInfoTarget) {
    const id = resolveTargetString(shotsInfoTarget);
    if (id) return id;
  }
  const trimmed = stripTrailingTimestamp(rawFolderName).trim();
  if (!trimmed) return null;
  return resolveTargetString(trimmed);
}

