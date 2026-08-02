import { describe, it, expect, beforeEach } from 'vitest';
import db from '../../server/lib/db';
import { reassignSessionSite } from '../../server/lib/library/observations';
import { createSite } from '../../server/lib/observingSites';

/** Minimal library object + session row, bypassing the import pipeline. */
function seedSession(objectId: string, date: string, extra: Partial<{
  siteId: string | null;
  temperature: number; cloudCover: number; humidity: number;
  windSpeed: number; dewPoint: number; visibility: number; precipProb: number;
}> = {}) {
  // OR IGNORE, not OR REPLACE: librarySessions.objectId has ON DELETE CASCADE,
  // and a REPLACE on a conflicting PK does a delete-then-insert under the
  // hood in SQLite — which would cascade-delete any session rows already
  // seeded for this object by an earlier call in the same test.
  db.prepare(
    'INSERT OR IGNORE INTO libraryObjects (objectId, folderName, fileCount, lastImport) VALUES (?, ?, 1, ?)',
  ).run(objectId, objectId, new Date().toISOString());
  db.prepare(
    `INSERT OR REPLACE INTO librarySessions
       (objectId, date, siteId, temperature, cloudCover, humidity, windSpeed, dewPoint, visibility, precipProb)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    objectId, date,
    extra.siteId ?? null,
    extra.temperature ?? null, extra.cloudCover ?? null, extra.humidity ?? null,
    extra.windSpeed ?? null, extra.dewPoint ?? null, extra.visibility ?? null, extra.precipProb ?? null,
  );
}

function readSession(objectId: string, date: string) {
  return db.prepare(
    `SELECT siteId, temperature, cloudCover, humidity, windSpeed, dewPoint, visibility, precipProb
       FROM librarySessions WHERE objectId = ? AND date = ?`,
  ).get(objectId, date) as {
    siteId: string | null; temperature: number | null; cloudCover: number | null;
    humidity: number | null; windSpeed: number | null; dewPoint: number | null;
    visibility: number | null; precipProb: number | null;
  } | undefined;
}

describe('reassignSessionSite', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM librarySessions').run();
    db.prepare('DELETE FROM libraryObjects').run();
    db.prepare('DELETE FROM observingSites').run();
  });

  it('sets siteId and returns true for an existing session', () => {
    seedSession('M31', '2026-07-01');
    const site = createSite({ name: 'Dark Site', latitude: 1, longitude: 2 });

    expect(reassignSessionSite('M31', '2026-07-01', site.id)).toBe(true);
    expect(readSession('M31', '2026-07-01')?.siteId).toBe(site.id);
  });

  it('clears the tag when siteId is null', () => {
    const site = createSite({ name: 'Dark Site', latitude: 1, longitude: 2 });
    seedSession('M31', '2026-07-01', { siteId: site.id });

    expect(reassignSessionSite('M31', '2026-07-01', null)).toBe(true);
    expect(readSession('M31', '2026-07-01')?.siteId).toBeNull();
  });

  it('returns false for a session that does not exist', () => {
    expect(reassignSessionSite('NoSuchObject', '2026-07-01', null)).toBe(false);
  });

  it('nulls every cached weather column, since they were fetched at the old site', () => {
    // Regression guard: retagging a session without invalidating weather would
    // leave stale conditions from the previous site's coordinates permanently
    // attached to the session (backfillSessionWeather only fills NULL columns,
    // so it would never correct a stale non-null value on its own).
    seedSession('M31', '2026-07-01', {
      temperature: 15, cloudCover: 20, humidity: 60,
      windSpeed: 5, dewPoint: 8, visibility: 10000, precipProb: 0,
    });
    const newSite = createSite({ name: 'New Site', latitude: 5, longitude: 6 });

    reassignSessionSite('M31', '2026-07-01', newSite.id);

    const row = readSession('M31', '2026-07-01');
    expect(row).toMatchObject({
      siteId: newSite.id,
      temperature: null, cloudCover: null, humidity: null,
      windSpeed: null, dewPoint: null, visibility: null, precipProb: null,
    });
  });

  it('does not touch other sessions of the same object', () => {
    const site = createSite({ name: 'Site', latitude: 1, longitude: 2 });
    seedSession('M31', '2026-07-01', { temperature: 12 });
    seedSession('M31', '2026-07-02', { temperature: 14 });

    reassignSessionSite('M31', '2026-07-01', site.id);

    expect(readSession('M31', '2026-07-01')?.siteId).toBe(site.id);
    const untouched = readSession('M31', '2026-07-02');
    expect(untouched?.siteId).toBeNull();
    expect(untouched?.temperature).toBe(14);
  });
});
