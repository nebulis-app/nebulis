import { describe, it, expect, beforeEach } from 'vitest';
import db from '../../server/lib/db';
import { createProfile } from '../../server/lib/telescopes';
import { addOpticalConfig } from '../../server/lib/telescopeOpticalConfigs';
import { setSessionOpticalConfig, sessionTrainKey } from '../../server/lib/library/sessionOptics';
import { comparisonKey } from '../../server/lib/frameAnalysis/service';
import { focalGroups, rankFrames } from '../../server/lib/frameAnalysis/ranking';
import type { FrameMetrics } from '../../server/lib/frameAnalysis/measure';

/** A night of frames as measured: a camera and a FOCALLEN in the header, a star count and a signal per frame. */
function night(n: number, opts: { signal: number; camera?: string; focal?: number }): FrameMetrics[] {
  return Array.from({ length: n }, (_, i) => ({
    width: 6248, height: 4176, starCount: 300, fwhm: 3, elongation: 1.1, orientation: null, background: 1000, noise: 10,
    gradient: 0.02, peakSNR: 40, signal: opts.signal, streak: null, saturatedFraction: 0, target: null, spots: [],
    rig: { camera: opts.camera ?? 'ZWO ASI2600MM Pro', focal: opts.focal ?? 600, scale: 1.29 }, ra: null, dec: null, id: i,
  } as unknown as FrameMetrics));
}

describe('comparisonKey', () => {
  const m = night(1, { signal: 5000 })[0];
  const focalOf = focalGroups([600, 610]);

  it('keys on the headers, exactly as before, when the night has no recorded train', () => {
    expect(comparisonKey('Ha', '300.0s', m, focalOf)).toBe('ha|300.0s|zwo asi2600mm pro|600|6248x4176');
    expect(comparisonKey('Ha', '300.0s', m, focalOf, null)).toBe(comparisonKey('Ha', '300.0s', m, focalOf));
  });

  it('keys on the train when there is one: two trains with the same headers differ, one train with different headers agrees', () => {
    const native = comparisonKey('Ha', '300.0s', m, focalOf, 'rig-1|native');
    const reducer = comparisonKey('Ha', '300.0s', m, focalOf, 'rig-1|reducer');
    expect(native).not.toBe(reducer);
    // A FOCALLEN typed differently on another night of the same train is still the same train.
    const otherHeader = night(1, { signal: 5000, focal: 640, camera: 'ASI2600MM' })[0];
    expect(comparisonKey('Ha', '300.0s', otherHeader, focalOf, 'rig-1|native')).toBe(native);
    // Filter, exposure and frame size still separate.
    expect(comparisonKey('OIII', '300.0s', m, focalOf, 'rig-1|native')).not.toBe(native);
  });
});

describe('two optical trains on the same object, with the same headers', () => {
  // Tonight through the native train; three earlier nights through the reducer, which puts more light on each pixel:
  // a FOCALLEN nobody updated when the reducer went on makes the headers identical.
  const tonight = night(8, { signal: 5000 });
  const reducerNights = night(15, { signal: 9000 });
  const focalOf = focalGroups([600]);

  /** The service's grouping: the other nights whose key matches tonight's are its history. */
  const scored = (trainTonight: string | null, trainOthers: string | null) => {
    const key = comparisonKey('Ha', '300.0s', tonight[0], focalOf, trainTonight);
    const history = reducerNights.filter(o => comparisonKey('Ha', '300.0s', o, focalOf, trainOthers) === key);
    return rankFrames(tonight, history).verdicts;
  };

  it('scores tonight against the reducer nights when nothing tells them apart', () => {
    const v = scored(null, null);
    expect(v.every(x => (x.score ?? 100) < 70)).toBe(true);
  });

  it('scores tonight on its own when each night has its train', () => {
    const v = scored('rig-1|native', 'rig-1|reducer');
    expect(v.every(x => x.grade === 'good')).toBe(true);
  });
});

describe('sessionTrainKey', () => {
  const OBJECT = 'TRAINTEST';
  let rig: string;
  let native: string;
  let reducer: string;

  beforeEach(() => {
    db.prepare('DELETE FROM libraryFiles WHERE objectId = ?').run(OBJECT);
    db.prepare('DELETE FROM librarySessions WHERE objectId = ?').run(OBJECT);
    db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run(OBJECT);
    rig = createProfile({ name: 'Garden rig', kind: 'asiair', model: 'ASIAIR' }).id;
    native = addOpticalConfig(rig, { name: 'Native', focalLengthMm: 600, sensorWidthMm: 23.5, sensorHeightMm: 15.7, pixelSizeUm: 3.76 }).id;
    reducer = addOpticalConfig(rig, { name: '0.8x reducer', focalLengthMm: 480, sensorWidthMm: 23.5, sensorHeightMm: 15.7, pixelSizeUm: 3.76 }).id;
    db.prepare(`INSERT INTO libraryObjects (objectId, folderName, lastImport) VALUES (?, ?, '2026-01-01')`).run(OBJECT, OBJECT);
  });

  /** A night with one sub from the rig, its FITS focal length already read and cached on the session. */
  function nightWith(date: string, focal: number | null) {
    db.prepare('INSERT INTO librarySessions (objectId, date, telescopeId) VALUES (?, ?, ?)').run(OBJECT, date, rig);
    db.prepare('UPDATE librarySessions SET fileFocalMm = ?, focalResolved = 1 WHERE objectId = ? AND date = ?').run(focal, OBJECT, date);
    db.prepare(
      `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, captureDate, captureTime, telescopeId, importedAt)
       VALUES (?, ?, 'sub.fit', 'sub.fit', 'sub', ?, '230000', ?, '2026-01-01')`,
    ).run(OBJECT, `${OBJECT}/${date}/sub.fit`, date, rig);
  }

  it('is the train chosen for the night, else the one its FITS focal length matches', () => {
    nightWith('2026-10-01', 602); // within 5 % of the native 600 mm
    nightWith('2026-10-02', 481);
    nightWith('2026-10-03', 600);
    setSessionOpticalConfig(OBJECT, '2026-10-03', reducer); // the owner says: reducer, whatever the header says
    expect(sessionTrainKey(OBJECT, '2026-10-01')).toBe(`${rig}|${native}`);
    expect(sessionTrainKey(OBJECT, '2026-10-02')).toBe(`${rig}|${reducer}`);
    expect(sessionTrainKey(OBJECT, '2026-10-03')).toBe(`${rig}|${reducer}`);
  });

  it('is null when nothing applies: no matching focal length among several trains, or a telescope with none', () => {
    nightWith('2026-10-04', 1000);
    expect(sessionTrainKey(OBJECT, '2026-10-04')).toBeNull();
    const bare = createProfile({ name: 'Bare', kind: 'other', model: 'Other' }).id;
    db.prepare('INSERT INTO librarySessions (objectId, date, telescopeId) VALUES (?, ?, ?)').run(OBJECT, '2026-10-05', bare);
    db.prepare(
      `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, captureDate, captureTime, telescopeId, importedAt)
       VALUES (?, ?, 'sub.fit', 'sub.fit', 'sub', '2026-10-05', '230000', ?, '2026-01-01')`,
    ).run(OBJECT, `${OBJECT}/2026-10-05/sub.fit`, bare);
    expect(sessionTrainKey(OBJECT, '2026-10-05')).toBeNull();
    expect(sessionTrainKey(OBJECT, '2026-12-31')).toBeNull(); // no such night
  });
});
