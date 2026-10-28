import { describe, it, expect, beforeEach, vi } from 'vitest';

// Isolated DATA_DIR before any server module loads (paths.ts reads it at import).
vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  process.env.DATA_DIR = _fs.mkdtempSync(_path.join(_root, 'nebulis-rig-test-'));
});

import db from '../../server/lib/db';
import { stmts } from '../../server/lib/library/objects';
import { saveCaptureInfo } from '../../server/lib/library/captureInfo';
import { setFilterAliases } from '../../server/lib/library/integration';
import {
  getRig, setRig, cleanRigFilters, getUsedFilterNames, MAX_RIG_FILTERS, MAX_RIG_FILTER_LENGTH,
} from '../../server/lib/telescopeRig';

const SCOPE = 'scope-a';

function addProfile(id: string): void {
  db.prepare(`INSERT OR IGNORE INTO telescopeProfiles (id, name, createdAt) VALUES (?, ?, '2026-01-01')`).run(id, id);
}

/** One imported night: the object, the session (with the telescope that shot it) and its sidecar record. */
function addNight(objectId: string, date: string, telescopeId: string, filter: string | null): void {
  stmts.upsertObject.run(objectId, objectId, 0, new Date().toISOString(), 0, null, null, null, null, null, null, null, null, null, null);
  db.prepare('INSERT OR REPLACE INTO librarySessions (objectId, date, telescopeId) VALUES (?, ?, ?)').run(objectId, date, telescopeId);
  saveCaptureInfo({
    objectId, sessionFolder: date, sessionDate: date, exposureSec: 10, gain: null, filter, binning: null,
    framesStacked: null, framesTaken: null, framesPlanned: null, minTempC: null, maxTempC: null,
    raHours: null, decDeg: null, target: null, sourceRelPath: null,
  });
}

beforeEach(() => {
  db.prepare('DELETE FROM captureInfo').run();
  db.prepare('DELETE FROM librarySessions').run();
  db.prepare('DELETE FROM telescopeRigSettings').run();
  db.prepare('DELETE FROM telescopeProfiles').run();
  setFilterAliases([]);
  addProfile(SCOPE);
});

describe('rig settings', () => {
  it('reads as unknown until the owner says', () => {
    expect(getRig(SCOPE)).toEqual({ sensorType: null, filters: [] });
  });

  it('round-trips and replaces', () => {
    expect(setRig(SCOPE, { sensorType: 'mono', filters: ['Ha', 'OIII', 'SII'] })).toEqual({ sensorType: 'mono', filters: ['Ha', 'OIII', 'SII'] });
    expect(getRig(SCOPE)).toEqual({ sensorType: 'mono', filters: ['Ha', 'OIII', 'SII'] });
    setRig(SCOPE, { sensorType: 'color', filters: ['L-eXtreme'] });
    expect(getRig(SCOPE)).toEqual({ sensorType: 'color', filters: ['L-eXtreme'] });
  });

  it('goes with the telescope when it is deleted', () => {
    setRig(SCOPE, { sensorType: 'color', filters: ['L-eXtreme'] });
    db.prepare('DELETE FROM telescopeProfiles WHERE id = ?').run(SCOPE);
    expect(db.prepare('SELECT COUNT(*) AS n FROM telescopeRigSettings').get()).toEqual({ n: 0 });
  });

  it('reads a damaged filter list as none instead of throwing', () => {
    db.prepare(`INSERT INTO telescopeRigSettings (profileId, sensorType, filtersJson, updatedAt) VALUES (?, 'mono', '{not json', 'x')`).run(SCOPE);
    expect(getRig(SCOPE)).toEqual({ sensorType: 'mono', filters: [] });
  });

  it('rejects a sensor type that is not colour or mono', () => {
    expect(() => db.prepare(`INSERT INTO telescopeRigSettings (profileId, sensorType, filtersJson, updatedAt) VALUES (?, 'rgb', '[]', 'x')`).run(SCOPE)).toThrow();
  });
});

describe('cleanRigFilters', () => {
  it('trims, collapses spaces, drops blanks and case-insensitive duplicates', () => {
    expect(cleanRigFilters([' Ha ', 'ha', '', '  ', 'L-eXtreme  2"', 'OIII'])).toEqual(['Ha', 'L-eXtreme 2"', 'OIII']);
  });

  it('refuses a name or a list past the limits', () => {
    expect(() => cleanRigFilters(['x'.repeat(MAX_RIG_FILTER_LENGTH + 1)])).toThrow(RangeError);
    expect(() => cleanRigFilters(Array.from({ length: MAX_RIG_FILTERS + 1 }, (_, i) => `F${i}`))).toThrow(RangeError);
  });
});

describe('getUsedFilterNames', () => {
  it('is empty for a telescope with nothing imported', () => {
    expect(getUsedFilterNames(SCOPE)).toEqual([]);
  });

  it('lists the filters this telescope shot through, most used first, normalised like the library', () => {
    addNight('M31', '2026-10-01', SCOPE, 'LP');
    addNight('M42', '2026-10-02', SCOPE, 'LP');
    addNight('M45', '2026-10-03', SCOPE, 'H-alpha');
    setFilterAliases([{ alias: 'H-alpha', canonical: 'Ha' }]);
    expect(getUsedFilterNames(SCOPE)).toEqual(['LP', 'Ha']);
  });

  it('ignores other telescopes, empty values and frames with no filter', () => {
    addProfile('scope-b');
    addNight('M31', '2026-10-01', 'scope-b', 'Ha');
    addNight('M42', '2026-10-02', SCOPE, null);
    addNight('M45', '2026-10-03', SCOPE, '  ');
    expect(getUsedFilterNames(SCOPE)).toEqual([]);
    expect(getUsedFilterNames('scope-b')).toEqual(['Ha']);
  });

  it('caps the list', () => {
    for (let i = 0; i < 9; i++) addNight(`NGC${100 + i}`, '2026-10-01', SCOPE, `Filter${i}`);
    expect(getUsedFilterNames(SCOPE)).toHaveLength(6);
    expect(getUsedFilterNames(SCOPE, 2)).toHaveLength(2);
  });
});
