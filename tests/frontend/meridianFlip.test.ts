import { describe, expect, it } from 'vitest';
import { altAz, lstHours } from '../../src/lib/altaz';
import {
  DEFAULT_FLIP_PAUSE_MINUTES, SHORT_SIDE_MINUTES, flipInBlock, flipSettingsFor, meridianTransits,
} from '../../src/lib/meridianFlip';

// Paris.
const LAT = 48.85;
const LON = 2.35;
const NIGHT_START = new Date('2026-11-26T17:00:00Z');
const NIGHT_END = new Date('2026-11-27T07:00:00Z');
const MIN = 60_000;

/** The object's altitude through a window, sampled each minute: its highest point is the upper culmination. */
function highestMoment(ra: number, dec: number, from: Date, to: Date): Date {
  let best = from;
  let bestAlt = -Infinity;
  for (let t = from.getTime(); t <= to.getTime(); t += MIN) {
    const alt = altAz(ra, dec, LAT, LON, new Date(t)).alt;
    if (alt > bestAlt) { bestAlt = alt; best = new Date(t); }
  }
  return best;
}

describe('meridianTransits', () => {
  // RA chosen so every one culminates inside the night; declinations south of the zenith, near it, and circumpolar.
  it.each([
    { name: 'M42', ra: 5.588, dec: -5.39 },
    { name: 'M31', ra: 0.712, dec: 41.27 },
    { name: 'M1', ra: 5.575, dec: 22.01 },
    { name: 'a field at RA 23.5 h, Dec +45 (circumpolar here)', ra: 23.5, dec: 45 },
    { name: 'M81 (circumpolar, north of the zenith)', ra: 9.926, dec: 69.07 },
    { name: 'Fomalhaut field', ra: 22.96, dec: -29.62 },
  ])('finds the culmination of $name', ({ ra, dec }) => {
    const transits = meridianTransits(ra, LON, NIGHT_START, NIGHT_END);
    expect(transits).toHaveLength(1);
    const [at] = transits;
    // Hour angle 0 at the returned instant.
    const ha = ((lstHours(at, LON) - ra) % 24 + 36) % 24 - 12;
    expect(Math.abs(ha)).toBeLessThan(1 / 3600);
    // The highest point of the object, sampled minute by minute, is within a minute of it…
    expect(Math.abs(highestMoment(ra, dec, NIGHT_START, NIGHT_END).getTime() - at.getTime())).toBeLessThanOrEqual(MIN);
    // …at the culmination altitude, due south (or due north for an object north of the zenith).
    const pos = altAz(ra, dec, LAT, LON, at);
    expect(pos.alt).toBeCloseTo(90 - Math.abs(LAT - dec), 2);
    const expectedAz = dec > LAT ? 0 : 180;
    expect(Math.min(Math.abs(pos.az - expectedAz), 360 - Math.abs(pos.az - expectedAz))).toBeLessThan(0.01);
  });

  it('finds none when the block ends before the crossing or starts after it', () => {
    const [at] = meridianTransits(5.588, LON, NIGHT_START, NIGHT_END);
    expect(meridianTransits(5.588, LON, NIGHT_START, new Date(at.getTime() - MIN))).toEqual([]);
    expect(meridianTransits(5.588, LON, new Date(at.getTime() + MIN), NIGHT_END)).toEqual([]);
  });

  it('finds one per sidereal day in a block longer than a day, and none in an empty block', () => {
    const transits = meridianTransits(5.588, LON, NIGHT_START, new Date(NIGHT_START.getTime() + 34 * 3600_000));
    expect(transits).toHaveLength(2);
    expect((transits[1].getTime() - transits[0].getTime()) / 3600_000).toBeCloseTo(23.9345, 3);
    expect(meridianTransits(5.588, LON, NIGHT_END, NIGHT_START)).toEqual([]);
  });
});

describe('flipSettingsFor', () => {
  it('never flips a smart telescope', () => {
    expect(flipSettingsFor({ kind: 'seestar-s50', rig: undefined })).toBeNull();
    expect(flipSettingsFor({ kind: 'dwarf-3', rig: { sensorType: null, filters: [], mount: 'equatorial', flipPauseMinutes: 5 } })).toBeNull();
    expect(flipSettingsFor(null)).toBeNull();
  });

  it('assumes an ASIAIR flips and another rig does not, until the owner says', () => {
    expect(flipSettingsFor({ kind: 'asiair', rig: undefined })).toEqual({ pauseMinutes: DEFAULT_FLIP_PAUSE_MINUTES });
    expect(flipSettingsFor({ kind: 'other', rig: { sensorType: null, filters: [], mount: null, flipPauseMinutes: null } })).toBeNull();
  });

  it('follows what the owner said, with their pause', () => {
    expect(flipSettingsFor({ kind: 'asiair', rig: { sensorType: null, filters: [], mount: 'altaz', flipPauseMinutes: null } })).toBeNull();
    expect(flipSettingsFor({ kind: 'other', rig: { sensorType: 'mono', filters: [], mount: 'equatorial', flipPauseMinutes: 4 } })).toEqual({ pauseMinutes: 4 });
  });
});

describe('flipInBlock', () => {
  const [transit] = meridianTransits(5.588, LON, NIGHT_START, NIGHT_END);
  const at = (minutes: number) => new Date(transit.getTime() + minutes * MIN);

  it('takes the pause off the imaging time and has nothing to suggest when both sides are long', () => {
    const flip = flipInBlock(5.588, LON, at(-90), at(90), 10)!;
    expect(flip.at.getTime()).toBe(transit.getTime());
    expect(flip.imagingMinutes).toBeCloseTo(170, 6);
    expect(flip.suggestion).toBeNull();
  });

  it('suggests ending at the flip when little is left after it', () => {
    const flip = flipInBlock(5.588, LON, at(-120), at(25), 10)!;
    expect(flip.suggestion).toEqual({ kind: 'endAtFlip', at: transit });
  });

  it('suggests starting once the flip is done when little comes before it', () => {
    const flip = flipInBlock(5.588, LON, at(-SHORT_SIDE_MINUTES + 5), at(120), 10)!;
    expect(flip.suggestion).toEqual({ kind: 'startAfterFlip', at: at(10) });
  });

  it('is null when the target does not cross during the block', () => {
    expect(flipInBlock(5.588, LON, at(5), at(120), 10)).toBeNull();
  });
});
