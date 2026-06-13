/**
 * Observation notes storage — SQLite backed.
 */
import { randomUUID } from 'crypto';
import SunCalc from 'suncalc';
import db from './db.js';

export interface ObservationNote {
  id: string;
  objectId: string;
  date: string;
  bortleClass: number | null;
  seeingRating: number | null;       // 1-5
  transparencyRating: number | null;  // 1-5
  moonPhase: string | null;
  moonIllumination: number | null;    // 0-100%
  equipment: string;
  notes: string;
  rating: number | null;              // 1-5 personal rating
  location: string;
  createdAt: string;
  updatedAt: string;
}

// Typed prepared statements — row shape flows through `.get()` / `.all()`.
// SQL trust boundary: enforced by notes CREATE TABLE in db.ts.
const stmts = {
  getAll: db.prepare<[], ObservationNote>('SELECT * FROM notes ORDER BY date DESC'),
  getByObject: db.prepare<[string], ObservationNote>('SELECT * FROM notes WHERE objectId = ? ORDER BY date DESC'),
  getByObjectAndDate: db.prepare<[string, string], ObservationNote>('SELECT * FROM notes WHERE objectId = ? AND date = ?'),
  getById: db.prepare<[string], ObservationNote>('SELECT * FROM notes WHERE id = ?'),
  insert: db.prepare(
    `INSERT INTO notes (id, objectId, date, bortleClass, seeingRating, transparencyRating,
     moonPhase, moonIllumination, equipment, notes, rating, location, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  update: db.prepare(
    `UPDATE notes SET objectId = ?, date = ?, bortleClass = ?, seeingRating = ?,
     transparencyRating = ?, moonPhase = ?, moonIllumination = ?, equipment = ?,
     notes = ?, rating = ?, location = ?, updatedAt = ? WHERE id = ?`
  ),
  delete: db.prepare('DELETE FROM notes WHERE id = ?'),
};

export function getAllNotes(): ObservationNote[] {
  return stmts.getAll.all();
}

export function getNotesForObject(objectId: string): ObservationNote[] {
  return stmts.getByObject.all(objectId);
}

export function getNote(objectId: string, date: string): ObservationNote | undefined {
  return stmts.getByObjectAndDate.get(objectId, date);
}

export function getNoteById(id: string): ObservationNote | undefined {
  return stmts.getById.get(id);
}

export function createNote(data: Partial<ObservationNote> & { objectId: string; date: string }): ObservationNote {
  // Auto-calculate moon phase if date is provided
  let moonPhase = data.moonPhase || null;
  let moonIllumination = data.moonIllumination || null;
  const parsedDate = data.date && data.date !== 'unknown' ? new Date(data.date + 'T22:00:00') : null;
  if (parsedDate && !isNaN(parsedDate.getTime()) && (!moonPhase || !moonIllumination)) {
    const moonData = SunCalc.getMoonIllumination(parsedDate);
    moonIllumination = moonIllumination ?? Math.round(moonData.fraction * 100);
    moonPhase = moonPhase ?? getMoonPhaseName(moonData.phase);
  }

  const note: ObservationNote = {
    id: randomUUID(),
    objectId: data.objectId,
    date: data.date,
    bortleClass: data.bortleClass ?? null,
    seeingRating: data.seeingRating ?? null,
    transparencyRating: data.transparencyRating ?? null,
    moonPhase,
    moonIllumination,
    equipment: data.equipment || '',
    notes: data.notes || '',
    rating: data.rating ?? null,
    location: data.location || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  stmts.insert.run(
    note.id, note.objectId, note.date, note.bortleClass, note.seeingRating,
    note.transparencyRating, note.moonPhase, note.moonIllumination,
    note.equipment, note.notes, note.rating, note.location,
    note.createdAt, note.updatedAt
  );

  return note;
}

export function updateNote(id: string, data: Partial<ObservationNote>): ObservationNote | null {
  const existing = stmts.getById.get(id);
  if (!existing) return null;

  const updated: ObservationNote = {
    ...existing,
    ...data,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };

  stmts.update.run(
    updated.objectId, updated.date, updated.bortleClass, updated.seeingRating,
    updated.transparencyRating, updated.moonPhase, updated.moonIllumination,
    updated.equipment, updated.notes, updated.rating, updated.location,
    updated.updatedAt, updated.id
  );

  return updated;
}

export function deleteNote(id: string): boolean {
  const result = stmts.delete.run(id);
  return result.changes > 0;
}

function getMoonPhaseName(phase: number): string {
  if (phase < 0.03 || phase > 0.97) return 'New Moon';
  if (phase < 0.22) return 'Waxing Crescent';
  if (phase < 0.28) return 'First Quarter';
  if (phase < 0.47) return 'Waxing Gibbous';
  if (phase < 0.53) return 'Full Moon';
  if (phase < 0.72) return 'Waning Gibbous';
  if (phase < 0.78) return 'Last Quarter';
  return 'Waning Crescent';
}
