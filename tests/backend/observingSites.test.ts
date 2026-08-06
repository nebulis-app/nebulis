import { describe, it, expect, beforeEach } from 'vitest';
import db, { seedDefaultObservingSite } from '../../server/lib/db';
import {
  listSites,
  getSite,
  getDefaultSite,
  getActiveSite,
  setActiveSite,
  createSite,
  updateSite,
  deleteSite,
  setDefaultSite,
  resolveSite,
  syncDefaultSiteToAppSettings,
} from '../../server/lib/observingSites';
import { SKY_MAP_CELLS } from '../../server/lib/skyMapConfig';

/** Read the legacy appSettings location columns the native clients consume. */
function readMirror() {
  return db.prepare<[], {
    latitude: number | null; longitude: number | null; locationName: string;
    timezone: string; minAlt: number; horizonProfile: string; visibleSkyMap: string;
  }>(`SELECT latitude, longitude, locationName, timezone, minAlt, horizonProfile, visibleSkyMap
        FROM appSettings WHERE id = 1`).get()!;
}

function setMirror(values: {
  latitude?: number | null; longitude?: number | null; locationName?: string;
  timezone?: string; minAlt?: number; horizonProfile?: string; visibleSkyMap?: string;
}) {
  const current = readMirror();
  const merged = { ...current, ...values };
  db.prepare(
    `UPDATE appSettings SET latitude = ?, longitude = ?, locationName = ?,
       timezone = ?, minAlt = ?, horizonProfile = ?, visibleSkyMap = ? WHERE id = 1`,
  ).run(
    merged.latitude, merged.longitude, merged.locationName,
    merged.timezone, merged.minAlt, merged.horizonProfile, merged.visibleSkyMap,
  );
}

const FLAT_HORIZON = JSON.stringify(Array(36).fill(0));
const EMPTY_MAP = '[]';

