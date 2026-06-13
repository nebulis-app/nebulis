import { describe, it, expect, beforeEach } from 'vitest';
import {
  getAllNotes,
  getNotesForObject,
  getNote,
  getNoteById,
  createNote,
  updateNote,
  deleteNote,
} from '../../server/lib/notes';
import db from '../../server/lib/db';

describe('notes', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM notes').run();
  });

  it('creates a note', () => {
    const note = createNote({
      objectId: 'M42',
      date: '2024-10-15',
      notes: 'Great seeing tonight',
      bortleClass: 4,
    });

    // randomUUID() output: 8-4-4-4-12 hex chars. `length > 0` was satisfied
    // by any non-empty string (e.g. 'x'), so it didn't actually pin shape.
    expect(note.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(note.objectId).toBe('M42');
    expect(note.date).toBe('2024-10-15');
    expect(note.notes).toBe('Great seeing tonight');
    expect(note.bortleClass).toBe(4);
    expect(new Date(note.createdAt).toString()).not.toBe('Invalid Date');
  });

  it('auto-calculates moon phase', () => {
    const note = createNote({
      objectId: 'M31',
      date: '2024-01-15',
    });

    // SunCalc.getMoonIllumination(2024-01-15) returns a Waxing Crescent at
    // roughly 26–27% illumination. We check phase name exactly and pin
    // illumination to a ±2% window so minor suncalc precision shifts don't
    // cause spurious failures.
    expect(note.moonPhase).toBe('Waxing Crescent');
    expect(note.moonIllumination).toBeGreaterThanOrEqual(24);
    expect(note.moonIllumination).toBeLessThanOrEqual(29);
  });

  it('retrieves notes for an object', () => {
    createNote({ objectId: 'M42', date: '2024-10-15' });
    createNote({ objectId: 'M42', date: '2024-10-20' });
    createNote({ objectId: 'M31', date: '2024-10-15' });

    const m42Notes = getNotesForObject('M42');
    expect(m42Notes).toHaveLength(2);

    const m31Notes = getNotesForObject('M31');
    expect(m31Notes).toHaveLength(1);
  });

  it('gets a specific note by object and date', () => {
    createNote({ objectId: 'M42', date: '2024-10-15', notes: 'first' });

    const note = getNote('M42', '2024-10-15');
    expect(note).toBeDefined();
    expect(note!.notes).toBe('first');
  });

  it('returns undefined for non-existent note', () => {
    const note = getNote('NOTREAL', '2024-01-01');
    expect(note).toBeUndefined();
  });

  it('gets a note by id', () => {
    const created = createNote({ objectId: 'M42', date: '2024-10-15', notes: 'test note' });
    const found = getNoteById(created.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(created.id);
    expect(found!.objectId).toBe('M42');
    expect(found!.notes).toBe('test note');
  });

  it('returns undefined for non-existent note id', () => {
    expect(getNoteById('nonexistent-id')).toBeUndefined();
  });

  it('updates a note', () => {
    const created = createNote({ objectId: 'M42', date: '2024-10-15', notes: 'original' });
    const updated = updateNote(created.id, { notes: 'updated text', seeingRating: 4 });

    expect(updated).not.toBeNull();
    expect(updated!.notes).toBe('updated text');
    expect(updated!.seeingRating).toBe(4);
    expect(updated!.objectId).toBe('M42'); // Unchanged fields preserved
  });

  it('returns null when updating non-existent note', () => {
    const result = updateNote('nonexistent-id', { notes: 'test' });
    expect(result).toBeNull();
  });

  it('deletes a note', () => {
    const created = createNote({ objectId: 'M42', date: '2024-10-15' });
    const deleted = deleteNote(created.id);
    expect(deleted).toBe(true);

    const all = getAllNotes();
    expect(all).toHaveLength(0);
  });

  it('returns false when deleting non-existent note', () => {
    expect(deleteNote('nonexistent')).toBe(false);
  });

  it('should set moonPhase to null when date is unparseable', () => {
    const note = createNote({
      objectId: 'M42',
      date: 'unknown',
    });
    // Should not crash, just skip moon calculation
    expect(note.moonPhase).toBeNull();
  });
});
