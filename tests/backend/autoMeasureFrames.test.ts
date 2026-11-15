import { beforeEach, describe, expect, it } from 'vitest';
import db from '../../server/lib/db';
import { pendingFrames, pendingLinkedFrames, measureLinkedFramesNightly, tickAutoMeasure } from '../../server/lib/frameAnalysis/autoMeasure';
import { setAnalyzeFrames, updateSource } from '../../server/lib/library/librarySources';
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

describe('analyze a linked folder at night', () => {
  function addSource(id: string, importOptions: object, enabled = 1): void {
    db.prepare(
      `INSERT INTO librarySources (id, label, rootPath, fingerprint, enabled, createdAt, importOptions, overrides, refreshIntervalMin)
       VALUES (?, ?, ?, NULL, ?, '2026-10-01T00:00:00Z', ?, '[]', NULL)`,
    ).run(id, id, `/mnt/${id}`, enabled, JSON.stringify(importOptions));
  }
  function addLinked(sourceId: string, name: string): string {
    const relPath = `@src/${sourceId}/${name}`;
    db.prepare(
      `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, sourceId, sourcePath, importedAt)
       VALUES ('M31', ?, ?, ?, 'sub', ?, ?, '2026-10-01T00:00:00Z')`,
    ).run(relPath, name, name, sourceId, name);
    return relPath;
  }

  beforeEach(() => {
    db.prepare('DELETE FROM libraryFiles').run();
    db.prepare('DELETE FROM frameMetrics').run();
    db.prepare('DELETE FROM librarySources').run();
    updateSettingsData({ autoMeasureFrames: false });
  });

  it('queues only the frames of enabled folders that asked for it', () => {
    addSource('on', { importSubFrames: true, analyzeFrames: true });
    addSource('off', { importSubFrames: true });
    addSource('paused', { analyzeFrames: true }, 0);
    const wanted = addLinked('on', 'a.fit');
    addLinked('off', 'b.fit');
    addLinked('paused', 'c.fit');
    expect(pendingLinkedFrames(10)).toEqual([wanted]);
  });

  it('does not depend on the global "Analyze frames after import" setting', () => {
    addSource('on', { analyzeFrames: true });
    addLinked('on', 'a.fit');
    expect(getSettingsData().autoMeasureFrames).toBe(false);
    expect(pendingLinkedFrames(10)).toHaveLength(1);
  });

  it('turns the option on and off without losing the folder\'s other link options', () => {
    addSource('s', { importSubFrames: true, importFits: false });
    setAnalyzeFrames('s', true);
    expect(JSON.parse(String(updateSource('s', {}).importOptions))).toEqual({ importSubFrames: true, importFits: false, analyzeFrames: true });
    expect(JSON.parse(String(updateSource('s', { analyzeFrames: false }).importOptions))).toEqual({ importSubFrames: true, importFits: false, analyzeFrames: false });
  });

  it('measures what is queued, leaves an unreadable frame for a later night, and reports it finished', async () => {
    addSource('on', { analyzeFrames: true });
    addLinked('on', 'missing-on-disk.fit');
    const first = await measureLinkedFramesNightly();
    expect(first).toEqual({ measured: 0, failed: 1, stoppedFor: 'done' });
    // The same unreadable frame is not retried on this run of the server.
    expect(pendingLinkedFrames(10)).toEqual([]);
  });
});
