import { describe, it, expect } from 'vitest';
import { matchGroup, pickDark, pickFlat, sameCamera, _internal, type CalCandidate, type LightGroupInput, type RigInfo } from '../../server/lib/stackingMatch';

const NIGHT = '2026-09-05';

const group = (over: Partial<LightGroupInput> = {}): LightGroupInput => ({
  night: NIGHT, filter: 'H', exposureSec: 180, gain: 200, binning: 1, sensorTempC: -10, scope: 'asiair', ...over,
});

let n = 0;
const cal = (type: CalCandidate['type'], over: Partial<CalCandidate> = {}): CalCandidate => ({
  type, scope: 'asiair', folderName: type, key: `k${n++}`, name: `${type}-${n}`,
  exposureSec: null, gain: 200, binning: 1, sensorTempC: null, filter: null,
  capturedAt: '2026-09-01T10:00:00.000Z', isExpired: false, fileCount: 30, bytes: 1000, ...over,
});

describe('pickDark', () => {
  it('needs the same exposure, gain and binning, and a close temperature', () => {
    const good = cal('dark', { exposureSec: 180, sensorTempC: -9.6, name: 'good' });
    const other = [
      cal('dark', { exposureSec: 120, sensorTempC: -10 }),
      cal('dark', { exposureSec: 180, gain: 100, sensorTempC: -10 }),
      cal('dark', { exposureSec: 180, binning: 2, sensorTempC: -10 }),
    ];
    const r = pickDark(group(), [...other, good]);
    expect(r.pick?.candidate.name).toBe('good');
    expect(r.pick?.deltaTempC).toBe(0.4);
    expect(r.issues).toEqual([]);
  });

  it('reports the nearest dark when every one is too warm or too cold', () => {
    const r = pickDark(group(), [cal('dark', { exposureSec: 180, sensorTempC: -4, name: 'warm' })]);
    expect(r.pick).toBeNull();
    expect(r.issues).toEqual([{ code: 'dark_temp_far', severity: 'error', params: { bundle: 'warm', delta: 6 } }]);
    expect(pickDark(group(), []).issues[0].code).toBe('no_dark');
  });

  it('prefers the session telescope, then unexpired, then the closer temperature', () => {
    const otherScope = cal('dark', { exposureSec: 180, sensorTempC: -10, scope: 'seestar', name: 'other-scope' });
    const expired = cal('dark', { exposureSec: 180, sensorTempC: -10, isExpired: true, name: 'expired' });
    const closeEnough = cal('dark', { exposureSec: 180, sensorTempC: -8.5, name: 'fresh' });
    expect(pickDark(group(), [otherScope, expired, closeEnough]).pick?.candidate.name).toBe('fresh');
    const onlyExpired = pickDark(group(), [expired]);
    expect(onlyExpired.pick?.candidate.name).toBe('expired');
    expect(onlyExpired.issues[0]).toMatchObject({ code: 'dark_expired', severity: 'warning' });
  });

  it('does not let a setting missing on one side block a match', () => {
    expect(pickDark(group({ gain: null, sensorTempC: null }), [cal('dark', { exposureSec: 180, sensorTempC: -20 })]).pick).not.toBeNull();
  });
});

describe('pickFlat', () => {
  it('takes the attached flats for the filter first', () => {
    const attached = cal('flat', { filter: 'H', name: 'attached', capturedAt: '2026-08-01T10:00:00.000Z' });
    const sameNight = cal('flat', { filter: 'H', name: 'same-night', capturedAt: `${NIGHT}T23:30:00` });
    const r = pickFlat(group(), [attached, sameNight], [attached], 1);
    expect(r.pick).toMatchObject({ source: 'attached', candidate: { name: 'attached' } });
  });

  it('otherwise matches flats of the same filter shot that night', () => {
    const r = pickFlat(group(), [
      cal('flat', { filter: 'O', capturedAt: `${NIGHT}T23:30:00` }),
      cal('flat', { filter: 'h', name: 'dawn', capturedAt: '2026-09-06T06:10:00' }),
      cal('flat', { filter: 'H', name: 'old', capturedAt: '2026-08-20T06:10:00' }),
    ], [], 2);
    expect(r.pick).toMatchObject({ source: 'matched', deltaDays: 0, candidate: { name: 'dawn' } });
    expect(r.issues).toEqual([]);
  });

  it('falls back to the nearest night with a warning, or reports none', () => {
    const r = pickFlat(group(), [cal('flat', { filter: 'H', name: 'old', capturedAt: '2026-09-01T06:00:00' })], [], 1);
    expect(r.pick?.candidate.name).toBe('old');
    expect(r.issues[0]).toMatchObject({ code: 'flat_other_night', severity: 'warning', params: { days: 4 } });
    expect(pickFlat(group(), [cal('flat', { filter: 'O' })], [], 2).issues[0]).toMatchObject({ code: 'no_flat', severity: 'error' });
  });

  it('only uses flats without a filter label on a single-filter night', () => {
    const unlabeled = cal('flat', { filter: null, capturedAt: `${NIGHT}T23:30:00` });
    expect(pickFlat(group(), [unlabeled], [], 1).pick).not.toBeNull();
    expect(pickFlat(group(), [unlabeled], [], 2).pick).toBeNull();
  });
});

