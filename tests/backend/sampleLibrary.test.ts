import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import db from '../../server/lib/db';
import {
  plantSampleObject,
  purgeSampleObject,
  SAMPLE_OBJECT_ID,
} from '../../server/lib/library/sampleLibrary';
import { getLibraryDir } from '../../server/lib/libraryPath';
import { getActiveSite, updateSite } from '../../server/lib/observingSites';

function resetSampleState() {
  db.prepare('DELETE FROM sessionProcessedImages').run();
  db.prepare('DELETE FROM libraryFiles').run();
  db.prepare('DELETE FROM librarySessions').run();
  db.prepare('DELETE FROM libraryObjects').run();
  db.prepare('DELETE FROM users').run();
  db.prepare("UPDATE appSettings SET sampleObjectId = '', sampleLibrarySeeded = 0, sampleLocationSiteId = '', sampleLocationPrevName = '' WHERE id = 1").run();
  // Hand the observing site back to its pristine "no location yet" state.
  const site = getActiveSite();
  updateSite(site.id, { name: 'My Location', latitude: null, longitude: null });

  // Wipe any previously planted disk files so each test starts clean.
  const libDir = getLibraryDir();
  const m31 = path.join(libDir, 'M31');
  if (fs.existsSync(m31)) fs.rmSync(m31, { recursive: true, force: true });
}

const plantedId = () =>
  (db.prepare('SELECT sampleObjectId FROM appSettings WHERE id = 1').get() as { sampleObjectId: string }).sampleObjectId;

