import { beforeEach, describe, expect, it } from 'vitest';
import db from '../../server/lib/db';
import { getAutoSolveStatus, pendingFiles, tickAutoSolve } from '../../server/lib/annotate/autoSolve';
import { getSettingsData, updateSettingsData } from '../../server/lib/telescopes';

function addFile(relPath: string, role: string, importedAt = '2026-09-14T00:00:00Z', objectId = 'M31'): void {
  const fileName = relPath.split('/').pop()!;
  db.prepare(
    `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, importedAt) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(objectId, relPath, fileName, fileName, role, importedAt);
}

describe('background plate solving', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM libraryFiles').run();
    db.prepare('DELETE FROM fileWcs').run();
    db.prepare('DELETE FROM fileSolveFailures').run();
    updateSettingsData({ annotateAutoSolve: true });
  });

  it('is on unless turned off', () => {
    expect(getSettingsData().annotateAutoSolve).toBe(true);
    updateSettingsData({ annotateAutoSolve: false });
    expect(getSettingsData().annotateAutoSolve).toBe(false);
  });

  it('queues stacked and preview pictures, and nothing else', () => {
    addFile('M31/Stacked_10_M31.jpg', 'stacked');
    addFile('M31/render.png', 'preview');
    addFile('M31/Stacked_10_M31_thn.jpg', 'thumbnail');
    addFile('M31/sub_001.fit', 'sub');
    addFile('M31/Stacked_10_M31.fit', 'stacked'); // a stacked FITS is not a picture
    expect(getAutoSolveStatus().pending).toBe(2);
  });

  it('never queues star trails or the Sun, Moon and planets, which have no stars to match', () => {
    addFile('M31/a.jpg', 'stacked');
    addFile('DWARF Star Trails/2026-04-16/startrails_1.jpg', 'preview', undefined, 'DWARFStarTrails');
    addFile('Moon/moon.jpg', 'stacked', undefined, 'Moon');
    addFile('Jupiter/j.png', 'stacked', undefined, 'Jupiter');
    expect(pendingFiles(40)).toEqual(['M31/a.jpg']);
  });

  it('does not let newer stacked FITS files crowd pictures out of a batch', () => {
    addFile('M31/old.jpg', 'stacked', '2026-09-01T00:00:00Z');
    for (let i = 0; i < 50; i++) addFile(`M31/Stacked_${i}_M31.fit`, 'stacked', '2026-09-20T00:00:00Z');
    expect(pendingFiles(40)).toEqual(['M31/old.jpg']);
  });

  it('does not queue a picture that already has an answer, solved or failed', () => {
    addFile('M31/a.jpg', 'stacked');
    addFile('M31/b.jpg', 'stacked');
    addFile('M31/c.jpg', 'stacked');
    db.prepare(`INSERT INTO fileWcs (relPath, mtimeMs, source, wcsJson, solvedAt) VALUES ('M31/a.jpg', 1, 'astap', '{}', 'x')`).run();
    db.prepare(`INSERT INTO fileSolveFailures (relPath, mtimeMs, message, failedAt) VALUES ('M31/b.jpg', 1, 'no stars', 'x')`).run();
    const status = getAutoSolveStatus();
    expect(status.pending).toBe(1);
    expect(status.solved).toBe(1);
    expect(status.failed).toBe(1);
  });

  it('does nothing while switched off', async () => {
    addFile('M31/a.jpg', 'stacked');
    updateSettingsData({ annotateAutoSolve: false });
    expect(await tickAutoSolve()).toMatchObject({ solved: 0, failed: 0, skippedBecause: 'disabled' });
    expect(getAutoSolveStatus().pending).toBe(1);
  });
});
