import { describe, it, expect, beforeEach } from 'vitest';
import {
  getAll,
  getById,
  add,
  update,
  remove,
  removeByObjectId,
} from '../../server/lib/wishlist';
import db from '../../server/lib/db';

describe('wishlist', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM wishlist').run();
  });

  const sampleItem = {
    objectId: 'M42',
    name: 'Orion Nebula',
    type: 'Nebula',
    constellation: 'Orion',
    magnitude: 4.0,
    majorAxisArcmin: 85,
    priority: 'high' as const,
    notes: '',
  };

  it('getAll returns empty array initially', () => {
    const items = getAll();
    expect(items).toEqual([]);
  });

  it('add creates item with id and addedAt', () => {
    const item = add(sampleItem);
    // Pin the actual shapes — `toBeTruthy` was satisfied by any non-empty
    // string, including a single character.
    expect(item.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(item.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // ISO 8601 timestamp
    expect(item.objectId).toBe('M42');
    expect(item.name).toBe('Orion Nebula');
    expect(item.type).toBe('Nebula');
    expect(item.constellation).toBe('Orion');
    expect(item.magnitude).toBe(4.0);
    expect(item.majorAxisArcmin).toBe(85);
    expect(item.priority).toBe('high');
    expect(item.notes).toBe('');
  });

  it('add prevents duplicate objectId and returns existing', () => {
    const first = add(sampleItem);
    const second = add({ ...sampleItem, name: 'Different Name' });
    expect(second.id).toBe(first.id);
    expect(second.name).toBe('Orion Nebula');
    expect(getAll()).toHaveLength(1);
  });

  it('getById finds added item', () => {
    const added = add(sampleItem);
    const found = getById(added.id);
    // The follow-up `.id` / `.objectId` dereferences would throw on undefined,
    // so the explicit `toBeDefined` was redundant; remove it.
    expect(found?.id).toBe(added.id);
    expect(found?.objectId).toBe('M42');
  });

  it('getById returns undefined for unknown id', () => {
    const result = getById('nonexistent-id');
    expect(result).toBeUndefined();
  });

  it('update changes priority', () => {
    const added = add(sampleItem);
    const updated = update(added.id, { priority: 'low' });
    expect(updated?.priority).toBe('low');
    expect(updated?.objectId).toBe('M42');
  });

  it('update changes notes', () => {
    const added = add(sampleItem);
    const updated = update(added.id, { notes: 'Best seen in winter' });
    expect(updated?.notes).toBe('Best seen in winter');
    expect(updated?.priority).toBe('high');
  });

  it('update returns null for unknown id', () => {
    const result = update('nonexistent-id', { priority: 'medium' });
    expect(result).toBeNull();
  });

  it('remove deletes item and returns true', () => {
    const added = add(sampleItem);
    const result = remove(added.id);
    expect(result).toBe(true);
    expect(getAll()).toHaveLength(0);
  });

  it('remove returns false for unknown id', () => {
    const result = remove('nonexistent-id');
    expect(result).toBe(false);
  });

  it('removeByObjectId removes the correct item', () => {
    add(sampleItem);
    add({
      objectId: 'M31',
      name: 'Andromeda Galaxy',
      type: 'Galaxy',
      constellation: 'Andromeda',
      magnitude: 3.4,
      majorAxisArcmin: 178,
      priority: 'medium',
      notes: '',
    });
    expect(getAll()).toHaveLength(2);

    const result = removeByObjectId('M42');
    expect(result).toBe(true);

    const remaining = getAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].objectId).toBe('M31');
  });

  it('removeByObjectId returns false for unknown objectId', () => {
    const result = removeByObjectId('NONEXISTENT');
    expect(result).toBe(false);
  });
});