describe('tour demo object', () => {
  beforeEach(() => {
    resetSampleState();
  });

  it('plants a complete M31 into an empty library', async () => {
    expect((await plantSampleObject()).object).toBe(true);

    const obj = db.prepare('SELECT * FROM libraryObjects WHERE objectId = ?').get(SAMPLE_OBJECT_ID) as Record<string, unknown>;
    expect(obj).toBeTruthy();
    expect(obj.objectName).toBe('Andromeda Galaxy');
    expect(obj.objectType).toBe('Spiral Galaxy');
    expect(obj.galleryImage).toBe('M31/processed/heic0512d.jpg');
    expect(obj.layout).toBe('nested');

    const sessions = db.prepare('SELECT * FROM librarySessions WHERE objectId = ?').all(SAMPLE_OBJECT_ID);
    expect(sessions).toHaveLength(1);

    const proc = db.prepare('SELECT * FROM sessionProcessedImages WHERE objectId = ?').all(SAMPLE_OBJECT_ID);
    expect(proc).toHaveLength(1);

    const files = db.prepare('SELECT * FROM libraryFiles WHERE objectId = ?').all(SAMPLE_OBJECT_ID) as Array<{ role: string }>;
    expect(files.filter(f => f.role === 'sub').length).toBeGreaterThanOrEqual(10);
    expect(files.filter(f => f.role === 'preview')).toHaveLength(3);

    // Actual bytes exist on disk for every recorded file.
    const libDir = getLibraryDir();
    const rows = db.prepare('SELECT relPath FROM libraryFiles WHERE objectId = ?').all(SAMPLE_OBJECT_ID) as Array<{ relPath: string }>;
    for (const row of rows) {
      expect(fs.existsSync(path.join(libDir, row.relPath))).toBe(true);
    }

    // Recorded as ours, so the purge knows it may remove it.
    expect(plantedId()).toBe(SAMPLE_OBJECT_ID);
  });

  it('purge removes every trace: rows, files on disk, and the record', async () => {
    await plantSampleObject();
    const libDir = getLibraryDir();
    expect(fs.existsSync(path.join(libDir, 'M31'))).toBe(true);

    expect(purgeSampleObject().object).toBe(true);

    expect(db.prepare('SELECT COUNT(*) AS n FROM libraryObjects').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM librarySessions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM libraryFiles').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessionProcessedImages').get()).toEqual({ n: 0 });
    expect(fs.existsSync(path.join(libDir, 'M31'))).toBe(false);
    expect(plantedId()).toBe('');
  });

  // The demo object must not be tombstoned the way a user-deleted object is:
  // a tombstone shows up in the trash view and blocks that object from ever
  // syncing off the telescope, so purging the prop would quietly block the
  // user's real Andromeda data.
  it('purge leaves no tombstone that would block a real import later', async () => {
    await plantSampleObject();
    purgeSampleObject();

    const tombstones = db.prepare('SELECT COUNT(*) AS n FROM libraryObjects WHERE deleted = 1').get() as { n: number };
    expect(tombstones.n).toBe(0);
  });

  it('takes user-owned rows attached to the demo object with it', async () => {
    await plantSampleObject();
    db.prepare('INSERT INTO favorites (objectId) VALUES (?)').run(SAMPLE_OBJECT_ID);
    purgeSampleObject();

    const favs = db.prepare('SELECT COUNT(*) AS n FROM favorites WHERE objectId = ?').get(SAMPLE_OBJECT_ID) as { n: number };
    expect(favs.n).toBe(0);
  });

  // The Planner computes nothing without coordinates, so the tour fills them
  // in for its own duration and hands them back afterwards.
  it('plants coordinates so the real Planner can render, then hands the site back', async () => {
    const before = getActiveSite();
    expect(before.latitude).toBeNull();
    expect(before.longitude).toBeNull();

    await plantSampleObject();
    const during = getActiveSite();
    expect(during.latitude).not.toBeNull();
    expect(during.longitude).not.toBeNull();
    // Renamed while borrowed, so it reads as an example rather than as theirs.
    expect(during.name).toContain('Example');

    purgeSampleObject();
    const after = getActiveSite();
    expect(after.latitude).toBeNull();
    expect(after.longitude).toBeNull();
    expect(after.name).toBe(before.name);
  });

  it('never touches coordinates the user set themselves', async () => {
    const site = getActiveSite();
    updateSite(site.id, { name: 'Back garden', latitude: 51.4769, longitude: -0.0005 });

    await plantSampleObject();
    const during = getActiveSite();
    expect(during.name).toBe('Back garden');
    expect(during.latitude).toBeCloseTo(51.4769);

    // And the purge must not clear a location it did not plant.
    purgeSampleObject();
    const after = getActiveSite();
    expect(after.name).toBe('Back garden');
    expect(after.latitude).toBeCloseTo(51.4769);
  });

  it('never plants into a library that already has real objects', async () => {
    db.prepare(`INSERT INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted, deletedAt)
                VALUES ('M42', 'M42', 1, '2025-01-01T00:00:00Z', 0, NULL)`).run();

    // The object half is declined. The location half is independent and may
    // still be planted — a populated library does not imply coordinates.
    expect((await plantSampleObject()).object).toBe(false);

    const m31 = db.prepare('SELECT COUNT(*) AS n FROM libraryObjects WHERE objectId = ?').get(SAMPLE_OBJECT_ID) as { n: number };
    expect(m31.n).toBe(0);
    expect(plantedId()).toBe('');
  });

  it('purge is a no-op when nothing was planted, leaving real objects alone', () => {
    db.prepare(`INSERT INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted, deletedAt)
                VALUES ('M42', 'M42', 1, '2025-01-01T00:00:00Z', 0, NULL)`).run();

    expect(purgeSampleObject().object).toBe(false);

    const m42 = db.prepare('SELECT COUNT(*) AS n FROM libraryObjects WHERE objectId = ?').get('M42') as { n: number };
    expect(m42.n).toBe(1);
  });

  it('planting twice is idempotent (restarting the tour reuses the object)', async () => {
    await plantSampleObject();
    const first = db.prepare('SELECT COUNT(*) AS n FROM libraryFiles').get() as { n: number };

    expect((await plantSampleObject()).object).toBe(true);
    const second = db.prepare('SELECT COUNT(*) AS n FROM libraryFiles').get() as { n: number };
    expect(second.n).toBe(first.n);
  });

  // Older builds planted M31 at boot and left it in the library permanently.
  // Those users must get it cleaned up rather than keeping it forever.
  it('adopts and removes a sample left behind by the previous build', async () => {
    await plantSampleObject();
    // Simulate the old build's record-keeping: the flag it set, and no
    // sampleObjectId, because that column did not exist then.
    db.prepare("UPDATE appSettings SET sampleObjectId = '', sampleLibrarySeeded = 1 WHERE id = 1").run();

    expect(purgeSampleObject().object).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM libraryObjects').get()).toEqual({ n: 0 });
  });

  it('does not adopt a real library that merely happens to contain M31', () => {
    db.prepare(`INSERT INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted, deletedAt)
                VALUES ('M31', 'M31', 4, '2025-01-01T00:00:00Z', 0, NULL)`).run();
    db.prepare("UPDATE appSettings SET sampleObjectId = '', sampleLibrarySeeded = 1 WHERE id = 1").run();

    // Real files, not the synthetic session folder the planter writes.
    db.prepare(`INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, bytes, importedAt)
                VALUES ('M31','M31/2024-08-01_21-00-00/real.fit','real.fit','real.fit','sub',10,'2025-01-01T00:00:00Z')`).run();

    expect(purgeSampleObject().object).toBe(false);

    const m31 = db.prepare('SELECT COUNT(*) AS n FROM libraryObjects WHERE objectId = ?').get(SAMPLE_OBJECT_ID) as { n: number };
    expect(m31.n).toBe(1);
  });
});
