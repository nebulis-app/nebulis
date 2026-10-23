import { beforeEach, describe, expect, it } from 'vitest';
import db from '../../server/lib/db';
import { pendingFrames, tickAutoMeasure } from '../../server/lib/frameAnalysis/autoMeasure';
import { FRAME_METRICS_VERSION } from '../../server/lib/frameAnalysis/measure';
import { getSettingsData, updateSettingsData } from '../../server/lib/telescopes';

function addFile(relPath: string, role: string, importedAt = '2026-10-01T00:00:00Z'): void {
  const fileName = relPath.split('/').pop()!;
  db.prepare(
    `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, importedAt) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('M31', relPath, fileName, fileName, role, importedAt);
}

describe('analyze frames after import', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM libraryFiles').run();
    db.prepare('DELETE FROM frameMetrics').run();
    updateSettingsData({ autoMeasureFrames: false });
  });

  it('is off unless turned on', () => {
    expect(getSettingsData().autoMeasureFrames).toBe(false);
    updateSettingsData({ autoMeasureFrames: true });
    expect(getSettingsData().autoMeasureFrames).toBe(true);
  });

  it('does nothing while the setting is off', async () => {
    addFile('M31/sub_001.fit', 'sub');
    expect((await tickAutoMeasure()).skippedBecause).toBe('disabled');
  });

  it('queues raw FITS frames that have no current measurement, newest first, and nothing else', () => {
    addFile('M31/sub_001.fit', 'sub', '2026-10-01T00:00:00Z');
    addFile('M31/sub_002.fit', 'sub', '2026-10-02T00:00:00Z');
    addFile('M31/sub_003.fit', 'sub', '2026-10-03T00:00:00Z');
    addFile('M31/sub_004.jpg', 'sub');
    addFile('M31/Stacked_10_M31.fit', 'stacked');
    addFile('M31/sub_005_thn.jpg', 'thumbnail');
    db.prepare(
      'INSERT INTO frameMetrics (relPath, size, mtimeMs, version, metricsJson, measuredAt) VALUES (?, 1, 1, ?, ?, ?)',
    ).run('M31/sub_001.fit', FRAME_METRICS_VERSION, '{}', '2026-10-01T00:00:00Z');
    expect(pendingFrames(10)).toEqual(['M31/sub_003.fit', 'M31/sub_002.fit']);
  });

  it('queues a frame measured by an older version of the analyzer again', () => {
    addFile('M31/sub_001.fit', 'sub');
    db.prepare(
      'INSERT INTO frameMetrics (relPath, size, mtimeMs, version, metricsJson, measuredAt) VALUES (?, 1, 1, ?, ?, ?)',
    ).run('M31/sub_001.fit', FRAME_METRICS_VERSION - 1, '{}', '2026-10-01T00:00:00Z');
    expect(pendingFrames(10)).toEqual(['M31/sub_001.fit']);
  });

  it('does not queue frames whose file is gone from the library', () => {
    addFile('M31/sub_001.fit', 'sub');
    db.prepare("UPDATE libraryFiles SET missingSince = '2026-10-05T00:00:00Z'").run();
    expect(pendingFrames(10)).toEqual([]);
  });
});