describe('matchGroup', () => {
  const dark = cal('dark', { exposureSec: 180, sensorTempC: -10 });
  const flat = cal('flat', { filter: 'H', exposureSec: 1.2, capturedAt: '2026-09-06T06:00:00' });

  it('pairs flat darks with the flats and keeps bias when found', () => {
    const flatDark = cal('flatDark', { exposureSec: 1.2, capturedAt: '2026-09-06T06:05:00', name: 'fd' });
    const wrongFlatDark = cal('flatDark', { exposureSec: 3 });
    const bias = cal('bias', { name: 'bias' });
    const m = matchGroup(group(), [dark, flat, flatDark, wrongFlatDark, bias], [], 1);
    expect(m.flatDark?.candidate.name).toBe('fd');
    expect(m.bias?.candidate.name).toBe('bias');
    expect(m.issues).toEqual([]);
  });

  it('flags flats that nothing can calibrate', () => {
    const m = matchGroup(group(), [dark, flat], [], 1);
    expect(m.issues).toEqual([{ code: 'no_flat_calibration', severity: 'error' }]);
  });
});

describe('camera and telescope', () => {
  const asi585: RigInfo = { camera: 'ZWO ASI585MC', telescope: 'Askar 91F', sensorPx: [3840, 2160], pixelUm: 2.9 };
  const pl9000: RigInfo = { camera: 'FLI ProLine PL9000', telescope: 'CDK24', sensorPx: [3056, 3056], pixelUm: 12 };
  const remote = (over: Partial<LightGroupInput> = {}) => group({ rig: pl9000, scope: 'chi1', ...over });

  it('tells cameras apart by name, sensor size or pixel size', () => {
    expect(sameCamera(asi585, { ...asi585, camera: 'ZWO ASI585MC Air' })).toBe(true);
    expect(sameCamera(asi585, pl9000)).toBe(false);
    expect(sameCamera(asi585, { ...asi585, camera: null, sensorPx: [3056, 3056] })).toBe(false);
    expect(sameCamera(asi585, { ...asi585, camera: null, sensorPx: null, pixelUm: 3.76 })).toBe(false);
    // Unknown on either side never blocks.
    expect(sameCamera(asi585, null)).toBe(true);
    expect(sameCamera(asi585, { camera: null, telescope: null, sensorPx: null, pixelUm: null })).toBe(true);
  });

  it('never falls back to another camera\'s darks or bias', () => {
    const dark = cal('dark', { exposureSec: 180, sensorTempC: -10, rig: asi585 });
    expect(pickDark(remote(), [dark])).toEqual({ pick: null, issues: [{ code: 'no_dark', severity: 'error' }] });
    const m = matchGroup(remote(), [dark, cal('bias', { rig: asi585 })], [], 1);
    expect(m.bias).toBeNull();
  });

  it('never falls back to another rig\'s flats, attached or not', () => {
    const flat = cal('flat', { filter: 'H', capturedAt: `${NIGHT}T23:30:00`, rig: asi585 });
    expect(pickFlat(remote(), [flat], [flat], 1).issues).toEqual([{ code: 'no_flat', severity: 'error', params: { filter: 'H' } }]);
    // Same camera, but on another telescope: flats only hold for their own optical train.
    const otherScope = cal('flat', { filter: 'H', scope: 'asiair', capturedAt: `${NIGHT}T23:30:00`, rig: pl9000 });
    expect(pickFlat(remote(), [otherScope], [], 1).pick).toBeNull();
    const otherTelescop = cal('flat', { filter: 'H', scope: 'chi1', capturedAt: `${NIGHT}T23:30:00`, rig: { ...pl9000, telescope: 'RC16' } });
    expect(pickFlat(remote(), [otherTelescop], [], 1).pick).toBeNull();
  });

  it('matches the lights\' own camera, and frames whose camera is unknown', () => {
    const own = cal('dark', { exposureSec: 180, sensorTempC: -10, name: 'own', rig: { ...pl9000, telescope: null } });
    const theirs = cal('dark', { exposureSec: 180, sensorTempC: -10, rig: asi585, fileCount: 100 });
    expect(pickDark(remote(), [theirs, own]).pick?.candidate.name).toBe('own');
    expect(pickDark(remote(), [cal('dark', { exposureSec: 180, sensorTempC: -10, name: 'unknown' })]).pick?.candidate.name).toBe('unknown');
  });

  it('keeps flat darks on the flats\' and the lights\' camera', () => {
    const flat = cal('flat', { filter: 'H', exposureSec: 1.2, scope: 'chi1', capturedAt: '2026-09-06T06:00:00' });
    const wrong = cal('flatDark', { exposureSec: 1.2, rig: asi585 });
    const m = matchGroup(remote(), [flat, wrong], [], 1);
    expect(m.flatDark).toBeNull();
  });
});

describe('night window', () => {
  it('covers noon to noon-plus-36h of the night date', () => {
    expect(_internal.daysFromNight(NIGHT, `${NIGHT}T13:00:00`)).toBe(0);
    expect(_internal.daysFromNight(NIGHT, '2026-09-06T23:00:00')).toBe(0);
    expect(_internal.daysFromNight(NIGHT, '2026-09-08T00:00:00')).toBe(1);
    expect(_internal.daysFromNight(NIGHT, null)).toBeNull();
  });
});
