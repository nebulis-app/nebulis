/**
 * Move a library object from one objectId to another, across every table that
 * keys rows by it.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Two boot migrations rewrite objectIds: the space-strip ("M 16" → "M16") and
 * the catalog-alias fold ("C30" → "NGC7331"). Both used to hand-list the tables
 * to touch, and both missed `libraryFiles` entirely and the `layout` column of
 * `libraryObjects`. A renamed object therefore came back with its per-file rows
 * still pointing at the old id (so the read path found none) and its on-disk
 * layout forgotten (a nested object then read as empty — "No stacked image" on
 * every session). One helper that knows the full table set is the only way to
 * keep the two migrations, and any future rename path, honest.
 *
 * ── The two modes ──────────────────────────────────────────────────────────
 *
 *   rename  the destination id does NOT exist yet. Every row moves.
 *   merge   the destination id already exists. Rows move where they don't
 *           collide with one the destination already has; the colliding
 *           originals are dropped (the destination's copy wins).
 *
 * Both are expressed as `UPDATE OR IGNORE ... SET objectId` followed by
 * `DELETE ... WHERE objectId = <old>`, which is column-agnostic: it never needs
 * to enumerate a table's columns, so a schema change to any of these tables
 * cannot silently desync this helper. In rename mode nothing collides, so the
 * UPDATE moves everything and the DELETE is a no-op; in merge mode the UPDATE
 * skips the colliding rows and the DELETE clears them.
 *
 * ── Caller contract ────────────────────────────────────────────────────────
 *
 * `PRAGMA foreign_keys` is a no-op inside a transaction, and `librarySessions`
 * / `libraryDeletedSessions` have an FK onto `libraryObjects(objectId)` with no
 * ON UPDATE action. So the caller MUST disable foreign keys *outside* the
 * transaction and wrap the call in `db.transaction(...)`:
 *
 *   db.pragma('foreign_keys = OFF');
 *   db.transaction(() => { rekeyLibraryObject(old, canonical); })();
 *   db.pragma('foreign_keys = ON');
 */
import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { getLibraryDir } from '../libraryPath.js';
import { writeObjectManifest, MANIFEST_NAME } from './libraryFiles.js';

/**
 * Every table that stores a per-object `objectId`, other than `libraryObjects`
 * itself (handled separately so its `fileCount` can be summed on a merge).
 *
 * Keep this list complete. A new table with an `objectId` column that is scoped
 * to a library object belongs here — leaving it out is exactly the bug this
 * module was written to stop. Catalog-metadata tables keyed by designation
 * (`catalogCache`, `catalogOverrides`) are intentionally included: after a fold
 * the metadata the user saw under the old id should follow it.
 */
const OBJECT_ID_TABLES = [
  'librarySessions',
  'libraryDeletedSessions',
  'libraryFiles',
  'captureInfo',
  'notes',
  'wishlist',
  'favorites',
  'sessionProcessedImages',
  'processingRuns',
  'plannedSessions',
  'sessionImportLog',
  'catalogCache',
  'catalogOverrides',
] as const;

function rewriteManifest(objectId: string, folderName: string): void {
  try {
    const objDir = path.join(getLibraryDir(), folderName);
    if (!fs.existsSync(objDir)) return;
    const hasRows = db
      .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM libraryFiles WHERE objectId = ?')
      .get(objectId);
    if ((hasRows?.n ?? 0) > 0) {
      // Rewrites `.nebulis-files.json` with the new id in its envelope, so a
      // later rebuildFromManifests() restores rows under the new id.
      writeObjectManifest(objectId, folderName);
    } else {
      // No rows to describe — drop a stale manifest rather than leave one
      // naming the old id.
      try { fs.rmSync(path.join(objDir, MANIFEST_NAME), { force: true }); } catch { /* best effort */ }
    }
  } catch {
    /* a manifest is a convenience, never the authority — see writeObjectManifest */
  }
}

/**
 * Move `fromId` → `toId` across `libraryObjects` and every table in
 * `OBJECT_ID_TABLES`. Chooses rename vs merge automatically from whether `toId`
 * already has a `libraryObjects` row. Preserving `folderName` for disk access
 * is the caller's job (both migrations already do it); it is only read here for
 * the manifest rewrite.
 *
 * Returns the mode taken, for logging. Pass `skipManifest` when a bulk manifest
 * pass will follow.
 */
export function rekeyLibraryObject(
  fromId: string,
  toId: string,
  opts: { skipManifest?: boolean } = {},
): 'rename' | 'merge' | 'noop' {
  if (fromId === toId) return 'noop';

  const folderRow = db
    .prepare<[string], { folderName: string }>('SELECT folderName FROM libraryObjects WHERE objectId = ?')
    .get(fromId);
  if (!folderRow) return 'noop'; // nothing to move

  const destExists = !!db
    .prepare<[string], { objectId: string }>('SELECT objectId FROM libraryObjects WHERE objectId = ?')
    .get(toId);

  for (const table of OBJECT_ID_TABLES) {
    db.prepare(`UPDATE OR IGNORE ${table} SET objectId = ? WHERE objectId = ?`).run(toId, fromId);
    db.prepare(`DELETE FROM ${table} WHERE objectId = ?`).run(fromId);
  }

  if (destExists) {
    // Merge: fold the source's file count / recency into the destination, then
    // drop the source row.
    db.prepare(`
      UPDATE libraryObjects SET
        fileCount  = fileCount + COALESCE((SELECT fileCount FROM libraryObjects WHERE objectId = ?), 0),
        lastImport = MAX(lastImport, COALESCE((SELECT lastImport FROM libraryObjects WHERE objectId = ?), lastImport))
      WHERE objectId = ?
    `).run(fromId, fromId, toId);
    db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run(fromId);
  } else {
    // Rename: the whole row moves, carrying every column (layout,
    // primaryTelescopeId, galleryImageUserSet, enrichment*, …) with it.
    db.prepare('UPDATE libraryObjects SET objectId = ? WHERE objectId = ?').run(toId, fromId);
  }

  // On a merge the destination keeps its own folder; on a rename the folder
  // name is preserved by the caller, so the source row's is still correct.
  const folderName = destExists
    ? db.prepare<[string], { folderName: string }>('SELECT folderName FROM libraryObjects WHERE objectId = ?').get(toId)?.folderName
    : folderRow.folderName;
  if (!opts.skipManifest && folderName) rewriteManifest(toId, folderName);

  return destExists ? 'merge' : 'rename';
}
