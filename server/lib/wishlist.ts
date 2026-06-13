/**
 * Wishlist / target queue persistence — SQLite backed.
 */
import { randomUUID } from 'crypto';
import db from './db.js';

export interface WishlistItem {
  id: string;
  objectId: string;
  name: string;
  type: string;
  constellation: string | null;
  magnitude: number | null;
  majorAxisArcmin: number | null;
  priority: 'high' | 'medium' | 'low';
  notes: string;
  addedAt: string;
}

// Typed prepared statements — row shape is declared once per statement and
// propagates through `.get()` / `.all()`. SQL trust boundary: column types
// are enforced by the CREATE TABLE in db.ts.
const stmts = {
  getAll: db.prepare<[], WishlistItem>('SELECT * FROM wishlist ORDER BY addedAt DESC'),
  getById: db.prepare<[string], WishlistItem>('SELECT * FROM wishlist WHERE id = ?'),
  getByObjectId: db.prepare<[string], WishlistItem>('SELECT * FROM wishlist WHERE objectId = ?'),
  insert: db.prepare(
    `INSERT INTO wishlist (id, objectId, name, type, constellation, magnitude, majorAxisArcmin, priority, notes, addedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  update: db.prepare('UPDATE wishlist SET priority = COALESCE(?, priority), notes = COALESCE(?, notes) WHERE id = ?'),
  delete: db.prepare('DELETE FROM wishlist WHERE id = ?'),
  deleteByObjectId: db.prepare('DELETE FROM wishlist WHERE objectId = ?'),
};

export function getAll(): WishlistItem[] {
  return stmts.getAll.all();
}

export function getById(id: string): WishlistItem | undefined {
  return stmts.getById.get(id);
}

export function add(data: Omit<WishlistItem, 'id' | 'addedAt'>): WishlistItem {
  // Prevent duplicates
  const existing = stmts.getByObjectId.get(data.objectId);
  if (existing) return existing;

  const item: WishlistItem = {
    ...data,
    id: randomUUID(),
    addedAt: new Date().toISOString(),
  };
  stmts.insert.run(
    item.id, item.objectId, item.name, item.type, item.constellation,
    item.magnitude, item.majorAxisArcmin, item.priority, item.notes, item.addedAt
  );
  return item;
}

export function update(id: string, data: Partial<Pick<WishlistItem, 'priority' | 'notes'>>): WishlistItem | null {
  const existing = stmts.getById.get(id);
  if (!existing) return null;
  stmts.update.run(data.priority ?? null, data.notes ?? null, id);
  return stmts.getById.get(id) ?? null;
}

export function remove(id: string): boolean {
  const result = stmts.delete.run(id);
  return result.changes > 0;
}

export function removeByObjectId(objectId: string): boolean {
  const result = stmts.deleteByObjectId.run(objectId);
  return result.changes > 0;
}
