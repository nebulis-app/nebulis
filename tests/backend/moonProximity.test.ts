import { describe, it, expect } from 'vitest';
import { checkMoonProximity, moonThresholdForIllumination, moonVerdictFor } from '../../server/lib/moonProximity';

// This is "the canonical implementation used by the planner's scheduling and
// verdict endpoints" per the header comment in server/lib/moonProximity.ts,
// yet had zero direct tests. The browser copy (src/lib/moonProximity.ts) is
// display-only and gets incidental coverage through plannerNight.test.ts, but
// nothing exercised the server port every client's verdict actually comes from.

const LAT = 40.7128;
const LON = -74.006;

describe('moonThresholdForIllumination', () => {
  it('is 25 + illum * 0.6', () => {
    expect(moonThresholdForIllumination(0)).toBe(25);
    expect(moonThresholdForIllumination(50)).toBe(55);
    expect(moonThresholdForIllumination(100)).toBe(85);
  });

  it('clamps illumination outside 0-100 rather than extrapolating', () => {
    expect(moonThresholdForIllumination(-10)).toBe(25);
    expect(moonThresholdForIllumination(150)).toBe(85);
  });
});

describe('checkMoonProximity — moon below the horizon', () => {
  it('is always ok, with no worst point and an infinite separation, when the moon never rises during the block', () => {
    // Confirmed the moon sits at roughly -25° to -42° altitude from this site
    // across this whole window, so it never enters the alt>=0 branch at all.
    const start = new Date('2025-06-21T03:14:15Z');
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    const result = checkMoonProximity(0, 20, LAT, LON, start, end, 50, 15);

    expect(result.verdict).toBe('ok');
    expect(result.minSeparation).toBe(Infinity);
    expect(result.worstAt).toBeNull();
    expect(result.reason).toBe('');
  });
});

describe('checkMoonProximity — moon above the horizon, verdict bands', () => {
  // Fixed target and instant with a real, confirmed separation from the moon
  // of ~33.7 degrees at this site. Varying only illumPercent moves the
  // phase-scaled threshold across all three verdict bands around that fixed
  // separation, rather than hunting for three different real geometries.
  const ra = 0;
  const dec = 20;
  const when = new Date('2025-06-21T13:00:00Z');

  it('is ok when the real separation clears the threshold', () => {
    const result = checkMoonProximity(ra, dec, LAT, LON, when, when, 0, 5);
    expect(result.verdict).toBe('ok');
    expect(result.minSeparation).toBeCloseTo(33.73, 1);
    expect(result.threshold).toBe(25);
    expect(result.reason).toBe('');
  });

  it('is caution within 15 degrees of the threshold, and reasons about it', () => {
    const result = checkMoonProximity(ra, dec, LAT, LON, when, when, 30, 5);
    expect(result.verdict).toBe('caution');
    expect(result.threshold).toBe(43);
    expect(result.worstAt).toEqual(when);
    expect(result.reason).toBe('Moon 34° away at 13:00 (recommended ≥ 43° at 30% illumination)');
  });

  it('is warning more than 15 degrees below the threshold', () => {
    const result = checkMoonProximity(ra, dec, LAT, LON, when, when, 60, 5);
    expect(result.verdict).toBe('warning');
    expect(result.threshold).toBe(61);
    expect(result.reason).toBe('Moon 34° away at 13:00 (recommended ≥ 61° at 60% illumination)');
  });

  it('reports the same real separation and worst-at instant across all three bands', () => {
    // The verdict changes with illumPercent; the underlying geometry must not.
    const ok = checkMoonProximity(ra, dec, LAT, LON, when, when, 0, 5);
    const caution = checkMoonProximity(ra, dec, LAT, LON, when, when, 30, 5);
    const warning = checkMoonProximity(ra, dec, LAT, LON, when, when, 60, 5);

    expect(caution.minSeparation).toBe(ok.minSeparation);
    expect(warning.minSeparation).toBe(ok.minSeparation);
    expect(caution.moonAltAtWorst).toBe(ok.moonAltAtWorst);
    expect(warning.moonAltAtWorst).toBe(ok.moonAltAtWorst);
  });
});

describe('narrowband tolerance', () => {
  const ra = 0;
  const dec = 20;
  const when = new Date('2025-06-21T13:00:00Z'); // ~33.7° from the Moon (above)

  it('is 15 + illum * 0.25, much closer to the Moon than broadband', () => {
    expect(moonThresholdForIllumination(0, 'narrowband')).toBe(15);
    expect(moonThresholdForIllumination(100, 'narrowband')).toBe(40);
    expect(moonThresholdForIllumination(100, 'broadband')).toBe(85);
  });

  it('keeps a block 34° from a 60% Moon fine in narrowband while broadband warns', () => {
    const bb = checkMoonProximity(ra, dec, LAT, LON, when, when, 60, 5, 'UTC', 'broadband');
    const nb = checkMoonProximity(ra, dec, LAT, LON, when, when, 60, 5, 'UTC', 'narrowband');
    expect(bb.verdict).toBe('warning');
    expect(nb.verdict).toBe('ok');
    expect(nb.minSeparation).toBe(bb.minSeparation);
  });

  it('says narrowband in the reason when the narrowband check fails', () => {
    const nb = checkMoonProximity(ra, dec, LAT, LON, when, when, 100, 5, 'UTC', 'narrowband');
    expect(nb.verdict).toBe('caution');
    expect(nb.reason).toBe('Moon 34° away at 13:00 (recommended ≥ 40° at 100% illumination, narrowband)');
  });

  it('bands verdicts the same way for both filters', () => {
    expect(moonVerdictFor(Infinity, 40)).toBe('ok');
    expect(moonVerdictFor(30, 40)).toBe('caution');
    expect(moonVerdictFor(20, 40)).toBe('warning');
  });
});
