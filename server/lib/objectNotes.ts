import db from './db.js';

export interface ObjectNote { objectId: string; text: string; updatedAt: string }

const stmts = {
  get: db.prepare<[string], ObjectNote>('SELECT objectId, text, updatedAt FROM objectNotes WHERE objectId = ?'),
  upsert: db.prepare(
    `INSERT INTO objectNotes (objectId, text, updatedAt) VALUES (?, ?, ?)
     ON CONFLICT(objectId) DO UPDATE SET text = excluded.text, updatedAt = excluded.updatedAt`,
  ),
  delete: db.prepare('DELETE FROM objectNotes WHERE objectId = ?'),
};

export function getObjectNote(objectId: string): ObjectNote | null {
  return stmts.get.get(objectId) ?? null;
}

export function saveObjectNote(objectId: string, text: string): ObjectNote | null {
  stmts.upsert.run(objectId, text, new Date().toISOString());
  return getObjectNote(objectId);
}

export function deleteObjectNote(objectId: string): void {
  stmts.delete.run(objectId);
}
