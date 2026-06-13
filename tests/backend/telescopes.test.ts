import { describe, it, expect, beforeEach } from 'vitest';
import {
  getAllProfiles,
  getFullSettings,
  createProfile,
  updateProfile,
  deleteProfile,
  type TelescopeProfile,
} from '../../server/lib/telescopes';
import db from '../../server/lib/db';

describe('telescopes', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM telescopeProfiles').run();
    db.prepare(`
      INSERT INTO telescopeProfiles (id, name, model, hostname, shareName, username, password, isActive, createdAt)
      VALUES ('test-1', 'Test Scope', 'SeeStar S50', '10.0.0.1', 'EMMC Images', 'guest', '', 0, '2024-01-01T00:00:00Z')
    `).run();
  });

  it('getAllProfiles returns at least one profile by default', () => {
    const profiles = getAllProfiles();
    expect(profiles.length).toBeGreaterThanOrEqual(1);
    expect(profiles[0].id).toBe('test-1');
  });

  it('createProfile adds a new profile', () => {
    const profile = createProfile({ name: 'Second Scope', hostname: '10.0.0.2' });
    // Profile id is a randomUUID; createdAt is an ISO 8601 timestamp.
    // `toBeTruthy` previously passed for any non-empty string.
    expect(profile.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(profile.name).toBe('Second Scope');
    expect(profile.hostname).toBe('10.0.0.2');
    expect(profile.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    const all = getAllProfiles();
    expect(all).toHaveLength(2);
  });

  it('updateProfile changes fields', () => {
    const updated = updateProfile('test-1', { name: 'Renamed Scope', hostname: '192.168.1.1' });
    expect(updated?.name).toBe('Renamed Scope');
    expect(updated?.hostname).toBe('192.168.1.1');
  });

  it('updateProfile preserves id and createdAt', () => {
    const updated = updateProfile('test-1', {
      id: 'should-not-change',
      createdAt: '2099-01-01T00:00:00Z',
      name: 'Updated Name',
    } as Partial<TelescopeProfile>);
    expect(updated?.id).toBe('test-1');
    expect(updated?.createdAt).toBe('2024-01-01T00:00:00Z');
  });

  it('updateProfile returns null for unknown id', () => {
    const result = updateProfile('nonexistent-id', { name: 'Ghost' });
    expect(result).toBeNull();
  });

  it('deleteProfile removes second profile', () => {
    const second = createProfile({ name: 'Second Scope', hostname: '10.0.0.2' });
    expect(getAllProfiles()).toHaveLength(2);

    const result = deleteProfile(second.id);
    expect(result).toBe(true);
    expect(getAllProfiles()).toHaveLength(1);
    expect(getAllProfiles()[0].id).toBe('test-1');
  });

  it('deleteProfile returns false if only one profile remains', () => {
    const result = deleteProfile('test-1');
    expect(result).toBe(false);
    expect(getAllProfiles()).toHaveLength(1);
  });

  it('deleteProfile returns false for unknown id', () => {
    createProfile({ name: 'Second Scope', hostname: '10.0.0.2' });
    const result = deleteProfile('nonexistent-id');
    expect(result).toBe(false);
  });

  it('getFullSettings returns settings with telescopes array', () => {
    const settings = getFullSettings();
    // beforeEach inserts exactly one profile (id 'test-1'), so the array
    // length and contents are knowable. `>= 1` would pass for duplicates.
    expect(settings.telescopes).toHaveLength(1);
    expect(settings.telescopes[0].id).toBe('test-1');
  });
});