describe('observingSites', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM observingSites').run();
    db.prepare('DELETE FROM librarySessions').run();
    db.prepare('DELETE FROM libraryObjects').run();
    db.prepare("UPDATE appSettings SET activeSiteId = '' WHERE id = 1").run();
    setMirror({
      latitude: null, longitude: null, locationName: '',
      timezone: '', minAlt: 20, horizonProfile: FLAT_HORIZON, visibleSkyMap: EMPTY_MAP,
    });
  });

  // ─── Seed migration ───────────────────────────────────────────────────────

  describe('seedDefaultObservingSite', () => {
    it('copies the existing appSettings location into one default site', () => {
      setMirror({
        latitude: 40.7128,
        longitude: -74.006,
        locationName: 'New York, NY',
        timezone: 'America/New_York',
        minAlt: 35,
      });

      expect(seedDefaultObservingSite()).toBe(true);

      const sites = listSites();
      expect(sites).toHaveLength(1);
      expect(sites[0]).toMatchObject({
        name: 'New York, NY',
        latitude: 40.7128,
        longitude: -74.006,
        timezone: 'America/New_York',
        minAlt: 35,
        isDefault: true,
      });
    });

    it('is idempotent — a second call inserts nothing', () => {
      expect(seedDefaultObservingSite()).toBe(true);
      expect(seedDefaultObservingSite()).toBe(false);
      expect(seedDefaultObservingSite()).toBe(false);
      expect(listSites()).toHaveLength(1);
    });

    it('names an unconfigured install "My Location" without inventing coordinates', () => {
      seedDefaultObservingSite();
      const site = getDefaultSite();
      expect(site.name).toBe('My Location');
      expect(site.latitude).toBeNull();
      expect(site.longitude).toBeNull();
    });

    it('preserves a stored sky mask verbatim', () => {
      const mask = Array(SKY_MAP_CELLS).fill(false).map((_, i) => i % 2 === 0);
      setMirror({ latitude: 1, longitude: 2, visibleSkyMap: JSON.stringify(mask) });
      seedDefaultObservingSite();
      expect(getDefaultSite().visibleSkyMap).toEqual(mask);
    });

    it('leaves appSettings byte-identical, so GET /settings cannot move on upgrade', () => {
      // This is the guarantee that makes the change safe to ship on its own:
      // seeding reads appSettings and never writes it, so a shipped iOS/Android
      // build sees exactly the same payload after upgrading. The mirror is only
      // written when the user actually mutates a site.
      const mask = Array(SKY_MAP_CELLS).fill(false).map((_, i) => i % 3 === 0);
      const horizon = Array(36).fill(0).map((_, i) => i % 7);
      setMirror({
        latitude: 51.4778, longitude: -0.0015, locationName: 'Greenwich',
        timezone: 'Europe/London', minAlt: 28,
        horizonProfile: JSON.stringify(horizon), visibleSkyMap: JSON.stringify(mask),
      });
      const before = readMirror();

      expect(seedDefaultObservingSite()).toBe(true);

      expect(readMirror()).toEqual(before);
      expect(listSites()).toHaveLength(1);
    });
  });

  // ─── The appSettings mirror (native-client back-compat) ───────────────────

  describe('syncDefaultSiteToAppSettings', () => {
    it('round-trips every legacy field from the default site', () => {
      const mask = Array(SKY_MAP_CELLS).fill(true);
      const horizon = Array(36).fill(0).map((_, i) => i);
      createSite({
        name: 'Dark Site',
        latitude: 41.02,
        longitude: -74.55,
        timezone: 'America/New_York',
        minAlt: 25,
        horizonProfile: horizon,
        visibleSkyMap: mask,
        isDefault: true,
      });

      const mirror = readMirror();
      expect(mirror.latitude).toBe(41.02);
      expect(mirror.longitude).toBe(-74.55);
      expect(mirror.locationName).toBe('Dark Site');
      expect(mirror.timezone).toBe('America/New_York');
      expect(mirror.minAlt).toBe(25);
      expect(JSON.parse(mirror.horizonProfile)).toEqual(horizon);
      expect(JSON.parse(mirror.visibleSkyMap)).toEqual(mask);
    });

    it('does NOT project the placeholder name when the site has no coordinates', () => {
      // Regression guard: the web UI reads a non-empty locationName as "a
      // location is configured" and would stop prompting the user to set one.
      createSite({ name: 'My Location', isDefault: true });
      expect(readMirror().locationName).toBe('');
    });

    it('follows the default flag rather than a specific site', () => {
      const home = createSite({ name: 'Home', latitude: 10, longitude: 20, isDefault: true });
      const remote = createSite({ name: 'Remote', latitude: 30, longitude: 40 });
      expect(readMirror().latitude).toBe(10);

      setDefaultSite(remote.id);
      expect(readMirror().latitude).toBe(30);
      expect(readMirror().locationName).toBe('Remote');

      setDefaultSite(home.id);
      expect(readMirror().latitude).toBe(10);
    });

    it('re-projects when the default site is edited in place', () => {
      const site = createSite({ name: 'Home', latitude: 10, longitude: 20, isDefault: true });
      updateSite(site.id, { latitude: 11.5, name: 'Home Garden' });
      expect(readMirror().latitude).toBe(11.5);
      expect(readMirror().locationName).toBe('Home Garden');
    });

    it('does not re-project when a non-default site is edited', () => {
      createSite({ name: 'Home', latitude: 10, longitude: 20, isDefault: true });
      const other = createSite({ name: 'Remote', latitude: 30, longitude: 40 });
      updateSite(other.id, { latitude: 33 });
      expect(readMirror().latitude).toBe(10);
    });

    it('is callable directly and is idempotent', () => {
      createSite({ name: 'Home', latitude: 10, longitude: 20, isDefault: true });
      syncDefaultSiteToAppSettings();
      syncDefaultSiteToAppSettings();
      expect(readMirror().latitude).toBe(10);
    });
  });

  // ─── Default-site invariants ──────────────────────────────────────────────

  describe('default site', () => {
    it('makes the very first site the default even when not asked', () => {
      const site = createSite({ name: 'Only', latitude: 1, longitude: 2 });
      expect(site.isDefault).toBe(true);
    });

    it('never leaves two defaults', () => {
      const a = createSite({ name: 'A', latitude: 1, longitude: 2, isDefault: true });
      const b = createSite({ name: 'B', latitude: 3, longitude: 4, isDefault: true });
      const defaults = listSites().filter(s => s.isDefault);
      expect(defaults).toHaveLength(1);
      expect(defaults[0]?.id).toBe(b.id);
      expect(getSite(a.id)?.isDefault).toBe(false);
    });

    it('the unique partial index rejects a second default written behind our back', () => {
      const a = createSite({ name: 'A', latitude: 1, longitude: 2, isDefault: true });
      const b = createSite({ name: 'B', latitude: 3, longitude: 4 });
      expect(a.isDefault).toBe(true);
      expect(() =>
        db.prepare('UPDATE observingSites SET isDefault = 1 WHERE id = ?').run(b.id),
      ).toThrow();
    });

    it('self-heals when no row is flagged default', () => {
      const a = createSite({ name: 'A', latitude: 1, longitude: 2, isDefault: true });
      db.prepare('UPDATE observingSites SET isDefault = 0').run();
      expect(getDefaultSite().id).toBe(a.id);
      expect(getSite(a.id)?.isDefault).toBe(true);
    });

    it('self-heals when the table is empty', () => {
      const site = getDefaultSite();
      expect(site.isDefault).toBe(true);
      expect(listSites()).toHaveLength(1);
      expect(site.name).toBe('My Location');
    });

    it('setDefaultSite returns false for an unknown id and changes nothing', () => {
      const a = createSite({ name: 'A', latitude: 1, longitude: 2, isDefault: true });
      expect(setDefaultSite('nope')).toBe(false);
      expect(getDefaultSite().id).toBe(a.id);
    });
  });

  // ─── Deletion ─────────────────────────────────────────────────────────────

  describe('deleteSite', () => {
    it('refuses to delete the last remaining site', () => {
      const only = createSite({ name: 'Only', latitude: 1, longitude: 2 });
      expect(deleteSite(only.id)).toEqual({ deleted: false, reason: 'last-site' });
      expect(listSites()).toHaveLength(1);
    });

    it('promotes the next site when the default is deleted', () => {
      const a = createSite({ name: 'A', latitude: 1, longitude: 2, isDefault: true });
      const b = createSite({ name: 'B', latitude: 3, longitude: 4 });
      expect(deleteSite(a.id).deleted).toBe(true);
      expect(getDefaultSite().id).toBe(b.id);
      expect(readMirror().latitude).toBe(3);
    });

    it('reports not-found for an unknown id', () => {
      createSite({ name: 'A', latitude: 1, longitude: 2 });
      expect(deleteSite('nope')).toEqual({ deleted: false, reason: 'not-found' });
    });

    it('clears a dangling active pointer', () => {
      createSite({ name: 'A', latitude: 1, longitude: 2, isDefault: true });
      const b = createSite({ name: 'B', latitude: 3, longitude: 4 });
      setActiveSite(b.id);
      deleteSite(b.id);
      expect(getActiveSite().name).toBe('A');
    });
  });

  // ─── Active site ──────────────────────────────────────────────────────────

  describe('getActiveSite', () => {
    it('falls back to the default when nothing is pinned', () => {
      const a = createSite({ name: 'A', latitude: 1, longitude: 2, isDefault: true });
      createSite({ name: 'B', latitude: 3, longitude: 4 });
      expect(getActiveSite().id).toBe(a.id);
    });

    it('returns the pinned site', () => {
      createSite({ name: 'A', latitude: 1, longitude: 2, isDefault: true });
      const b = createSite({ name: 'B', latitude: 3, longitude: 4 });
      setActiveSite(b.id);
      expect(getActiveSite().id).toBe(b.id);
    });

    it('recovers from a stale pointer left by a raw delete', () => {
      const a = createSite({ name: 'A', latitude: 1, longitude: 2, isDefault: true });
      const b = createSite({ name: 'B', latitude: 3, longitude: 4 });
      setActiveSite(b.id);
      db.prepare('DELETE FROM observingSites WHERE id = ?').run(b.id);
      expect(getActiveSite().id).toBe(a.id);
      // And the pointer is cleared so the next read is a plain default lookup.
      expect(
        db.prepare<[], { activeSiteId: string }>('SELECT activeSiteId FROM appSettings WHERE id = 1')
          .get()?.activeSiteId,
      ).toBe('');
    });

    it('setActiveSite(null) unpins', () => {
      const a = createSite({ name: 'A', latitude: 1, longitude: 2, isDefault: true });
      const b = createSite({ name: 'B', latitude: 3, longitude: 4 });
      setActiveSite(b.id);
      setActiveSite(null);
      expect(getActiveSite().id).toBe(a.id);
    });

    it('setActiveSite rejects an unknown id', () => {
      createSite({ name: 'A', latitude: 1, longitude: 2 });
      expect(() => setActiveSite('nope')).toThrow(/Unknown observing site/);
    });
  });

  // ─── resolveSite precedence ───────────────────────────────────────────────

  describe('resolveSite', () => {
    it('prefers an explicit siteId over everything else', () => {
      createSite({ name: 'Default', latitude: 1, longitude: 2, isDefault: true });
      const target = createSite({ name: 'Target', latitude: 3, longitude: 4 });
      const resolved = resolveSite({ siteId: target.id, lat: 50, lon: 60 });
      expect(resolved.id).toBe(target.id);
      expect(resolved.latitude).toBe(3);
    });

    it('falls through to coordinates when the siteId is unknown', () => {
      createSite({ name: 'Default', latitude: 1, longitude: 2, isDefault: true });
      const resolved = resolveSite({ siteId: 'nope', lat: 50, lon: 60 });
      expect(resolved.latitude).toBe(50);
      expect(resolved.isTransient).toBe(true);
    });

    it('builds a transient site from an ad-hoc coordinate pair', () => {
      createSite({
        name: 'Home', latitude: 1, longitude: 2, minAlt: 42,
        visibleSkyMap: Array(SKY_MAP_CELLS).fill(true), isDefault: true,
      });
      const resolved = resolveSite({ lat: 50, lon: 60 });
      expect(resolved.latitude).toBe(50);
      expect(resolved.longitude).toBe(60);
      expect(resolved.isTransient).toBe(true);
      // Sky settings ride along from the active site — the caller gave
      // coordinates, not a horizon.
      expect(resolved.minAlt).toBe(42);
      expect(resolved.visibleSkyMap).toHaveLength(SKY_MAP_CELLS);
      // Timezone is blanked because the base site's zone may not apply at the
      // supplied coordinates; callers re-derive it from lat/lon.
      expect(resolved.timezone).toBe('');
    });

    it('ignores a half-supplied coordinate pair', () => {
      // Regression guard: mixing a client latitude with a stored longitude puts
      // the observer somewhere that is neither location.
      const home = createSite({ name: 'Home', latitude: 1, longitude: 2, isDefault: true });
      expect(resolveSite({ lat: 50 }).id).toBe(home.id);
      expect(resolveSite({ lon: 60 }).id).toBe(home.id);
      expect(resolveSite({ lat: 50 }).latitude).toBe(1);
    });

    it('resolves the active site when given nothing', () => {
      createSite({ name: 'Default', latitude: 1, longitude: 2, isDefault: true });
      const active = createSite({ name: 'Active', latitude: 3, longitude: 4 });
      setActiveSite(active.id);
      expect(resolveSite().id).toBe(active.id);
      expect(resolveSite({}).id).toBe(active.id);
    });

    it('gives a transient site an id distinct from the site it borrowed from', () => {
      // Guards the planner's 2-minute response cache: if a transient site
      // inherited the active site's id, two observers at different coordinates
      // would collide on one cache entry and see each other's targets.
      const home = createSite({ name: 'Home', latitude: 1, longitude: 2, isDefault: true });
      const a = resolveSite({ lat: 50, lon: 60 });
      const b = resolveSite({ lat: 10, lon: 20 });
      expect(a.id).not.toBe(home.id);
      expect(a.id).not.toBe(b.id);
      // Same coordinates resolve to the same key, so caching still works.
      expect(resolveSite({ lat: 50, lon: 60 }).id).toBe(a.id);
    });

    it('accepts a zero coordinate as a real value', () => {
      // 0,0 is in the Gulf of Guinea, but a null-vs-zero mixup here would
      // silently relocate anyone on the prime meridian or the equator.
      createSite({ name: 'Home', latitude: 1, longitude: 2, isDefault: true });
      const resolved = resolveSite({ lat: 0, lon: 0 });
      expect(resolved.latitude).toBe(0);
      expect(resolved.longitude).toBe(0);
      expect(resolved.isTransient).toBe(true);
    });
  });

  // ─── Field validation ─────────────────────────────────────────────────────

  describe('validation', () => {
    it('rejects out-of-range coordinates rather than storing them', () => {
      const site = createSite({ name: 'Bad', latitude: 91, longitude: 181 });
      expect(site.latitude).toBeNull();
      expect(site.longitude).toBeNull();
    });

    it('clamps minAlt into 0-90', () => {
      expect(createSite({ name: 'Low', minAlt: -5 }).minAlt).toBe(0);
      const site = listSites()[0]!;
      expect(updateSite(site.id, { minAlt: 200 })?.minAlt).toBe(90);
    });

    it('falls back to a flat horizon for a wrong-length profile', () => {
      const site = createSite({ name: 'X', horizonProfile: [1, 2, 3] });
      expect(site.horizonProfile).toEqual(Array(36).fill(0));
    });

    it('falls back to an empty mask for a wrong-length sky map', () => {
      const site = createSite({ name: 'X', visibleSkyMap: [true, false] });
      expect(site.visibleSkyMap).toEqual([]);
    });

    it('gives an unnamed site a placeholder rather than an empty name', () => {
      expect(createSite({ name: '   ' }).name).toBe('Untitled site');
      expect(createSite({}).name).toBe('Untitled site');
    });

    it('updateSite leaves absent fields alone', () => {
      const site = createSite({
        name: 'Home', latitude: 1, longitude: 2, timezone: 'UTC', minAlt: 30,
      });
      const updated = updateSite(site.id, { name: 'Renamed' });
      expect(updated).toMatchObject({
        name: 'Renamed', latitude: 1, longitude: 2, timezone: 'UTC', minAlt: 30,
      });
    });

    it('updateSite returns null for an unknown id', () => {
      expect(updateSite('nope', { name: 'X' })).toBeNull();
    });

    it('assigns increasing sortOrder so list order is stable', () => {
      createSite({ name: 'A' });
      createSite({ name: 'B' });
      createSite({ name: 'C' });
      expect(listSites().map(s => s.name)).toEqual(['A', 'B', 'C']);
    });
  });
});
