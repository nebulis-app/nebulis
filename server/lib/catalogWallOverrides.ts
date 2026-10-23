/**
 * Persistence for the edits a user makes on their "My Catalog" wall: a tile's
 * size, which of their own pictures it shows, and its crop (centre + zoom).
 *
 * Keyed by (catalog, tileId) so an object can be large in Messier and small in
 * Caldwell. Stored server-side so the layout follows the user across devices
 * and into the poster.
 */
import db from './db.js';

export interface WallOverrideRecord {
  span?: { cols: number; rows: number };
  imagePath?: string;
  /** Centre of the crop window (0-1 each axis). */
  focus?: { x: number; y: number };
  /** 1 = the whole cover window, higher zooms in on `focus`. */
  zoom?: number;
}

interface Row {
  tileId: string;
  cols: number | null;
  rows: number | null;
  imagePath: string | null;
  focusX: number | null;
  focusY: number | null;
  zoom: number | null;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS catalogWallOverrides (
    catalog   TEXT NOT NULL,
    tileId    TEXT NOT NULL,
    cols      INTEGER,
    rows      INTEGER,
    imagePath TEXT,
    focusX    REAL,
    focusY    REAL,
    PRIMARY KEY (catalog, tileId)
  );
`);
// Added after the table first shipped.
if (!db.prepare('PRAGMA table_info(catalogWallOverrides)').all().some(c => (c as { name: string }).name === 'zoom')) {
  db.exec('ALTER TABLE catalogWallOverrides ADD COLUMN zoom REAL');
}

const stmts = {
  all: db.prepare<[string], Row>('SELECT tileId, cols, rows, imagePath, focusX, focusY, zoom FROM catalogWallOverrides WHERE catalog = ?'),
  upsert: db.prepare(
    `INSERT INTO catalogWallOverrides (catalog, tileId, cols, rows, imagePath, focusX, focusY, zoom)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(catalog, tileId) DO UPDATE SET
       cols = excluded.cols, rows = excluded.rows, imagePath = excluded.imagePath,
       focusX = excluded.focusX, focusY = excluded.focusY, zoom = excluded.zoom`,
  ),
  remove: db.prepare('DELETE FROM catalogWallOverrides WHERE catalog = ? AND tileId = ?'),
  removeAll: db.prepare('DELETE FROM catalogWallOverrides WHERE catalog = ?'),
};

export function getWallOverrides(catalog: string): Record<string, WallOverrideRecord> {
  const out: Record<string, WallOverrideRecord> = {};
  for (const r of stmts.all.all(catalog)) {
    const o: WallOverrideRecord = {};
    if (r.cols != null && r.rows != null) o.span = { cols: r.cols, rows: r.rows };
    if (r.imagePath) o.imagePath = r.imagePath;
    if (r.focusX != null && r.focusY != null) o.focus = { x: r.focusX, y: r.focusY };
    if (r.zoom != null) o.zoom = r.zoom;
    out[r.tileId] = o;
  }
  return out;
}

/** Replace one tile's override wholesale; an empty override removes the row. */
function setOne(catalog: string, tileId: string, o: WallOverrideRecord): void {
  if (!o.span && !o.imagePath && !o.focus && o.zoom == null) {
    stmts.remove.run(catalog, tileId);
    return;
  }
  stmts.upsert.run(
    catalog, tileId,
    o.span?.cols ?? null, o.span?.rows ?? null,
    o.imagePath ?? null,
    o.focus?.x ?? null, o.focus?.y ?? null,
    o.zoom ?? null,
  );
}

/** Apply a whole edit session atomically: `set` replaces, `clear` removes. */
export const applyWallOverrides = db.transaction(
  (catalog: string, set: Record<string, WallOverrideRecord>, clear: string[]) => {
    for (const id of clear) stmts.remove.run(catalog, id);
    for (const [id, o] of Object.entries(set)) setOne(catalog, id, o);
  },
);

export function resetWallOverrides(catalog: string): void {
  stmts.removeAll.run(catalog);
}
