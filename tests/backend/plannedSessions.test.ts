import { describe, it, expect, beforeEach } from 'vitest';
import { create, update, getInRange, getAll, getById } from '../../server/lib/plannedSessions';
import db from '../../server/lib/db';

describe('plannedSessions', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM plannedSessions').run();
  });

  const sample = {
    objectId: 'M42',
    objectName: 'Orion Nebula',
    ra: 5.588,
    dec: -5.391,
    startTime: '2026-06-12T03:00:00.000Z',
    endTime: '2026-06-12T04:00:00.000Z',
  };

  it('create stores canonical millisecond-precision UTC timestamps', () => {
    const row = create(sample);
    expect(row.startTime).toBe('2026-06-12T03:00:00.000Z');
    expect(row.endTime).toBe('2026-06-12T04:00:00.000Z');
  });

  it('create canonicalizes a fraction-less timestamp (Android ISO_INSTANT form)', () => {
    // Android's DateTimeFormatter.ISO_INSTANT drops ".000" when millis are zero.
    // Both clients must land on the same stored bytes so range/order queries agree.
    const row = create({ ...sample, startTime: '2026-06-12T03:00:00Z' });
    expect(row.startTime).toBe('2026-06-12T03:00:00.000Z');
  });

  it('update canonicalizes a patched timestamp but leaves absent fields untouched', () => {
    const row = create(sample);
    const updated = update(row.id, { endTime: '2026-06-12T05:00:00Z' });
    expect(updated?.startTime).toBe('2026-06-12T03:00:00.000Z');
    expect(updated?.endTime).toBe('2026-06-12T05:00:00.000Z');
  });

  it('range query includes a session written in fraction-less form at the boundary', () => {
    // Regression: string comparison put "…00Z" after "…00.000Z", so a
    // fraction-less start could sort wrong relative to the query bound. After
    // canonicalization both sides are byte-comparable.
    create({ ...sample, startTime: '2026-06-12T03:00:00Z', endTime: '2026-06-12T03:30:00Z' });
    const results = getInRange('2026-06-12T03:00:00.000Z', '2026-06-12T06:00:00.000Z');
    expect(results).toHaveLength(1);
    expect(results[0]?.startTime).toBe('2026-06-12T03:00:00.000Z');
  });

  it('range query excludes a session ending exactly at the window start (no overlap)', () => {
    // Ends at 03:00, window starts at 03:00 → zero-overlap, must be excluded.
    // This is the case the fraction mismatch previously corrupted.
    create({ ...sample, startTime: '2026-06-12T02:00:00Z', endTime: '2026-06-12T03:00:00Z' });
    const results = getInRange('2026-06-12T03:00:00.000Z', '2026-06-12T06:00:00.000Z');
    expect(results).toHaveLength(0);
  });

  it('getAll orders by startTime with mixed-precision inputs canonicalized', () => {
    create({ ...sample, objectId: 'B', startTime: '2026-06-12T04:00:00.500Z', endTime: '2026-06-12T05:00:00Z' });
    create({ ...sample, objectId: 'A', startTime: '2026-06-12T03:00:00Z', endTime: '2026-06-12T03:30:00Z' });
    const all = getAll();
    expect(all.map(s => s.objectId)).toEqual(['A', 'B']);
  });

  it('getById round-trips a created row', () => {
    const row = create(sample);
    expect(getById(row.id)?.objectId).toBe('M42');
  });

  it('a new session has no framingSetup until one is saved', () => {
    const row = create(sample);
    expect(row.framingSetup).toBeNull();
  });

  it('update stores framingSetup and leaves it untouched when absent from a later patch', () => {
    const row = create(sample);
    const withFraming = update(row.id, { framingSetup: '{"cols":2,"rows":2,"overlap":0.1,"rotationDeg":15}' });
    expect(withFraming?.framingSetup).toBe('{"cols":2,"rows":2,"overlap":0.1,"rotationDeg":15}');

    const afterUnrelatedPatch = update(row.id, { notes: 'clear skies' });
    expect(afterUnrelatedPatch?.framingSetup).toBe('{"cols":2,"rows":2,"overlap":0.1,"rotationDeg":15}');
  });
});

describe('plannedSessions filterBand', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM plannedSessions').run();
  });
  const block = {
    objectId: 'NGC6888', objectName: 'Crescent Nebula', ra: 20.2, dec: 38.35,
    startTime: '2026-09-05T21:00:00.000Z', endTime: '2026-09-05T23:00:00.000Z',
  };

  it('is null unless set, can be set on create and patched', () => {
    expect(create(block).filterBand).toBeNull();
    const nb = create({ ...block, filterBand: 'narrowband' });
    expect(nb.filterBand).toBe('narrowband');
    expect(update(nb.id, { filterBand: 'broadband' })?.filterBand).toBe('broadband');
  });

  it('is left alone by other patches and cleared by an explicit null', () => {
    const row = create({ ...block, filterBand: 'narrowband' });
    expect(update(row.id, { notes: 'D2 filter' })?.filterBand).toBe('narrowband');
    expect(update(row.id, { filterBand: null })?.filterBand).toBeNull();
  });
});

describe('plannedSessions filter', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM plannedSessions').run();
  });
  it('stores the picked filter, trims it, and clears it with null', () => {
    const row = create({
      objectId: 'NGC6888', objectName: 'Crescent Nebula', ra: 20.2, dec: 38.35,
      startTime: '2026-09-05T21:00:00.000Z', endTime: '2026-09-05T23:00:00.000Z', filter: ' D2 ', filterBand: 'narrowband',
    });
    expect(row).toMatchObject({ filter: 'D2', filterBand: 'narrowband' });
    expect(update(row.id, { notes: 'x' })?.filter).toBe('D2');
    expect(update(row.id, { filter: null })?.filter).toBeNull();
  });
});
