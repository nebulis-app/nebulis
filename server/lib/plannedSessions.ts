/**
 * Planned imaging sessions for the planner timeline. SQLite backed.
 *
 * Single-device install (no per-user partitioning yet). When the app gains
 * multi-user planning, add `userId` and filter every query by it.
 */
import db from './db.js';

export interface PlannedSession {
  id: number;
  objectId: string;
  objectName: string;
  ra: number;
  dec: number;
  startTime: string; // ISO 8601 UTC
  endTime: string;   // ISO 8601 UTC
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlannedSessionInput {
  objectId: string;
  objectName: string;
  ra: number;
  dec: number;
  startTime: string;
  endTime: string;
  notes?: string;
}

const stmts = {
  getAll: db.prepare<[], PlannedSession>('SELECT * FROM plannedSessions ORDER BY startTime ASC'),
  // Range query: every session that overlaps the [from, to) window. Two
  // sessions overlap iff start < to AND end > from.
  getRange: db.prepare<[string, string], PlannedSession>(
    'SELECT * FROM plannedSessions WHERE startTime < ? AND endTime > ? ORDER BY startTime ASC',
  ),
  getById: db.prepare<[number], PlannedSession>('SELECT * FROM plannedSessions WHERE id = ?'),
  insert: db.prepare(
    `INSERT INTO plannedSessions (objectId, objectName, ra, dec, startTime, endTime, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ),
  update: db.prepare(
    `UPDATE plannedSessions
       SET startTime = COALESCE(?, startTime),
           endTime   = COALESCE(?, endTime),
           notes     = COALESCE(?, notes),
           updatedAt = datetime('now')
     WHERE id = ?`,
  ),
  delete: db.prepare('DELETE FROM plannedSessions WHERE id = ?'),
};

export function getAll(): PlannedSession[] {
  return stmts.getAll.all();
}

/** All sessions whose time range overlaps [from, to). */
export function getInRange(from: string, to: string): PlannedSession[] {
  return stmts.getRange.all(to, from);
}

export function getById(id: number): PlannedSession | undefined {
  return stmts.getById.get(id);
}

export function create(input: PlannedSessionInput): PlannedSession {
  const result = stmts.insert.run(
    input.objectId,
    input.objectName,
    input.ra,
    input.dec,
    input.startTime,
    input.endTime,
    input.notes ?? '',
  );
  const row = stmts.getById.get(Number(result.lastInsertRowid));
  if (!row) throw new Error('[plannedSessions] insert succeeded but row not found');
  return row;
}

export function update(
  id: number,
  patch: Partial<Pick<PlannedSession, 'startTime' | 'endTime' | 'notes'>>,
): PlannedSession | null {
  const existing = stmts.getById.get(id);
  if (!existing) return null;
  stmts.update.run(
    patch.startTime ?? null,
    patch.endTime ?? null,
    patch.notes ?? null,
    id,
  );
  return stmts.getById.get(id) ?? null;
}

export function remove(id: number): boolean {
  return stmts.delete.run(id).changes > 0;
}
